import type { IpcRenderer, IpcRendererEvent } from "electron";
import type {
	AutomationBridgeRole,
	AutomationCommandMessage,
	AutomationResultMessage,
	AutomationRuntimeInfo,
	AutomationSettings,
	SessionJournal,
} from "./contract";

export interface AutomationServerStatus {
	running: boolean;
	baseUrl: string | null;
	port: number | null;
	tokenFile: string | null;
	error: string | null;
	token: string | null;
}

export function createAutomationPreloadApi(ipcRenderer: IpcRenderer) {
	return {
		announce: (role: AutomationBridgeRole) => {
			ipcRenderer.send("automation:bridge-ready", role);
		},
		onCommand: (callback: (message: AutomationCommandMessage) => void) => {
			const listener = (_event: IpcRendererEvent, message: AutomationCommandMessage) =>
				callback(message);
			ipcRenderer.on("automation:command", listener);
			return () => {
				ipcRenderer.removeListener("automation:command", listener);
			};
		},
		respond: (message: AutomationResultMessage) => {
			ipcRenderer.send("automation:result", message);
		},
		emit: (type: string, data?: unknown) => {
			ipcRenderer.send("automation:event", { type, data });
		},
		onNotification: (callback: (type: string, data: unknown) => void) => {
			const listener = (_event: IpcRendererEvent, type: string, data: unknown) =>
				callback(type, data);
			ipcRenderer.on("automation:notification", listener);
			return () => {
				ipcRenderer.removeListener("automation:notification", listener);
			};
		},
		getRuntimeInfo: (): Promise<AutomationRuntimeInfo> =>
			ipcRenderer.invoke("automation:get-runtime-info"),
		getSettings: (): Promise<AutomationSettings> =>
			ipcRenderer.invoke("automation:get-settings"),
		setSettings: (patch: Partial<AutomationSettings>): Promise<AutomationSettings> =>
			ipcRenderer.invoke("automation:set-settings", patch),
		getServerStatus: (): Promise<AutomationServerStatus> =>
			ipcRenderer.invoke("automation:get-server-status"),
		rotateToken: (): Promise<AutomationServerStatus> =>
			ipcRenderer.invoke("automation:rotate-token"),
		readJournal: (videoPath: string): Promise<SessionJournal | null> =>
			ipcRenderer.invoke("automation:read-journal", videoPath),
		markJournalApplied: (
			videoPath: string,
			part: "content" | "autoEdit",
			appliedIds: string[] = [],
		): Promise<void> =>
			ipcRenderer.invoke("automation:mark-journal-applied", videoPath, part, appliedIds),
	};
}

export type AutomationPreloadApi = ReturnType<typeof createAutomationPreloadApi>;
