import { describe, expect, it } from "vitest";
import { createEmptyJournal, type SessionJournal } from "../../../electron/automation/contract";
import {
	createSpeedBadgeAnnotations,
	getDiscardRanges,
	getJournalCalibrationShiftMs,
	mergeJournalIntoTimeline,
	zoomDepthForRect,
} from "./mergeJournal";

const AUTO_EDIT = {
	speedUpIdle: true,
	targetMs: 10_000,
	keepMs: 1000,
	maxSpeed: 16,
	speedBadge: true,
	presetId: null,
};

function journalWith(patch: Partial<SessionJournal>): SessionJournal {
	return { ...createEmptyJournal("s1"), clockMsAtStop: 120_000, ...patch };
}

const emptyTimeline = (durationMs: number) => ({
	clipRegions: [{ id: "clip-1", startMs: 0, endMs: durationMs, speed: 1 }],
	zoomRegions: [],
	annotationRegions: [],
	audioRegions: [],
	autoCaptions: [],
});

describe("journal calibration and markers", () => {
	it("uses small duration/clock differences as a constant offset", () => {
		expect(getJournalCalibrationShiftMs(journalWith({}), 120_040)).toBe(40);
		expect(getJournalCalibrationShiftMs(journalWith({}), 130_000)).toBe(0);
		expect(getJournalCalibrationShiftMs(journalWith({ clockMsAtStop: null }), 1)).toBe(0);
	});

	it("pairs discard markers into ranges", () => {
		expect(
			getDiscardRanges([
				{ id: "a", atMs: 1000, label: "", kind: "discard-start" },
				{ id: "b", atMs: 4000, label: "", kind: "discard-end" },
				{ id: "c", atMs: 5000, label: "", kind: "discard-end" },
			]),
		).toEqual([{ startMs: 1000, endMs: 4000 }]);
	});

	it("picks the deepest zoom that keeps the rectangle visible", () => {
		expect(zoomDepthForRect({ width: 1, height: 1 })).toBe(1);
		expect(zoomDepthForRect({ width: 0.3, height: 0.2 })).toBe(4);
	});
});

