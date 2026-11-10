import type { IpcRenderer, IpcRendererEvent } from "electron";
import { STT_IPC, type SttPreloadApi } from "./types";

export type { SttPreloadApi };

function subscribe<T>(ipcRenderer: IpcRenderer, channel: string, callback: (payload: T) => void) {
	const listener = (_event: IpcRendererEvent, payload: T) => callback(payload);
	ipcRenderer.on(channel, listener);
	return () => {
		ipcRenderer.removeListener(channel, listener);
	};
}

/** Spread into the preload `electronAPI` under the `stt` key. */
export function createSttPreloadApi(ipcRenderer: IpcRenderer): SttPreloadApi {
	return {
		getSettings: () => ipcRenderer.invoke(STT_IPC.getSettings),
		setSettings: (patch) => ipcRenderer.invoke(STT_IPC.setSettings, patch),
		getBridgeStatus: () => ipcRenderer.invoke(STT_IPC.getBridgeStatus),
		resolveBackend: () => ipcRenderer.invoke(STT_IPC.resolveBackend),
		listModels: () => ipcRenderer.invoke(STT_IPC.listModels),
		downloadModel: (modelId) => ipcRenderer.invoke(STT_IPC.downloadModel, modelId),
		deleteModel: (modelId) => ipcRenderer.invoke(STT_IPC.deleteModel, modelId),
		onModelDownloadProgress: (callback) =>
			subscribe(ipcRenderer, STT_IPC.modelDownloadProgress, callback),
		listGpus: () => ipcRenderer.invoke(STT_IPC.listGpus),
		getCudaStatus: () => ipcRenderer.invoke(STT_IPC.getCudaStatus),
		downloadCudaRuntime: () => ipcRenderer.invoke(STT_IPC.downloadCudaRuntime),
		probeCudaRuntime: (modelPath) => ipcRenderer.invoke(STT_IPC.probeCudaRuntime, modelPath),
		deleteCudaRuntime: () => ipcRenderer.invoke(STT_IPC.deleteCudaRuntime),
		onCudaDownloadProgress: (callback) =>
			subscribe(ipcRenderer, STT_IPC.cudaDownloadProgress, callback),
		onCaptionJobProgress: (callback) =>
			subscribe(ipcRenderer, STT_IPC.captionJobProgress, callback),
	};
}
