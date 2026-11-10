# Narration voices

Pick per the user's request; default chain (`--provider auto` in `scripts/tts.py`):
CallAPICall bridge → ElevenLabs / OpenAI (if a key is set) → Kokoro → edge-tts → Piper.

| Provider | Where | Quality / speed | How |
|---|---|---|---|
| **CallAPICall bridge** (Kokoro, XTTS, CosyVoice, Qwen3-TTS…) | local GPU, already loaded | good, fast, cloned voices | `recordly_ai.py narrate "…" --tts --voice if_sara --lang it` (Recordly AI calls `:8720/tts/test`) |
| Kokoro-82M | local CPU/GPU | best quality per size | `uv tool install kokoro-tts` → `tts.py … --provider kokoro` |
| edge-tts | cloud, free, no key | natural, 300+ voices | `pip install edge-tts` → `--provider edge --voice it-IT-IsabellaNeural` |
| Piper | local CPU | fastest, robotic | `pip install piper-tts` + `python -m piper.download_voices it_IT-paola-medium` |
| OpenAI gpt-4o-mini-tts | cloud | steerable (`--instructions "calm, warm"`) | `OPENAI_API_KEY` |
| ElevenLabs | cloud, paid | top quality, cloning | `ELEVENLABS_API_KEY`, `--voice <voice id>` |
| agent's own TTS tool | — | — | write a file, then `recordly_ai.py prepare <id> "<text>" --audio file` |

Rules:
- Render **before** recording (`demo_runner.py prepare`); durations come back from Recordly AI
  and drive the pacing (`play --wait` sleeps exactly the spoken duration).
- Keep each clip short (one step, ≤ 2 sentences): easier to retime in the editor.
- Same voice and speed for the whole video; for a localized set change only the language
  and voice, never the step structure.
- Subtitles are generated from the narration text, distributed over the audio duration;
  `--word-timing` (bridge STT) gives word-accurate karaoke-style subtitles.
