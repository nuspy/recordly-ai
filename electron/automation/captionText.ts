import type { JournalCaption, JournalCaptionWord } from "./contract";

const CHARS_PER_SECOND = 14;
const MAX_CUE_CHARS = 84;
const MIN_CUE_MS = 900;

/** Reading/speaking time estimate for text sent without audio. */
export function estimateSpeechDurationMs(text: string) {
	const chars = text.trim().length;
	return Math.min(12_000, Math.max(1200, Math.round((chars / CHARS_PER_SECOND) * 1000)));
}

function splitLongPhrase(phrase: string): string[] {
	if (phrase.length <= MAX_CUE_CHARS) return [phrase];
	const parts: string[] = [];
	let rest = phrase;
	while (rest.length > MAX_CUE_CHARS) {
		const window = rest.slice(0, MAX_CUE_CHARS);
		const breakAt = Math.max(window.lastIndexOf(", "), window.lastIndexOf(" "));
		const cut = breakAt > MAX_CUE_CHARS / 3 ? breakAt + 1 : MAX_CUE_CHARS;
		parts.push(rest.slice(0, cut).trim());
		rest = rest.slice(cut).trim();
	}
	if (rest) parts.push(rest);
	return parts;
}

/** Splits narration into caption-sized phrases (sentence punctuation first, then length). */
export function splitNarrationText(text: string): string[] {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (!normalized) return [];
	const sentences = normalized.match(/[^.!?…;:]+[.!?…;:]*["»”)]*\s*/g) ?? [normalized];
	return sentences
		.map((sentence) => sentence.trim())
		.filter(Boolean)
		.flatMap(splitLongPhrase);
}

/**
 * Spreads `text` over `[startMs, startMs + durationMs]`, one cue per phrase, with each cue's
 * share proportional to its length (speech rate is roughly constant within a narration).
 */
export function distributeNarrationCues(
	text: string,
	startMs: number,
	durationMs: number,
	idPrefix: string,
	narrationId?: string,
): JournalCaption[] {
	const phrases = splitNarrationText(text);
	if (phrases.length === 0) return [];
	const totalChars = phrases.reduce((sum, phrase) => sum + phrase.length, 0);
	const total = Math.max(durationMs, MIN_CUE_MS);
	let cursor = startMs;
	return phrases.map((phrase, index) => {
		const isLast = index === phrases.length - 1;
		const share = Math.round((phrase.length / totalChars) * total);
		const endMs = isLast ? startMs + total : cursor + Math.max(MIN_CUE_MS, share);
		const cue: JournalCaption = {
			id: `${idPrefix}-${index}`,
			startMs: Math.round(cursor),
			endMs: Math.round(Math.max(endMs, cursor + 1)),
			text: phrase,
			...(narrationId ? { narrationId } : {}),
		};
		cursor = cue.endMs;
		return cue;
	});
}

export interface TimedWord {
	text: string;
	startMs: number;
	endMs: number;
}

/**
 * Builds word-timed cues from a transcript of the narration audio itself (e.g. the bridge
 * STT run on the TTS output), grouping words into phrases on punctuation or length.
 */
export function groupWordsIntoCues(
	words: TimedWord[],
	offsetMs: number,
	idPrefix: string,
	narrationId?: string,
): JournalCaption[] {
	const cues: JournalCaption[] = [];
	let current: JournalCaptionWord[] = [];
	const pushCue = () => {
		if (current.length === 0) return;
		const text = current
			.map((word, index) => `${index > 0 && word.leadingSpace ? " " : ""}${word.text}`)
			.join("")
			.trim();
		cues.push({
			id: `${idPrefix}-${cues.length}`,
			startMs: current[0].startMs,
			endMs: current[current.length - 1].endMs,
			text,
			words: current,
			...(narrationId ? { narrationId } : {}),
		});
		current = [];
	};

	for (const word of words) {
		const trimmed = word.text.trim();
		if (!trimmed) continue;
		current.push({
			text: trimmed,
			startMs: Math.round(word.startMs + offsetMs),
			endMs: Math.round(word.endMs + offsetMs),
			leadingSpace: current.length > 0,
		});
		const length = current.reduce((sum, w) => sum + w.text.length + 1, 0);
		if (/[.!?…;:]$/.test(trimmed) || length >= MAX_CUE_CHARS) {
			pushCue();
		}
	}
	pushCue();
	return cues;
}
