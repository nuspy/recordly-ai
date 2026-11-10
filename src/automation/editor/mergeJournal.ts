import {
	type AnnotationRegion,
	type AudioRegion,
	type CaptionCue,
	type ClipRegion,
	DEFAULT_ANNOTATION_STYLE,
	mapSourceTimeToTimelineTime,
	ZOOM_DEPTH_SCALES,
	type ZoomDepth,
	type ZoomRegion,
} from "@/components/video-editor/types";
import type {
	AutoEditOptions,
	JournalMarker,
	SessionJournal,
} from "../../../electron/automation/contract";
import {
	type AcceleratedSpan,
	cutSourceRanges,
	planIdleSpeedups,
	remapTimelineSpan,
	remapTimelineStart,
	type TimeSpan,
} from "./autoEdit";

/** Prefix of every editor item created from a journal: merging is idempotent by id. */
export const JOURNAL_ITEM_PREFIX = "ai-";
const MAX_CALIBRATION_SHIFT_MS = 2500;

export interface EditorTimelineSlice {
	clipRegions: ClipRegion[];
	zoomRegions: ZoomRegion[];
	annotationRegions: AnnotationRegion[];
	audioRegions: AudioRegion[];
	autoCaptions: CaptionCue[];
}

export interface JournalMergeResult extends EditorTimelineSlice {
	added: { captions: number; audio: number; zooms: number; annotations: number };
	/** Journal ids merged (or deliberately skipped) by this call: never merge them again. */
	appliedIds: string[];
	accelerated: AcceleratedSpan[];
	discardedMs: number;
	autoEditApplied: boolean;
}

/**
 * Footage starts a few tens of ms before the renderer clock (native warm start), so the
 * difference between the video duration and the clock reading at stop is a constant offset.
 * Large differences mean something else is going on: then the journal is used as-is.
 */
export function getJournalCalibrationShiftMs(journal: SessionJournal, videoDurationMs: number) {
	if (journal.clockMsAtStop === null || !(videoDurationMs > 0)) return 0;
	const shift = videoDurationMs - journal.clockMsAtStop;
	return Math.abs(shift) <= MAX_CALIBRATION_SHIFT_MS ? Math.round(shift) : 0;
}

/** Source ranges between paired discard-start / discard-end markers (retaken steps). */
export function getDiscardRanges(markers: readonly JournalMarker[], shiftMs = 0): TimeSpan[] {
	const ranges: TimeSpan[] = [];
	let openStart: number | null = null;
	for (const marker of [...markers].sort((a, b) => a.atMs - b.atMs)) {
		if (marker.kind === "discard-start") {
			openStart ??= marker.atMs + shiftMs;
		} else if (marker.kind === "discard-end" && openStart !== null) {
			const endMs = marker.atMs + shiftMs;
			if (endMs > openStart) ranges.push({ startMs: openStart, endMs });
			openStart = null;
		}
	}
	return ranges;
}

export function zoomDepthForRect(rect: { width: number; height: number }): ZoomDepth {
	const fit = 1 / Math.max(0.05, rect.width, rect.height);
	let best: ZoomDepth = 1;
	for (const [depth, scale] of Object.entries(ZOOM_DEPTH_SCALES)) {
		if (scale <= fit) best = Number(depth) as ZoomDepth;
	}
	return best;
}

function pickAudioTrack(regions: readonly AudioRegion[], startMs: number, endMs: number) {
	for (let track = 0; track < 8; track++) {
		const overlaps = regions.some(
			(region) =>
				(region.trackIndex ?? 0) === track &&
				region.startMs < endMs &&
				region.endMs > startMs,
		);
		if (!overlaps) return track;
	}
	return 0;
}

const clampToDuration = (ms: number, durationMs: number) =>
	Math.max(0, durationMs > 0 ? Math.min(ms, durationMs) : ms);

/**
 * Merges what an agent sent during the recording (captions, narration audio, zooms,
 * annotations, discard markers, idle periods) into the editor timeline.
 * Journal times are recording time = source time; audio/zoom/annotation regions are placed
 * on the timeline after the idle speed-ups so they line up with what the viewer sees.
 */
