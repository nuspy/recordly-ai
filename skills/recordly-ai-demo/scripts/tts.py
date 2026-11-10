#!/usr/bin/env python3
"""Narration TTS with a provider fallback chain (standard library + optional CLIs).

    python tts.py "Testo da leggere" out.wav --provider auto --voice if_sara --lang it

Providers (``--provider``):
  bridge      CallAPICall handy-compat server (Kokoro & co.), POST :8720/tts/test. Local,
              zero setup when CallAPICall runs; shares its already-loaded models.
  edge        `edge-tts` CLI (pip install edge-tts). Free, many voices, needs internet.
  kokoro      `kokoro-tts` CLI (uv tool install kokoro-tts). Local, good quality.
  piper       `python -m piper` (pip install piper-tts). Local, fastest, robotic.
  openai      OpenAI gpt-4o-mini-tts (OPENAI_API_KEY). Steerable with --instructions.
  elevenlabs  ElevenLabs (ELEVENLABS_API_KEY, --voice is the voice id).
  command     Any command template: --command "mytts --in {text_file} --out {out}".
  auto        bridge → elevenlabs/openai (if a key is set) → kokoro → edge → piper.

Prints JSON {path, provider, voice, durationMs?} on success.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import shlex
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import wave
from pathlib import Path
from typing import Callable, Dict, List, Optional

BRIDGE_URL = os.environ.get("CALLBRIDGE_TTS_URL", "http://127.0.0.1:8720")

# Sensible default voices per language for each engine.
EDGE_VOICES = {"it": "it-IT-IsabellaNeural", "en": "en-US-AriaNeural", "fr": "fr-FR-DeniseNeural", "es": "es-ES-ElviraNeural", "de": "de-DE-KatjaNeural", "pt": "pt-BR-FranciscaNeural"}
KOKORO_VOICES = {"it": "if_sara", "en": "af_heart", "fr": "ff_siwis", "es": "ef_dora", "pt": "pf_dora", "ja": "jf_alpha", "zh": "zf_xiaoxiao", "hi": "hf_alpha"}
PIPER_VOICES = {"it": "it_IT-paola-medium", "en": "en_US-lessac-medium", "fr": "fr_FR-siwis-medium", "es": "es_ES-davefx-medium", "de": "de_DE-thorsten-medium"}


class TtsError(RuntimeError):
    pass


def wav_duration_ms(path: Path) -> Optional[int]:
    try:
        with wave.open(str(path), "rb") as handle:
            return round(handle.getnframes() / float(handle.getframerate()) * 1000)
    except (wave.Error, OSError, EOFError):
        return None


def _run(command: List[str]) -> None:
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0:
        raise TtsError(f"{command[0]} failed: {(result.stderr or result.stdout).strip()[:400]}")


def tts_bridge(text: str, out: Path, voice: Optional[str], lang: str, **_: object) -> str:
    body = json.dumps({"text": text, "voice": voice or KOKORO_VOICES.get(lang, "af_heart"), "lang": lang}).encode()
    request = urllib.request.Request(f"{BRIDGE_URL}/tts/test", data=body, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except OSError as error:
        raise TtsError(f"CallAPICall bridge not reachable: {error}") from None
    audio = payload.get("audio_b64")
    if not audio:
        raise TtsError(f"bridge TTS failed: {payload.get('message') or payload.get('status')}")
    out.write_bytes(base64.b64decode(audio))
    return str(payload.get("voice") or voice or "")


def tts_edge(text: str, out: Path, voice: Optional[str], lang: str, rate: Optional[str] = None, **_: object) -> str:
    exe = shutil.which("edge-tts")
    if not exe:
        raise TtsError("edge-tts not installed (pip install edge-tts)")
    chosen = voice or EDGE_VOICES.get(lang, "en-US-AriaNeural")
    command = [exe, "--voice", chosen, "--text", text, "--write-media", str(out)]
    if rate:
        command += ["--rate", rate]
    _run(command)
    return chosen


def tts_kokoro(text: str, out: Path, voice: Optional[str], lang: str, **_: object) -> str:
    exe = shutil.which("kokoro-tts")
    if not exe:
        raise TtsError("kokoro-tts not installed (uv tool install kokoro-tts)")
    chosen = voice or KOKORO_VOICES.get(lang, "af_heart")
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False, encoding="utf-8") as handle:
        handle.write(text)
    try:
        _run([exe, handle.name, str(out), "--voice", chosen])
    finally:
        os.unlink(handle.name)
    return chosen


def tts_piper(text: str, out: Path, voice: Optional[str], lang: str, **_: object) -> str:
    chosen = voice or PIPER_VOICES.get(lang, "en_US-lessac-medium")
    result = subprocess.run([sys.executable, "-m", "piper", "-m", chosen, "-f", str(out), "--", text], capture_output=True, text=True)
    if result.returncode != 0:
        raise TtsError(f"piper failed (pip install piper-tts; python -m piper.download_voices {chosen}): {result.stderr.strip()[:300]}")
    return chosen


def tts_openai(text: str, out: Path, voice: Optional[str], lang: str, instructions: Optional[str] = None, **_: object) -> str:
    key = os.environ.get("OPENAI_API_KEY")
    if not key:
        raise TtsError("OPENAI_API_KEY not set")
    chosen = voice or "alloy"
    body = {"model": "gpt-4o-mini-tts", "voice": chosen, "input": text, "response_format": "wav"}
    if instructions:
        body["instructions"] = instructions
    request = urllib.request.Request(
        "https://api.openai.com/v1/audio/speech",
        data=json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=180) as response:
        out.write_bytes(response.read())
    return chosen


def tts_elevenlabs(text: str, out: Path, voice: Optional[str], lang: str, **_: object) -> str:
    key = os.environ.get("ELEVENLABS_API_KEY")
    if not key:
        raise TtsError("ELEVENLABS_API_KEY not set")
    voice_id = voice or os.environ.get("ELEVENLABS_VOICE_ID")
    if not voice_id:
        raise TtsError("pass --voice <elevenlabs voice id> or set ELEVENLABS_VOICE_ID")
    request = urllib.request.Request(
        f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}?output_format=mp3_44100_128",
        data=json.dumps({"text": text, "model_id": "eleven_multilingual_v2"}).encode(),
        headers={"xi-api-key": key, "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=180) as response:
        out.write_bytes(response.read())
    return voice_id


def tts_command(text: str, out: Path, voice: Optional[str], lang: str, command: Optional[str] = None, **_: object) -> str:
    if not command:
        raise TtsError("--command is required for the command provider")
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False, encoding="utf-8") as handle:
        handle.write(text)
    try:
        rendered = command.format(text_file=handle.name, out=str(out), voice=voice or "", lang=lang)
        _run(shlex.split(rendered, posix=os.name != "nt"))
    finally:
        os.unlink(handle.name)
    return voice or ""


PROVIDERS: Dict[str, Callable[..., str]] = {
    "bridge": tts_bridge,
    "edge": tts_edge,
    "kokoro": tts_kokoro,
    "piper": tts_piper,
    "openai": tts_openai,
    "elevenlabs": tts_elevenlabs,
    "command": tts_command,
}


def auto_chain() -> List[str]:
    chain = ["bridge"]
    if os.environ.get("ELEVENLABS_API_KEY"):
        chain.append("elevenlabs")
    if os.environ.get("OPENAI_API_KEY"):
        chain.append("openai")
    return chain + ["kokoro", "edge", "piper"]


def synthesize(text: str, out: Path, provider: str = "auto", voice: Optional[str] = None, lang: str = "it", **options: object) -> Dict[str, object]:
    """Writes `text` as speech to `out` (extension fixed up per provider) and describes it."""
    names = auto_chain() if provider == "auto" else [provider]
    errors = []
    for name in names:
        target = out
        if name in ("elevenlabs",) and target.suffix.lower() != ".mp3":
            target = target.with_suffix(".mp3")
        if name == "edge" and target.suffix.lower() not in (".mp3",):
            target = target.with_suffix(".mp3")
        try:
            used_voice = PROVIDERS[name](text, target, voice if provider != "auto" else None, lang, **options)
            if not target.exists() or target.stat().st_size == 0:
                raise TtsError("no audio written")
            return {"path": str(target.resolve()), "provider": name, "voice": used_voice, "durationMs": wav_duration_ms(target)}
        except (TtsError, OSError, ValueError) as error:
            errors.append(f"{name}: {error}")
    raise TtsError("all TTS providers failed: " + " | ".join(errors))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("text")
    parser.add_argument("out")
    parser.add_argument("--provider", default="auto", choices=["auto", *PROVIDERS])
    parser.add_argument("--voice")
    parser.add_argument("--lang", default="it")
    parser.add_argument("--rate", help="edge-tts rate, e.g. +5%%")
    parser.add_argument("--instructions", help="OpenAI style instructions (tone, pace)")
    parser.add_argument("--command", help="template for the command provider")
    args = parser.parse_args()
    try:
        result = synthesize(args.text, Path(args.out), args.provider, args.voice, args.lang, rate=args.rate, instructions=args.instructions, command=args.command)
    except TtsError as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
