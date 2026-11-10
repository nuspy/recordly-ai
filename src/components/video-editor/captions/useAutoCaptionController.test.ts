import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { useAutoCaptionController } from "./useAutoCaptionController";
const state = vi.hoisted(() => ({ refs: [] as { current: unknown }[], index: 0 }));
vi.mock("react", () => ({
	useCallback: (callback: unknown) => callback,
	useEffect: () => {},
	useRef: (current: unknown) => {
		const index = state.index++;
		state.refs[index] ??= { current };
		return state.refs[index];
	},
}));
vi.mock("@/components/ui/toast", () => ({
	toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));
beforeEach(() => {
	state.refs = [];
	state.index = 0;
});
afterEach(() => vi.unstubAllGlobals());
function setup() {
	let complete!: (result: unknown) => void;
	const generateAutoCaptions = vi.fn(
		() =>
			new Promise((resolve) => {
				complete = resolve;
			}),
	);
	vi.stubGlobal("window", { electronAPI: { generateAutoCaptions } });
	const params = {
		videoSourcePath: "/recordings/a.mp4",
		videoPath: "file:///recordings/a.mp4",
		whisperModelPath: "/models/small.bin",
		isGeneratingCaptions: false,
		autoCaptionSettings: { language: "en" },
		setIsGeneratingCaptions: vi.fn(),
		setAutoCaptions: vi.fn(),
		setAutoCaptionSettings: vi.fn(),
		syncActiveVideoSource: vi.fn(),
		t: (key: string) => key,
	} as unknown as Parameters<typeof useAutoCaptionController>[0];
	const render = () => {
		state.index = 0;
		return useAutoCaptionController(params);
	};
	return {
		params,
		render,
		generateAutoCaptions,
		complete: (result: unknown) => complete(result),
	};
}
const cues = [{ id: "generated", startMs: 0, endMs: 1000, text: "Hello" }];
it("deduplicates requests and enables captions without resetting the active session", async () => {
	const test = setup();
	const controller = test.render();
	const pending = controller.handleGenerateAutoCaptions();
	await controller.handleGenerateAutoCaptions();
	expect(test.generateAutoCaptions).toHaveBeenCalledTimes(1);
	test.complete({ success: true, cues });
	await pending;
	expect(test.params.setAutoCaptions).toHaveBeenCalledWith(cues);
	expect(test.params.setAutoCaptionSettings).toHaveBeenCalledOnce();
	expect(test.params.syncActiveVideoSource).not.toHaveBeenCalled();
	expect(test.params.setIsGeneratingCaptions).toHaveBeenLastCalledWith(false);
});
it("discards results after switching recordings", async () => {
	const test = setup();
	const pending = test.render().handleGenerateAutoCaptions();
	test.params.videoSourcePath = "/recordings/b.mp4";
	test.render();
	test.complete({ success: true, cues });
	await pending;
	expect(test.params.setAutoCaptions).not.toHaveBeenCalled();
	expect(test.params.setIsGeneratingCaptions).toHaveBeenLastCalledWith(false);
});
it("generates without a local model when the backend resolves to the CallAPICall bridge", async () => {
	const test = setup();
	const resolveBackend = vi.fn(async () => ({ success: true, backend: "bridge" }));
	vi.stubGlobal("window", {
		electronAPI: { generateAutoCaptions: test.generateAutoCaptions, stt: { resolveBackend } },
	});
	test.params.whisperModelPath = null;
	const pending = test.render().handleGenerateAutoCaptions();
	await vi.waitFor(() => expect(test.generateAutoCaptions).toHaveBeenCalledTimes(1));
	expect(test.generateAutoCaptions).toHaveBeenCalledWith(
		expect.objectContaining({ whisperModelPath: "" }),
	);
	test.complete({ success: true, cues, backend: "bridge" });
	await pending;
	expect(test.params.setAutoCaptions).toHaveBeenCalledWith(cues);
});
it("still requires a model when the backend resolves to local whisper.cpp", async () => {
	const test = setup();
	const resolveBackend = vi.fn(async () => ({ success: true, backend: "local" }));
	vi.stubGlobal("window", {
		electronAPI: { generateAutoCaptions: test.generateAutoCaptions, stt: { resolveBackend } },
	});
	test.params.whisperModelPath = null;
	await test.render().handleGenerateAutoCaptions();
	expect(resolveBackend).toHaveBeenCalledOnce();
	expect(test.generateAutoCaptions).not.toHaveBeenCalled();
	expect(test.params.setIsGeneratingCaptions).toHaveBeenLastCalledWith(false);
});
it("preserves existing captions on failure and permits retry", async () => {
	const test = setup();
	const controller = test.render();
	const pending = controller.handleGenerateAutoCaptions();
	test.complete({ success: false, error: "Transcription failed" });
	await pending;
	expect(test.params.setAutoCaptions).not.toHaveBeenCalled();
	const retry = controller.handleGenerateAutoCaptions();
	test.complete({ success: true, cues });
	await retry;
	expect(test.generateAutoCaptions).toHaveBeenCalledTimes(2);
	expect(test.params.setAutoCaptions).toHaveBeenCalledWith(cues);
});
