// Recordly AI fork identity. Kept in one place so upstream merges only touch the call sites.
import fs from "node:fs";
import path from "node:path";

export const RECORDLY_AI_APP_ID = "dev.recordly.ai";
export const RECORDLY_AI_DISPLAY_NAME = "Recordly AI";

// The upstream publish feed would offer upstream releases and overwrite the fork.
// Set RECORDLY_AI_ENABLE_AUTO_UPDATES=1 once the fork publishes its own feed.
export const FORK_UPDATES_DISABLED = process.env.RECORDLY_AI_ENABLE_AUTO_UPDATES !== "1";

/** Upstream's userData folder name (productName "Recordly"). */
export const UPSTREAM_USER_DATA_DIR_NAME = "Recordly";

/**
 * Preferences worth carrying over from an upstream Recordly install: small JSON files only.
 * Recordings, projects and Whisper models stay where they are (their paths keep working).
 */
const IMPORTABLE_SETTINGS_FILES = [
	"app-settings.json",
	"shortcuts.json",
	"countdown-settings.json",
	"recordings-settings.json",
	"hud-overlay-settings.json",
	"recent-projects.json",
];
const IMPORT_MARKER = "imported-from-recordly.json";

/**
 * The fork has its own userData folder (productName "Recordly AI"). On the first start,
 * copy the upstream preferences once so editor presets and settings are not lost.
 */
export function importUpstreamSettingsOnce(userDataPath: string, appDataPath: string) {
	const upstreamDir = path.join(appDataPath, UPSTREAM_USER_DATA_DIR_NAME);
	const marker = path.join(userDataPath, IMPORT_MARKER);
	if (path.resolve(upstreamDir) === path.resolve(userDataPath) || fs.existsSync(marker)) return;
	try {
		fs.mkdirSync(userDataPath, { recursive: true });
		const imported: string[] = [];
		if (fs.existsSync(upstreamDir)) {
			for (const fileName of IMPORTABLE_SETTINGS_FILES) {
				const source = path.join(upstreamDir, fileName);
				const target = path.join(userDataPath, fileName);
				if (fs.existsSync(source) && !fs.existsSync(target)) {
					fs.copyFileSync(source, target);
					imported.push(fileName);
				}
			}
		}
		fs.writeFileSync(
			marker,
			JSON.stringify({ from: upstreamDir, imported, at: new Date().toISOString() }, null, 2),
		);
	} catch (error) {
		console.warn("[recordly-ai] could not import upstream Recordly settings:", error);
	}
}