describe("mergeJournalIntoTimeline", () => {
	it("places narration after idle speed-ups and keeps it at normal speed", () => {
		const journal = journalWith({
			idle: [{ startMs: 20_000, endMs: 100_000 }],
			audio: [
				{ id: "n1", path: "C:/n1.wav", atMs: 105_000, durationMs: 3000, volume: 1 },
				{ id: "n2", path: "C:/n2.wav", atMs: 50_000, durationMs: 4000, volume: 1 },
			],
			captions: [{ id: "c1", startMs: 105_000, endMs: 108_000, text: "Ecco il risultato." }],
			autoEdit: AUTO_EDIT,
		});
		const result = mergeJournalIntoTimeline({
			journal,
			timeline: emptyTimeline(120_000),
			videoDurationMs: 120_000,
			applyAutoEdit: true,
		});
		expect(result.accelerated.length).toBeGreaterThan(0);
		expect(result.autoCaptions[0]).toMatchObject({ id: "ai-c1", startMs: 105_000 });
		const n1 = result.audioRegions.find((region) => region.id === "ai-n1");
		expect(n1?.endMs).toBe((n1?.startMs ?? 0) + 3000);
		expect(n1?.startMs).toBeLessThan(105_000);
		const narrationClip = result.clipRegions.find(
			(clip) =>
				(clip.sourceStartMs ?? clip.startMs) <= 50_000 &&
				(clip.sourceStartMs ?? clip.startMs) + (clip.endMs - clip.startMs) * clip.speed >=
					54_000,
		);
		expect(narrationClip?.speed).toBe(1);
	});

	it("is idempotent and does not re-run speed-ups when told not to", () => {
		const journal = journalWith({
			captions: [{ id: "c1", startMs: 1000, endMs: 2000, text: "Ciao" }],
			idle: [{ startMs: 20_000, endMs: 100_000 }],
			autoEdit: AUTO_EDIT,
		});
		const first = mergeJournalIntoTimeline({
			journal,
			timeline: emptyTimeline(120_000),
			videoDurationMs: 120_000,
			applyAutoEdit: true,
		});
		const second = mergeJournalIntoTimeline({
			journal,
			timeline: first,
			videoDurationMs: 120_000,
			applyAutoEdit: false,
		});
		expect(second.added.captions).toBe(0);
		expect(second.clipRegions).toEqual(first.clipRegions);
	});

	it("converts zooms, annotations and discards", () => {
		const result = mergeJournalIntoTimeline({
			journal: journalWith({
				markers: [
					{ id: "d1", atMs: 10_000, label: "retake", kind: "discard-start" },
					{ id: "d2", atMs: 20_000, label: "retake", kind: "discard-end" },
				],
				zooms: [
					{
						id: "z1",
						startMs: 30_000,
						endMs: 33_000,
						rect: { x: 0.1, y: 0.1, width: 0.3, height: 0.2 },
					},
				],
				annotations: [
					{
						id: "b1",
						startMs: 30_000,
						endMs: 40_000,
						type: "blur",
						rect: { x: 0.5, y: 0.5, width: 0.2, height: 0.1 },
					},
				],
			}),
			timeline: emptyTimeline(120_000),
			videoDurationMs: 120_000,
			applyAutoEdit: true,
		});
		expect(result.discardedMs).toBe(10_000);
		expect(result.zoomRegions[0]).toMatchObject({ id: "ai-z1", startMs: 20_000, depth: 4 });
		expect(result.annotationRegions[0]).toMatchObject({
			type: "blur",
			position: { x: 50, y: 50 },
			startMs: 20_000,
		});
	});

	it("never re-adds items the user deleted after the first merge", () => {
		const journal = journalWith({
			captions: [{ id: "c1", startMs: 1000, endMs: 2000, text: "Ciao" }],
			audio: [{ id: "n1", path: "C:/n1.wav", atMs: 1000, durationMs: 1000, volume: 1 }],
		});
		const first = mergeJournalIntoTimeline({
			journal,
			timeline: emptyTimeline(10_000),
			videoDurationMs: 10_000,
			applyAutoEdit: false,
		});
		expect(first.appliedIds.sort()).toEqual(["c1", "n1"]);
		const userDeletedEverything = { ...first, autoCaptions: [], audioRegions: [] };
		const reopened = mergeJournalIntoTimeline({
			journal,
			timeline: userDeletedEverything,
			videoDurationMs: 10_000,
			applyAutoEdit: false,
			alreadyApplied: new Set(first.appliedIds),
		});
		expect(reopened.added).toEqual({ captions: 0, audio: 0, zooms: 0, annotations: 0 });
		expect(reopened.audioRegions).toEqual([]);
	});

	it("drops narration recorded inside a discarded retake", () => {
		const result = mergeJournalIntoTimeline({
			journal: journalWith({
				markers: [
					{ id: "d1", atMs: 10_000, label: "retake", kind: "discard-start" },
					{ id: "d2", atMs: 20_000, label: "retake", kind: "discard-end" },
				],
				audio: [
					{ id: "bad", path: "C:/bad.wav", atMs: 12_000, durationMs: 2000, volume: 1 },
					{ id: "good", path: "C:/good.wav", atMs: 21_000, durationMs: 2000, volume: 1 },
				],
			}),
			timeline: emptyTimeline(60_000),
			videoDurationMs: 60_000,
			applyAutoEdit: true,
		});
		expect(result.audioRegions.map((region) => region.id)).toEqual(["ai-good"]);
		expect(result.appliedIds).toContain("bad");
	});

	it("creates honest speed badges", () => {
		const [badge] = createSpeedBadgeAnnotations(
			[
				{
					sourceStartMs: 1000,
					sourceEndMs: 299_000,
					cutSourceRange: null,
					speed: 16,
					realDurationMs: 300_000,
				},
			],
			[{ id: "c", startMs: 0, endMs: 400_000, speed: 1 }],
			10,
		);
		expect(badge.content).toBe("⏩ ×16 · 5:00");
	});
});