export function mergeJournalIntoTimeline(input: {
	journal: SessionJournal;
	timeline: EditorTimelineSlice;
	videoDurationMs: number;
	applyAutoEdit: boolean;
	autoEditOptions?: AutoEditOptions | null;
	/**
	 * Journal ids merged by an earlier call. They are skipped even when the user deleted the
	 * resulting item, so removed captions/narration/zooms do not come back on reopen.
	 */
	alreadyApplied?: ReadonlySet<string>;
}): JournalMergeResult {
	const { journal, timeline, videoDurationMs } = input;
	const shift = getJournalCalibrationShiftMs(journal, videoDurationMs);
	const at = (ms: number) => clampToDuration(Math.round(ms + shift), videoDurationMs);
	const alreadyApplied = input.alreadyApplied ?? new Set<string>();
	const appliedIds: string[] = [];
	// Content recorded during a discarded retake must go with the cut footage; otherwise its
	// audio would snap to the cut boundary and play over the retake.
	const discardRanges = getDiscardRanges(journal.markers, shift);
	const inDiscard = (sourceMs: number) =>
		discardRanges.some((range) => sourceMs >= range.startMs && sourceMs < range.endMs);
	const shouldMerge = (journalId: string, prefixedIds: ReadonlySet<string>, sourceMs: number) => {
		if (alreadyApplied.has(journalId)) return false;
		appliedIds.push(journalId);
		if (prefixedIds.has(`${JOURNAL_ITEM_PREFIX}${journalId}`)) return false;
		return !inDiscard(sourceMs);
	};

	let clips = timeline.clipRegions;
	let zoomRegions = timeline.zoomRegions;
	let annotationRegions = timeline.annotationRegions;
	let audioRegions = timeline.audioRegions;
	let accelerated: AcceleratedSpan[] = [];
	let discardedMs = 0;

	const rebuildClips = (nextClips: ClipRegion[]) => {
		zoomRegions = zoomRegions.map((region) => remapTimelineSpan(region, clips, nextClips));
		annotationRegions = annotationRegions.map((region) =>
			remapTimelineSpan(region, clips, nextClips),
		);
		audioRegions = audioRegions.map((region) => remapTimelineStart(region, clips, nextClips));
		clips = nextClips;
	};

	if (input.applyAutoEdit && clips.length > 0) {
		if (discardRanges.length > 0) {
			discardedMs = discardRanges.reduce(
				(sum, range) => sum + range.endMs - range.startMs,
				0,
			);
			rebuildClips(cutSourceRanges(clips, discardRanges));
		}

		const options = input.autoEditOptions ?? journal.autoEdit;
		if (options?.speedUpIdle && journal.idle.length > 0) {
			const protect: TimeSpan[] = [
				...journal.audio.map((audio) => ({
					startMs: at(audio.atMs),
					endMs: at(audio.atMs + audio.durationMs),
				})),
				...journal.captions.map((caption) => ({
					startMs: at(caption.startMs),
					endMs: at(caption.endMs),
				})),
			];
			const plan = planIdleSpeedups({
				clips,
				idle: journal.idle.map((span) => ({
					startMs: at(span.startMs),
					endMs: at(span.endMs),
				})),
				protect,
				options: {
					targetMs: options.targetMs,
					keepMs: options.keepMs,
					maxSpeed: options.maxSpeed,
				},
			});
			if (plan.accelerated.length > 0) {
				accelerated = plan.accelerated;
				rebuildClips(plan.clips);
			}
		}
	}

	const added = { captions: 0, audio: 0, zooms: 0, annotations: 0 };

	const existingCaptionIds = new Set(timeline.autoCaptions.map((cue) => cue.id));
	const newCaptions: CaptionCue[] = [];
	for (const caption of journal.captions) {
		const id = `${JOURNAL_ITEM_PREFIX}${caption.id}`;
		if (!shouldMerge(caption.id, existingCaptionIds, at(caption.startMs))) continue;
		newCaptions.push({
			id,
			startMs: at(caption.startMs),
			endMs: Math.max(at(caption.startMs) + 1, at(caption.endMs)),
			text: caption.text,
			...(caption.words
				? {
						words: caption.words.map((word) => ({
							...word,
							startMs: at(word.startMs),
							endMs: at(word.endMs),
						})),
					}
				: {}),
		});
	}
	added.captions = newCaptions.length;
	const autoCaptions = [...timeline.autoCaptions, ...newCaptions].sort(
		(a, b) => a.startMs - b.startMs,
	);

	const existingAudioIds = new Set(audioRegions.map((region) => region.id));
	for (const audio of journal.audio) {
		const id = `${JOURNAL_ITEM_PREFIX}${audio.id}`;
		if (!shouldMerge(audio.id, existingAudioIds, at(audio.atMs))) continue;
		const startMs = mapSourceTimeToTimelineTime(at(audio.atMs), clips);
		const endMs = startMs + Math.max(1, Math.round(audio.durationMs));
		const trackIndex = audio.trackIndex ?? pickAudioTrack(audioRegions, startMs, endMs);
		audioRegions = [
			...audioRegions,
			{ id, startMs, endMs, audioPath: audio.path, volume: audio.volume, trackIndex },
		];
		added.audio++;
	}

	const existingZoomIds = new Set(zoomRegions.map((region) => region.id));
	for (const zoom of journal.zooms) {
		const id = `${JOURNAL_ITEM_PREFIX}${zoom.id}`;
		if (!shouldMerge(zoom.id, existingZoomIds, at(zoom.startMs))) continue;
		const startMs = mapSourceTimeToTimelineTime(at(zoom.startMs), clips);
		const endMs = Math.max(startMs + 1, mapSourceTimeToTimelineTime(at(zoom.endMs), clips));
		zoomRegions = [
			...zoomRegions,
			{
				id,
				startMs,
				endMs,
				depth: zoomDepthForRect(zoom.rect),
				focus: {
					cx: Math.min(1, Math.max(0, zoom.rect.x + zoom.rect.width / 2)),
					cy: Math.min(1, Math.max(0, zoom.rect.y + zoom.rect.height / 2)),
				},
				mode: "manual",
			},
		];
		added.zooms++;
	}

	const existingAnnotationIds = new Set(annotationRegions.map((region) => region.id));
	let zIndex = annotationRegions.reduce((max, region) => Math.max(max, region.zIndex), 0) + 1;
	for (const annotation of journal.annotations) {
		const id = `${JOURNAL_ITEM_PREFIX}${annotation.id}`;
		if (!shouldMerge(annotation.id, existingAnnotationIds, at(annotation.startMs))) continue;
		const startMs = mapSourceTimeToTimelineTime(at(annotation.startMs), clips);
		const endMs = Math.max(
			startMs + 1,
			mapSourceTimeToTimelineTime(at(annotation.endMs), clips),
		);
		const rect = annotation.rect ?? { x: 0.35, y: 0.05, width: 0.3, height: 0.12 };
		annotationRegions = [
			...annotationRegions,
			{
				id,
				startMs,
				endMs,
				type: annotation.type,
				content: annotation.text ?? "",
				...(annotation.type === "text" ? { textContent: annotation.text ?? "" } : {}),
				position: { x: rect.x * 100, y: rect.y * 100 },
				size: { width: rect.width * 100, height: rect.height * 100 },
				style: { ...DEFAULT_ANNOTATION_STYLE },
				zIndex: zIndex++,
				trackIndex: annotation.type === "blur" ? 1 : 0,
			},
		];
		added.annotations++;
	}

	return {
		clipRegions: clips,
		zoomRegions,
		annotationRegions,
		audioRegions,
		autoCaptions,
		added,
		appliedIds,
		accelerated,
		discardedMs,
		autoEditApplied: input.applyAutoEdit,
	};
}

/** Text badges for accelerated spans ("⏩ ×12 · 4:30"), placed on the rebuilt timeline. */
export function createSpeedBadgeAnnotations(
	accelerated: readonly AcceleratedSpan[],
	clips: ClipRegion[],
	startZIndex: number,
): AnnotationRegion[] {
	return accelerated.map((span, index) => {
		const seconds = Math.round(span.realDurationMs / 1000);
		const label = `⏩ ×${Math.round(span.speed)} · ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
		const startMs = mapSourceTimeToTimelineTime(span.sourceStartMs, clips);
		const endMs = Math.max(startMs + 500, mapSourceTimeToTimelineTime(span.sourceEndMs, clips));
		return {
			id: `${JOURNAL_ITEM_PREFIX}speed-badge-${index}-${Math.round(span.sourceStartMs)}`,
			startMs,
			endMs,
			type: "text",
			content: label,
			textContent: label,
			position: { x: 78, y: 4 },
			size: { width: 19, height: 8 },
			style: {
				...DEFAULT_ANNOTATION_STYLE,
				fontSize: 26,
				backgroundColor: "rgba(0, 0, 0, 0.55)",
			},
			zIndex: startZIndex + index,
			trackIndex: 2,
		};
	});
}
