import { describe, expect, it, vi } from "vitest";
import type { BridgeTranscript } from "../bridgeClient";
import { type BridgeTranscriberDeps, transcribeWavWithBridge } from "./bridgeTranscriber";
import { createSilentWav, parsePcmWav } from "./wav";

function makeDeps(overrides: Partial<BridgeTranscriberDeps> = {}) {
	let now = 0;
	const deps: BridgeTranscriberDeps = {
		now: () => now,
		sleep: vi.fn(async (ms: number) => {
			now += ms;
		}),
		getSessionState: vi.fn(async () => ({ active: false })),
		transcribe: vi.fn(
			async (): Promise<BridgeTranscript> => ({
				text: "Hi.",
				segments: [
					{
						start_s: 1,
						end_s: 2,
						text: "Hi.",
						words: [{ start_s: 1, end_s: 2, text: " Hi." }],
					},
				],
			}),
		),
		...overrides,
	};
	return deps;
}

describe("transcribeWavWithBridge", () => {
	it("transcribes every ≤30 s segment and offsets the cues", async () => {
		const deps = makeDeps();
		const result = await transcribeWavWithBridge(
			{ wav: createSilentWav(65_000), silences: [], language: "it", busyTimeoutMs: 600_000 },
			deps,
		);
		expect(result.completed).toBe(true);
		expect(deps.transcribe).toHaveBeenCalledTimes(3);
		expect(deps.getSessionState).toHaveBeenCalledTimes(3);
		const uploaded = vi
			.mocked(deps.transcribe)
			.mock.calls.map(([wav]) => parsePcmWav(wav).durationMs);
		expect(uploaded).toEqual([30_000, 30_000, 5_000]);
		expect(vi.mocked(deps.transcribe).mock.calls[0][1]).toEqual({ language: "it" });
		expect(result.cues.map((cue) => cue.startMs)).toEqual([1_000, 31_000, 61_000]);
		expect(result.cues[2].words?.[0]).toEqual({ text: "Hi.", startMs: 61_000, endMs: 62_000 });
	});

	it("waits for an active voice session before each segment", async () => {
		const states = [true, true, false, false];
		const deps = makeDeps({
			getSessionState: vi.fn(async () => ({ active: states.shift() ?? false })),
		});
		const onProgress = vi.fn();
		const result = await transcribeWavWithBridge(
			{ wav: createSilentWav(40_000), silences: null, busyTimeoutMs: 600_000, onProgress },
			deps,
		);
		expect(result.completed).toBe(true);
		expect(deps.sleep).toHaveBeenCalledTimes(2);
		expect(onProgress).toHaveBeenCalledWith(
			expect.objectContaining({ phase: "waiting-bridge", segmentIndex: 0 }),
		);
	});

	it("stops at the busy segment after the timeout and reports where to resume", async () => {
		let calls = 0;
		const deps = makeDeps({
			// Idle for the first segment, then a call starts and never ends.
			getSessionState: vi.fn(async () => ({ active: calls++ > 0 })),
		});
		const result = await transcribeWavWithBridge(
			{ wav: createSilentWav(65_000), silences: [], busyTimeoutMs: 10_000 },
			deps,
		);
		expect(result).toMatchObject({
			completed: false,
			reason: "busy-timeout",
			resumeAtMs: 30_000,
		});
		expect(result.cues).toHaveLength(1);
		expect(deps.transcribe).toHaveBeenCalledTimes(1);
	});

	it("reports a bridge failure with the segment to resume from", async () => {
		const deps = makeDeps({
			transcribe: vi.fn(async () => {
				throw new Error("HTTP 500");
			}),
		});
		const result = await transcribeWavWithBridge(
			{ wav: createSilentWav(10_000), silences: [], busyTimeoutMs: 1_000 },
			deps,
		);
		expect(result).toMatchObject({
			completed: false,
			reason: "bridge-error",
			resumeAtMs: 0,
			error: "HTTP 500",
		});
	});
});
