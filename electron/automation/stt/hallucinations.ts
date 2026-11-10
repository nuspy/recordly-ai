import type { CaptionCuePayload } from "../../ipc/types";

// Phrases Whisper produces from silence: they come from the subtitle credits it was trained
// on and nobody ever says them into a microphone. Ported from CallAPICall's whisper_stt.py.
const HALLUCINATION_MARKERS = [
	"sottotitoli e revisione a cura di",
	"sottotitoli creati dalla comunit",
	"amara.org",
	"sottotitoli a cura di",
	"subtitles by the amara.org community",
	"thanks for watching",
	"thank you for watching",
	"please subscribe",
	"ご視聴ありがとうございました",
	"字幕由",
];

/** Text a cue may keep besides the marker (e.g. a credited name) and still be dropped. */
const MAX_RESIDUAL_CHARS = 30;

function normalize(text: string) {
	return Array.from(text.toLowerCase())
		.filter((char) => /[\p{L}\p{N} .-]/u.test(char))
		.join("")
		.replace(/\s+/g, " ")
		.trim();
}

export function isHallucinatedCaptionText(text: string): boolean {
	const normalized = normalize(text);
	if (!normalized) return false;
	return HALLUCINATION_MARKERS.some((marker) => {
		const index = normalized.indexOf(marker);
		if (index < 0) return false;
		// A long cue that merely contains a marker also carries real speech: keep it.
		const residual = `${normalized.slice(0, index)}${normalized.slice(index + marker.length)}`;
		return residual.replace(/[ .-]/g, "").length <= MAX_RESIDUAL_CHARS;
	});
}

export function filterHallucinatedCues(cues: CaptionCuePayload[]): CaptionCuePayload[] {
	return cues.filter((cue) => !isHallucinatedCaptionText(cue.text));
}
