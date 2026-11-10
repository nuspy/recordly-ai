import { describe, expect, it, vi } from "vitest";
import { AutomationEventBus } from "./events";

describe("AutomationEventBus", () => {
	it("assigns increasing sequence numbers and filters by type and wildcard", () => {
		const bus = new AutomationEventBus();
		bus.publish("recording.started");
		bus.publish("idle.started", { atMs: 10 });
		bus.publish("idle.ended", { idleMs: 7000 });
		expect(bus.lastSeq).toBe(3);
		expect(bus.since(0, ["idle.ended"]).map((e) => e.seq)).toEqual([3]);
		expect(bus.since(1, ["idle.*"]).map((e) => e.type)).toEqual(["idle.started", "idle.ended"]);
	});

	it("keeps only the newest events within capacity", () => {
		const bus = new AutomationEventBus(2);
		bus.publish("a");
		bus.publish("b");
		bus.publish("c");
		expect(bus.since(0).map((e) => e.type)).toEqual(["b", "c"]);
	});

	it("waitNext returns an already published event immediately", async () => {
		const bus = new AutomationEventBus();
		bus.publish("idle.ended");
		await expect(bus.waitNext(0, ["idle.ended"], 10)).resolves.toMatchObject({ seq: 1 });
	});

	it("waitNext resolves on a later event and null on timeout", async () => {
		vi.useFakeTimers();
		try {
			const bus = new AutomationEventBus();
			const pending = bus.waitNext(0, ["idle.ended"], 1000);
			bus.publish("idle.started");
			bus.publish("idle.ended", { idleMs: 1 });
			await expect(pending).resolves.toMatchObject({ type: "idle.ended" });

			const timedOut = bus.waitNext(bus.lastSeq, ["export.done"], 1000);
			vi.advanceTimersByTime(1001);
			await expect(timedOut).resolves.toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});
});
