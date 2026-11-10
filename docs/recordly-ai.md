# Recordly AI

Recordly AI is a fork of Recordly that AI agents can drive end to end: record, narrate,
subtitle, edit and export software demos over a local REST API, with a headless server mode.

## What the fork adds

| Area | Where |
|---|---|
| REST API (`/v1/*`, Bearer token, loopback only) + SSE/long-poll events | `electron/automation/` (`restServer.ts`, `routes.ts`, `controller.ts`) |
| Server mode: `RecordlyAI.exe --server [--port N] [--show]` (dev: `RECORDLY_SERVER=1 npm run dev`) | `electron/automation/cli.ts`, `headless.ts`, `index.ts` |
| Recording control from main (start/pause/resume/stop/cancel, sources, settings) | `src/automation/hud/useHudAutomation.ts` (drives `useScreenRecorder`) |
| Live subtitles, narration audio, markers, zooms, blurs during a take (session journal → merged on stop) | `electron/automation/journal.ts`, `src/automation/editor/mergeJournal.ts` |
| Idle detection (still screen for X s, default 6) + automatic speed-up to ~Y s (default 10) | `src/automation/idle/*`, `src/automation/editor/autoEdit.ts` |
| Editor control: project JSON get/put, save, presets, captions, export jobs | `src/automation/editor/useEditorAutomation.ts` |
| Speech-to-text via the CallAPICall bridge (shares its loaded Whisper) or local whisper.cpp (ggml models download, CUDA runtime with CPU fallback) | `electron/automation/stt/*` |
| Settings → "AI & REST" panel | `src/automation/settings/AutomationSettingsPanel.tsx` |
| Agent skill (Claude Code, Codex, Gemini CLI, Hermes) with Python CLI, demo runner, TTS chain, pipelines | `skills/recordly-ai-demo/` |

Upstream touchpoints are kept small (one hook call per window, a few exported helpers) so
upstream merges stay easy. The fork disables upstream auto-updates
(`electron/automation/fork.ts`; set `RECORDLY_AI_ENABLE_AUTO_UPDATES=1` once the fork has
its own release feed) and has its own identity: productName "Recordly AI", executable
`RecordlyAI.exe`, appId `dev.recordly.ai`, userData `%APPDATA%\Recordly AI` (preferences of an
upstream Recordly install are imported once on first start). The `recordly://` protocol and the
`.recordly` project format are unchanged. Installer layout: `installforge_instructions.md`.

## Quick start for agents

```
python skills/recordly-ai-demo/scripts/install.py -g --deps   # global: ~/.claude, ~/.agents, ~/.gemini, Hermes (+ PyYAML, pywinauto)
python skills/recordly-ai-demo/scripts/recordly_ai.py launch
python skills/recordly-ai-demo/scripts/recordly_ai.py select --title "Notepad"
python skills/recordly-ai-demo/scripts/recordly_ai.py start
python skills/recordly-ai-demo/scripts/recordly_ai.py narrate "Hello" --audio hello.wav --wait
python skills/recordly-ai-demo/scripts/recordly_ai.py stop
python skills/recordly-ai-demo/scripts/recordly_ai.py export --out demo.mp4 --sidecar
```

Full API: `skills/recordly-ai-demo/references/rest-api.md` (or `GET /v1/openapi.json`).

## How timing works

- The HUD's recording clock (pauses excluded) is the time base of everything an agent sends;
  "now" is resolved when the request arrives. Content sent while paused lands where the
  recording resumes. At stop, the clock reading is compared with the video duration to absorb
  the native capture's start offset.
- The journal (`<video>.recordly-automation.json`) stores captions/markers/idle in recording
  time; on editor load the merge places audio, zooms and annotations on the timeline **after**
  the idle speed-ups, so they line up with what viewers see. Merging is idempotent (ids are
  prefixed `ai-`), speed-ups run once.
- Speed-ups never cover narration audio or subtitles (protected spans), keep 1 s at normal
  speed at both ends, mute the sped-up source audio, cap at 16× (preview playback limit) and
  cut the middle of longer waits.

## Server mode notes

- Windows are created but never shown (`show/focus` are disabled per window), with Chromium
  background throttling off: capture (native WGC helper) and WebCodecs export work hidden.
- The HUD is closed by upstream after each recording; the automation layer recreates it
  on demand (next take, visual waits) while the editor stays open.
- A second `--server` launch exits immediately, printing `RECORDLY_AI_RUNNING {...}`; the
  discovery file `<userData>/automation/server.json` and the token file are the contract for
  clients (packaged Windows GUI apps have no stdout).
