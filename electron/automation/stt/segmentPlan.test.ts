import { describe, expect, it } from "vitest";
import { planAudioSegments } from "./segmentPlan";

const lengths = (segments: { startMs: number; endMs: number }[]) =>
	segments.map((segment) => segment.endMs - segment.startMs);

describe("planAudioSegments", () => {
	it("returns one segment for short audio", () => {
		expect(planAudioSegments(12_000, [])).toEqual([{ startMs: 0, endMs: 12_000 }]);
	});

	it("hard-cuts at 30 s without silences", () => {
		expect(planAudioSegments(75_000, null)).toEqual([
			{ startMs: 0, endMs: 30_000 },
			{ startMs: 30_000, endMs: 60_000 },
			{ startMs: 60_000, endMs: 75_000 },
		]);
	});

	it("cuts inside the latest silence that keeps the segment within 30 s", () => {
		const segments = planAudioSegments(70_000, [
			{ startMs: 10_000, endMs: 11_000 },
			{ startMs: 24_000, endMs: 26_000 },
			{ startMs: 52_000, endMs: 53_000 },
		]);
		expect(segments[0]).toEqual({ startMs: 0, endMs: 25_000 });
		expect(segments[1]).toEqual({ startMs: 25_000, endMs: 52_500 });
		expect(lengths(segments).every((length) => length <= 30_000)).toBe(true);
		expect(segments[segments.length - 1].endMs).toBe(70_000);
	});

	it("cuts at the limit when a silence straddles it", () => {
		const segments = planAudioSegments(50_000, [{ startMs: 28_000, endMs: 40_000 }]);
		expect(segments[0]).toEqual({ startMs: 0, endMs: 30_000 });
	});

	it("ignores silences too close to the segment start", () => {
		const segments = planAudioSegments(40_000, [{ startMs: 1_000, endMs: 2_000 }]);
		expect(segments[0]).toEqual({ startMs: 0, endMs: 30_000 });
	});

	it("skips segments that lie entirely inside a silence, and tiny tails", () => {
		expect(planAudioSegments(90_100, [{ startMs: 29_000, endMs: 90_100 }])).toEqual([
			{ startMs: 0, endMs: 30_000 },
		]);
		expect(planAudioSegments(30_100, [])).toEqual([{ startMs: 0, endMs: 30_000 }]);
	});

	it("handles an unbounded trailing silence from silencedetect", () => {
		const segments = planAudioSegments(45_000, [
			{ startMs: 20_000, endMs: Number.POSITIVE_INFINITY },
		]);
		expect(segments).toEqual([{ startMs: 0, endMs: 30_000 }]);
	});
});
