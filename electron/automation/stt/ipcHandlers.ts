import type Electron from "electron";
import { ipcMain } from "electron";
import {
	downloadFileWithProgress,
	sendWhisperModelDownloadProgress,
} from "../../ipc/captions/whisper";
import { approveUserPath } from "../../ipc/utils";
import {
	deleteCudaRuntime,
	getCudaRuntimeStatus,
	installCudaRuntime,
	probeCudaRuntime,
} from "./cudaRuntime";
import { listNvidiaGpus } from "./gpus";
import {
	deleteWhisperModel,
	downloadWhisperModel,
	findWhisperModel,
	listWhisperModels,
	verifyDownloadedFile,
} from "./models";
import {
	getCudaRuntimePaths,
	getSttBridgeStatus,
	readSttSettings,
	resolveSttBackendNow,
	STT_MODEL_DIR,
	writeSttSettings,
} from "./service";
import {
	STT_IPC,
	type SttCaptionJobProgress,
	type SttCudaDownloadProgress,
	type SttModelDownloadProgress,
	type SttSettings,
} from "./types";

function errorMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

function send(webContents: Electron.WebContents, channel: string, payload: unknown) {
	if (!webContents.isDestroyed()) webContents.send(channel, payload);
}

/** Emits only when the integer percentage changes (downloads report every chunk). */
function throttledProgress(emit: (progress: number) => void) {
	let last = -1;
	return (progress: number) => {
		const rounded = Math.floor(progress);
		if (rounded === last) return;
		last = rounded;
		emit(rounded);
	};
}

export function sendSttCaptionJobProgress(
	webContents: Electron.WebContents,
	progress: SttCaptionJobProgress,
) {
	send(webContents, STT_IPC.captionJobProgress, progress);
}

export function registerSttIpcHandlers() {
	ipcMain.handle(STT_IPC.getSettings, () => {
		try {
			return { success: true, settings: readSttSettings() };
		} catch (error) {
			return { success: false, error: errorMessage(error) };
		}
	});

	ipcMain.handle(STT_IPC.setSettings, (_, patch: Partial<SttSettings>) => {
		try {
			return { success: true, settings: writeSttSettings(patch) };
		} catch (error) {
			return { success: false, error: errorMessage(error) };
		}
	});

	ipcMain.handle(STT_IPC.getBridgeStatus, async () => {
		try {
			return { success: true, status: await getSttBridgeStatus() };
		} catch (error) {
			return { success: false, error: errorMessage(error) };
		}
	});

	ipcMain.handle(STT_IPC.resolveBackend, () => resolveSttBackendNow());

	ipcMain.handle(STT_IPC.listModels, async () => {
		try {
			const models = await listWhisperModels(STT_MODEL_DIR);
			for (const model of models) {
				if (model.installed) approveUserPath(model.path);
			}
			return { success: true, models };
		} catch (error) {
			return { success: false, error: errorMessage(error) };
		}
	});

	ipcMain.handle(STT_IPC.downloadModel, async (event, modelId: string) => {
		const model = findWhisperModel(modelId);
		if (!model) return { success: false, error: `Unknown Whisper model: ${String(modelId)}` };
		const emit = (payload: Omit<SttModelDownloadProgress, "modelId">) => {
			send(event.sender, STT_IPC.modelDownloadProgress, { modelId: model.id, ...payload });
			// Keep the legacy small-model UI in sync with the catalog download.
			if (model.id === "small" && payload.status !== "verifying") {
				sendWhisperModelDownloadProgress(event.sender, {
					...payload,
					status: payload.status,
				});
			}
		};
		try {
			emit({ status: "downloading", progress: 0, path: null });
			const modelPath = await downloadWhisperModel(
				model,
				STT_MODEL_DIR,
				throttledProgress((progress) =>
					emit({ status: progress >= 100 ? "verifying" : "downloading", progress }),
				),
				{ download: downloadFileWithProgress, verify: verifyDownloadedFile },
			);
			approveUserPath(modelPath);
			emit({ status: "downloaded", progress: 100, path: modelPath });
			return { success: true, path: modelPath };
		} catch (error) {
			console.error(`Failed to download Whisper model ${model.id}:`, error);
			emit({ status: "error", progress: 0, path: null, error: errorMessage(error) });
			return { success: false, error: errorMessage(error) };
		}
	});

	ipcMain.handle(STT_IPC.deleteModel, async (event, modelId: string) => {
		const model = findWhisperModel(modelId);
		if (!model) return { success: false, error: `Unknown Whisper model: ${String(modelId)}` };
		try {
			await deleteWhisperModel(model, STT_MODEL_DIR);
			send(event.sender, STT_IPC.modelDownloadProgress, {
				modelId: model.id,
				status: "idle",
				progress: 0,
				path: null,
			});
			if (model.id === "small") {
				sendWhisperModelDownloadProgress(event.sender, {
					status: "idle",
					progress: 0,
					path: null,
				});
			}
			return { success: true };
		} catch (error) {
			return { success: false, error: errorMessage(error) };
		}
	});

	ipcMain.handle(STT_IPC.listGpus, async () => {
		try {
			return { success: true, gpus: await listNvidiaGpus() };
		} catch (error) {
			return { success: false, error: errorMessage(error) };
		}
	});

	ipcMain.handle(STT_IPC.getCudaStatus, async () => {
		try {
			return { success: true, status: await getCudaRuntimeStatus(getCudaRuntimePaths()) };
		} catch (error) {
			return { success: false, error: errorMessage(error) };
		}
	});

	ipcMain.handle(STT_IPC.downloadCudaRuntime, async (event) => {
		const emit = (payload: SttCudaDownloadProgress) =>
			send(event.sender, STT_IPC.cudaDownloadProgress, payload);
		try {
			emit({ status: "downloading", progress: 0 });
			const status = await installCudaRuntime(
				getCudaRuntimePaths(),
				throttledProgress((progress) =>
					emit({ status: progress >= 100 ? "verifying" : "downloading", progress }),
				),
				{ download: downloadFileWithProgress, verify: verifyDownloadedFile },
			);
			emit({ status: "installed", progress: 100 });
			return { success: true, status };
		} catch (error) {
			console.error("Failed to install the CUDA Whisper runtime:", error);
			emit({ status: "error", progress: 0, error: errorMessage(error) });
			return { success: false, error: errorMessage(error) };
		}
	});

	ipcMain.handle(STT_IPC.probeCudaRuntime, async (_, modelPath: string) => {
		if (typeof modelPath !== "string" || !modelPath.trim()) {
			return {
				success: false,
				error: "Select a Whisper model to test the GPU runtime with.",
			};
		}
		try {
			const paths = getCudaRuntimePaths();
			const probe = await probeCudaRuntime(paths, modelPath);
			return { success: true, probe, status: await getCudaRuntimeStatus(paths) };
		} catch (error) {
			return { success: false, error: errorMessage(error) };
		}
	});

	ipcMain.handle(STT_IPC.deleteCudaRuntime, async () => {
		try {
			await deleteCudaRuntime(getCudaRuntimePaths());
			return { success: true };
		} catch (error) {
			return { success: false, error: errorMessage(error) };
		}
	});
}
