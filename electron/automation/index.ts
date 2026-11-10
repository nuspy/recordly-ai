import { app, ipcMain } from "electron";
import { type AutomationLaunchOptions, parseAutomationArgs } from "./cli";
import { AutomationController, type AutomationHost } from "./controller";
import { isProcessAlive, readServerInfo, writeAppInfo } from "./discovery";
import { appendHeadlessChromiumSwitches, installHeadlessWindowPolicy } from "./headless";
import { createAutomationRouter } from "./routes";

let controller: AutomationController | null = null;

/**
 * Must run at module load, before `app.whenReady()`: Chromium switches and the window
 * policy only apply to windows created afterwards.
 */
export function prepareAutomation(argv: readonly string[]): AutomationLaunchOptions {
	const launch = parseAutomationArgs(argv, process.env);
	if (launch.server) {
		appendHeadlessChromiumSwitches(app);
		if (!launch.show) installHeadlessWindowPolicy(app);
	}
	return launch;
}

/**
 * A second `--server` launch must not open a second app: it reports the running server so
 * agents can launch idempotently ("start it if needed, then talk to it").
 */
export function reportRunningServer(userDataPath: string): boolean {
	const info = readServerInfo(userDataPath);
	if (!info || !isProcessAlive(info.pid)) return false;
	console.log(`RECORDLY_AI_RUNNING ${JSON.stringify(info)}`);
	return true;
}

export async function startAutomation(host: AutomationHost) {
	if (controller) return controller;
	if (app.isPackaged) {
		writeAppInfo(host.userDataPath, { executable: process.execPath, version: host.appVersion });
	}
	controller = new AutomationController(host);
	controller.register(ipcMain, createAutomationRouter(controller));
	await controller.start();
	app.on("will-quit", () => {
		void controller?.stop();
	});
	return controller;
}

/** A later `--server` launch (second instance) turns the REST API on in the running app. */
export async function handleSecondInstanceArgs(argv: readonly string[]) {
	if (!controller) return false;
	const launch = parseAutomationArgs(argv);
	if (!launch.server) return false;
	if (!controller.isServing) {
		await controller.updateSettings({ restEnabled: true });
	}
	return true;
}

export function getAutomationController() {
	return controller;
}
