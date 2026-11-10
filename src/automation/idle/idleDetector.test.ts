import { describe, expect, it } from "vitest";
import { buildIgnoreMask, changedFraction, rgbaToLuma } from "./frameDiff";
import { IdleDetector } from "./idleDetector";

describe("frame diff", () => {
	it("computes luma and the changed fraction, honoring ignore masks", () => {
		const a = rgbaToLuma(new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 255]));
		const b = rgbaToLuma(new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255]));
		expect(changedFraction(a, b, null)).toBe(0.5);
		const mask = buildIgnoreMask(2, 1, [{ x: 0, y: 0, width: 0.5, height: 1 }]);
		expect(Array.from(mask)).toEqual([0, 1]);
		expect(changedFraction(a, b, mask)).toBe(0);
	});
});

describe("IdleDetector", () => {
	it("reports idle after the threshold and the full dead interval when change resumes", () => {
		const detector = new IdleDetector({ idleAfterMs: 6000, changeThreshold: 0.01 });
		expect(detector.push(0, 0)).toEqual([]);
		expect(detector.push(1000, 0.5)).toEqual([]);
		expect(detector.push(6500, 0)).toEqual([]);
		expect(detector.push(7000, 0)).toEqual([
			{ type: "idle.started", atMs: 7000, lastChangeMs: 1000 },
		]);
		expect(detector.push(60_000, 0.001)).toEqual([]);
		expect(detector.push(61_000, 0.2)).toEqual([
			{ type: "idle.ended", atMs: 61_000, startMs: 1000, endMs: 61_000, idleMs: 60_000 },
		]);
		expect(detector.isIdle).toBe(false);
	});

	it("needs confirmed changes to end idle and flushes on stop", () => {
		const detector = new IdleDetector({
			idleAfterMs: 1000,
			changeThreshold: 0.01,
			changeConfirmSamples: 2,
		});
		detector.push(0, 0);
		detector.push(2000, 0);
		expect(detector.push(3000, 0.5)).toEqual([]);
		expect(detector.push(3500, 0)).toEqual([]);
		expect(detector.isIdle).toBe(true);
		expect(detector.flush(5000)).toEqual([
			{ type: "idle.ended", atMs: 5000, startMs: 0, endMs: 5000, idleMs: 5000 },
		]);
	});
});
