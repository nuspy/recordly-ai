import {
	type ClipRegion,
	getClipSourceEndMs,
	getClipSourceStartMs,
	mapSourceTimeToTimelineTime,
	mapTimelineTimeToSourceTime,
	sortClipRegions,
} from "@/components/video-editor/types";

export interface TimeSpan {
	startMs: number;
	endMs: number;
}

export interface IdleSpeedupOptions {
	/** On-screen duration an idle period is compressed to (GUI setting Y). */
	targetMs: number;
	/** Normal-speed lead-in/lead-out kept at both ends of each idle period. */
	keepMs: number;
	/** Highest playback speed; beyond it the middle of the idle period is cut. */
	maxSpeed: number;
	/** Speed-ups smaller than this are not worth a split. */
	minSpeed?: number;
}

export interface AcceleratedSpan {
	/** Source range that plays faster (the first piece when the middle was cut). */
	sourceStartMs: number;
	sourceEndMs: number;
	/** Source range removed from the middle when the speed would exceed `maxSpeed`. */
	cutSourceRange: TimeSpan | null;
	speed: number;
	/** Real duration of the idle period, for honest "⏩ 5:00" badges. */
	realDurationMs: number;
}

interface PlannedPiece {
	sourceStartMs: number;
	sourceEndMs: number;
	speed: number;
	accelerated: boolean;
}

const MIN_COMPRESSED_OUTPUT_MS = 1000;

/** `span` minus every protected span, keeping only non-empty pieces. */
export function subtractSpans(span: TimeSpan, protectedSpans: readonly TimeSpan[]): TimeSpan[] {
	let pieces: TimeSpan[] = [span];
	for (const guard of protectedSpans) {
		pieces = pieces.flatMap((piece) => {
			if (guard.endMs <= piece.startMs || guard.startMs >= piece.endMs) return [piece];
			const result: TimeSpan[] = [];
			if (guard.startMs > piece.startMs) {
				result.push({ startMs: piece.startMs, endMs: guard.startMs });
			}
			if (guard.endMs < piece.endMs)
				result.push({ startMs: guard.endMs, endMs: piece.endMs });
			return result;
		});
	}
	return pieces.filter((piece) => piece.endMs > piece.startMs);
}

/**
 * Plans how one idle span is played back: lead-in at normal speed, the core compressed so
 * the whole span lasts about `targetMs`, lead-out at normal speed. Returns null when the
 * span is too short to be worth accelerating.
 */
export function planIdleSpan(
	span: TimeSpan,
	options: IdleSpeedupOptions,
): { pieces: PlannedPiece[]; accelerated: AcceleratedSpan } | null {
	const durationMs = span.endMs - span.startMs;
	const keepMs = Math.max(0, Math.min(options.keepMs, durationMs / 4));
	const compressibleMs = durationMs - 2 * keepMs;
	const outputMs = Math.max(MIN_COMPRESSED_OUTPUT_MS, options.targetMs - 2 * keepMs);
	const speed = compressibleMs / outputMs;
	if (durationMs <= options.targetMs || speed < (options.minSpeed ?? 1.25)) return null;

	const coreStart = span.startMs + keepMs;
	const coreEnd = span.endMs - keepMs;
	const pieces: PlannedPiece[] = [];
	if (keepMs > 0) {
		pieces.push({
			sourceStartMs: span.startMs,
			sourceEndMs: coreStart,
			speed: 1,
			accelerated: false,
		});
	}

	let cutSourceRange: TimeSpan | null = null;
	let appliedSpeed = speed;
	if (speed <= options.maxSpeed) {
		pieces.push({ sourceStartMs: coreStart, sourceEndMs: coreEnd, speed, accelerated: true });
	} else {
		// Faster than the preview can play: keep both ends of the wait at maxSpeed and drop
		// the middle, so the viewer still sees the wait begin and the result arrive.
		appliedSpeed = options.maxSpeed;
		const halfSourceMs = Math.round((outputMs * options.maxSpeed) / 2);
		const firstEnd = coreStart + halfSourceMs;
		const secondStart = coreEnd - halfSourceMs;
		cutSourceRange = { startMs: firstEnd, endMs: secondStart };
		pieces.push(
			{
				sourceStartMs: coreStart,
				sourceEndMs: firstEnd,
				speed: appliedSpeed,
				accelerated: true,
			},
			{
				sourceStartMs: secondStart,
				sourceEndMs: coreEnd,
				speed: appliedSpeed,
				accelerated: true,
			},
		);
	}

	if (keepMs > 0) {
		pieces.push({
			sourceStartMs: coreEnd,
			sourceEndMs: span.endMs,
			speed: 1,
			accelerated: false,
		});
	}
	return {
		pieces,
		accelerated: {
			sourceStartMs: coreStart,
			sourceEndMs: coreEnd,
			cutSourceRange,
			speed: Math.round(appliedSpeed * 100) / 100,
			realDurationMs: durationMs,
		},
	};
}

export interface IdleSpeedupPlan {
	clips: ClipRegion[];
	accelerated: AcceleratedSpan[];
}

/**
 * Rebuilds the clip list so every idle period (source time) plays compressed. Clips keep
 * their order and the gaps between them; speed-ups never touch protected spans (narration
 * audio, captions) so voice-over recorded during a wait stays intact. Accelerated pieces are
 * muted: time-stretched source audio at 10x+ is noise, narration lives on its own track.
 */
