#!/usr/bin/env python3
"""Deterministic executor for Recordly AI demo scripts (YAML or JSON).

    python demo_runner.py validate demo.yaml
    python demo_runner.py prepare  demo.yaml          # TTS for every narration, ahead of time
    python demo_runner.py run      demo.yaml [--from STEP] [--dry-run] [--no-record]

What `run` does, step by step (see references/demo-script.md for the schema):
  * starts/attaches Recordly AI (--server), selects the target window, starts recording;
  * for each step: marker → narration (prepared audio + subtitles) → actions → wait;
  * if the next step's narration is not ready yet, it PAUSES the recording and resumes when
    it is (no dead air, no cut needed);
  * long AI generations: `wait: {type: idle_end}` blocks until the screen changes again,
    optional `while_waiting` narration fills the wait (narration is never accelerated);
  * a failed `retryable` step is discarded from the edit (discard markers) and retried;
  * a step of kind `agent` stops with exit code 10 and a JSON hand-off so the agent can do
    the non-deterministic part with its own computer-use tools, then `--from <next step>`.
  * finally: stop → auto-edit (idle speed-ups, journal merge) → save → export → quit.

Optional dependencies: PyYAML (YAML scripts), pywinauto (UIA clicks/keys on Windows).
"""
from __future__ import annotations

import argparse
import json
import queue
import re
import shlex
import subprocess
import sys
import threading
import time
import webbrowser
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))
from recordly_ai import RecordlyAI, RecordlyError, launch  # noqa: E402
from tts import TtsError, synthesize  # noqa: E402

EXIT_AGENT_STEP = 10
# WinUI apps (e.g. Windows 11 Notepad) drop or repeat keystrokes sent faster than ~30 ms.
MIN_KEY_INTERVAL_S = 0.03
NARRATION_TIMINGS = {"before", "with", "after"}
ACTION_TYPES = {"hotkey", "keys", "type", "click", "double_click", "right_click", "scroll", "shell", "open_url", "sleep", "focus", "zoom_on", "blur_element", "callout", "uia_set_text"}
WAIT_TYPES = {"none", "sleep", "stable", "changed", "idle_end", "uia_exists", "event"}


# ── Script loading & validation ─────────────────────────────────────────────


def load_script(path: Path) -> Dict[str, Any]:
    text = path.read_text(encoding="utf-8")
    if path.suffix.lower() in (".yaml", ".yml"):
        try:
            import yaml  # type: ignore
        except ImportError:
            raise SystemExit("PyYAML is required for YAML scripts (pip install pyyaml) or use JSON.")
        return yaml.safe_load(text)
    return json.loads(text)


def validate(script: Dict[str, Any]) -> List[str]:
    problems: List[str] = []
    if not isinstance(script.get("steps"), list) or not script["steps"]:
        return ["`steps` must be a non-empty list"]
    seen = set()
    for index, step in enumerate(script["steps"]):
        where = f"steps[{index}]"
        sid = step.get("id")
        if not sid or not re.fullmatch(r"[\w.-]+", str(sid)):
            problems.append(f"{where}: `id` is required ([A-Za-z0-9_.-])")
        elif sid in seen:
            problems.append(f"{where}: duplicate id {sid!r}")
        seen.add(sid)
        if step.get("narration_timing", "before") not in NARRATION_TIMINGS:
            problems.append(f"{where}: narration_timing must be one of {sorted(NARRATION_TIMINGS)}")
        if step.get("kind", "auto") not in ("auto", "agent"):
            problems.append(f"{where}: kind must be auto or agent")
        for action in step.get("actions", []):
            if action.get("type") not in ACTION_TYPES:
                problems.append(f"{where}: unknown action type {action.get('type')!r}")
        wait = step.get("wait") or {"type": "none"}
        if wait.get("type") not in WAIT_TYPES:
            problems.append(f"{where}: unknown wait type {wait.get('type')!r}")
    return problems


# ── Desktop actions (pywinauto when available) ──────────────────────────────


def _pywinauto():
    try:
        import pywinauto  # type: ignore
        from pywinauto import Desktop, keyboard, mouse  # type: ignore

        return pywinauto, Desktop, keyboard, mouse
    except ImportError:
        raise RuntimeError("this action needs pywinauto (pip install pywinauto)") from None


