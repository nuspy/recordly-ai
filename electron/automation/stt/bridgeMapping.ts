import { buildCaptionTextFromWords } from "../../ipc/captions/parser";
import type { CaptionCuePayload, CaptionWordPayload } from "../../ipc/types";
import type { BridgeTranscript, BridgeTranscriptWord } from "../bridgeClient";

function toMs(seconds: unknown, offsetMs: number) {
	return typeof seconds === "number" && Number.isFinite(seconds)
		? Math.max(0, Math.round(seconds * 1000) + offsetMs)
		: null;
}

/**
 * Bridge words come from openai-whisper (`" ciao,"`): the leading space marks a word break,
 * punctuation is usually attached. Mirrors `parseWhisperJsonWords` so both backends feed the
 * phrase segmenter the same shape.
 */
export function mapBridgeWords(
	words: BridgeTranscriptWord[] | undefined,
	offsetMs: number,
): CaptionWordPayload[] {
	const result: CaptionWordPayload[] = [];
	for (const word of words ?? []) {
		const raw = typeof word?.text === "string" ? word.text : "";
		const text = raw.trim();
		if (!text) continue;
		const startMs = toMs(word.start_s, offsetMs);
		const endMs = toMs(word.end_s, offsetMs);
		if (startMs === null || endMs === null) continue;

		const previous = result.length > 0 ? result[result.length - 1] : null;
		const leadingSpace = /^\s/.test(raw);
		if (previous && (!leadingSpace || /^\p{P}+$/u.test(text))) {
			previous.text += text;
			previous.endMs = Math.max(previous.endMs, endMs);
			continue;
		}

		// openai-whisper emits zero-length words at segment edges; keep them ordered and non-empty.
		const safeStart = previous ? Math.max(startMs, previous.startMs) : startMs;
		result.push({
			text,
			startMs: safeStart,
			endMs: Math.max(endMs, safeStart + 1),
			...(previous ? { leadingSpace: true } : {}),
		});
	}
	return result;
}

/** Map one bridge response for an audio segment starting at `offsetMs` into caption cues. */
export function mapBridgeTranscriptToCues(
	transcript: BridgeTranscript,
	offsetMs: number,
	segmentEndMs?: number,
): CaptionCuePayload[] {
	const cues: CaptionCuePayload[] = [];
	for (const segment of transcript.segments ?? []) {
		const startMs = toMs(segment?.start_s, offsetMs);
		let endMs = toMs(segment?.end_s, offsetMs);
		if (startMs === null || endMs === null) continue;
		if (segmentEndMs !== undefined) endMs = Math.min(endMs, segmentEndMs);

		const words = mapBridgeWords(segment.words, offsetMs);
		const segmentText = typeof segment.text === "string" ? segment.text.trim() : "";
		const text = words.length > 0 ? buildCaptionTextFromWords(words) : segmentText;
		if (!text) continue;

		const cueStart = words.length > 0 ? Math.min(startMs, words[0].startMs) : startMs;
		const cueEnd = Math.max(endMs, words.length > 0 ? words[words.length - 1].endMs : endMs);
		if (cueEnd <= cueStart) continue;
		cues.push({
			id: `caption-${cues.length + 1}`,
			startMs: cueStart,
			endMs: cueEnd,
			text,
			...(words.length > 0 ? { words } : {}),
		});
	}
	return cues;
}
