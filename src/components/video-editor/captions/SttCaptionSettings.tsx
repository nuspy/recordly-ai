import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { useScopedT } from "@/contexts/I18nContext";
import { cn } from "@/lib/utils";
import type { SttBackendPreference } from "../../../../electron/automation/contract";
import type {
	CudaRuntimeStatus,
	SttBridgeStatus,
	SttCaptionJobProgress,
	SttGpuInfo,
	WhisperModelId,
} from "../../../../electron/automation/stt/types";
import { useSttCaptionSettings } from "./useSttCaptionSettings";

type Translate = ReturnType<typeof useScopedT>;

export function formatModelSize(bytes: number) {
	return bytes >= 1_000_000_000
		? `${(bytes / 1_000_000_000).toFixed(1)} GB`
		: `${Math.round(bytes / 1_000_000)} MB`;
}

function describeBridge(t: Translate, bridge: SttBridgeStatus | null) {
	if (!bridge) return { tone: "muted" as const, text: t("captions.stt.checking", "Checking…") };
	if (bridge.preference === "local") {
		return {
			tone: "muted" as const,
			text: t("captions.stt.localActive", "Local Whisper (whisper.cpp)"),
		};
	}
	if (!bridge.reachable) {
		return bridge.preference === "auto"
			? {
					tone: "muted" as const,
					text: t(
						"captions.stt.bridgeOfflineLocal",
						"CallAPICall not reachable: local Whisper is used",
					),
				}
			: {
					tone: "error" as const,
					text: t(
						"captions.stt.bridgeOfflineStrict",
						"CallAPICall not reachable: start it or pick another backend",
					),
				};
	}
	const engine = bridge.engine?.model
		? t("captions.stt.bridgeEngine", "{{model}} on {{device}}", {
				model: bridge.engine.model,
				device: bridge.engine.device ?? "?",
			})
		: null;
	const connected = t("captions.stt.bridgeConnected", "CallAPICall connected");
	return {
		tone: bridge.sessionActive ? ("warning" as const) : ("ok" as const),
		text: [
			connected,
			engine,
			bridge.sessionActive
				? t("captions.stt.bridgeBusy", "voice session active: captions wait for it")
				: null,
		]
			.filter(Boolean)
			.join(" · "),
	};
}

function describeCuda(t: Translate, cuda: CudaRuntimeStatus) {
	if (!cuda.installed) return t("captions.stt.gpuNotInstalled", "Not installed: CPU is used");
	const source =
		cuda.source === "source-build"
			? ` (${t("captions.stt.gpuSourceBuild", "source build")})`
			: "";
	if (!cuda.probe)
		return `${t("captions.stt.gpuUntested", "Installed, not tested yet")}${source}`;
	if (cuda.usable) {
		const gpu = cuda.probe.gpuName ? ` · ${cuda.probe.gpuName}` : "";
		return `${t("captions.stt.gpuReady", "Ready")}${gpu}${source}`;
	}
	return `${t("captions.stt.gpuUnusable", "Not usable on this GPU: CPU is used")} (${cuda.probe.reason})${source}`;
}

const GPU_AUTO = "auto";

function describeGpu(gpu: SttGpuInfo) {
	const memory = gpu.memoryMiB ? ` · ${Math.round(gpu.memoryMiB / 1024)} GB` : "";
	return `${gpu.index}: ${gpu.name}${memory}`;
}

function describeJob(t: Translate, progress: SttCaptionJobProgress | null) {
	if (!progress) return null;
	if (progress.phase === "waiting-bridge") {
		return t(
			"captions.stt.waitingBridge",
			"Waiting for the CallAPICall voice session to end… {{seconds}} s",
			{ seconds: Math.round((progress.waitedMs ?? 0) / 1000) },
		);
	}
	if (progress.phase === "transcribing") {
		return t(
			"captions.stt.transcribingSegment",
			"CallAPICall: segment {{current}} of {{total}}",
			{ current: (progress.segmentIndex ?? 0) + 1, total: progress.segmentCount ?? 0 },
		);
	}
	return t("captions.stt.fallbackLocal", "Continuing with local Whisper");
}

const TONE_CLASS = {
	ok: "bg-emerald-500",
	warning: "bg-amber-500",
	error: "bg-red-500",
	muted: "bg-muted-foreground/50",
} as const;

interface SttCaptionSettingsProps {
	whisperModelPath: string | null | undefined;
	onUseWhisperModel?: (modelPath: string | null) => void;
	isGeneratingCaptions: boolean;
	onBridgeReadyChange?: (ready: boolean) => void;
}

