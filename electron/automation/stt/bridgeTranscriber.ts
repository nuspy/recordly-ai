import type { SilenceInterval } from "../../ipc/captions/silence";
import type { CaptionCuePayload } from "../../ipc/types";
import type { BridgeTranscript } from "../bridgeClient";
import { mapBridgeTranscriptToCues } from "./bridgeMapping";
import { type BusyWaitDeps, waitForBridgeIdle } from "./busyWait";
import { BRIDGE_MAX_SEGMENT_MS, planAudioSegments } from "./segmentPlan";
import { parsePcmWav, sliceWav } from "./wav";

export interface BridgeTranscriberDeps extends BusyWaitDeps {
	transcribe: (wav: Buffer, options: { language?: string | null }) => Promise<BridgeTranscript>;
}

export interface BridgeJobProgress {
	phase: "transcribing" | "waiting-bridge";
	segmentIndex: number;
	segmentCount: number;
	waitedMs?: number;
}

export type BridgeTranscriptionResult =
	| { completed: true; cues: CaptionCuePayload[] }
	| {
			completed: false;
			/** Cues for the audio before `resumeAtMs`, already transcribed by the bridge. */
			cues: CaptionCuePayload[];
			resumeAtMs: number;
			reason: "busy-timeout" | "bridge-error";
			error?: string;
	  };

/**
 * Transcribe a 16 kHz mono WAV through the CallAPICall bridge in ≤30 s segments cut at
 * silences. Before every segment the bridge's voice-session state is checked: a live call
 * keeps priority, and if it stays busy past `busyTimeoutMs` (or the bridge fails) the job
 * stops and reports where another backend should resume.
 */
export async function transcribeWavWithBridge(
	input: {
		wav: Buffer;
		silences: SilenceInterval[] | null;
		language?: string | null;
		busyTimeoutMs: number;
		maxSegmentMs?: number;
		onProgress?: (progress: BridgeJobProgress) => void;
	},
	deps: BridgeTranscriberDeps,
): Promise<BridgeTranscriptionResult> {
	const info = parsePcmWav(input.wav);
	const segments = planAudioSegments(info.durationMs, input.silences, {
		maxSegmentMs: input.maxSegmentMs ?? BRIDGE_MAX_SEGMENT_MS,
	});
	const cues: CaptionCuePayload[] = [];

	for (const [segmentIndex, segment] of segments.entries()) {
		const segmentCount = segments.length;
		const waited = await waitForBridgeIdle(deps, {
			timeoutMs: input.busyTimeoutMs,
			onWaiting: (waitedMs) =>
				input.onProgress?.({
					phase: "waiting-bridge",
					segmentIndex,
					segmentCount,
					waitedMs,
				}),
		});
		if (waited === "timeout") {
			return { completed: false, cues, resumeAtMs: segment.startMs, reason: "busy-timeout" };
		}

		input.onProgress?.({ phase: "transcribing", segmentIndex, segmentCount });
		let transcript: BridgeTranscript;
		try {
			transcript = await deps.transcribe(
				sliceWav(input.wav, info, segment.startMs, segment.endMs),
				{ language: input.language },
			);
		} catch (error) {
			return {
				completed: false,
				cues,
				resumeAtMs: segment.startMs,
				reason: "bridge-error",
				error: error instanceof Error ? error.message : String(error),
			};
		}
		cues.push(...mapBridgeTranscriptToCues(transcript, segment.startMs, segment.endMs));
	}

	return { completed: true, cues };
}
