import { describe, expect, it, vi } from "vitest";
import { waitForBridgeIdle } from "./busyWait";

function fakeClock() {
	let now = 0;
	return {
		now: () => now,
		sleep: vi.fn(async (ms: number) => {
			now += ms;
		}),
	};
}

describe("waitForBridgeIdle", () => {
	it("returns idle immediately when no session is active", async () => {
		const clock = fakeClock();
		const getSessionState = vi.fn(async () => ({ active: false }));
		expect(await waitForBridgeIdle({ ...clock, getSessionState }, { timeoutMs: 600_000 })).toBe(
			"idle",
		);
		expect(clock.sleep).not.toHaveBeenCalled();
	});

	it("polls every 2 s until the session ends", async () => {
		const clock = fakeClock();
		const states = [true, true, true, false];
		const getSessionState = vi.fn(async () => ({ active: states.shift() ?? false }));
		const onWaiting = vi.fn();
		const result = await waitForBridgeIdle(
			{ ...clock, getSessionState },
			{ timeoutMs: 600_000, onWaiting },
		);
		expect(result).toBe("idle");
		expect(clock.sleep.mock.calls.map(([ms]) => ms)).toEqual([2000, 2000, 2000]);
		expect(onWaiting).toHaveBeenLastCalledWith(4000);
	});

	it("times out once the budget is spent with the session still active", async () => {
		const clock = fakeClock();
		const getSessionState = vi.fn(async () => ({ active: true }));
		const result = await waitForBridgeIdle({ ...clock, getSessionState }, { timeoutMs: 5_000 });
		expect(result).toBe("timeout");
		expect(clock.now()).toBe(5_000);
		expect(clock.sleep.mock.calls.map(([ms]) => ms)).toEqual([2000, 2000, 1000]);
	});
});
