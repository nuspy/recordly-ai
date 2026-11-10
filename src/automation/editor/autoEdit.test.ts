import { describe, expect, it } from "vitest";
import {
	type ClipRegion,
	getClipSourceEndMs,
	getClipSourceStartMs,
} from "@/components/video-editor/types";
import {
	cutSourceRanges,
	planIdleSpan,
	planIdleSpeedups,
	remapTimelineSpan,
	remapTimelineStart,
	subtractSpans,
} from "./autoEdit";

const OPTIONS = { targetMs: 10_000, keepMs: 1000, maxSpeed: 16 };
const fullClip = (durationMs: number): ClipRegion => ({
	id: "clip-1",
	startMs: 0,
	endMs: durationMs,
	speed: 1,
});

function expectContiguous(clips: ClipRegion[]) {
	for (let index = 1; index < clips.length; index++) {
		expect(clips[index].startMs).toBe(clips[index - 1].endMs);
	}
}

describe("planIdleSpan", () => {
	it("skips spans already shorter than the target", () => {
		expect(planIdleSpan({ startMs: 0, endMs: 9000 }, OPTIONS)).toBeNull();
	});

	it("compresses the core so the span lasts about the target", () => {
		const plan = planIdleSpan({ startMs: 10_000, endMs: 90_000 }, OPTIONS);
		expect(plan?.accelerated.speed).toBe(9.75);
		const outputMs = plan?.pieces.reduce(
			(sum, piece) => sum + (piece.sourceEndMs - piece.sourceStartMs) / piece.speed,
			0,
		);
		expect(outputMs).toBeCloseTo(10_000, 0);
	});

	it("cuts the middle when the needed speed exceeds the cap", () => {
		const plan = planIdleSpan({ startMs: 0, endMs: 300_000 }, OPTIONS);
		expect(plan?.accelerated.speed).toBe(16);
		expect(plan?.accelerated.cutSourceRange).toEqual({ startMs: 65_000, endMs: 235_000 });
		expect(plan?.accelerated.realDurationMs).toBe(300_000);
	});
});

describe("planIdleSpeedups", () => {
	it("splits a single full-track clip into contiguous normal and muted fast pieces", () => {
		const { clips, accelerated } = planIdleSpeedups({
			clips: [fullClip(120_000)],
			idle: [{ startMs: 20_000, endMs: 100_000 }],
			options: OPTIONS,
		});
		expectContiguous(clips);
		expect(accelerated).toHaveLength(1);
		const fast = clips.filter((clip) => clip.speed > 1);
		expect(fast).toHaveLength(1);
		expect(fast[0].muted).toBe(true);
		expect(getClipSourceStartMs(clips[0])).toBe(0);
		expect(getClipSourceEndMs(clips[clips.length - 1])).toBe(120_000);
		expect(clips[clips.length - 1].endMs).toBe(20_000 + 10_000 + 20_000);
	});

	it("never accelerates protected narration spans", () => {
		const { clips } = planIdleSpeedups({
			clips: [fullClip(200_000)],
			idle: [{ startMs: 0, endMs: 200_000 }],
			protect: [{ startMs: 90_000, endMs: 110_000 }],
			options: OPTIONS,
		});
		const narrationClip = clips.find(
			(clip) => getClipSourceStartMs(clip) <= 90_000 && getClipSourceEndMs(clip) >= 110_000,
		);
		expect(narrationClip?.speed).toBe(1);
		expect(subtractSpans({ startMs: 0, endMs: 10 }, [{ startMs: 2, endMs: 4 }])).toEqual([
			{ startMs: 0, endMs: 2 },
			{ startMs: 4, endMs: 10 },
		]);
	});

	it("keeps clips untouched when nothing is idle and preserves later clip gaps", () => {
		const clips: ClipRegion[] = [
			{ id: "a", startMs: 0, endMs: 60_000, speed: 1 },
			{ id: "b", startMs: 70_000, endMs: 80_000, sourceStartMs: 60_000, speed: 1 },
		];
		const plan = planIdleSpeedups({
			clips,
			idle: [{ startMs: 10_000, endMs: 50_000 }],
			options: OPTIONS,
		});
		const lastA = plan.clips.filter((clip) => clip.id !== "b").at(-1);
		const b = plan.clips.find((clip) => clip.id === "b");
		expect(b && lastA ? b.startMs - lastA.endMs : null).toBe(10_000);
		expect(planIdleSpeedups({ clips, idle: [], options: OPTIONS }).clips).toEqual(clips);
	});
});

describe("region remapping and cuts", () => {
	it("moves timeline regions with the rebuilt clips", () => {
		const previous = [fullClip(120_000)];
		const { clips } = planIdleSpeedups({
			clips: previous,
			idle: [{ startMs: 20_000, endMs: 100_000 }],
			options: OPTIONS,
		});
		const zoom = remapTimelineSpan({ startMs: 105_000, endMs: 110_000 }, previous, clips);
		expect(zoom).toEqual({ startMs: 35_000, endMs: 40_000 });
		const audio = remapTimelineStart({ startMs: 110_000, endMs: 113_000 }, previous, clips);
		expect(audio).toEqual({ startMs: 40_000, endMs: 43_000 });
	});

	it("removes discarded source ranges and closes the gap", () => {
		const clips = cutSourceRanges([fullClip(60_000)], [{ startMs: 10_000, endMs: 25_000 }]);
		expect(clips).toHaveLength(2);
		expectContiguous(clips);
		expect(clips[1].sourceStartMs).toBe(25_000);
		expect(clips[1].endMs).toBe(45_000);
	});
});
