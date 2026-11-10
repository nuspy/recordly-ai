import type { SttPreloadApi } from "../../../../electron/automation/stt/types";

/** `window.electronAPI.stt`, or null where the preload does not expose the STT API. */
export function getSttApi(): SttPreloadApi | null {
	if (typeof window === "undefined") return null;
	const api = (window as unknown as { electronAPI?: { stt?: SttPreloadApi } }).electronAPI;
	return api?.stt ?? null;
}
