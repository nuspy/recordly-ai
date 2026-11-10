import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type CudaRuntimePaths,
	classifyCudaProbe,
	getCudaRuntimeStatus,
	isCudaRuntimeSupported,
	probeCudaRuntime,
	recordCudaRuntimeFailure,
	resolveCudaExecutableForJob,
	WHISPER_CUDA_RUNTIME_RELEASE,
} from "./cudaRuntime";

const CUDA_OK_STDERR = [
	"ggml_cuda_init: found 1 CUDA devices:",
	"  Device 0: NVIDIA GeForce RTX 5090, compute capability 12.0, VMM: yes",
	"whisper_backend_init_gpu: using CUDA0 backend",
].join("\n");

describe("classifyCudaProbe", () => {
	it("accepts a run that used a CUDA device and extracts the GPU", () => {
		expect(classifyCudaProbe({ exitCode: 0, stderr: CUDA_OK_STDERR })).toEqual({
			usable: true,
			reason: "ok",
			detail: null,
			gpuName: "NVIDIA GeForce RTX 5090",
			computeCapability: "12.0",
		});
	});

	it("flags missing kernels for the GPU architecture (e.g. sm_120 on CUDA 12.4)", () => {
		const result = classifyCudaProbe({
			exitCode: 1,
			stderr: `${CUDA_OK_STDERR}\nCUDA error: no kernel image is available for execution on the device`,
		});
		expect(result).toMatchObject({ usable: false, reason: "no-kernel-image" });
		expect(result.detail).toContain("no kernel image");
		expect(result.gpuName).toBe("NVIDIA GeForce RTX 5090");
	});

	it("flags CUDA errors even when the process exits 0", () => {
		expect(
			classifyCudaProbe({ exitCode: 0, stderr: "ggml_cuda_init: failed to initialize CUDA" }),
		).toMatchObject({ usable: false, reason: "cuda-error" });
		expect(
			classifyCudaProbe({ exitCode: 3, stderr: "CUBLAS_STATUS_NOT_SUPPORTED" }),
		).toMatchObject({ reason: "cuda-error" });
	});

	it("flags missing DLLs, timeouts, plain failures and CPU-only runs", () => {
		expect(classifyCudaProbe({ exitCode: 3221225781, stderr: "" }).reason).toBe("missing-dll");
		expect(classifyCudaProbe({ exitCode: null, stderr: "", timedOut: true }).reason).toBe(
			"timeout",
		);
		expect(classifyCudaProbe({ exitCode: 1, stderr: "bad model" }).reason).toBe("failed");
		expect(
			classifyCudaProbe({ exitCode: 0, stderr: "ggml_cuda_init: found 0 CUDA devices" })
				.reason,
		).toBe("no-cuda-device");
		expect(
			classifyCudaProbe({ exitCode: 0, stderr: "system_info: n_threads = 8" }).reason,
		).toBe("no-cuda-device");
	});
});

describe("CUDA runtime release", () => {
	it("pins the official v1.8.4 cuBLAS asset", () => {
		expect(WHISPER_CUDA_RUNTIME_RELEASE.url).toBe(
			"https://github.com/ggml-org/whisper.cpp/releases/download/v1.8.4/whisper-cublas-12.4.0-bin-x64.zip",
		);
		expect(WHISPER_CUDA_RUNTIME_RELEASE.sha256).toMatch(/^[0-9a-f]{64}$/);
		expect(isCudaRuntimeSupported("win32", "x64")).toBe(true);
		expect(isCudaRuntimeSupported("darwin", "arm64")).toBe(false);
	});
});

const tempDirs: string[] = [];
afterEach(async () => {
	await Promise.all(
		tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
	);
});

async function installedPaths(): Promise<CudaRuntimePaths> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "recordly-cuda-"));
	tempDirs.push(root);
	const paths = {
		downloadDir: path.join(root, "cuda"),
		probeFile: path.join(root, "cuda-probe.json"),
		tempDir: path.join(root, "tmp"),
	};
	await fs.mkdir(paths.downloadDir, { recursive: true });
	await fs.writeFile(path.join(paths.downloadDir, "whisper-cli.exe"), "exe");
	return paths;
}

