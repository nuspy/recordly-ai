import type { BridgeEndpoints } from "../bridgeClient";
import type { AutomationSettings, SttBackendPreference } from "../contract";
import type { BridgeJobProgress } from "./bridgeTranscriber";
import type { ResolvedSttBackend, SttBridgeEngineInfo } from "./types";

export type { ResolvedSttBackend };

export interface SttBridgeConfig extends BridgeEndpoints {
	busyTimeoutMs: number;
}

export type SttJobProgress = BridgeJobProgress | { phase: "local"; reason?: string };

/** How one caption job transcribes; resolved once per job, shared by mic and system tracks. */
export interface SttJobPlan {
	backend: ResolvedSttBackend;
	/** "bridge" preference: never fall back to whisper.cpp. */
	strict: boolean;
	bridge: SttBridgeConfig | null;
	/** A CUDA whisper-cli that passed its probe; used instead of the CPU runtime when set. */
	cudaExecutablePath?: string | null;
	/** Extra environment for the CUDA runtime only (selects the GPU); the CPU runtime ignores it. */
	cudaEnv?: Record<string, string>;
	/** Called when the CUDA runtime fails mid-job; the job then retries on the CPU runtime. */
	onCudaFailure?: (error: unknown) => Promise<void> | void;
	onProgress?: (progress: SttJobProgress) => void;
}

export class SttBackendError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SttBackendError";
	}
}

export function getSttBridgeConfig(settings: AutomationSettings): SttBridgeConfig {
	return {
		bridgeUrl: settings.bridgeUrl,
		bridgeControlUrl: settings.bridgeControlUrl,
		bridgeControlToken: settings.bridgeControlToken,
		busyTimeoutMs: Math.round(settings.bridgeBusyTimeoutSeconds * 1000),
	};
}

export interface ResolvedSttBackendInfo {
	backend: ResolvedSttBackend;
	strict: boolean;
	/** null when the preference did not require probing the bridge. */
	bridgeReachable: boolean | null;
}

export async function resolveSttBackend(
	preference: SttBackendPreference,
	deps: { isBridgeReachable: () => Promise<boolean>; bridgeUrl?: string },
): Promise<ResolvedSttBackendInfo> {
	if (preference === "local") {
		return { backend: "local", strict: false, bridgeReachable: null };
	}
	const reachable = await deps.isBridgeReachable().catch(() => false);
	if (preference === "bridge") {
		if (!reachable) {
			throw new SttBackendError(
				`The CallAPICall bridge is not reachable${deps.bridgeUrl ? ` at ${deps.bridgeUrl}` : ""}. ` +
					"Start CallAPICall, or switch the transcription backend to Auto or Local in Caption settings.",
			);
		}
		return { backend: "bridge", strict: true, bridgeReachable: true };
	}
	return { backend: reachable ? "bridge" : "local", strict: false, bridgeReachable: reachable };
}

/** The STT part of CallAPICall's GET /engines/status (`{stt: {model, running_on, ...}}`). */
export function parseBridgeEngineInfo(raw: unknown): SttBridgeEngineInfo | null {
	if (!raw || typeof raw !== "object") return null;
	const stt = (raw as Record<string, unknown>).stt;
	if (!stt || typeof stt !== "object") return null;
	const info = stt as Record<string, unknown>;
	const text = (value: unknown) =>
		typeof value === "string" && value.trim() ? value.trim() : null;
	const loaded = info.loaded === true;
	return {
		model: text(info.model),
		device: loaded
			? (text(info.running_on) ?? text(info.would_load_on))
			: text(info.would_load_on),
		loaded,
	};
}
