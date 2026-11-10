import { describe, expect, it, vi } from "vitest";
import { DEFAULT_AUTOMATION_SETTINGS } from "../contract";
import {
	getSttBridgeConfig,
	parseBridgeEngineInfo,
	resolveSttBackend,
	SttBackendError,
} from "./backend";

describe("resolveSttBackend", () => {
	it("auto uses the bridge when reachable, else whisper.cpp", async () => {
		await expect(
			resolveSttBackend("auto", { isBridgeReachable: async () => true }),
		).resolves.toEqual({ backend: "bridge", strict: false, bridgeReachable: true });
		await expect(
			resolveSttBackend("auto", { isBridgeReachable: async () => false }),
		).resolves.toEqual({ backend: "local", strict: false, bridgeReachable: false });
	});

	it("auto treats a failing reachability probe as unreachable", async () => {
		const result = await resolveSttBackend("auto", {
			isBridgeReachable: async () => {
				throw new Error("boom");
			},
		});
		expect(result.backend).toBe("local");
	});

	it("bridge is strict and errors clearly when unreachable", async () => {
		await expect(
			resolveSttBackend("bridge", { isBridgeReachable: async () => true }),
		).resolves.toEqual({ backend: "bridge", strict: true, bridgeReachable: true });
		const failing = resolveSttBackend("bridge", {
			isBridgeReachable: async () => false,
			bridgeUrl: "http://127.0.0.1:8720",
		});
		await expect(failing).rejects.toBeInstanceOf(SttBackendError);
		await expect(failing).rejects.toThrow(/not reachable at http:\/\/127\.0\.0\.1:8720/);
	});

	it("local never probes the bridge", async () => {
		const isBridgeReachable = vi.fn(async () => true);
		await expect(resolveSttBackend("local", { isBridgeReachable })).resolves.toEqual({
			backend: "local",
			strict: false,
			bridgeReachable: null,
		});
		expect(isBridgeReachable).not.toHaveBeenCalled();
	});
});

describe("getSttBridgeConfig", () => {
	it("converts the busy timeout to milliseconds", () => {
		expect(getSttBridgeConfig(DEFAULT_AUTOMATION_SETTINGS)).toEqual({
			bridgeUrl: "http://127.0.0.1:8720",
			bridgeControlUrl: "http://127.0.0.1:8770",
			bridgeControlToken: "",
			busyTimeoutMs: 600_000,
		});
	});
});

describe("parseBridgeEngineInfo", () => {
	it("reads the live STT engine", () => {
		expect(
			parseBridgeEngineInfo({
				stt: { loaded: true, running_on: "cuda", would_load_on: "cuda", model: "medium" },
			}),
		).toEqual({ model: "medium", device: "cuda", loaded: true });
	});

	it("falls back to the configured device when the model is not loaded", () => {
		expect(
			parseBridgeEngineInfo({
				stt: { loaded: false, running_on: null, would_load_on: "cpu", model: "medium" },
			}),
		).toEqual({ model: "medium", device: "cpu", loaded: false });
		expect(parseBridgeEngineInfo({ error: "engines not initialized" })).toBeNull();
		expect(parseBridgeEngineInfo(null)).toBeNull();
	});
});
