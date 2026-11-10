import type { WebContents } from "electron";

// Output paths requested over REST, keyed by the editor that will finalize the export.
// The editor's normal export flow shows a save dialog; with a pending target the main
// process writes straight to the requested path instead.
const pendingTargets = new Map<number, string>();

export function setAutomationExportPath(contents: WebContents, outputPath: string) {
	pendingTargets.set(contents.id, outputPath);
}

export function clearAutomationExportPath(contents: WebContents) {
	pendingTargets.delete(contents.id);
}

export function takeAutomationExportPath(contents: WebContents): string | null {
	const target = pendingTargets.get(contents.id) ?? null;
	pendingTargets.delete(contents.id);
	return target;
}
