---
name: recordly-ai-demo
description: Plan, record, narrate, subtitle, edit and export a polished software demo video with Recordly AI, driving the target app with computer-use tools while Recordly AI records through its local REST API. Use when the user wants a demo, tutorial, walkthrough, product video, bug-repro video, release video or localized video of an application or website — especially AI image/video generation apps with long waits, which Recordly AI detects and speeds up automatically. Also use to control Recordly AI (start/pause/stop recording, captions, narration audio, presets, export) from an agent.
license: AGPL-3.0
compatibility: Windows 10/11 (primary), macOS, Linux. Needs Recordly AI installed (or its dev build), Python 3.9+, a desktop session. Optional - pywinauto, PyYAML, a TTS engine, CallAPICall bridge for local TTS/STT.
platforms: [windows, macos, linux]
metadata:
  author: Recordly AI
  version: "1.0.0"
  category: media
---

# Recordly AI demo producer

You are the director, the operator and the narrator of a screen-recorded demo.
Recordly AI records and edits; you drive the app under test with your computer-use tools
and tell Recordly AI what to say and show, step by step, over a local REST API.

Install: `python scripts/install.py -g --deps` (all agents of this user + PyYAML/pywinauto).
All paths below are relative to this file's folder. Run scripts with the Python of this
machine, e.g. `python scripts/recordly_ai.py health` (Claude Code also exposes this folder as
`${CLAUDE_SKILL_DIR}`). Every script prints JSON; errors go to stderr with exit code 1.

## Golden rules

1. **Never start recording before the user approved the demo script** (Phase 2). Talk to the
   user in their language; ask in several short rounds rather than one long questionnaire.
2. **Rehearse before you record.** Run every step once without recording (Phase 1); timings
   and selectors from a real run beat guesses.
3. **Pre-render all narration before recording** (Phase 3). During the take you only press
   play; if a narration is not ready, pause the recording instead of leaving dead air.
4. **Let Recordly AI handle long waits.** For AI generations wait for `idle.ended` (the screen
   changed again) instead of sleeping. Idle periods are accelerated in the edit; narration and
   subtitles are never accelerated, so you may fill a wait with commentary.
5. **Keep the recorded window clean**: close notifications, use a dedicated browser profile,
   never type passwords on camera, blur secrets (`blur --screen-rect`).
6. **Deterministic first, agent second.** Put repeatable steps in a demo script run by
   `scripts/demo_runner.py`; reserve `kind: agent` steps for parts that need judgment.

## Phase 0 — Interview (multi-turn)