describe.runIf(process.platform === "win32" && process.arch === "x64")("CUDA probe", () => {
	it("probes once with the job model, persists the verdict and reuses it", async () => {
		const paths = await installedPaths();
		const exec = vi.fn(async () => ({
			exitCode: 0,
			stdout: "",
			stderr: CUDA_OK_STDERR,
			timedOut: false,
		}));
		const exe = await resolveCudaExecutableForJob(paths, "/models/turbo.bin", { exec });
		expect(exe).toBe(path.join(paths.downloadDir, "whisper-cli.exe"));
		expect(exec).toHaveBeenCalledTimes(1);
		const [, args] = exec.mock.calls[0] as unknown as [string, string[]];
		expect(args.slice(0, 2)).toEqual(["-m", "/models/turbo.bin"]);
		expect(args).not.toContain("-ng");

		const persisted = JSON.parse(await fs.readFile(paths.probeFile, "utf8"));
		expect(persisted).toMatchObject({ usable: true, gpuName: "NVIDIA GeForce RTX 5090" });
		expect(typeof persisted.checkedAt).toBe("string");

		await resolveCudaExecutableForJob(paths, "/models/turbo.bin", { exec });
		expect(exec).toHaveBeenCalledTimes(1);
		await expect(fs.readdir(paths.tempDir)).resolves.toEqual([]);
	});

	it("probes pinned to the chosen GPU and drops the verdict when the GPU changes", async () => {
		const paths = { ...(await installedPaths()), gpuId: "GPU-aaaa-1111" };
		const exec = vi.fn(async () => ({
			exitCode: 0,
			stdout: "",
			stderr: CUDA_OK_STDERR,
			timedOut: false,
		}));
		expect(await resolveCudaExecutableForJob(paths, "/m.bin", { exec })).not.toBeNull();
		const env = (
			exec.mock.calls[0] as unknown as [string, string[], number, Record<string, string>]
		)[3];
		expect(env).toEqual({
			CUDA_DEVICE_ORDER: "PCI_BUS_ID",
			CUDA_VISIBLE_DEVICES: "GPU-aaaa-1111",
		});
		expect((await getCudaRuntimeStatus(paths)).usable).toBe(true);

		// Another GPU, or back to automatic: the old verdict does not apply.
		expect((await getCudaRuntimeStatus({ ...paths, gpuId: "GPU-bbbb-2222" })).probe).toBeNull();
		expect((await getCudaRuntimeStatus({ ...paths, gpuId: "" })).probe).toBeNull();
		await resolveCudaExecutableForJob({ ...paths, gpuId: "" }, "/m.bin", { exec });
		expect(exec).toHaveBeenCalledTimes(2);
		expect(
			(
				exec.mock.calls[1] as unknown as [string, string[], number, Record<string, string>]
			)[3],
		).toEqual({});
	});

	it("falls back to CPU after a failed probe", async () => {
		const paths = await installedPaths();
		const exec = vi.fn(async () => ({
			exitCode: 1,
			stdout: "",
			stderr: "CUDA error: no kernel image is available for execution on the device",
			timedOut: false,
		}));
		expect(await resolveCudaExecutableForJob(paths, "/m.bin", { exec })).toBeNull();
		const status = await getCudaRuntimeStatus(paths);
		expect(status).toMatchObject({ installed: true, usable: false });
		expect(status.hint).toContain("CUDA 12.8");
	});

	it("does not probe without a model and marks CUDA failures from a job", async () => {
		const paths = await installedPaths();
		const exec = vi.fn();
		expect(await resolveCudaExecutableForJob(paths, null, { exec })).toBeNull();
		expect(exec).not.toHaveBeenCalled();

		await probeCudaRuntime(paths, "/m.bin", {
			exec: async () => ({
				exitCode: 0,
				stdout: "",
				stderr: CUDA_OK_STDERR,
				timedOut: false,
			}),
		});
		expect((await getCudaRuntimeStatus(paths)).usable).toBe(true);
		expect(
			await recordCudaRuntimeFailure(paths, new Error("model file is corrupt")),
		).toBeNull();
		expect((await getCudaRuntimeStatus(paths)).usable).toBe(true);
		const failure = Object.assign(new Error("Command failed"), {
			code: 1,
			stderr: "CUDA error: out of memory",
		});
		expect(await recordCudaRuntimeFailure(paths, failure)).toMatchObject({
			reason: "cuda-error",
		});
		expect((await getCudaRuntimeStatus(paths)).usable).toBe(false);
	});
});
