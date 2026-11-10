import { describe, expect, it, vi } from "vitest";
import type { CaptionCuePayload } from "../../ipc/types";
import type { SttJobPlan } from "./backend";
import type { BridgeTranscriberDeps } from "./bridgeTranscriber";
import { type CaptionTranscriptionDeps, transcribeCaptionAudio } from "./captionTranscription";
import { createSilentWav, parsePcmWav } from "./wav";

const localCue: CaptionCuePayload = {
	id: "caption-1",
	startMs: 500,
	endMs: 1500,
	text: "local",
	words: [{ text: "local", startMs: 500, endMs: 1500 }],
};

function setup(options: { busy?: boolean; strict?: boolean } = {}) {
	const written = new Map<string, Buffer>();
	let calls = 0;
	let now = 0;
	const bridgeDeps: BridgeTranscriberDeps = {
		now: () => now,
		sleep: async (ms) => {
			now += ms;
		},
		getSessionState: async () => ({ active: options.busy === true && calls++ > 0 }),
		transcribe: async () => ({
			text: "bridge",
			segments: [{ start_s: 0, end_s: 1, text: "bridge" }],
		}),
	};
	const deps: CaptionTranscriptionDeps = {
		readFile: async () => createSilentWav(45_000),
		writeFile: async (filePath, data) => {
			written.set(filePath, data);
		},
		rm: vi.fn(async () => undefined),
		createBridgeDeps: () => bridgeDeps,
	};
	const plan: SttJobPlan = {
		backend: "bridge",
		strict: options.strict ?? false,
		bridge: {
			bridgeUrl: "http://bridge",
			bridgeControlUrl: "http://control",
			busyTimeoutMs: 4_000,
		},
	};
	const transcribeLocal = vi.fn(async () => [localCue]);
	return { deps, plan, transcribeLocal, written };
}

describe("transcribeCaptionAudio", () => {
	it("uses whisper.cpp only when no plan is given", async () => {
		const { deps, transcribeLocal } = setup();
		const result = await transcribeCaptionAudio(
			{ wavPath: "/t/a.wav", getSilences: async () => [], transcribeLocal },
			deps,
		);
		expect(result).toEqual({ cues: [localCue], backend: "local" });
		expect(transcribeLocal).toHaveBeenCalledWith("/t/a.wav");
	});

	it("never touches whisper.cpp when the bridge completes", async () => {
		const { deps, plan, transcribeLocal } = setup();
		const result = await transcribeCaptionAudio(
			{ wavPath: "/t/a.wav", plan, getSilences: async () => [], transcribeLocal },
			deps,
		);
		expect(result.backend).toBe("bridge");
		expect(result.cues.map((cue) => cue.startMs)).toEqual([0, 30_000]);
		expect(transcribeLocal).not.toHaveBeenCalled();
	});

	it("transcribes the rest locally after a busy timeout in auto mode", async () => {
		const { deps, plan, transcribeLocal, written } = setup({ busy: true });
		const result = await transcribeCaptionAudio(
			{ wavPath: "/t/a.wav", plan, getSilences: async () => [], transcribeLocal },
			deps,
		);
		expect(transcribeLocal).toHaveBeenCalledWith("/t/a-tail.wav");
		expect(parsePcmWav(written.get("/t/a-tail.wav") as Buffer).durationMs).toBe(15_000);
		expect(result.backend).toBe("bridge");
		expect(result.fallback?.resumeAtMs).toBe(30_000);
		expect(result.cues.map((cue) => [cue.text, cue.startMs])).toEqual([
			["bridge", 0],
			["local", 30_500],
		]);
		expect(result.cues[1].words?.[0].startMs).toBe(30_500);
		expect(deps.rm).toHaveBeenCalledWith("/t/a-tail.wav");
	});

	it("fails instead of falling back in bridge-only mode", async () => {
		const { deps, plan, transcribeLocal } = setup({ busy: true, strict: true });
		await expect(
			transcribeCaptionAudio(
				{ wavPath: "/t/a.wav", plan, getSilences: async () => [], transcribeLocal },
				deps,
			),
		).rejects.toThrow(/stayed busy/);
		expect(transcribeLocal).not.toHaveBeenCalled();
	});
});
