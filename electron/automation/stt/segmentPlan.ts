import type { SilenceInterval } from "../../ipc/captions/silence";

export interface AudioSegment {
	startMs: number;
	endMs: number;
}

export interface SegmentPlanOptions {
	/** Whisper decodes 30 s windows: longer uploads get re-chunked by the server anyway. */
	maxSegmentMs?: number;
	/** Never cut earlier than this into a segment, so tiny segments don't lose context. */
	minSegmentMs?: number;
	/** Segments shorter than this cannot hold a recognizable word and are dropped. */
	minKeepMs?: number;
}

export const BRIDGE_MAX_SEGMENT_MS = 30_000;

/**
 * Split [0, durationMs] into segments of at most `maxSegmentMs`, cutting inside a detected
 * silence whenever one is available (the latest one that fits, to keep requests few) and
 * hard-cutting otherwise. Segments that lie entirely inside a silence are skipped: Whisper
 * only invents text from them.
 */
export function planAudioSegments(
	durationMs: number,
	silences: SilenceInterval[] | null | undefined,
	options: SegmentPlanOptions = {},
): AudioSegment[] {
	const maxSegmentMs = options.maxSegmentMs ?? BRIDGE_MAX_SEGMENT_MS;
	const minSegmentMs = Math.min(options.minSegmentMs ?? 5_000, maxSegmentMs);
	const minKeepMs = options.minKeepMs ?? 250;
	if (!(durationMs > 0)) return [];

	const sortedSilences = (silences ?? [])
		.map((silence) => ({
			startMs: Math.max(0, silence.startMs),
			endMs: Math.min(durationMs, silence.endMs),
		}))
		.filter((silence) => silence.endMs > silence.startMs)
		.sort((left, right) => left.startMs - right.startMs);

	const segments: AudioSegment[] = [];
	let cursor = 0;
	while (cursor < durationMs) {
		const limit = cursor + maxSegmentMs;
		if (limit >= durationMs) {
			segments.push({ startMs: cursor, endMs: durationMs });
			break;
		}

		let cut = limit;
		let bestSilenceCut = -1;
		for (const silence of sortedSilences) {
			const low = Math.max(silence.startMs, cursor + minSegmentMs);
			const high = Math.min(silence.endMs, limit);
			if (low > high) continue;
			const middle = (silence.startMs + silence.endMs) / 2;
			const candidate = Math.round(Math.min(high, Math.max(low, middle)));
			if (candidate > bestSilenceCut) bestSilenceCut = candidate;
		}
		if (bestSilenceCut > cursor) cut = bestSilenceCut;

		segments.push({ startMs: cursor, endMs: cut });
		cursor = cut;
	}

	return segments.filter(
		(segment) =>
			segment.endMs - segment.startMs >= minKeepMs &&
			!sortedSilences.some(
				(silence) => silence.startMs <= segment.startMs && silence.endMs >= segment.endMs,
			),
	);
}
