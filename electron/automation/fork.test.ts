import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { importUpstreamSettingsOnce, RECORDLY_AI_APP_ID } from "./fork";

describe("fork identity", () => {
	it("keeps the electron-builder appId aligned with the Windows AppUserModelID", () => {
		const builderConfig = fs.readFileSync(
			path.join(process.cwd(), "electron-builder.json5"),
			"utf8",
		);
		const appId = builderConfig.match(/"appId":\s*"([^"]+)"/)?.[1];
		expect(appId).toBe(RECORDLY_AI_APP_ID);
	});

	it("uses its own product name so it can coexist with upstream Recordly", () => {
		const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"));
		expect(pkg.productName).toBe("Recordly AI");
	});
});

describe("importUpstreamSettingsOnce", () => {
	it("copies upstream preferences once, never overwriting fork settings", () => {
		const appData = fs.mkdtempSync(path.join(os.tmpdir(), "rai-appdata-"));
		try {
			const upstream = path.join(appData, "Recordly");
			const fork = path.join(appData, "Recordly AI");
			fs.mkdirSync(upstream);
			fs.mkdirSync(fork);
			fs.writeFileSync(path.join(upstream, "app-settings.json"), '{"presets":1}');
			fs.writeFileSync(path.join(upstream, "shortcuts.json"), '{"a":1}');
			fs.writeFileSync(path.join(fork, "shortcuts.json"), '{"mine":1}');
			fs.mkdirSync(path.join(upstream, "recordings"));

			importUpstreamSettingsOnce(fork, appData);
			expect(fs.readFileSync(path.join(fork, "app-settings.json"), "utf8")).toBe(
				'{"presets":1}',
			);
			expect(fs.readFileSync(path.join(fork, "shortcuts.json"), "utf8")).toBe('{"mine":1}');
			expect(fs.existsSync(path.join(fork, "recordings"))).toBe(false);

			fs.writeFileSync(path.join(upstream, "countdown-settings.json"), "{}");
			importUpstreamSettingsOnce(fork, appData);
			expect(fs.existsSync(path.join(fork, "countdown-settings.json"))).toBe(false);
		} finally {
			fs.rmSync(appData, { recursive: true, force: true });
		}
	});
});
