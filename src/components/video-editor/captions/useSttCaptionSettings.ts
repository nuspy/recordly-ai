import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "@/components/ui/toast";
import type { SttBackendPreference } from "../../../../electron/automation/contract";
import type {
	CudaRuntimeStatus,
	SttBridgeStatus,
	SttCaptionJobProgress,
	SttCudaDownloadProgress,
	SttGpuInfo,
	SttModelDownloadProgress,
	SttSettings,
	WhisperModelId,
	WhisperModelStatus,
} from "../../../../electron/automation/stt/types";
import { getSttApi } from "./sttApi";

const BRIDGE_POLL_MS = 10_000;

interface Params {
	whisperModelPath: string | null | undefined;
	onUseWhisperModel?: (modelPath: string | null) => void;
	isGeneratingCaptions: boolean;
	onBridgeReadyChange?: (ready: boolean) => void;
}

export function useSttCaptionSettings({
	whisperModelPath,
	onUseWhisperModel,
	isGeneratingCaptions,
	onBridgeReadyChange,
}: Params) {
	const api = useMemo(() => getSttApi(), []);
	const [settings, setSettings] = useState<SttSettings | null>(null);
	const [bridge, setBridge] = useState<SttBridgeStatus | null>(null);
	const [bridgeLoading, setBridgeLoading] = useState(false);
	const [models, setModels] = useState<WhisperModelStatus[]>([]);
	const [modelProgress, setModelProgress] = useState<
		Partial<Record<WhisperModelId, SttModelDownloadProgress>>
	>({});
	const [cuda, setCuda] = useState<CudaRuntimeStatus | null>(null);
	const [cudaProgress, setCudaProgress] = useState<SttCudaDownloadProgress | null>(null);
	const [cudaBusy, setCudaBusy] = useState(false);
	const [gpus, setGpus] = useState<SttGpuInfo[]>([]);
	const [jobProgress, setJobProgress] = useState<SttCaptionJobProgress | null>(null);

	const refreshBridge = useCallback(async () => {
		if (!api) return;
		setBridgeLoading(true);
		try {
			const result = await api.getBridgeStatus();
			if (result.success) setBridge(result.status);
		} finally {
			setBridgeLoading(false);
		}
	}, [api]);

	const refreshModels = useCallback(async () => {
		const result = await api?.listModels();
		if (result?.success) setModels(result.models);
	}, [api]);

	const refreshCuda = useCallback(async () => {
		const result = await api?.getCudaStatus();
		if (result?.success) setCuda(result.status);
	}, [api]);

	const refreshGpus = useCallback(async () => {
		const result = await api?.listGpus();
		if (result?.success) setGpus(result.gpus);
	}, [api]);

	useEffect(() => {
		if (!api) return;
		let cancelled = false;
		void api.getSettings().then((result) => {
			if (!cancelled && result.success) setSettings(result.settings);
		});
		void refreshBridge();
		void refreshModels();
		void refreshCuda();
		void refreshGpus();
		const timer = window.setInterval(() => void refreshBridge(), BRIDGE_POLL_MS);
		const unsubscribers = [
			api.onModelDownloadProgress((progress) => {
				setModelProgress((current) => ({ ...current, [progress.modelId]: progress }));
				if (progress.status === "downloaded" || progress.status === "idle") {
					void refreshModels();
				}
			}),
			api.onCudaDownloadProgress((progress) => setCudaProgress(progress)),
			api.onCaptionJobProgress((progress) => setJobProgress(progress)),
		];
		return () => {
			cancelled = true;
			window.clearInterval(timer);
			for (const unsubscribe of unsubscribers) unsubscribe();
		};
	}, [api, refreshBridge, refreshCuda, refreshGpus, refreshModels]);

	useEffect(() => {
		if (!isGeneratingCaptions) setJobProgress(null);
	}, [isGeneratingCaptions]);

	const bridgeReady = bridge?.resolvedBackend === "bridge";
	useEffect(() => {
		onBridgeReadyChange?.(bridgeReady);
	}, [bridgeReady, onBridgeReadyChange]);

	const setBackend = useCallback(
		async (sttBackend: SttBackendPreference) => {
			if (!api) return;
			const result = await api.setSettings({ sttBackend });
			if (!result.success) {
				toast.error(result.error);
				return;
			}
			setSettings(result.settings);
			await refreshBridge();
		},
		[api, refreshBridge],
	);

	/** "" = automatic. The main process drops the old GPU verdict, so the runtime shows as untested. */
	const setGpu = useCallback(
		async (sttGpuId: string) => {
			if (!api) return;
			const result = await api.setSettings({ sttGpuId });
			if (!result.success) {
				toast.error(result.error);
				return;
			}
			setSettings(result.settings);
			await refreshCuda();
		},
		[api, refreshCuda],
	);

	const downloadModel = useCallback(
		async (modelId: WhisperModelId) => {
			if (!api) return;
			setModelProgress((current) => ({
				...current,
				[modelId]: { modelId, status: "downloading", progress: 0 },
			}));
			const result = await api.downloadModel(modelId);
			await refreshModels();
			if (!result.success) {
				toast.error(result.error);
				return;
			}
			if (!whisperModelPath) onUseWhisperModel?.(result.path);
		},
		[api, onUseWhisperModel, refreshModels, whisperModelPath],
	);

	const deleteModel = useCallback(
		async (model: WhisperModelStatus) => {
			if (!api) return;
			const result = await api.deleteModel(model.id);
			if (!result.success) {
				toast.error(result.error);
				return;
			}
			if (whisperModelPath === model.path) onUseWhisperModel?.(null);
			setModelProgress((current) => ({ ...current, [model.id]: undefined }));
			await refreshModels();
		},
		[api, onUseWhisperModel, refreshModels, whisperModelPath],
	);

	const downloadCuda = useCallback(async () => {
		if (!api) return;
		setCudaBusy(true);
		try {
			const result = await api.downloadCudaRuntime();
			if (!result.success) {
				toast.error(result.error);
				return;
			}
			setCuda(result.status);
			// Verify right away when a model is selected; otherwise the first local job probes.
			if (whisperModelPath) {
				const probe = await api.probeCudaRuntime(whisperModelPath);
				if (probe.success) setCuda(probe.status);
			}
		} finally {
			setCudaBusy(false);
			setCudaProgress(null);
		}
	}, [api, whisperModelPath]);

	const probeCuda = useCallback(async () => {
		if (!api || !whisperModelPath) return;
		setCudaBusy(true);
		try {
			const result = await api.probeCudaRuntime(whisperModelPath);
			if (!result.success) {
				toast.error(result.error);
				return;
			}
			setCuda(result.status);
		} finally {
			setCudaBusy(false);
		}
	}, [api, whisperModelPath]);

	const deleteCuda = useCallback(async () => {
		if (!api) return;
		const result = await api.deleteCudaRuntime();
		if (!result.success) toast.error(result.error);
		await refreshCuda();
	}, [api, refreshCuda]);

	return {
		available: api !== null,
		settings,
		bridge,
		bridgeLoading,
		models,
		modelProgress,
		cuda,
		cudaProgress,
		cudaBusy,
		gpus,
		jobProgress,
		refreshBridge,
		setBackend,
		setGpu,
		downloadModel,
		deleteModel,
		selectModel: (model: WhisperModelStatus) => onUseWhisperModel?.(model.path),
		downloadCuda,
		probeCuda,
		deleteCuda,
	};
}
