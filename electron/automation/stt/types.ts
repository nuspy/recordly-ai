// Renderer-safe STT types shared by the main process, the preload API and the editor UI.
// Keep this file free of Node/Electron imports.

import type { SttBackendPreference } from "../contract";

export type ResolvedSttBackend = "bridge" | "local";

export interface SttSettings {
	sttBackend: SttBackendPreference;
	bridgeUrl: string;
	bridgeControlUrl: string;
	bridgeControlToken: string;
	bridgeBusyTimeoutSeconds: number;
	/** NVIDIA GPU (nvidia-smi UUID) whisper.cpp runs on; "" lets CUDA pick. */
	sttGpuId: string;
}

export interface SttGpuInfo {
	/** nvidia-smi UUID (`GPU-...`): the stable identifier stored in the settings. */
	id: string;
	index: number;
	name: string;
	memoryMiB: number | null;
	driverVersion: string | null;
	computeCapability: string | null;
}

export interface SttBridgeEngineInfo {
	model: string | null;
	device: string | null;
	loaded: boolean;
}

export interface SttBridgeStatus {
	preference: SttBackendPreference;
	reachable: boolean;
	sessionActive: boolean;
	sessionMode: string | null;
	/** STT engine as reported by CallAPICall's /engines/status (null when unavailable). */
	engine: SttBridgeEngineInfo | null;
	/** Backend a caption job would use right now (null: "bridge" preference, unreachable). */
	resolvedBackend: ResolvedSttBackend | null;
}

export interface SttResolveBackendResult {
	success: boolean;
	backend: ResolvedSttBackend | null;
	preference: SttBackendPreference;
	bridgeReachable: boolean | null;
	error?: string;
}

export type WhisperModelId = "small" | "large-v3-turbo-q5_0" | "large-v3-turbo";

export interface WhisperModelStatus {
	id: WhisperModelId;
	label: string;
	fileName: string;
	sizeBytes: number;
	installed: boolean;
	path: string;
	downloading: boolean;
}

export interface SttModelDownloadProgress {
	modelId: WhisperModelId;
	status: "idle" | "downloading" | "verifying" | "downloaded" | "error";
	progress: number;
	path?: string | null;
	error?: string;
}

export type CudaProbeReason =
	| "ok"
	| "no-kernel-image"
	| "cuda-error"
	| "no-cuda-device"
	| "missing-dll"
	| "timeout"
	| "failed";

export interface CudaProbeClassification {
	usable: boolean;
	reason: CudaProbeReason;
	detail: string | null;
	gpuName: string | null;
	computeCapability: string | null;
}

export interface CudaProbeRecord extends CudaProbeClassification {
	checkedAt: string;
	executablePath: string;
	executableMtimeMs: number;
	modelPath: string;
	/** GPU selection the verdict was obtained with ("" = automatic); absent in older records. */
	gpuId?: string;
}

export interface CudaRuntimeStatus {
	supported: boolean;
	installed: boolean;
	source: "download" | "source-build" | null;
	executablePath: string | null;
	version: string | null;
	probe: CudaProbeRecord | null;
	/** The probe passed for exactly this executable. */
	usable: boolean;
	downloading: boolean;
	asset: { name: string; sizeBytes: number; cudaVersion: string };
	hint: string | null;
}

export interface SttCudaDownloadProgress {
	status: "idle" | "downloading" | "verifying" | "installed" | "error";
	progress: number;
	error?: string;
}

export interface SttCaptionJobProgress {
	phase: "transcribing" | "waiting-bridge" | "local";
	segmentIndex?: number;
	segmentCount?: number;
	waitedMs?: number;
	reason?: string;
}

export type SttResult<T extends object = object> =
	| ({ success: true } & T)
	| { success: false; error: string };

/** Functions the preload exposes as `window.electronAPI.stt`. */
export interface SttPreloadApi {
	getSettings: () => Promise<SttResult<{ settings: SttSettings }>>;
	setSettings: (patch: Partial<SttSettings>) => Promise<SttResult<{ settings: SttSettings }>>;
	getBridgeStatus: () => Promise<SttResult<{ status: SttBridgeStatus }>>;
	resolveBackend: () => Promise<SttResolveBackendResult>;
	listModels: () => Promise<SttResult<{ models: WhisperModelStatus[] }>>;
	downloadModel: (modelId: WhisperModelId) => Promise<SttResult<{ path: string }>>;
	deleteModel: (modelId: WhisperModelId) => Promise<SttResult>;
	onModelDownloadProgress: (callback: (progress: SttModelDownloadProgress) => void) => () => void;
	listGpus: () => Promise<SttResult<{ gpus: SttGpuInfo[] }>>;
	getCudaStatus: () => Promise<SttResult<{ status: CudaRuntimeStatus }>>;
	downloadCudaRuntime: () => Promise<SttResult<{ status: CudaRuntimeStatus }>>;
	probeCudaRuntime: (
		modelPath: string,
	) => Promise<SttResult<{ probe: CudaProbeRecord; status: CudaRuntimeStatus }>>;
	deleteCudaRuntime: () => Promise<SttResult>;
	onCudaDownloadProgress: (callback: (progress: SttCudaDownloadProgress) => void) => () => void;
	onCaptionJobProgress: (callback: (progress: SttCaptionJobProgress) => void) => () => void;
}

export const STT_IPC = {
	getSettings: "stt:get-settings",
	setSettings: "stt:set-settings",
	getBridgeStatus: "stt:get-bridge-status",
	resolveBackend: "stt:resolve-backend",
	listModels: "stt:list-models",
	downloadModel: "stt:download-model",
	deleteModel: "stt:delete-model",
	modelDownloadProgress: "stt:model-download-progress",
	listGpus: "stt:list-gpus",
	getCudaStatus: "stt:get-cuda-status",
	downloadCudaRuntime: "stt:download-cuda-runtime",
	probeCudaRuntime: "stt:probe-cuda-runtime",
	deleteCudaRuntime: "stt:delete-cuda-runtime",
	cudaDownloadProgress: "stt:cuda-download-progress",
	captionJobProgress: "stt:caption-job-progress",
} as const;
