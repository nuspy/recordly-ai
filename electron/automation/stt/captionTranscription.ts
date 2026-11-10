import fs from "node:fs/promises";
import type { SilenceInterval } from "../../ipc/captions/silence";
import type { CaptionCuePayload } from "../../ipc/types";
import { type BridgeEndpoints, getBridgeSessionState, transcribeWithBridge } from "../bridgeClient";
import type { ResolvedSttBackend, SttJobPlan } from "./backend";
import { type BridgeTranscriberDeps, transcribeWavWithBridge } from "./bridgeTranscriber";
import { realClock } from "./busyWait";
import { parsePcmWav, sliceWav } from "./wav";

export function createBridgeTranscriberDeps(endpoints: BridgeEndpoints): BridgeTranscriberDeps {
	return {
		...realClock,
		getSessionState: () => getBridgeSessionState(endpoints),
		transcribe: (wav, options) => transcribeWithBridge(endpoints, wav, options),
	};
}

export interface CaptionTranscriptionDeps {
	readFile: (filePath: string) => Promise<Buffer>;
	writeFile: (filePath: string, data: Buffer) => Promise<void>;
	rm: (filePath: string) => Promise<void>;
	createBridgeDeps: (endpoints: BridgeEndpoints) => BridgeTranscriberDeps;
}

const defaultDeps: CaptionTranscriptionDeps = {
	readFile: (filePath) => fs.readFile(filePath),
	writeFile: (filePath, data) => fs.writeFile(filePath, data),
	rm: (filePath) => fs.rm(filePath, { force: true }),
	createBridgeDeps: createBridgeTranscriberDeps,
};

export interface CaptionTranscriptionResult {
	cues: CaptionCuePayload[];
	backend: ResolvedSttBackend;
	/** Set when the bridge job stopped early and whisper.cpp transcribed the rest. */
	fallback?: { reason: string; resumeAtMs: number };
}

function shiftCues(cues: CaptionCuePayload[], offsetMs: number): CaptionCuePayload[] {
	if (offsetMs === 0) return cues;
	return cues.map((cue) => ({
		...cue,
		startMs: cue.startMs + offsetMs,
		endMs: cue.endMs + offsetMs,
		...(cue.words
			? {
					words: cue.words.map((word) => ({
						...word,
						startMs: word.startMs + offsetMs,
						endMs: word.endMs + offsetMs,
					})),
				}
			: {}),
	}));
}

/**
 * Raw (not yet phrase-segmented) cues for one extracted 16 kHz WAV, from whichever backend
 * the job plan selected. Without a plan this is exactly the historical whisper.cpp path.
 */
export async function transcribeCaptionAudio(
	input: {
		wavPath: string;
		language?: string;
		plan?: SttJobPlan;
		getSilences: () => Promise<SilenceInterval[] | null>;
		transcribeLocal: (wavPath: string) => Promise<CaptionCuePayload[]>;
	},
	deps: CaptionTranscriptionDeps = defaultDeps,
): Promise<CaptionTranscriptionResult> {
	const plan = input.plan;
	if (!plan || plan.backend === "local" || !plan.bridge) {
		return { cues: await input.transcribeLocal(input.wavPath), backend: "local" };
	}

	const wav = await deps.readFile(input.wavPath);
	const result = await transcribeWavWithBridge(
		{
			wav,
			silences: await input.getSilences(),
			language: input.language,
			busyTimeoutMs: plan.bridge.busyTimeoutMs,
			onProgress: plan.onProgress,
		},
		deps.createBridgeDeps(plan.bridge),
	);
	if (result.completed) {
		return { cues: result.cues, backend: "bridge" };
	}

	const timeoutSeconds = Math.round(plan.bridge.busyTimeoutMs / 1000);
	const reason =
		result.reason === "busy-timeout"
			? `CallAPICall stayed busy with a voice session for ${timeoutSeconds} s`
			: `CallAPICall transcription failed: ${result.error ?? "unknown error"}`;
	if (plan.strict) {
		throw new Error(
			`${reason}. Captions were not generated; retry later or switch the transcription backend to Auto or Local.`,
		);
	}

	console.warn(`[auto-captions] ${reason}; transcribing the rest with whisper.cpp.`);
	plan.onProgress?.({ phase: "local", reason });
	const fallback = { reason, resumeAtMs: result.resumeAtMs };
	if (result.resumeAtMs <= 0) {
		return { cues: await input.transcribeLocal(input.wavPath), backend: "local", fallback };
	}

	const info = parsePcmWav(wav);
	const tailPath = input.wavPath.replace(/(\.wav)?$/i, "-tail.wav");
	try {
		await deps.writeFile(tailPath, sliceWav(wav, info, result.resumeAtMs, info.durationMs));
		const tailCues = shiftCues(await input.transcribeLocal(tailPath), result.resumeAtMs);
		return { cues: [...result.cues, ...tailCues], backend: "bridge", fallback };
	} finally {
		await deps.rm(tailPath).catch(() => undefined);
	}
}
