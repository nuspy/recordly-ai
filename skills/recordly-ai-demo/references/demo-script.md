# Demo script schema (`demo.yaml` / `demo.json`)

Run with `python scripts/demo_runner.py validate|prepare|run demo.yaml`.
YAML needs `pip install pyyaml`; UIA actions need `pip install pywinauto` (Windows).

```yaml
title: "LTX Studio — dal prompt al video"
language: it                     # narration language (TTS default)
audience: "creator non tecnici"
style: "diretto, entusiasta ma preciso, frasi brevi, seconda persona"

target:
  launch: "start \"\" \"C:\\Program Files\\MyApp\\MyApp.exe\""   # optional shell command
  settle_ms: 4000                # wait after launch
  window: { title: "MyApp", app: null }    # source to record (regex); or `display: 0`

recorder:
  countdown: 0
  microphone: false
  system_audio: false            # true to keep app sounds
  idle_seconds: 6                # X: still-screen threshold
  auto_edit: { speed_up_idle: true, target_seconds: 10, max_speed: 16, speed_badge: true }

preset: null                     # editor preset id to apply
idle_ignore_rects:               # spinners/clocks to ignore during idle detection (normalized)
  - { x: 0.92, y: 0.02, width: 0.07, height: 0.05 }

tts:
  provider: bridge               # bridge | edge | kokoro | piper | openai | elevenlabs | command
  voice: if_sara
  lang: it
  word_timing: false             # true: word-level subtitles via CallAPICall STT
  # instructions: "tono caldo, ritmo calmo"   (openai)
  # command: "mytts --in {text_file} --out {out} --voice {voice}"

steps:
  - id: intro
    chapter: "Introduzione"      # chapter marker (else a step marker with `title`)
    narration: "In due minuti vediamo come trasformare un'idea in un video."
    narration_timing: before     # before (speak, then act) | with (act while speaking) | after
    actions: []
    hold_ms: 800

  - id: prompt
    title: "Scrivere il prompt"
    narration: "Scriviamo il prompt: più è concreto, migliore è il risultato."
    narration_timing: with
    actions:
      - { type: click, uia: { window: "MyApp", name: "Prompt", control_type: "Edit" }, zoom: true }
      - { type: type, text: "Un faro al tramonto, stile acquerello", interval_ms: 35 }
    wait: { type: stable, for_ms: 1000, timeout_s: 10 }

  - id: generate
    chapter: "Generazione"
    narration: "Avviamo la generazione."
    actions:
      - { type: zoom_on, uia: { window: "MyApp", name: "Genera", control_type: "Button" }, duration_ms: 2000 }
      - { type: click, uia: { window: "MyApp", name: "Genera", control_type: "Button" } }
      - { type: sleep, ms: 1500 }
    while_waiting:               # spoken during the wait; never accelerated
      after_ms: 3000
      narration: "Mentre il modello lavora, notate la barra di avanzamento: qui accelero il tempo."
    wait: { type: idle_end, timeout_s: 900, required: true }
    retry: { max: 1, reset_actions: [ { type: hotkey, keys: "esc" } ] }

  - id: review
    kind: agent                  # the agent does this part with its own tools, then resumes
    instruction: "Evaluate the generated video; if it is poor, regenerate once and describe it."
    narration: "Ecco il risultato."

  - id: outro
    narration: "Tutto qui: provate anche voi."
    narration_timing: before

output:
  project_name: "LTX demo"
  video: "C:/Users/me/Videos/ltx-demo.mp4"
  format: mp4
  quality: high
  subtitles: true                # also write .srt/.vtt
  captions_from_audio: false     # true: Whisper-transcribe instead of using the narration text
  quit: true
```

## Actions

| type | fields |
|---|---|
| `click`, `double_click`, `right_click` | `uia: {window, name|name_re, control_type, auto_id, found_index}` or `xy: [x, y]`; `zoom: true` adds a zoom on the element |
| `type` | `text`, `interval_ms` (typing speed visible on camera) |
| `hotkey` | `keys: "ctrl+shift+n"` |
| `keys` | raw pywinauto `send_keys` string |
| `uia_set_text` | `uia`, `text` (instant, no typing animation) |
| `scroll` | `xy`, `amount` |
| `focus` | `window` regex |
| `shell` | `cmd`, `check`, `timeout_s` |
| `open_url` | `url` |
| `sleep` | `ms` |
| `zoom_on` / `blur_element` / `callout` | `uia` or `rect` (normalized), `duration_ms`, `text` (callout) |

## Waits

| type | fields |
|---|---|
| `none` | default |
| `sleep` | `ms` |
| `stable` | `for_ms`, `timeout_s`, `ignore_rects`, `threshold` — UI settled |
| `changed` | `timeout_s` — something started moving |
| `idle_end` | `timeout_s` — a long wait ended (AI generation finished) |
| `uia_exists` | `uia`, `timeout_s` |
| `event` | `types: [...]`, `timeout_s` |

`required: true` turns an unmet wait into a step failure (→ `retry`).

## Behaviour notes

- Narration is rendered on a background thread in step order; the first one is awaited
  before recording starts. If a later one is late, the runner pauses the recording until it
  is ready, then resumes (no dead air, nothing to cut).
- `retry`: on failure the runner marks `discard-start` at the step start and `discard-end`
  now, so the failed attempt disappears from the edit, runs `reset_actions`, and retries.
- `kind: agent` exits with code 10 and `{"agent_step": {step, instruction, resume_with}}`.
  The recording keeps running; any time you spend thinking is a still screen that the
  idle speed-up compresses. Pause explicitly (`recordly_ai.py pause`) if you need minutes.