Ask, at most 3–4 questions per turn, and summarize what you understood before moving on.
See `references/style-interview.md` for the full checklist. Minimum to settle:
- **Goal & audience**: what the viewer should be able to do or believe afterwards; expertise.
- **Language(s)** of narration and subtitles; a localized multi-language set?
- **Tone & style** (the user's style description wins): pace, formality, humor, call to action.
- **Length** target and **format**: 16:9 MP4, vertical short, GIF; subtitles burned or `.srt`.
- **Voice**: the agent's own TTS, a named provider/voice, CallAPICall (`--tts`), or none.
- **What to show**: app, account/data to use, steps that must appear, things to hide.

## Phase 1 — Reconnaissance (no recording)

1. Start the target app; explore it with your computer-use tools (see
   `references/computer-use.md` for Claude Code, Codex, Gemini CLI and Hermes setups).
2. Record UIA selectors (window title regex, control name/type/automation id) and screen
   rectangles for important elements: they become `click`/`zoom_on` actions.
3. Measure slow operations once (AI generation time, page loads). Note visual noise during
   waits (spinners, progress counters, clocks) → `idle_ignore_rects` so idle is detected.
4. Optional dry run: `python scripts/demo_runner.py run demo.yaml --no-record`.

## Phase 2 — Demo script (user approval required)

Write `demo.yaml` from `templates/demo-script.example.yaml` (schema:
`references/demo-script.md`; ready-made pipelines in `templates/pipelines/`). For each step:
id, title/chapter, narration text in the agreed style, actions, wait condition, optional
`while_waiting` narration, `retry`. Show the user the outline + every narration line, iterate,
then `python scripts/demo_runner.py validate demo.yaml`.

Narration writing tips: one idea per step, ≤ 2 sentences, say *why* before *what*, match
the on-screen action ("Clicco Genera…" while clicking), avoid reading the UI verbatim.

## Phase 3 — Pre-production

- `python scripts/demo_runner.py prepare demo.yaml` renders every narration with the chosen
  TTS (`tts.provider`: bridge | edge | kokoro | piper | openai | elevenlabs | command) and
  registers it in Recordly AI as a prepared clip with its exact duration.
- Using your own TTS tool instead: write the audio file, then
  `python scripts/recordly_ai.py prepare <id> "<text>" --audio <file>`.

## Phase 4 — Launch Recordly AI

```
python scripts/recordly_ai.py launch            # idempotent; waits until ready (can take 10-60 s)
python scripts/recordly_ai.py select --title "My App"   # or --app chrome / --display 0
python scripts/recordly_ai.py settings --set idleThresholdSeconds=6 idleTargetSeconds=10
python scripts/recordly_ai.py presets list       # apply one: presets apply <id> --default
```
`launch` starts `RecordlyAI.exe --server` (hidden, REST only) or reuses a running instance;
it finds the executable via `RECORDLY_AI_EXE`, the app's own `automation/app.json`, or the
default folder `C:\Program Files\Recordly AI\`.
Never assume it is ready: `launch` / `health` already wait on `GET /v1/health?wait=…`.

## Phase 5 — Record

Preferred: `python scripts/demo_runner.py run demo.yaml`. It marks chapters, plays prepared
narration, runs actions, waits, pauses when the next narration is not ready, discards and
retries failed steps, and hands off `kind: agent` steps (exit code 10 + JSON with the
instruction and `resume_with`). After doing an agent step yourself, run it again with
`--from <next step id>`.

Manual control (agent-driven takes) — the same primitives:
```
recordly_ai.py start --countdown 0                 # session starts, journal opens
recordly_ai.py marker "Generare un'immagine" --kind chapter
recordly_ai.py play step3.narration --wait         # prepared voice + subtitles, waits until spoken
recordly_ai.py zoom --screen-rect 812,440,220,48 --duration 2500   # UIA rect of the button
<click the button with your computer-use tool>
recordly_ai.py wait-changed --timeout 15000        # generation started
recordly_ai.py wait-idle-end --timeout 900         # long AI generation: blocks until the result appears
recordly_ai.py pause / resume                      # whenever you are not ready for the next step
recordly_ai.py marker "retake" --kind discard-start --at <ms> ; ... --kind discard-end   # cut a failed try
recordly_ai.py stop                                # saves, opens the editor, merges everything
```
While waiting for `idle.ended`, prepare the next steps (texts, audio, selectors) so they are
ready the moment the screen changes; use `wait-stable --for 1500` after UI transitions instead
of fixed sleeps.

## Phase 6 — Post-production

1. `recordly_ai.py editor` → counts of clips/captions/audio; idle speed-ups were applied on stop.
2. Review: `recordly_ai.py chapters --youtube`, `recordly_ai.py project-get --out p.json`
   (full project JSON; edit and `project-put p.json` for precise fixes), screenshots of
   key moments if your tools allow.
3. Ask the user for feedback on a short summary (duration, chapters, speed-ups); apply it.
4. `recordly_ai.py save --name "<project name>"`
5. `recordly_ai.py export --out "<video>.mp4" --quality high --sidecar`
6. `recordly_ai.py quit` (refuses with unsaved changes unless `--force`).

## Phase 7 — Deliver

Give the user: video path, `.srt/.vtt`, YouTube chapters text, the demo script (reusable
pipeline), and notes on what to tweak next time. Offer the localized variant
(`templates/pipelines/localize.yaml`) or a written how-to built from the chapters.

## Key facts about Recordly AI

- Times in REST calls are **recording time** in ms (pauses excluded); omit `atMs` to mean
  "now". Content sent while paused lands where the recording resumes.
- Subtitles/audio sent during recording are journaled and merged into the project on stop;
  audio stays movable on its own track in the editor.
- Idle detection: no visual change for X s (setting `idleThresholdSeconds`, default 6) →
  `idle.started`; change again → `idle.ended {idleMs}`. In the edit each idle span is
  compressed to ~Y s (`idleTargetSeconds`, default 10), max 16× (longer waits are cut in
  the middle), muted, with an optional honest "⏩ ×N · m:ss" badge.
- `references/rest-api.md` lists every endpoint and event; `GET /v1/openapi.json` too.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `unreachable` / `launch_timeout` | Recordly AI not installed or blocked: pass `--exe`, or start it once by hand. Check the userData `automation/server.json`. |
| `hud_unavailable` | The recorder window is starting: retry `health` (it auto-recovers after a recording). |
| `no_source` / `source_not_found` | `sources --q <regex>`; the error lists available windows. |
| idle never detected | Animated UI: add `idle-ignore --rect …` for spinners/counters, or raise `idleChangeThreshold`. |
| `bridge_unavailable` | CallAPICall is off: use your own TTS (`--audio`) or another `tts.provider`. |
| UIA click fails | Elevated target app (run both non-elevated), DPI scaling; fall back to `xy` clicks or vision. |
