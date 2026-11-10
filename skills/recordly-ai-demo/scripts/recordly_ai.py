#!/usr/bin/env python3
"""Recordly AI REST client and CLI (Python 3.9+, standard library only).

Every command prints JSON on stdout; errors go to stderr with exit code 1.
Use it from any agent shell (Claude Code, Codex, Gemini CLI, Hermes) or import it:

    from recordly_ai import RecordlyAI
    rai = RecordlyAI.discover()
    rai.post("/v1/markers", {"label": "Step 1", "kind": "chapter"})

Discovery order: RECORDLY_AI_URL + RECORDLY_AI_TOKEN env vars, then the server.json and
token files that Recordly AI writes in <userData>/automation/ (RECORDLY_AI_DATA_DIR
overrides the userData folder; "Recordly-dev" is tried for `npm run dev`).
The executable is found via RECORDLY_AI_EXE, then <userData>/automation/app.json (written by
the app on every start, so custom install folders work), then the default install folders.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

DEFAULT_PORT = 47800


class RecordlyError(RuntimeError):
    def __init__(self, status: int, code: str, message: str, details: Any = None):
        super().__init__(f"[{status} {code}] {message}")
        self.status = status
        self.code = code
        self.details = details


def _user_data_candidates() -> List[Path]:
    override = os.environ.get("RECORDLY_AI_DATA_DIR")
    if override:
        return [Path(override)]
    if sys.platform == "win32":
        base = Path(os.environ.get("APPDATA", Path.home() / "AppData" / "Roaming"))
    elif sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support"
    else:
        base = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config"))
    return [base / "Recordly AI", base / "Recordly-dev"]


def read_server_info() -> Optional[Dict[str, Any]]:
    """Newest server.json among the candidate userData folders."""
    found = []
    for folder in _user_data_candidates():
        info_path = folder / "automation" / "server.json"
        try:
            info = json.loads(info_path.read_text(encoding="utf-8"))
            info["_dataDir"] = str(folder)
            found.append((info_path.stat().st_mtime, info))
        except (OSError, ValueError):
            continue
    if not found:
        return None
    found.sort(key=lambda item: item[0], reverse=True)
    return found[0][1]


def _read_token(info: Optional[Dict[str, Any]]) -> Optional[str]:
    if os.environ.get("RECORDLY_AI_TOKEN"):
        return os.environ["RECORDLY_AI_TOKEN"].strip()
    paths = []
    if info and info.get("tokenFile"):
        paths.append(Path(info["tokenFile"]))
    paths += [folder / "automation" / "token" for folder in _user_data_candidates()]
    for token_path in paths:
        try:
            token = token_path.read_text(encoding="utf-8").strip()
            if token:
                return token
        except OSError:
            continue
    return None


class RecordlyAI:
    def __init__(self, base_url: str, token: Optional[str], timeout: float = 120.0):
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.timeout = timeout

    @classmethod
    def discover(cls, timeout: float = 120.0) -> "RecordlyAI":
        info = read_server_info()
        url = os.environ.get("RECORDLY_AI_URL") or (info or {}).get("baseUrl")
        if not url:
            url = f"http://127.0.0.1:{DEFAULT_PORT}"
        return cls(url, _read_token(info), timeout)

    # ── HTTP ────────────────────────────────────────────────────────────────

    def request(
        self,
        method: str,
        path: str,
        body: Any = None,
        *,
        query: Optional[Dict[str, Any]] = None,
        raw: Optional[bytes] = None,
        content_type: Optional[str] = None,
        timeout: Optional[float] = None,
        expect_json: bool = True,
    ) -> Any:
        url = self.base_url + path
        if query:
            clean = {k: v for k, v in query.items() if v is not None}
            if clean:
                url += "?" + urllib.parse.urlencode(clean)
        data = None
        headers = {"Accept": "application/json"}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        if raw is not None:
            data = raw
            headers["Content-Type"] = content_type or "application/octet-stream"
        elif body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(url, data=data, method=method.upper(), headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=timeout or self.timeout) as response:
                payload = response.read()
                if not expect_json:
                    return payload
                return json.loads(payload.decode("utf-8")) if payload else None
        except urllib.error.HTTPError as error:
            text = error.read().decode("utf-8", "replace")
            try:
                detail = json.loads(text).get("error", {})
            except ValueError:
                detail = {}
            raise RecordlyError(
                error.code,
                detail.get("code", "http_error"),
                detail.get("message", text[:300]),
                detail.get("details"),
            ) from None
        except urllib.error.URLError as error:
            raise RecordlyError(0, "unreachable", f"Recordly AI is not reachable at {self.base_url}: {error.reason}") from None

    def get(self, path: str, **kwargs: Any) -> Any:
        return self.request("GET", path, **kwargs)

    def post(self, path: str, body: Any = None, **kwargs: Any) -> Any:
        return self.request("POST", path, body if body is not None else {}, **kwargs)

    def patch(self, path: str, body: Any, **kwargs: Any) -> Any:
        return self.request("PATCH", path, body, **kwargs)

    def put(self, path: str, body: Any, **kwargs: Any) -> Any:
        return self.request("PUT", path, body, **kwargs)

    def delete(self, path: str, **kwargs: Any) -> Any:
        return self.request("DELETE", path, **kwargs)

    # ── Helpers ─────────────────────────────────────────────────────────────

    def health(self, wait_seconds: int = 0) -> Dict[str, Any]:
        return self.get("/v1/health", query={"wait": wait_seconds or None}, timeout=wait_seconds + 30)

    def wait_event(self, types: Iterable[str], timeout_s: float, after: Optional[int] = None) -> Optional[Dict[str, Any]]:
        """Blocks until an event of `types` arrives (long-poll, resumes across chunks)."""
        deadline = time.time() + timeout_s
        cursor = after
        if cursor is None:
            cursor = self.get("/v1/info").get("lastEventSeq", 0)
        while True:
            remaining = deadline - time.time()
            if remaining <= 0:
                return None
            chunk = int(min(60, max(1, remaining)))
            result = self.get(
                "/v1/events/next",
                query={"types": ",".join(types), "after": cursor, "timeout": chunk},
                timeout=chunk + 30,
            )
            if result.get("event"):
                return result["event"]
            cursor = result.get("lastSeq", cursor)

    def narrate(self, text: Optional[str], **options: Any) -> Dict[str, Any]:
        body = {k: v for k, v in options.items() if v is not None}
        if text:
            body["text"] = text
        return self.post("/v1/narration", body, timeout=300)


# ── Launch ──────────────────────────────────────────────────────────────────


def _default_executables() -> List[Path]:
    if os.environ.get("RECORDLY_AI_EXE"):
        return [Path(os.environ["RECORDLY_AI_EXE"])]
    found: List[Path] = []
    for folder in _user_data_candidates():
        try:
            info = json.loads((folder / "automation" / "app.json").read_text(encoding="utf-8"))
            if info.get("executable"):
                found.append(Path(info["executable"]))
        except (OSError, ValueError):
            continue
    if sys.platform == "win32":
        local = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
        program_files = Path(os.environ.get("ProgramFiles", r"C:\Program Files"))
        found += [
            program_files / "Recordly AI" / "RecordlyAI.exe",
            local / "Programs" / "Recordly AI" / "RecordlyAI.exe",
        ]
    elif sys.platform == "darwin":
        found.append(Path("/Applications/Recordly AI.app/Contents/MacOS/Recordly AI"))
    else:
        found += [Path("/opt/Recordly AI/recordly"), Path("/usr/bin/recordly")]
    return found


def launch(exe: Optional[str], show: bool, port: Optional[int], timeout_s: float) -> Dict[str, Any]:
    """Starts Recordly AI in --server mode unless it already runs, then waits until ready.

    The app needs several seconds to load (the HUD renderer hosts the recorder): we poll
    the discovery file and /v1/health?wait instead of sleeping blindly.
    """
    client = RecordlyAI.discover()
    try:
        health = client.health(wait_seconds=5)
        if health.get("ready"):
            return {"launched": False, "baseUrl": client.base_url, "health": health}
    except RecordlyError:
        pass

    candidates = [Path(exe)] if exe else _default_executables()
    executable = next((path for path in candidates if path.exists()), None)
    if not executable:
        raise RecordlyError(0, "not_installed", "Recordly AI executable not found; pass --exe or set RECORDLY_AI_EXE.")
    args = [str(executable), "--server"]
    if show:
        args.append("--show")
    if port:
        args += ["--port", str(port)]
    flags = 0
    if sys.platform == "win32":
        flags = getattr(subprocess, "DETACHED_PROCESS", 0) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=flags, close_fds=True)

    deadline = time.time() + timeout_s
    last_error: Optional[str] = None
    while time.time() < deadline:
        time.sleep(1.0)
        client = RecordlyAI.discover()
        try:
            health = client.health(wait_seconds=10)
            if health.get("ready"):
                return {"launched": True, "baseUrl": client.base_url, "health": health}
        except RecordlyError as error:
            last_error = str(error)
    raise RecordlyError(0, "launch_timeout", f"Recordly AI did not become ready in {timeout_s}s ({last_error}).")


# ── CLI ─────────────────────────────────────────────────────────────────────


def _rect(value: Optional[str]) -> Optional[Dict[str, float]]:
    if not value:
        return None
    parts = [float(part) for part in value.replace(" ", "").split(",")]
    if len(parts) != 4:
        raise argparse.ArgumentTypeError("rectangles are x,y,width,height")
    return {"x": parts[0], "y": parts[1], "width": parts[2], "height": parts[3]}


def _coerce(value: str) -> Any:
    lowered = value.lower()
    if lowered in ("true", "false"):
        return lowered == "true"
    if lowered == "null":
        return None
    try:
        return int(value)
    except ValueError:
        try:
            return float(value)
        except ValueError:
            return value


def _pairs(items: Optional[List[str]]) -> Dict[str, Any]:
    result: Dict[str, Any] = {}
    for item in items or []:
        key, _, value = item.partition("=")
        result[key.strip()] = _coerce(value.strip())
    return result


def _out(value: Any) -> None:
    print(json.dumps(value, ensure_ascii=False, indent=2))


def _audio_body(args: argparse.Namespace) -> Dict[str, Any]:
    body: Dict[str, Any] = {}
    if getattr(args, "audio", None):
        body["path"] = str(Path(args.audio).resolve())
    if getattr(args, "tts", False):
        tts = {k: v for k, v in {"voice": args.voice, "lang": args.lang, "engine": args.engine}.items() if v}
        body["tts"] = tts or True
    return body


def _sleep_until_spoken(result: Dict[str, Any]) -> None:
    duration = result.get("durationMs") or 0
    if duration:
        time.sleep(duration / 1000.0)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="recordly_ai.py", description="Control Recordly AI over its local REST API.")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("launch", help="start Recordly AI in --server mode (idempotent) and wait until ready")
    p.add_argument("--exe")
    p.add_argument("--show", action="store_true", help="keep windows visible (debug/supervision)")
    p.add_argument("--port", type=int)
    p.add_argument("--timeout", type=float, default=180)

    for name in ("health", "info", "status", "editor", "openapi"):
        sub.add_parser(name)

    p = sub.add_parser("sources", help="list screens/windows")
    p.add_argument("--q", help="title regex filter")
    p.add_argument("--types", default="screen,window")

    p = sub.add_parser("select", help="select the source to record")
    p.add_argument("--title")
    p.add_argument("--app")
    p.add_argument("--id")
    p.add_argument("--display", type=int)
    p.add_argument("--type", choices=["screen", "window"])
    p.add_argument("--no-front", action="store_true")

    p = sub.add_parser("settings", help="show or change settings")
    p.add_argument("--set", nargs="*", metavar="KEY=VALUE", help="automation settings")
    p.add_argument("--recording", nargs="*", metavar="KEY=VALUE", help="microphone/systemAudio/webcam/countdownSeconds")

    p = sub.add_parser("presets", help="list | apply ID | save NAME | rename ID NAME | delete ID")
    p.add_argument("action", choices=["list", "apply", "save", "rename", "delete", "current"])
    p.add_argument("values", nargs="*")
    p.add_argument("--default", action="store_true", help="use for automated edits")

    p = sub.add_parser("start", help="start recording")
    p.add_argument("--title", help="select a window by title regex first")
    p.add_argument("--app")
    p.add_argument("--display", type=int)
    p.add_argument("--mic", action="store_true")
    p.add_argument("--system-audio", action="store_true")
    p.add_argument("--webcam", action="store_true")
    p.add_argument("--countdown", type=int, default=0)
    p.add_argument("--no-speedup", action="store_true", help="do not accelerate idle waits")
    p.add_argument("--target-seconds", type=float)
    p.add_argument("--max-speed", type=float)
    p.add_argument("--no-badge", action="store_true")
    p.add_argument("--preset")
    p.add_argument("--idle-seconds", type=float, help="still-screen threshold (default from settings)")

    for name in ("pause", "resume", "cancel"):
        sub.add_parser(name)
    p = sub.add_parser("stop", help="stop recording and open the editor")
    p.add_argument("--no-wait-editor", action="store_true")

    p = sub.add_parser("caption", help="add a subtitle at recording 'now'")
    p.add_argument("text")
    p.add_argument("--at", type=int)
    p.add_argument("--offset", type=int)
    p.add_argument("--duration", type=int)

    p = sub.add_parser("audio", help="insert an audio file at recording 'now'")
    p.add_argument("file")
    p.add_argument("--at", type=int)
    p.add_argument("--offset", type=int)
    p.add_argument("--volume", type=float)
    p.add_argument("--track", type=int)

    for name in ("narrate", "prepare"):
        p = sub.add_parser(name, help="subtitle + voice" if name == "narrate" else "pre-render a narration by id")
        if name == "prepare":
            p.add_argument("id")
        p.add_argument("text")
        p.add_argument("--audio", help="audio file produced by your own TTS")
        p.add_argument("--tts", action="store_true", help="let Recordly AI synthesize via CallAPICall")
        p.add_argument("--voice")
        p.add_argument("--lang")
        p.add_argument("--engine")
        if name == "narrate":
            p.add_argument("--at", type=int)
            p.add_argument("--offset", type=int)
            p.add_argument("--volume", type=float)
            p.add_argument("--no-captions", action="store_true")
            p.add_argument("--word-timing", action="store_true")
            p.add_argument("--wait", action="store_true", help="sleep until the narration has been spoken")

    p = sub.add_parser("play", help="insert a prepared narration now")
    p.add_argument("id")
    p.add_argument("--offset", type=int)
    p.add_argument("--no-captions", action="store_true")
    p.add_argument("--word-timing", action="store_true")
    p.add_argument("--wait", action="store_true")
    sub.add_parser("prepared")

    p = sub.add_parser("marker", help="step/chapter/note or discard-start/discard-end")
    p.add_argument("label")
    p.add_argument("--kind", default="step", choices=["step", "chapter", "note", "discard-start", "discard-end"])
    p.add_argument("--at", type=int)

    for name in ("zoom", "blur", "callout"):
        p = sub.add_parser(name)
        if name == "callout":
            p.add_argument("text")
        p.add_argument("--rect", type=_rect, help="normalized x,y,w,h of the recorded source")
        p.add_argument("--screen-rect", type=_rect, help="screen pixels x,y,w,h (e.g. UIA BoundingRectangle)")
        p.add_argument("--dip", action="store_true", help="screen-rect is in DIP instead of physical pixels")
        p.add_argument("--duration", type=int)
        p.add_argument("--padding", type=float)

    for name in ("wait-stable", "wait-changed"):
        p = sub.add_parser(name, help="block until the recorded source is still / changes")
        p.add_argument("--for", dest="for_ms", type=int, default=2000)
        p.add_argument("--timeout", type=int, default=120_000, help="ms")
        p.add_argument("--threshold", type=float)
        p.add_argument("--ignore", type=_rect, action="append", help="normalized rect to ignore (spinners, clocks)")

    p = sub.add_parser("wait-event", help="block until one of TYPES (comma list, wildcards like idle.*)")
    p.add_argument("types")
    p.add_argument("--timeout", type=float, default=600, help="seconds")
    p.add_argument("--after", type=int)
    p = sub.add_parser("wait-idle-end", help="block until the screen changes after an idle period")
    p.add_argument("--timeout", type=float, default=1800)
    p = sub.add_parser("idle-ignore", help="mask regions from idle detection")
    p.add_argument("--rect", type=_rect, action="append", default=[])

    p = sub.add_parser("events", help="print events (history or --follow SSE)")
    p.add_argument("--after", type=int, default=0)
    p.add_argument("--types")
    p.add_argument("--follow", action="store_true")

    p = sub.add_parser("screenshot", help="PNG of the selected source")
    p.add_argument("out")
    p.add_argument("--max-width", type=int, default=1280)

    p = sub.add_parser("open", help="open a video or project in the editor")
    p.add_argument("--video")
    p.add_argument("--project")
    p = sub.add_parser("auto-edit", help="accelerate idle waits now")
    p.add_argument("--target-ms", type=int)
    p.add_argument("--max-speed", type=float)
    p.add_argument("--force", action="store_true")
    sub.add_parser("apply-journal")
    p = sub.add_parser("project-get")
    p.add_argument("--out")
    p = sub.add_parser("project-put")
    p.add_argument("file")
    p = sub.add_parser("save")
    p.add_argument("--name")
    p.add_argument("--copy-to")
    p = sub.add_parser("chapters")
    p.add_argument("--youtube", action="store_true")
    p = sub.add_parser("captions-generate", help="transcribe the recording (bridge or local Whisper)")
    p.add_argument("--lang")
    p = sub.add_parser("export")
    p.add_argument("--out")
    p.add_argument("--format", choices=["mp4", "gif"], default="mp4")
    p.add_argument("--quality", choices=["medium", "good", "high", "source"])
    p.add_argument("--encoding", choices=["fast", "balanced", "quality"])
    p.add_argument("--fps", type=int, choices=[24, 30, 60])
    p.add_argument("--sidecar", action="store_true", help="also write .srt/.vtt")
    p.add_argument("--no-wait", action="store_true")
    p.add_argument("--timeout", type=int, default=3600)
    p = sub.add_parser("quit")
    p.add_argument("--force", action="store_true")

    p = sub.add_parser("call", help="raw request: METHOD PATH [JSON]")
    p.add_argument("method")
    p.add_argument("path")
    p.add_argument("json", nargs="?")
    return parser


def run(args: argparse.Namespace) -> Any:
    if args.cmd == "launch":
        return launch(args.exe, args.show, args.port, args.timeout)
    rai = RecordlyAI.discover()
    c = args.cmd
    if c == "health":
        return rai.health()
    if c == "info":
        return rai.get("/v1/info")
    if c == "status":
        return rai.get("/v1/recording")
    if c == "editor":
        return rai.get("/v1/editor")
    if c == "openapi":
        return rai.get("/v1/openapi.json")
    if c == "sources":
        return rai.get("/v1/sources", query={"q": args.q, "types": args.types})
    if c == "select":
        body = {"title": args.title, "appName": args.app, "id": args.id, "displayIndex": args.display, "type": args.type, "bringToFront": not args.no_front}
        return rai.post("/v1/sources/select", {k: v for k, v in body.items() if v is not None})
    if c == "settings":
        automation, recording = _pairs(args.set), _pairs(args.recording)
        if automation or recording:
            return rai.patch("/v1/settings", {"automation": automation, "recording": recording})
        return rai.get("/v1/settings")
    if c == "presets":
        values = args.values
        if args.action == "list":
            return rai.get("/v1/presets")
        if args.action == "current":
            return rai.get("/v1/presets/current")
        if args.action == "apply":
            return rai.post(f"/v1/presets/{urllib.parse.quote(values[0])}/apply", {"default": True} if args.default else {})
        if args.action == "save":
            return rai.post("/v1/presets", {"name": " ".join(values), "makeDefault": args.default})
        if args.action == "rename":
            return rai.patch(f"/v1/presets/{urllib.parse.quote(values[0])}", {"name": " ".join(values[1:])})
        return rai.delete(f"/v1/presets/{urllib.parse.quote(values[0])}")
    if c == "start":
        body: Dict[str, Any] = {"microphone": args.mic, "systemAudio": args.system_audio, "webcam": args.webcam, "countdownSeconds": args.countdown}
        source = {k: v for k, v in {"title": args.title, "appName": args.app, "displayIndex": args.display}.items() if v is not None}
        if source:
            if args.title or args.app:
                source["type"] = "window"
            body["source"] = source
        auto = {k: v for k, v in {"speedUpIdle": False if args.no_speedup else None, "targetSeconds": args.target_seconds, "maxSpeed": args.max_speed, "speedBadge": False if args.no_badge else None}.items() if v is not None}
        if auto:
            body["autoEdit"] = auto
        if args.preset:
            body["presetId"] = args.preset
        if args.idle_seconds:
            body["idle"] = {"thresholdSeconds": args.idle_seconds}
        return rai.post("/v1/recording/start", body, timeout=180)
    if c in ("pause", "resume", "cancel"):
        return rai.post(f"/v1/recording/{c}")
    if c == "stop":
        return rai.post("/v1/recording/stop", {"waitForEditor": not args.no_wait_editor}, timeout=900)
    if c == "caption":
        return rai.post("/v1/captions", {k: v for k, v in {"text": args.text, "atMs": args.at, "offsetMs": args.offset, "durationMs": args.duration}.items() if v is not None})
    if c == "audio":
        return rai.post("/v1/audio", {k: v for k, v in {"path": str(Path(args.file).resolve()), "atMs": args.at, "offsetMs": args.offset, "volume": args.volume, "trackIndex": args.track}.items() if v is not None})
    if c == "narrate":
        body = _audio_body(args)
        body.update({k: v for k, v in {"atMs": args.at, "offsetMs": args.offset, "volume": args.volume, "wordTiming": args.word_timing or None, "captions": False if args.no_captions else None}.items() if v is not None})
        result = rai.narrate(args.text, **body)
        if args.wait:
            _sleep_until_spoken(result)
        return result
    if c == "prepare":
        body = _audio_body(args)
        body.update({"id": args.id, "text": args.text})
        if "path" not in body:
            body.setdefault("tts", True)
        return rai.post("/v1/narration/prepare", body, timeout=300)
    if c == "prepared":
        return rai.get("/v1/narration/prepared")
    if c == "play":
        body = {k: v for k, v in {"offsetMs": args.offset, "captions": False if args.no_captions else None, "wordTiming": args.word_timing or None}.items() if v is not None}
        result = rai.post(f"/v1/narration/{urllib.parse.quote(args.id)}/play", body, timeout=120)
        if args.wait:
            _sleep_until_spoken(result)
        return result
    if c == "marker":
        return rai.post("/v1/markers", {k: v for k, v in {"label": args.label, "kind": args.kind, "atMs": args.at}.items() if v is not None})
    if c in ("zoom", "blur", "callout"):
        body = {k: v for k, v in {"rect": args.rect, "screenRect": args.screen_rect, "durationMs": args.duration, "padding": args.padding, "coordinateSpace": "dip" if args.dip else None}.items() if v is not None}
        if c == "zoom":
            return rai.post("/v1/zoom", body)
        body["type"] = "blur" if c == "blur" else "text"
        if c == "callout":
            body["text"] = args.text
        return rai.post("/v1/annotations", body)
    if c in ("wait-stable", "wait-changed"):
        body = {"condition": "stable" if c == "wait-stable" else "changed", "forMs": args.for_ms, "timeoutMs": args.timeout, "threshold": args.threshold, "ignoreRects": args.ignore or None}
        return rai.post("/v1/wait", {k: v for k, v in body.items() if v is not None}, timeout=args.timeout / 1000 + 30)
    if c == "wait-event":
        event = rai.wait_event([t.strip() for t in args.types.split(",") if t.strip()], args.timeout, args.after)
        return {"event": event, "timedOut": event is None}
    if c == "wait-idle-end":
        event = rai.wait_event(["idle.ended"], args.timeout)
        return {"event": event, "timedOut": event is None}
    if c == "idle-ignore":
        return rai.post("/v1/idle/ignore", {"rects": args.rect})
    if c == "events":
        if not args.follow:
            return rai.get("/v1/events/history", query={"after": args.after, "types": args.types})
        _follow_events(rai, args.after, args.types)
        return None
    if c == "screenshot":
        png = rai.get("/v1/screenshot", query={"maxWidth": args.max_width}, expect_json=False)
        Path(args.out).write_bytes(png)
        return {"path": str(Path(args.out).resolve()), "bytes": len(png)}
    if c == "open":
        body = {"videoPath": str(Path(args.video).resolve()) if args.video else None, "projectPath": str(Path(args.project).resolve()) if args.project else None}
        return rai.post("/v1/editor/open", {k: v for k, v in body.items() if v}, timeout=180)
    if c == "auto-edit":
        return rai.post("/v1/editor/auto-edit", {k: v for k, v in {"targetMs": args.target_ms, "maxSpeed": args.max_speed, "force": args.force or None}.items() if v is not None})
    if c == "apply-journal":
        return rai.post("/v1/editor/apply-journal")
    if c == "project-get":
        project = rai.get("/v1/project")
        if args.out:
            Path(args.out).write_text(json.dumps(project, indent=2, ensure_ascii=False), encoding="utf-8")
            return {"path": args.out}
        return project
    if c == "project-put":
        data = json.loads(Path(args.file).read_text(encoding="utf-8"))
        return rai.put("/v1/project", {"project": data.get("project", data)})
    if c == "save":
        return rai.post("/v1/project/save", {k: v for k, v in {"name": args.name, "copyTo": args.copy_to}.items() if v})
    if c == "chapters":
        return rai.get("/v1/project/chapters", query={"format": "youtube" if args.youtube else None})
    if c == "captions-generate":
        return rai.post("/v1/captions/generate", {"language": args.lang} if args.lang else {}, timeout=3700)
    if c == "export":
        body = {"format": args.format, "quality": args.quality, "encodingMode": args.encoding, "fps": args.fps, "includeCaptionSidecar": args.sidecar or None, "outputPath": str(Path(args.out).resolve()) if args.out else None, "wait": not args.no_wait, "timeoutSeconds": args.timeout}
        return rai.post("/v1/export", {k: v for k, v in body.items() if v is not None}, timeout=args.timeout + 60)
    if c == "quit":
        return rai.post("/v1/app/quit", {"force": args.force})
    if c == "call":
        body = json.loads(args.json) if args.json else None
        return rai.request(args.method, args.path, body)
    raise SystemExit(f"unknown command {c}")


def _follow_events(rai: RecordlyAI, after: int, types: Optional[str]) -> None:
    cursor = after
    while True:
        result = rai.get("/v1/events/next", query={"after": cursor, "types": types, "timeout": 60}, timeout=90)
        if result.get("event"):
            event = result["event"]
            cursor = event["seq"]
            print(json.dumps(event, ensure_ascii=False), flush=True)
        else:
            cursor = result.get("lastSeq", cursor)


def main(argv: Optional[List[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        result = run(args)
        if result is not None:
            _out(result)
        return 0
    except RecordlyError as error:
        print(json.dumps({"error": {"status": error.status, "code": error.code, "message": str(error), "details": error.details}}, ensure_ascii=False), file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
