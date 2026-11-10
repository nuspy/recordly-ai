# Recordly AI REST API (v1)

Base URL `http://127.0.0.1:<port>` (default 47800; the running port is in
`<userData>/automation/server.json`). Every route except `GET /v1/health` needs
`Authorization: Bearer <token>` (token file: `<userData>/automation/token`).
`<userData>` is `%APPDATA%\Recordly AI` on Windows (`Recordly-dev` for `npm run dev`),
`~/Library/Application Support/Recordly AI` on macOS, `~/.config/Recordly AI` on Linux.
`<userData>/automation/app.json` holds the path of the installed executable.

Security: loopback only, Host header must be the loopback address, requests carrying an
`Origin` header (browsers) are rejected. JSON bodies up to 256 MB; audio may also be sent as
a raw `audio/*` body.

Errors: `{"error": {"code", "message", "details?"}}` with HTTP status — 400 `bad_request` /
`invalid_json`, 401 `unauthorized`, 404 `not_found` / `source_not_found`, 409 `conflict`
(e.g. not recording, export running, unsaved changes), 502 `bridge_unavailable` (CallAPICall
TTS/STT off), 503 `hud_unavailable` / `editor_unavailable`, 504 `renderer_timeout` /
`editor_timeout`.

**Time base**: `atMs` = recording time in ms (pauses excluded). Omit it to mean "now";
`offsetMs` shifts "now" (e.g. `-500` to start a subtitle half a second earlier).

## System

| Method | Path | Notes |
|---|---|---|
| GET | `/v1/health?wait=60` | `{ok, ready, hudReady, editorOpen, serverMode, apiVersion}`. `wait` blocks until the recorder is ready (no token needed). |
| GET | `/v1/info` | server info, recordings folder, `sessionId`, `lastEventSeq` |
| GET | `/v1/openapi.json` | list of routes |
| GET | `/v1/events?types=idle.*,export.*&after=SEQ` | Server-Sent Events stream (`id:` = seq, `Last-Event-ID` honored) |
| GET | `/v1/events/next?types=idle.ended&after=SEQ&timeout=60` | long-poll: first matching event after SEQ, or `{event:null, timedOut:true}` |
| GET | `/v1/events/history?after=SEQ&types=…` | non-blocking list |
| POST | `/v1/app/quit` `{force?}` | 409 if the project has unsaved changes and not forced |

### Events
`app.ready`, `settings.changed`, `source.selected`, `recording.starting`, `recording.countdown`,
`recording.started {sessionId}`, `recording.paused {atMs}`, `recording.resumed {atMs}`,
`recording.stopped`, `recording.finalized {videoPath, journal}`,
`idle.started {atMs, lastChangeMs}`, `idle.ended {startMs, endMs, idleMs}`, `idle.unavailable`,
`content.caption|audio|narration|marker|zoom|annotation`, `hud.alert {message}`,
`editor.ready`, `editor.journal-applied {added, accelerated, discardedMs}`,
`editor.journal-failed`, `export.started {jobId, outputPath}`,
`export.progress {percent, phase, etaSeconds}`, `export.done {path}`, `export.failed {message}`,
`preset.saved`. Types accept `prefix.*` wildcards.

## Settings

| Method | Path | Body |
|---|---|---|
| GET | `/v1/settings` | → `{automation, recording, recordingsDirectory}` |
| PATCH | `/v1/settings` | `{automation?: {...}, recording?: {microphone, systemAudio, webcam, microphoneDeviceId, webcamDeviceId, countdownSeconds}}` |

`automation` keys: `restEnabled`, `port`, `idleThresholdSeconds` (X, default 6),
`idleTargetSeconds` (Y, default 10), `idleKeepMs` (1000), `idleMaxSpeed` (≤16),
`idleChangeThreshold` (0.002 = 0.2 % of pixels), `idleSpeedBadge`, `autoEditOnStop`,
`sttBackend` (`auto|bridge|local`), `bridgeUrl`, `bridgeControlUrl`, `bridgeControlToken`,
`bridgeBusyTimeoutSeconds`, `sttGpuId` (nvidia-smi UUID `GPU-...` of the GPU local Whisper uses; `""` = automatic), `ttsVoice`, `ttsLanguage`, `defaultPresetId`.

## Sources

| Method | Path | Body / query |
|---|---|---|
| GET | `/v1/sources?types=screen,window&q=regex` | `{sources:[{id, name, sourceType, appName?, windowTitle?, display_id}], selected}` |
| GET | `/v1/sources/selected` | |
| POST | `/v1/sources/select` | `{id}` or `{title: regex, type?: "window"}` or `{appName}` or `{displayIndex}`; `bringToFront` (default true) |
| GET | `/v1/screenshot?maxWidth=1280` | PNG of the selected source |
| POST | `/v1/wait` | `{condition: "stable"|"changed", forMs (stable only), timeoutMs, threshold?, ignoreRects?: [{x,y,width,height} normalized]}` → `{met, elapsedMs}` |
| POST | `/v1/idle/ignore` | `{rects: [...]}` regions excluded from idle detection |

