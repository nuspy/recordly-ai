# Pre-built pipelines and use cases

Templates live in `templates/pipelines/`. Copy one next to the user's project, fill the
`target`, selectors and narration, validate, rehearse with `--no-record`, then run.

| Pipeline | Use case | Key techniques |
|---|---|---|
| `ai-image-gen.yaml` | demo of an AI image generator (prompt → result → variation) | `wait: idle_end`, `while_waiting` narration, honest ⏩ badge, `idle_ignore_rects` for spinners |
| `ai-video-gen.yaml` | AI video generation with multi-minute renders | pause-if-not-ready, discard + retry on failed renders, result playback with `system_audio` |
| `web-app-tour.yaml` | SaaS/web app walkthrough | Playwright/UIA clicks, `zoom: true` on every important control, chapters |
| `cli-tool.yaml` | terminal tool demo | `type` with visible typing speed, `wait: stable` after each command |
| `bug-repro.yaml` | reproduce a bug for an issue | no narration, markers per step, GIF export, short `idleTargetSeconds` |
| `localize.yaml` | same demo in several languages | one recording per language driven by the same steps, or one silent take + per-language narration via `atMs` |

## Ideas worth proposing to the user
- **Localized set from one script**: identical steps, different `language`/`voice`; chapters
  stay aligned across languages.
- **Docs from the video**: `chapters --youtube` + one screenshot per chapter → Markdown how-to.
- **Release video in CI**: run a pipeline against each release build; diff durations and
  screenshots as a visual regression signal.
- **Bug report attachment**: `bug-repro.yaml` → GIF + `.srt` steps pasted in the issue.
- **Social cut**: export a vertical variant by applying a 9:16 preset before export.
- **Co-pilot mode**: the user records by hand (REST enabled in Settings → AI & REST); the
  agent adds chapters, subtitles and narration during or after the take using `atMs`.
- **Honest AI demos**: keep the speed-up badge so viewers know how long generation took.
