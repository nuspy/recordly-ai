import type { App, BrowserWindow } from "electron";

/**
 * Server mode keeps every window alive but never on screen: the HUD still hosts the
 * recorder and the editor still renders/exports, only nobody sees them. Instead of touching
 * the many places that call show()/focus(), each new window gets those methods disabled.
 */
export function installHeadlessWindowPolicy(app: App) {
	app.on("browser-window-created", (_event, window: BrowserWindow) => {
		const noop = () => undefined;
		const target = window as unknown as Record<string, unknown>;
		for (const method of ["show", "showInactive", "focus", "maximize", "restore", "moveTop"]) {
			target[method] = noop;
		}
		window.setSkipTaskbar(true);
	});
}

/** Hidden windows must keep full-speed timers and rendering for capture and export. */
export function appendHeadlessChromiumSwitches(app: App) {
	app.commandLine.appendSwitch("disable-renderer-backgrounding");
	app.commandLine.appendSwitch("disable-background-timer-throttling");
	app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
}