## Presets (editor look: background, padding, cursor, zoom feel, captions style…)

| Method | Path | Body |
|---|---|---|
| GET | `/v1/presets?full=1` | list (+ snapshots), `defaultPresetId` |
| GET | `/v1/presets/current` | snapshot of the open editor |
| POST | `/v1/presets` | `{name, snapshot?: partial overrides, makeDefault?}` — from the open editor's look |
| PATCH | `/v1/presets/:id` | `{name}` |
| DELETE | `/v1/presets/:id` | |
| POST | `/v1/presets/:id/apply` | `{default?}` — applies now when the editor is open; `default` (implied when closed) uses it for automated edits |

## Recording

| Method | Path | Body |
|---|---|---|
| GET | `/v1/recording` | `{status: {recording, paused, starting, finalizing, countdownActive, clock, …}, sessionId, journal}` |
| POST | `/v1/recording/start` | `{source?: selector, microphone, systemAudio, webcam, countdownSeconds (0 in server mode), autoEdit?: {speedUpIdle, targetSeconds, keepMs, maxSpeed, speedBadge}, presetId?, idle?: {thresholdSeconds}}` |
| POST | `/v1/recording/pause` · `/resume` · `/cancel` | |
| POST | `/v1/recording/stop` | `{waitForEditor?: true}` → `{videoPath, sessionId, editor}` (journal merged, idle accelerated) |

## Live content (journaled during the recording, merged on stop)

| Method | Path | Body |
|---|---|---|
| POST | `/v1/captions` | `{text, atMs?, offsetMs?, durationMs?}` (long text is split into phrases) |
| POST | `/v1/audio` | `{path | base64 + format, atMs?, offsetMs?, volume?, trackIndex?, label?}` or raw `audio/*` body with the same keys as query params |
| POST | `/v1/narration` | `{text, path | base64 | tts: {voice, lang, engine} | preparedId, atMs?, offsetMs?, volume?, captions?: true, wordTiming?, language?}` → `{narrationId, atMs, durationMs, endsAtMs}` |
| POST | `/v1/narration/prepare` | `{id, text, path | base64 | tts}` — pre-render, returns `durationMs` |
| GET | `/v1/narration/prepared` | |
| POST | `/v1/narration/:id/play` | `{offsetMs?, captions?, volume?, wordTiming?}` — insert a prepared clip now |
| POST | `/v1/markers` | `{label, kind: step|chapter|note|discard-start|discard-end, atMs?}` |
| POST | `/v1/zoom` | `{rect (normalized) | screenRect (pixels), coordinateSpace?: physical|dip, padding?, durationMs?, startMs?, endMs?}` |
| POST | `/v1/annotations` | `{type: text|blur, text?, rect|screenRect, durationMs?, startMs?}` |

`screenRect` is converted with the selected source bounds (UIA `BoundingRectangle` values
are physical pixels — the default). `wordTiming: true` transcribes the narration audio with
the CallAPICall bridge to get word-level subtitle timing.

## Editor, project, export

| Method | Path | Body |
|---|---|---|
| GET | `/v1/editor` | `{open, ready, videoPath, projectPath, durationMs, hasUnsavedChanges, isExporting, counts}` |
| POST | `/v1/editor/open` | `{videoPath | projectPath, waitReady?: true}` |
| POST | `/v1/editor/apply-journal` | merge content sent after stop (needs `atMs`) |
| POST | `/v1/editor/auto-edit` | `{targetMs?, keepMs?, maxSpeed?, speedBadge?, force?}` — accelerate idle now |
| GET | `/v1/project` | `{path, project}` full project JSON |
| PUT | `/v1/project` | `{project}` replace (validated by the editor) |
| POST | `/v1/project/save` | `{name?, copyTo?}` — no dialogs |
| GET | `/v1/project/chapters?format=youtube` | chapters on the edited timeline (+ `text`) |
| POST | `/v1/captions/generate` | `{language?}` — Whisper via CallAPICall bridge or local whisper.cpp |
| POST | `/v1/export` | `{format: mp4|gif, quality: medium|good|high|source, encodingMode: fast|balanced|quality, fps: 24|30|60, includeCaptionSidecar, outputPath?, wait?, timeoutSeconds?}` → `{job}` |
| POST | `/v1/export/cancel` | |
| GET | `/v1/jobs/:id` | `{job: {status: running|done|failed, percent, outputPath, error}}` |

## curl quick start

```bash
TOKEN=$(cat "$APPDATA/Recordly AI/automation/token"); B=http://127.0.0.1:47800/v1
curl -s "$B/health?wait=60"
curl -s -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -X POST "$B/sources/select" -d '{"title":"My App","type":"window"}'
curl -s -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -X POST "$B/recording/start" -d '{"countdownSeconds":0}'
curl -s -H "Authorization: Bearer $TOKEN" "$B/events/next?types=idle.ended&timeout=60"
```