def to_send_keys(combo: str) -> str:
    """'ctrl+shift+n' → '^+n'; 'enter' → '{ENTER}' (pywinauto syntax)."""
    modifiers = {"ctrl": "^", "control": "^", "shift": "+", "alt": "%", "win": "{VK_LWIN down}"}
    parts = [part.strip().lower() for part in combo.split("+")]
    key = parts[-1]
    prefix = "".join(modifiers.get(part, "") for part in parts[:-1])
    named = {"enter": "{ENTER}", "tab": "{TAB}", "esc": "{ESC}", "escape": "{ESC}", "space": " ", "backspace": "{BACKSPACE}", "delete": "{DELETE}", "up": "{UP}", "down": "{DOWN}", "left": "{LEFT}", "right": "{RIGHT}", "home": "{HOME}", "end": "{END}", "pageup": "{PGUP}", "pagedown": "{PGDN}"}
    if re.fullmatch(r"f\d{1,2}", key):
        named[key] = "{" + key.upper() + "}"
    body = named.get(key, key)
    suffix = "{VK_LWIN up}" if "win" in parts[:-1] else ""
    return prefix + body + suffix


def find_element(selector: Dict[str, Any], timeout_s: float = 10.0):
    """UIA element from {window: title regex, name|title, control_type, auto_id, found_index}."""
    _, Desktop, _, _ = _pywinauto()
    desktop = Desktop(backend="uia")
    window = desktop.window(title_re=selector["window"]) if selector.get("window") else desktop.top_window()
    criteria = {}
    if selector.get("name") or selector.get("title"):
        criteria["title"] = selector.get("name") or selector.get("title")
    if selector.get("name_re"):
        criteria["title_re"] = selector["name_re"]
    if selector.get("control_type"):
        criteria["control_type"] = selector["control_type"]
    if selector.get("auto_id"):
        criteria["auto_id"] = selector["auto_id"]
    if "found_index" in selector:
        criteria["found_index"] = selector["found_index"]
    element = window.child_window(**criteria) if criteria else window
    element.wait("exists visible", timeout=timeout_s)
    return element


def element_rect(element) -> Dict[str, int]:
    rect = element.rectangle()
    return {"x": rect.left, "y": rect.top, "width": rect.width(), "height": rect.height()}


@dataclass
class RunContext:
    rai: Optional[RecordlyAI]
    script: Dict[str, Any]
    dry_run: bool
    recording: bool
    log: List[Dict[str, Any]] = field(default_factory=list)

    def say(self, message: str, **data: Any) -> None:
        entry = {"t": round(time.time(), 3), "msg": message, **data}
        self.log.append(entry)
        print(json.dumps(entry, ensure_ascii=False), flush=True)


