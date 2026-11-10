import path from "node:path";
import { app } from "electron";
import {
	WHISPER_CUDA_RUNTIME_DIR,
	WHISPER_MODEL_DIR,
	WHISPER_RUNTIME_DIR,
} from "../../ipc/constants";
import { getPrebundledNativeHelperPath } from "../../ipc/paths/binaries";
import { getBridgeEngineStatus, getBridgeSessionState, isBridgeReachable } from "../bridgeClient";
import type { AutomationSettings } from "../contract";
import { readAutomationSettings, writeAutomationSettings } from "../settings";
import {
	getSttBridgeConfig,
	parseBridgeEngineInfo,
	resolveSttBackend,
	type SttJobPlan,
	type SttJobProgress,
} from "./backend";
import {
	type CudaRuntimePaths,
	getCudaRuntimeStatus,
	recordCudaRuntimeFailure,
	resolveCudaExecutableForJob,
} from "./cudaRuntime";
import { buildCudaDeviceEnv } from "./gpus";
import type { SttBridgeStatus, SttResolveBackendResult, SttSettings } from "./types";

export const STT_MODEL_DIR = WHISPER_MODEL_DIR;

export function getCudaRuntimePaths(): CudaRuntimePaths {
	return {
		downloadDir: WHISPER_CUDA_RUNTIME_DIR,
		probeFile: path.join(WHISPER_RUNTIME_DIR, "cuda-probe.json"),
		// Optional `WHISPER_RUNTIME_CUDA=1` source build (sm_120-capable) staged next to the
		// bundled CPU runtime; it wins over the downloaded release when present.
		sourceBuildExecutable:
			process.platform === "win32"
				? getPrebundledNativeHelperPath("whisper-cli.exe", "win32-x64-cuda")
				: null,
		tempDir: app.getPath("temp"),
		gpuId: readAutomationSettings().sttGpuId,
	};
}

export function pickSttSettings(settings: AutomationSettings): SttSettings {
	return {
		sttBackend: settings.sttBackend,
		bridgeUrl: settings.bridgeUrl,
		bridgeControlUrl: settings.bridgeControlUrl,
		bridgeControlToken: settings.bridgeControlToken,
		bridgeBusyTimeoutSeconds: settings.bridgeBusyTimeoutSeconds,
		sttGpuId: settings.sttGpuId,
	};
}

export function readSttSettings(): SttSettings {
	return pickSttSettings(readAutomationSettings());
}

export function writeSttSettings(patch: Partial<SttSettings>): SttSettings {
	const allowed: Partial<SttSettings> = {};
	const input = (patch ?? {}) as Record<string, unknown>;
	for (const key of [
		"sttBackend",
		"bridgeUrl",
		"bridgeControlUrl",
		"bridgeControlToken",
		"bridgeBusyTimeoutSeconds",
		"sttGpuId",
	] as const) {
		if (key in input) (allowed as Record<string, unknown>)[key] = input[key];
	}
	return pickSttSettings(writeAutomationSettings(allowed));
}

export async function resolveSttBackendNow(): Promise<SttResolveBackendResult> {
	const settings = readAutomationSettings();
	const bridge = getSttBridgeConfig(settings);
	try {
		const resolved = await resolveSttBackend(settings.sttBackend, {
			isBridgeReachable: () => isBridgeReachable(bridge),
			bridgeUrl: bridge.bridgeUrl,
		});
		return {
			success: true,
			backend: resolved.backend,
			preference: settings.sttBackend,
			bridgeReachable: resolved.bridgeReachable,
		};
	} catch (error) {
		return {
			success: false,
			backend: null,
			preference: settings.sttBackend,
			bridgeReachable: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export async function getSttBridgeStatus(): Promise<SttBridgeStatus> {
	const settings = readAutomationSettings();
	const bridge = getSttBridgeConfig(settings);
	const reachable = await isBridgeReachable(bridge);
	const [session, engine] = reachable
		? await Promise.all([
				getBridgeSessionState(bridge),
				getBridgeEngineStatus(bridge)
					.then(parseBridgeEngineInfo)
					.catch(() => null),
			])
		: [{ active: false, mode: null }, null];
	return {
		preference: settings.sttBackend,
		reachable,
		sessionActive: session.active,
		sessionMode: session.mode ?? null,
		engine,
		resolvedBackend:
			settings.sttBackend === "local"
				? "local"
				: reachable
					? "bridge"
					: settings.sttBackend === "auto"
						? "local"
						: null,
	};
}

/** Resolve the backend (and the CUDA runtime for whisper.cpp) once for a caption job. */
export async function createSttJobPlan(options: {
	whisperModelPath?: string | null;
	whisperExecutablePath?: string | null;
	onProgress?: (progress: SttJobProgress) => void;
}): Promise<SttJobPlan> {
	const settings = readAutomationSettings();
	const bridge = getSttBridgeConfig(settings);
	const resolved = await resolveSttBackend(settings.sttBackend, {
		isBridgeReachable: () => isBridgeReachable(bridge),
		bridgeUrl: bridge.bridgeUrl,
	});

	const cudaPaths = getCudaRuntimePaths();
	let cudaExecutablePath: string | null = null;
	if (!options.whisperExecutablePath?.trim()) {
		try {
			if (resolved.backend === "local") {
				cudaExecutablePath = await resolveCudaExecutableForJob(
					cudaPaths,
					options.whisperModelPath,
				);
			} else {
				// A bridge job must not spawn a probe (it would load a model into VRAM); only an
				// already-verified runtime is used if the job falls back to whisper.cpp.
				const status = await getCudaRuntimeStatus(cudaPaths);
				cudaExecutablePath = status.usable ? status.executablePath : null;
			}
		} catch (error) {
			console.warn("[auto-captions] CUDA runtime unavailable, using CPU:", error);
		}
	}

	return {
		backend: resolved.backend,
		strict: resolved.strict,
		bridge: resolved.backend === "bridge" ? bridge : null,
		cudaExecutablePath,
		cudaEnv: buildCudaDeviceEnv(settings.sttGpuId),
		onCudaFailure: async (error) => {
			await recordCudaRuntimeFailure(cudaPaths, error).catch(() => null);
		},
		onProgress: options.onProgress,
	};
}
