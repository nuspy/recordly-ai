import { describe, expect, it } from "vitest";
import { parseAutomationArgs, resolveAutomationPort } from "./cli";

describe("parseAutomationArgs", () => {
	it("defaults to GUI mode", () => {
		expect(parseAutomationArgs(["electron", "."])).toEqual({
			server: false,
			port: null,
			show: false,
		});
	});

	it("parses --server, --show and both port spellings", () => {
		expect(parseAutomationArgs(["app.exe", "--server", "--port", "48000", "--show"])).toEqual({
			server: true,
			port: 48000,
			show: true,
		});
		expect(parseAutomationArgs(["app.exe", "--server", "--port=48001"]).port).toBe(48001);
	});

	it("ignores invalid ports and supports env flags for dev", () => {
		expect(parseAutomationArgs(["--port", "80"]).port).toBeNull();
		expect(
			parseAutomationArgs([], { RECORDLY_SERVER: "1", RECORDLY_SERVER_PORT: "47999" }),
		).toEqual({ server: true, port: 47999, show: false });
	});

	it("resolves the port: CLI flag, then configured, then default", () => {
		expect(resolveAutomationPort({ server: true, port: 48000, show: false }, 47900)).toBe(
			48000,
		);
		expect(resolveAutomationPort({ server: true, port: null, show: false }, 47900)).toBe(47900);
		expect(resolveAutomationPort({ server: true, port: null, show: false })).toBe(47800);
	});
});