def run_action(ctx: RunContext, action: Dict[str, Any]) -> None:
    kind = action["type"]
    ctx.say("action", type=kind)
    if ctx.dry_run:
        return
    if kind == "sleep":
        time.sleep(action.get("ms", 500) / 1000)
    elif kind == "shell":
        command = action["cmd"]
        subprocess.run(command if isinstance(command, list) else shlex.split(command, posix=sys.platform != "win32"), check=action.get("check", True), timeout=action.get("timeout_s", 600))
    elif kind == "open_url":
        webbrowser.open(action["url"])
    elif kind in ("hotkey", "keys"):
        _, _, keyboard, _ = _pywinauto()
        keyboard.send_keys(
            to_send_keys(action["keys"]) if kind == "hotkey" else action["keys"],
            with_spaces=kind == "keys",
            pause=max(MIN_KEY_INTERVAL_S, action.get("pause", 0.05)),
        )
    elif kind == "type":
        _, _, keyboard, _ = _pywinauto()
        # send_keys treats + ^ % ~ ( ) { } [ ] as syntax: wrap each in braces to type it literally.
        text = re.sub(r"([+^%~(){}\[\]])", r"{\1}", action["text"])
        interval = max(MIN_KEY_INTERVAL_S, action.get("interval_ms", 40) / 1000)
        keyboard.send_keys(text, with_spaces=True, with_newlines=True, pause=interval)
    elif kind in ("click", "double_click", "right_click"):
        _, _, _, mouse = _pywinauto()
        if "xy" in action:
            x, y = action["xy"]
            {"click": mouse.click, "double_click": mouse.double_click, "right_click": mouse.right_click}[kind](coords=(x, y))
        else:
            element = find_element(action["uia"], action.get("timeout_s", 10))
            if action.get("zoom") and ctx.rai and ctx.recording:
                ctx.rai.post("/v1/zoom", {"screenRect": element_rect(element), "durationMs": action.get("zoom_ms", 2500)})
            {"click": element.click_input, "double_click": element.double_click_input, "right_click": element.right_click_input}[kind]()
    elif kind == "scroll":
        _, _, _, mouse = _pywinauto()
        mouse.scroll(coords=tuple(action.get("xy", (0, 0))), wheel_dist=action.get("amount", -3))
    elif kind == "focus":
        find_element({"window": action["window"]}, action.get("timeout_s", 10)).set_focus()
    elif kind == "uia_set_text":
        find_element(action["uia"], action.get("timeout_s", 10)).set_edit_text(action["text"])
    elif kind in ("zoom_on", "blur_element", "callout"):
        if not (ctx.rai and ctx.recording):
            return
        body: Dict[str, Any] = {"durationMs": action.get("duration_ms", 3000)}
        if "uia" in action:
            body["screenRect"] = element_rect(find_element(action["uia"], action.get("timeout_s", 10)))
        elif "rect" in action:
            body["rect"] = action["rect"]
        if kind == "zoom_on":
            ctx.rai.post("/v1/zoom", body)
        else:
            body["type"] = "blur" if kind == "blur_element" else "text"
            if kind == "callout":
                body["text"] = action["text"]
            ctx.rai.post("/v1/annotations", body)