export function planIdleSpeedups(input: {
	clips: ClipRegion[];
	idle: readonly TimeSpan[];
	protect?: readonly TimeSpan[];
	options: IdleSpeedupOptions;
	idPrefix?: string;
}): IdleSpeedupPlan {
	const idPrefix = input.idPrefix ?? "clip-ai";
	const idleSpans = input.idle
		.flatMap((span) => subtractSpans(span, input.protect ?? []))
		.sort((a, b) => a.startMs - b.startMs);
	const accelerated: AcceleratedSpan[] = [];
	const nextClips: ClipRegion[] = [];
	let timelineShift = 0;
	let pieceCounter = 0;

	for (const clip of sortClipRegions(input.clips)) {
		const clipSourceStart = getClipSourceStartMs(clip);
		const clipSourceEnd = getClipSourceEndMs(clip);
		const clipSpeed = Number.isFinite(clip.speed) && clip.speed > 0 ? clip.speed : 1;
		const pieces: PlannedPiece[] = [];
		let cursor = clipSourceStart;

		for (const idleSpan of idleSpans) {
			const start = Math.max(idleSpan.startMs, clipSourceStart);
			const end = Math.min(idleSpan.endMs, clipSourceEnd);
			if (end <= start || start < cursor) continue;
			const plan = planIdleSpan({ startMs: start, endMs: end }, input.options);
			if (!plan) continue;
			if (start > cursor) {
				pieces.push({
					sourceStartMs: cursor,
					sourceEndMs: start,
					speed: clipSpeed,
					accelerated: false,
				});
			}
			for (const piece of plan.pieces) {
				pieces.push(piece.accelerated ? piece : { ...piece, speed: clipSpeed });
			}
			accelerated.push(plan.accelerated);
			cursor = end;
		}

		if (pieces.length === 0) {
			const shifted = {
				...clip,
				startMs: clip.startMs + timelineShift,
				endMs: clip.endMs + timelineShift,
			};
			nextClips.push(shifted);
			continue;
		}
		if (cursor < clipSourceEnd) {
			pieces.push({
				sourceStartMs: cursor,
				sourceEndMs: clipSourceEnd,
				speed: clipSpeed,
				accelerated: false,
			});
		}

		let timelineCursor = clip.startMs + timelineShift;
		for (const piece of pieces) {
			const displayMs = Math.max(
				1,
				Math.round((piece.sourceEndMs - piece.sourceStartMs) / piece.speed),
			);
			nextClips.push({
				...clip,
				id: `${idPrefix}-${++pieceCounter}`,
				startMs: timelineCursor,
				endMs: timelineCursor + displayMs,
				sourceStartMs: piece.sourceStartMs,
				speed: piece.speed,
				muted: piece.accelerated ? true : clip.muted,
			});
			timelineCursor += displayMs;
		}
		timelineShift = timelineCursor - clip.endMs;
	}

	return { clips: nextClips, accelerated };
}

/** Moves timeline-anchored regions (zooms, annotations, audio) along with a clip rebuild. */
export function remapTimelineSpan<T extends TimeSpan>(
	region: T,
	previousClips: ClipRegion[],
	nextClips: ClipRegion[],
): T {
	const sourceStart = mapTimelineTimeToSourceTime(region.startMs, previousClips);
	const sourceEnd = mapTimelineTimeToSourceTime(region.endMs, previousClips);
	const startMs = mapSourceTimeToTimelineTime(sourceStart, nextClips);
	const endMs = Math.max(startMs + 1, mapSourceTimeToTimelineTime(sourceEnd, nextClips));
	return { ...region, startMs, endMs };
}

/** Like `remapTimelineSpan` but keeps the duration (audio must not be stretched). */
export function remapTimelineStart<T extends TimeSpan>(
	region: T,
	previousClips: ClipRegion[],
	nextClips: ClipRegion[],
): T {
	const durationMs = region.endMs - region.startMs;
	const sourceStart = mapTimelineTimeToSourceTime(region.startMs, previousClips);
	const startMs = mapSourceTimeToTimelineTime(sourceStart, nextClips);
	return { ...region, startMs, endMs: startMs + durationMs };
}

/** Removes source ranges (e.g. agent "discard" markers for a retaken step) from the clips. */
export function cutSourceRanges(
	clips: ClipRegion[],
	ranges: readonly TimeSpan[],
	idPrefix = "clip-cut",
): ClipRegion[] {
	if (ranges.length === 0) return clips;
	const result: ClipRegion[] = [];
	let timelineShift = 0;
	let counter = 0;
	for (const clip of sortClipRegions(clips)) {
		const sourceStart = getClipSourceStartMs(clip);
		const sourceEnd = getClipSourceEndMs(clip);
		const speed = Number.isFinite(clip.speed) && clip.speed > 0 ? clip.speed : 1;
		const kept = subtractSpans({ startMs: sourceStart, endMs: sourceEnd }, ranges);
		let timelineCursor = clip.startMs + timelineShift;
		for (const [index, piece] of kept.entries()) {
			const displayMs = Math.max(1, Math.round((piece.endMs - piece.startMs) / speed));
			result.push({
				...clip,
				id: kept.length === 1 && index === 0 ? clip.id : `${idPrefix}-${++counter}`,
				startMs: timelineCursor,
				endMs: timelineCursor + displayMs,
				sourceStartMs: piece.startMs,
			});
			timelineCursor += displayMs;
		}
		timelineShift = timelineCursor - clip.endMs;
	}
	return result;
}
