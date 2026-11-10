# Style interview checklist

Ask in rounds of 3–4 questions, in the user's language. Offer defaults so the user can
answer "ok". Summarize the decisions as a short brief and get a yes before scripting.

## Round 1 — Purpose
- What is the video for? (sales demo, onboarding tutorial, feature announcement, bug report,
  internal training, social short, conference talk backup)
- Who watches it? Their expertise with the app/topic? What do they already know?
- One sentence the viewer should remember. Call to action at the end?

## Round 2 — Language & voice
- Narration language(s)? Subtitles in the same language, another, or several (localized set)?
- Voice: the agent's own TTS, a provider/voice named by the user, CallAPICall voice
  (e.g. `if_sara`), the user's cloned voice, or no voice (subtitles only)?
- Formality (tu/Lei, you/one), energy (calm ↔ enthusiastic), humor yes/no, jargon level.

## Round 3 — Shape
- Target length (30 s short, 2 min overview, 10 min tutorial). Hard limit?
- Format: 16:9 MP4 (YouTube/web), 9:16 vertical, GIF for docs; quality/fps.
- Subtitles burned in (accessible, social) or `.srt/.vtt` sidecar (YouTube)?
- Chapters for YouTube? A written step-by-step guide as well?

## Round 4 — Content & safety
- Steps that must appear; things that must not (accounts, prices, internal data).
- Sample data/prompts to use; account to log into (never type passwords on camera — log in
  before recording).
- Long waits: show honest speed-up badge ("⏩ ×12 · 4:30") or hide waiting time?
- Branding: editor preset (background, padding, cursor style), intro/outro lines.

## Brief template
```
Goal: … | Audience: … | Language: … (subs: …) | Voice: … | Tone: …
Length: … | Format: … | Subtitles: … | Chapters: yes/no | Badge: yes/no
Must show: … | Must hide: … | Preset: … | Output: <path>
```