/** Backend selector, CallAPICall status, downloadable ggml models and the CUDA runtime. */
export function SttCaptionSettings({
	whisperModelPath,
	onUseWhisperModel,
	isGeneratingCaptions,
	onBridgeReadyChange,
}: SttCaptionSettingsProps) {
	const t = useScopedT("settings");
	const stt = useSttCaptionSettings({
		whisperModelPath,
		onUseWhisperModel,
		isGeneratingCaptions,
		onBridgeReadyChange,
	});
	const [selectedModelId, setSelectedModelId] = useState<WhisperModelId | null>(null);

	// Follow the model actually in use, else the first installed, else the recommended one.
	useEffect(() => {
		if (selectedModelId || stt.models.length === 0) return;
		const preferred =
			stt.models.find((model) => model.path === whisperModelPath) ??
			stt.models.find((model) => model.installed) ??
			stt.models.find((model) => model.id === "large-v3-turbo-q5_0") ??
			stt.models[0];
		setSelectedModelId(preferred.id);
	}, [selectedModelId, stt.models, whisperModelPath]);

	if (!stt.available) return null;

	const backend = stt.settings?.sttBackend ?? stt.bridge?.preference ?? "auto";
	const bridgeInfo = describeBridge(t, stt.bridge);
	const selectedModel = stt.models.find((model) => model.id === selectedModelId) ?? null;
	const selectedProgress = selectedModel ? stt.modelProgress[selectedModel.id] : undefined;
	const modelDownloading =
		selectedModel !== null &&
		(selectedModel.downloading ||
			selectedProgress?.status === "downloading" ||
			selectedProgress?.status === "verifying");
	const jobText = isGeneratingCaptions ? describeJob(t, stt.jobProgress) : null;
	const cuda = stt.cuda;
	const cudaDownloading =
		cuda?.downloading ||
		stt.cudaProgress?.status === "downloading" ||
		stt.cudaProgress?.status === "verifying";
	const gpuId = stt.settings?.sttGpuId ?? "";
	const gpuMissing =
		gpuId !== "" && stt.gpus.length > 0 && !stt.gpus.some((gpu) => gpu.id === gpuId);
	// Only worth showing with a real choice (several NVIDIA GPUs) or a saved GPU that vanished.
	const showGpuPicker = stt.gpus.length > 1 || gpuMissing;

	return (
		<div className="space-y-3">
			<div className="flex items-center justify-between gap-3">
				<div className="text-sm font-medium text-foreground">
					{t("captions.stt.backend", "Transcription")}
				</div>
				<Select
					aria-label={t("captions.stt.backend", "Transcription")}
					value={backend}
					onValueChange={(value) => void stt.setBackend(value as SttBackendPreference)}
				>
					<SelectTrigger className="h-9 w-[180px] text-sm">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="auto">
							{t("captions.stt.backendAuto", "Auto (CallAPICall if running)")}
						</SelectItem>
						<SelectItem value="bridge">
							{t("captions.stt.backendBridge", "CallAPICall only")}
						</SelectItem>
						<SelectItem value="local">
							{t("captions.stt.backendLocal", "Local (whisper.cpp)")}
						</SelectItem>
					</SelectContent>
				</Select>
			</div>

			<div className="flex items-center justify-between gap-2">
				<div
					className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground"
					role="status"
					aria-live="polite"
				>
					<span
						aria-hidden="true"
						className={cn("size-2 shrink-0 rounded-full", TONE_CLASS[bridgeInfo.tone])}
					/>
					<span className="min-w-0 break-words">{bridgeInfo.text}</span>
				</div>
				{backend !== "local" ? (
					<Button
						type="button"
						size="sm"
						variant="ghost"
						className="h-9 shrink-0 px-3 text-xs"
						disabled={stt.bridgeLoading}
						onClick={() => void stt.refreshBridge()}
					>
						{t("captions.stt.refresh", "Refresh")}
					</Button>
				) : null}
			</div>

			{jobText ? (
				<div className="text-xs text-muted-foreground" role="status" aria-live="polite">
					{jobText}
				</div>
			) : null}

			{stt.models.length > 0 ? (
				<div className="space-y-2">
					<div className="flex items-center justify-between gap-3">
						<div className="text-sm font-medium text-foreground">
							{t("captions.stt.localModel", "Local model")}
						</div>
						<Select
							aria-label={t("captions.stt.localModel", "Local model")}
							value={selectedModelId ?? ""}
							onValueChange={(value) => setSelectedModelId(value as WhisperModelId)}
						>
							<SelectTrigger className="h-9 w-[180px] text-sm">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{stt.models.map((model) => (
									<SelectItem
										key={model.id}
										value={model.id}
										textValue={model.label}
									>
										{model.label}
										{" · "}
										{model.path === whisperModelPath
											? t("captions.stt.inUse", "in use")
											: model.installed
												? t("captions.stt.installed", "installed")
												: formatModelSize(model.sizeBytes)}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
					{selectedModel ? (
						<div className="grid grid-cols-2 gap-2">
							{modelDownloading ? (
								<Button type="button" disabled className="col-span-2 h-9 text-sm">
									{selectedProgress?.status === "verifying"
										? t("captions.stt.verifying", "Verifying…")
										: `${t("captions.downloading", "Downloading...")} ${Math.round(
												selectedProgress?.progress ?? 0,
											)}%`}
								</Button>
							) : selectedModel.installed ? (
								<>
									<Button
										type="button"
										className="h-9 text-sm"
										disabled={selectedModel.path === whisperModelPath}
										onClick={() => stt.selectModel(selectedModel)}
									>
										{selectedModel.path === whisperModelPath
											? t("captions.stt.inUse", "in use")
											: t("captions.stt.use", "Use")}
									</Button>
									<Button
										type="button"
										variant="outline"
										className="h-9 text-sm"
										onClick={() => void stt.deleteModel(selectedModel)}
									>
										{t("captions.stt.delete", "Delete")}
									</Button>
								</>
							) : (
								<Button
									type="button"
									className="col-span-2 h-9 text-sm"
									onClick={() => void stt.downloadModel(selectedModel.id)}
								>
									{t("captions.stt.download", "Download")} (
									{formatModelSize(selectedModel.sizeBytes)})
								</Button>
							)}
						</div>
					) : null}
					{modelDownloading ? (
						<div
							className="h-2 overflow-hidden rounded-full bg-foreground/5"
							role="progressbar"
							aria-valuemin={0}
							aria-valuemax={100}
							aria-valuenow={Math.round(selectedProgress?.progress ?? 0)}
						>
							<div
								className="h-full rounded-full bg-accent transition-all motion-reduce:transition-none"
								style={{ width: `${selectedProgress?.progress ?? 0}%` }}
							/>
						</div>
					) : null}
				</div>
			) : null}

			{cuda?.supported ? (
				<div className="space-y-2">
					<div className="flex items-start justify-between gap-3">
						<div className="min-w-0">
							<div className="text-sm font-medium text-foreground">
								{t("captions.stt.gpuRuntime", "GPU runtime (CUDA)")}
							</div>
							<div className="text-xs text-muted-foreground">
								{describeCuda(t, cuda)}
							</div>
						</div>
					</div>
					{showGpuPicker ? (
						<div className="space-y-1">
							<div className="flex items-center justify-between gap-3">
								<div className="text-sm font-medium text-foreground">
									{t("captions.stt.gpuDevice", "GPU")}
								</div>
								<Select
									aria-label={t("captions.stt.gpuDevice", "GPU")}
									value={gpuMissing ? GPU_AUTO : gpuId || GPU_AUTO}
									disabled={stt.cudaBusy}
									onValueChange={(value) =>
										void stt.setGpu(value === GPU_AUTO ? "" : value)
									}
								>
									<SelectTrigger className="h-9 w-[220px] text-sm">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value={GPU_AUTO}>
											{t("captions.stt.gpuAuto", "Automatic (fastest)")}
										</SelectItem>
										{stt.gpus.map((gpu) => (
											<SelectItem
												key={gpu.id}
												value={gpu.id}
												textValue={describeGpu(gpu)}
											>
												{describeGpu(gpu)}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>
							<div className="text-xs text-muted-foreground">
								{gpuMissing
									? t(
											"captions.stt.gpuMissing",
											"The GPU you chose is no longer available: CUDA picks one automatically.",
										)
									: t(
											"captions.stt.gpuDeviceHint",
											"Whisper runs on this GPU. Test the GPU again after changing it.",
										)}
							</div>
						</div>
					) : null}
					<div className="grid grid-cols-2 gap-2">
						{cudaDownloading ? (
							<Button type="button" disabled className="col-span-2 h-9 text-sm">
								{stt.cudaProgress?.status === "verifying"
									? t("captions.stt.verifying", "Verifying…")
									: `${t("captions.downloading", "Downloading...")} ${stt.cudaProgress?.progress ?? 0}%`}
							</Button>
						) : cuda.installed ? (
							<>
								<Button
									type="button"
									variant="outline"
									className="h-9 text-sm"
									disabled={stt.cudaBusy || !whisperModelPath}
									onClick={() => void stt.probeCuda()}
								>
									{stt.cudaBusy
										? t("captions.stt.gpuTesting", "Testing…")
										: t("captions.stt.gpuTest", "Test GPU")}
								</Button>
								<Button
									type="button"
									variant="outline"
									className="h-9 text-sm"
									disabled={stt.cudaBusy}
									onClick={() => void stt.deleteCuda()}
								>
									{t("captions.stt.gpuRemove", "Remove")}
								</Button>
							</>
						) : (
							<Button
								type="button"
								variant="outline"
								className="col-span-2 h-9 text-sm"
								disabled={stt.cudaBusy}
								onClick={() => void stt.downloadCuda()}
							>
								{t("captions.stt.download", "Download")} (
								{formatModelSize(cuda.asset.sizeBytes)})
							</Button>
						)}
					</div>
					{cuda.hint ? (
						<div className="text-xs text-muted-foreground">
							{t(
								"captions.stt.gpuHint",
								"The CUDA {{cuda}} build cannot drive this GPU (RTX 50xx needs CUDA 12.8 or newer). Captions keep working on the CPU; for GPU speed build whisper-cli from source with WHISPER_RUNTIME_CUDA=1.",
								{ cuda: cuda.asset.cudaVersion },
							)}
						</div>
					) : null}
				</div>
			) : null}
		</div>
	);
}