def run_wait(ctx: RunContext, wait: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    wait = wait or {"type": "none"}
    kind = wait.get("type", "none")
    ctx.say("wait", type=kind)
    if ctx.dry_run or kind == "none":
        return {"met": True}
    if kind == "sleep":
        time.sleep(wait.get("ms", 1000) / 1000)
        return {"met": True}
    timeout_s = wait.get("timeout_s", 120)
    if not ctx.rai and kind in ("stable", "changed", "idle_end", "event"):
        # Rehearsal without Recordly AI (--no-record): approximate visual waits with a pause.
        time.sleep(wait.get("for_ms", 1500) / 1000)
        return {"met": True, "rehearsal": True}
    if kind in ("stable", "changed"):
        assert ctx.rai
        return ctx.rai.post(
            "/v1/wait",
            {"condition": kind, "forMs": wait.get("for_ms", 1500), "timeoutMs": int(timeout_s * 1000), "ignoreRects": wait.get("ignore_rects"), "threshold": wait.get("threshold")},
            timeout=timeout_s + 30,
        )
    if kind in ("idle_end", "event"):
        assert ctx.rai
        types = ["idle.ended"] if kind == "idle_end" else wait["types"]
        event = ctx.rai.wait_event(types, timeout_s, wait.get("after"))
        return {"met": event is not None, "event": event}
    if kind == "uia_exists":
        try:
            find_element(wait["uia"], timeout_s)
            return {"met": True}
        except Exception as error:  # noqa: BLE001 - pywinauto raises many timeout types
            return {"met": False, "error": str(error)}
    return {"met": False}


# ── Narration preparation (background, so recording can start early) ────────


class NarrationPreparer:
    """Renders narrations in order on a worker thread; `get(id)` blocks until ready."""

    def __init__(self, ctx: RunContext, cache_dir: Path):
        self.ctx = ctx
        self.cache_dir = cache_dir
        self.ready: Dict[str, Dict[str, Any]] = {}
        self.errors: Dict[str, str] = {}
        self.events: Dict[str, threading.Event] = {}
        self.jobs: "queue.Queue[Optional[Dict[str, Any]]]" = queue.Queue()
        self.thread = threading.Thread(target=self._work, daemon=True)

    def start(self, steps: List[Dict[str, Any]]) -> None:
        for step in steps:
            for key in ("narration", "while_waiting"):
                text = step.get(key) if key == "narration" else (step.get("while_waiting") or {}).get("narration")
                if text:
                    nid = f"{step['id']}.{key}"
                    self.events[nid] = threading.Event()
                    self.jobs.put({"id": nid, "text": text})
        self.jobs.put(None)
        self.thread.start()

    def _work(self) -> None:
        tts = self.ctx.script.get("tts", {})
        provider = tts.get("provider", "bridge")
        while True:
            job = self.jobs.get()
            if job is None:
                return
            try:
                self.ready[job["id"]] = self._render(job["id"], job["text"], provider, tts)
            except Exception as error:  # noqa: BLE001 - a dead worker would stall every later narration
                self.errors[job["id"]] = str(error)
            finally:
                self.events[job["id"]].set()

    def _render(self, nid: str, text: str, provider: str, tts: Dict[str, Any]) -> Dict[str, Any]:
        if self.ctx.dry_run or not self.ctx.rai:
            return {"id": nid, "durationMs": int(len(text) / 14 * 1000)}
        if provider == "bridge":
            return self.ctx.rai.post("/v1/narration/prepare", {"id": nid, "text": text, "tts": {k: v for k, v in {"voice": tts.get("voice"), "lang": tts.get("lang"), "engine": tts.get("engine")}.items() if v}}, timeout=300)
        out = self.cache_dir / f"{nid}.wav"
        audio = synthesize(text, out, provider, tts.get("voice"), tts.get("lang", self.ctx.script.get("language", "it")), rate=tts.get("rate"), instructions=tts.get("instructions"), command=tts.get("command"))
        return self.ctx.rai.post("/v1/narration/prepare", {"id": nid, "text": text, "path": audio["path"]}, timeout=120)

    def is_ready(self, nid: str) -> bool:
        return nid not in self.events or self.events[nid].is_set()

    def get(self, nid: str, timeout_s: float = 600) -> Dict[str, Any]:
        if nid in self.events and not self.events[nid].wait(timeout_s):
            raise RuntimeError(f"narration {nid} not ready after {timeout_s}s")
        if nid in self.errors:
            raise RuntimeError(f"narration {nid} failed: {self.errors[nid]}")
        return self.ready[nid]


def play(ctx: RunContext, preparer: NarrationPreparer, nid: str, wait_spoken: bool) -> int:
    """Inserts the prepared narration now; pauses the recording while it is not ready."""
    paused = False
    if not preparer.is_ready(nid) and ctx.rai and ctx.recording and not ctx.dry_run:
        ctx.say("pause: narration not ready yet", narration=nid)
        ctx.rai.post("/v1/recording/pause")
        paused = True
    prepared = preparer.get(nid)
    if paused and ctx.rai:
        ctx.rai.post("/v1/recording/resume")
        ctx.say("resume: narration ready", narration=nid)
    duration = int(prepared.get("durationMs") or 0)
    if ctx.rai and ctx.recording and not ctx.dry_run:
        ctx.rai.post(f"/v1/narration/{nid}/play", {"wordTiming": bool(ctx.script.get("tts", {}).get("word_timing"))}, timeout=120)
    ctx.say("narration", id=nid, durationMs=duration)
    if wait_spoken and not ctx.dry_run:
        time.sleep(duration / 1000)
    return duration


# ── Main flow ───────────────────────────────────────────────────────────────


def setup_recorder(ctx: RunContext) -> None:
    assert ctx.rai
    target = ctx.script.get("target", {})
    window = target.get("window") or {}
    if target.get("launch"):
        ctx.say("launching target", cmd=target["launch"])
        if not ctx.dry_run:
            subprocess.Popen(target["launch"], shell=True)
            time.sleep(target.get("settle_ms", 3000) / 1000)
    selector = {k: v for k, v in {"title": window.get("title"), "appName": window.get("app"), "displayIndex": target.get("display"), "type": "window" if window else ("screen" if "display" in target else None)}.items() if v is not None}
    if selector and not ctx.dry_run:
        ctx.say("select source", **selector)
        ctx.rai.post("/v1/sources/select", selector)
    if ctx.script.get("preset") and not ctx.dry_run:
        ctx.rai.post(f"/v1/presets/{ctx.script['preset']}/apply", {"default": True})
    if ctx.script.get("idle_ignore_rects") and not ctx.dry_run:
        ctx.rai.post("/v1/idle/ignore", {"rects": ctx.script["idle_ignore_rects"]})


def start_recording(ctx: RunContext) -> None:
    assert ctx.rai
    recorder = ctx.script.get("recorder", {})
    auto = recorder.get("auto_edit", {})
    body = {
        "microphone": recorder.get("microphone", False),
        "systemAudio": recorder.get("system_audio", False),
        "webcam": recorder.get("webcam", False),
        "countdownSeconds": recorder.get("countdown", 0),
        "autoEdit": {k: v for k, v in {"speedUpIdle": auto.get("speed_up_idle"), "targetSeconds": auto.get("target_seconds"), "maxSpeed": auto.get("max_speed"), "speedBadge": auto.get("speed_badge")}.items() if v is not None},
    }
    if recorder.get("idle_seconds"):
        body["idle"] = {"thresholdSeconds": recorder["idle_seconds"]}
    ctx.say("start recording")
    if not ctx.dry_run:
        ctx.rai.post("/v1/recording/start", body, timeout=180)


def run_step(ctx: RunContext, preparer: NarrationPreparer, step: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    sid = step["id"]
    ctx.say("step", id=sid, title=step.get("title"))
    step_start_ms = None
    if ctx.rai and ctx.recording and not ctx.dry_run:
        marker = ctx.rai.post("/v1/markers", {"label": step.get("chapter") or step.get("title") or sid, "kind": "chapter" if step.get("chapter") else "step"})
        step_start_ms = marker.get("atMs")

    if step.get("kind") == "agent":
        return {"handoff": True, "step": sid, "instruction": step.get("instruction"), "narration": step.get("narration")}

    timing = step.get("narration_timing", "before")
    nid = f"{sid}.narration" if step.get("narration") else None
    attempts = 1 + int((step.get("retry") or {}).get("max", 0))
    for attempt in range(1, attempts + 1):
        try:
            # A retake is cut together with its narration, so every attempt speaks again.
            if nid and timing in ("before", "with"):
                play(ctx, preparer, nid, wait_spoken=timing == "before")
            for action in step.get("actions", []):
                run_action(ctx, action)
            while_waiting = step.get("while_waiting") or {}
            if while_waiting.get("narration"):
                time.sleep(while_waiting.get("after_ms", 2500) / 1000 if not ctx.dry_run else 0)
                play(ctx, preparer, f"{sid}.while_waiting", wait_spoken=False)
            result = run_wait(ctx, step.get("wait"))
            if not result.get("met", True) and step.get("wait", {}).get("required", False):
                raise RuntimeError(f"wait not met: {result}")
            break
        except Exception as error:  # noqa: BLE001
            ctx.say("step failed", id=sid, attempt=attempt, error=str(error))
            if attempt >= attempts:
                raise
            cut = bool(ctx.rai and ctx.recording and step_start_ms is not None and not ctx.dry_run)
            if cut:
                # Cut the failed attempt (and the reset below) from the edit, then try again.
                ctx.rai.post("/v1/markers", {"label": f"retake {sid}", "kind": "discard-start", "atMs": step_start_ms})
            for action in (step.get("retry") or {}).get("reset_actions", []):
                run_action(ctx, action)
            if cut:
                ctx.rai.post("/v1/markers", {"label": f"retake {sid}", "kind": "discard-end"})
                step_start_ms = ctx.rai.post("/v1/markers", {"label": f"{sid} (retake)", "kind": "step"}).get("atMs")

    if nid and timing == "after":
        play(ctx, preparer, nid, wait_spoken=True)
    if step.get("hold_ms") and not ctx.dry_run:
        time.sleep(step["hold_ms"] / 1000)
    return None


def finish(ctx: RunContext) -> Dict[str, Any]:
    assert ctx.rai
    output = ctx.script.get("output", {})
    summary: Dict[str, Any] = {}
    ctx.say("stop recording")
    if ctx.dry_run:
        return {"dryRun": True}
    summary["stop"] = ctx.rai.post("/v1/recording/stop", {}, timeout=900)
    if output.get("captions_from_audio"):
        summary["captions"] = ctx.rai.post("/v1/captions/generate", {"language": ctx.script.get("language")}, timeout=3700)
    if output.get("project_name"):
        summary["project"] = ctx.rai.post("/v1/project/save", {"name": output["project_name"]})
    summary["chapters"] = ctx.rai.get("/v1/project/chapters", query={"format": "youtube"})
    if output.get("video"):
        summary["export"] = ctx.rai.post(
            "/v1/export",
            {"outputPath": str(Path(output["video"]).resolve()), "format": output.get("format", "mp4"), "quality": output.get("quality", "high"), "fps": output.get("fps"), "includeCaptionSidecar": output.get("subtitles", True), "wait": True, "timeoutSeconds": output.get("timeout_s", 3600)},
            timeout=output.get("timeout_s", 3600) + 60,
        )
    if output.get("quit"):
        summary["quit"] = ctx.rai.post("/v1/app/quit", {"force": False})
    return summary


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=["validate", "prepare", "run"])
    parser.add_argument("script")
    parser.add_argument("--from", dest="from_step", help="resume at this step id (after an agent hand-off)")
    parser.add_argument("--dry-run", action="store_true", help="log the plan without touching the desktop or recorder")
    parser.add_argument("--no-record", action="store_true", help="rehearse actions without recording")
    parser.add_argument("--no-finish", action="store_true", help="do not stop/export at the end")
    parser.add_argument("--exe", help="Recordly AI executable for --server launch")
    args = parser.parse_args()

    script_path = Path(args.script).resolve()
    script = load_script(script_path)
    problems = validate(script)
    if problems:
        print(json.dumps({"valid": False, "problems": problems}, indent=2), file=sys.stderr)
        return 2
    if args.command == "validate":
        print(json.dumps({"valid": True, "steps": len(script["steps"])}))
        return 0

    rai = None
    if not args.dry_run and not args.no_record:
        launch(args.exe, False, None, 180)
        rai = RecordlyAI.discover()
    ctx = RunContext(rai=rai, script=script, dry_run=args.dry_run, recording=not args.no_record)
    steps = script["steps"]
    if args.from_step:
        ids = [step["id"] for step in steps]
        if args.from_step not in ids:
            raise SystemExit(f"unknown step {args.from_step}")
        steps = steps[ids.index(args.from_step):]

    cache_dir = script_path.parent / ".narration-cache"
    cache_dir.mkdir(exist_ok=True)
    preparer = NarrationPreparer(ctx, cache_dir)
    preparer.start(steps)
    if args.command == "prepare":
        for nid in list(preparer.events):
            try:
                ctx.say("prepared", **preparer.get(nid))
            except RuntimeError as error:
                ctx.say("prepare failed", id=nid, error=str(error))
        return 1 if preparer.errors else 0

    resumed = bool(args.from_step)
    if not resumed and ctx.rai:
        setup_recorder(ctx)
        if ctx.recording:
            # Give the worker a head start on the first narration before the first frame.
            first = next((f"{s['id']}.narration" for s in steps if s.get("narration")), None)
            if first:
                preparer.get(first)
            start_recording(ctx)
    elif resumed and ctx.rai and ctx.recording:
        status = ctx.rai.get("/v1/recording")["status"]
        if status.get("paused"):
            ctx.rai.post("/v1/recording/resume")

    for step in steps:
        handoff = run_step(ctx, preparer, step)
        if handoff:
            next_index = steps.index(step) + 1
            handoff["resume_with"] = f"--from {steps[next_index]['id']}" if next_index < len(steps) else "--from <none: call recordly_ai.py stop/export>"
            print(json.dumps({"agent_step": handoff}, ensure_ascii=False), flush=True)
            return EXIT_AGENT_STEP

    if ctx.recording and not args.no_finish and ctx.rai:
        print(json.dumps({"done": True, "summary": finish(ctx)}, ensure_ascii=False, indent=2))
    else:
        print(json.dumps({"done": True}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
