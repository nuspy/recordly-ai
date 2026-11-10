import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { buildCudaDeviceEnv } from "./gpus";
import { type ModelDownloadFn, verifyDownloadedFile } from "./models";
import type {
	CudaProbeClassification,
	CudaProbeReason,
	CudaProbeRecord,
	CudaRuntimeStatus,
} from "./types";
import { createSilentWav } from "./wav";

export type { CudaProbeClassification, CudaProbeRecord, CudaRuntimeStatus };

// whisper.cpp CUDA runtime for Windows, downloaded on demand (the cuBLAS DLLs are ~1 GB
// unpacked, far too large to bundle). It must match the bundled CPU runtime version.
//
// v1.8.4 publishes it as `whisper-cublas-12.4.0-bin-x64.zip`; newer tags renamed it to
// `whisper-bin-win-cuda-12.4.0-x64.zip`. CUDA 12.4 has no native kernels for Blackwell
// (RTX 50xx, sm_120): it only works there if the build ships PTX the driver can JIT. When the
// probe fails with "no kernel image", build whisper-cli from source with CUDA >= 12.8
// (`WHISPER_RUNTIME_CUDA=1 node scripts/build-whisper-runtime.mjs`, which configures
// `-DGGML_CUDA=1 -DCMAKE_CUDA_ARCHITECTURES=89;120` into electron/native/bin/win32-x64-cuda).
export const WHISPER_CUDA_RUNTIME_RELEASE = {
	version: "v1.8.4",
	assetName: "whisper-cublas-12.4.0-bin-x64.zip",
	url: "https://github.com/ggml-org/whisper.cpp/releases/download/v1.8.4/whisper-cublas-12.4.0-bin-x64.zip",
	sizeBytes: 457_024_596,
	sha256: "b07cff4e59831b227896018facbb6334907bf324a342c84597c44f087823d252",
	cudaVersion: "12.4",
} as const;

export const CUDA_SOURCE_BUILD_HINT =
	"Build whisper-cli from source with CUDA 12.8 or newer: WHISPER_RUNTIME_CUDA=1 node scripts/build-whisper-runtime.mjs (-DGGML_CUDA=1 -DCMAKE_CUDA_ARCHITECTURES=89;120).";

const MANIFEST_FILE = "recordly-cuda-runtime.json";
const WHISPER_CLI = "whisper-cli.exe";

export function isCudaRuntimeSupported(platform = process.platform, arch = process.arch) {
	return platform === "win32" && arch === "x64";
}

// ── Probe classification ──

const WINDOWS_DLL_NOT_FOUND_CODES = new Set([-1073741515, 3221225781]);

function firstMatchingLine(text: string, pattern: RegExp) {
	return (
		text
			.split(/\r?\n/)
			.map((line) => line.trim())
			.find((line) => pattern.test(line)) ?? null
	);
}

export function classifyCudaProbe(result: {
	exitCode: number | string | null;
	stderr: string;
	stdout?: string;
	timedOut?: boolean;
}): CudaProbeClassification {
	const text = `${result.stderr ?? ""}\n${result.stdout ?? ""}`;
	const gpu = text.match(/Device\s+\d+:\s*([^,\r\n]+),\s*compute capability\s*([\d.]+)/i);
	const base = {
		gpuName: gpu?.[1]?.trim() ?? null,
		computeCapability: gpu?.[2] ?? null,
	};
	const fail = (reason: CudaProbeReason, detail: string | null) => ({
		usable: false,
		reason,
		detail,
		...base,
	});

	const noKernel = /no kernel image is available/i;
	if (noKernel.test(text)) return fail("no-kernel-image", firstMatchingLine(text, noKernel));
	if (result.timedOut) return fail("timeout", "The CUDA probe timed out.");
	if (typeof result.exitCode === "number" && WINDOWS_DLL_NOT_FOUND_CODES.has(result.exitCode)) {
		return fail("missing-dll", "A CUDA runtime DLL could not be loaded.");
	}
	const cudaError =
		/CUDA error|cudaError|CUBLAS_STATUS_(?!SUCCESS)|ggml_cuda_init: failed|failed to initialize CUDA/i;
	if (cudaError.test(text)) return fail("cuda-error", firstMatchingLine(text, cudaError));
	if (result.exitCode !== 0) {
		return fail("failed", `whisper-cli exited with code ${String(result.exitCode)}.`);
	}
	if (
		/found 0 CUDA devices|no CUDA-capable device/i.test(text) ||
		!/using CUDA\d*\s+backend|ggml_cuda_init: found [1-9]\d* CUDA devices?/i.test(text)
	) {
		return fail("no-cuda-device", "whisper-cli ran without a CUDA device.");
	}
	return { usable: true, reason: "ok", detail: null, ...base };
}

// ── Paths, manifest and persisted probe ──

export interface CudaRuntimePaths {
	/** Where the downloaded release is extracted (userData/whisper-runtime/cuda). */
	downloadDir: string;
	/** JSON file holding the last probe result. */
	probeFile: string;
	/** Optional source build staged by scripts/build-whisper-runtime.mjs; preferred if present. */
	sourceBuildExecutable?: string | null;
	tempDir: string;
	/** GPU the runtime is pinned to (nvidia-smi UUID); empty/absent = CUDA's own choice. */
	gpuId?: string;
}

async function fileMtimeMs(filePath: string) {
	try {
		const stats = await fs.stat(filePath);
		return stats.isFile() ? stats.mtimeMs : null;
	} catch {
		return null;
	}
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
	try {
		return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
	} catch {
		return null;
	}
}

async function findCudaExecutable(paths: CudaRuntimePaths) {
	if (paths.sourceBuildExecutable && (await fileMtimeMs(paths.sourceBuildExecutable)) !== null) {
		return { source: "source-build" as const, executablePath: paths.sourceBuildExecutable };
	}
	const downloaded = path.join(paths.downloadDir, WHISPER_CLI);
	if ((await fileMtimeMs(downloaded)) !== null) {
		return { source: "download" as const, executablePath: downloaded };
	}
	return null;
}

let downloadInFlight: Promise<CudaRuntimeStatus> | null = null;

export async function getCudaRuntimeStatus(
	paths: CudaRuntimePaths,
	platform = process.platform,
	arch = process.arch,
): Promise<CudaRuntimeStatus> {
	const supported = isCudaRuntimeSupported(platform, arch);
	const asset = {
		name: WHISPER_CUDA_RUNTIME_RELEASE.assetName,
		sizeBytes: WHISPER_CUDA_RUNTIME_RELEASE.sizeBytes,
		cudaVersion: WHISPER_CUDA_RUNTIME_RELEASE.cudaVersion,
	};
	const found = supported ? await findCudaExecutable(paths) : null;
	if (!found) {
		return {
			supported,
			installed: false,
			source: null,
			executablePath: null,
			version: null,
			probe: null,
			usable: false,
			downloading: downloadInFlight !== null,
			asset,
			hint: null,
		};
	}

	const manifest = await readJsonFile<{ version?: string }>(
		path.join(
			path.dirname(found.executablePath),
			found.source === "download" ? MANIFEST_FILE : "whisper-runtime.json",
		),
	);
	const probe = await readJsonFile<CudaProbeRecord>(paths.probeFile);
	const mtime = await fileMtimeMs(found.executablePath);
	const probeMatches =
		probe !== null &&
		probe.executablePath === found.executablePath &&
		probe.executableMtimeMs === mtime &&
		// A verdict is only valid for the GPU it was measured on.
		(probe.gpuId ?? "") === (paths.gpuId ?? "");
	const currentProbe = probeMatches ? probe : null;
	return {
		supported,
		installed: true,
		source: found.source,
		executablePath: found.executablePath,
		version: manifest?.version ?? null,
		probe: currentProbe,
		usable: currentProbe?.usable === true,
		downloading: downloadInFlight !== null,
		asset,
		hint:
			currentProbe && !currentProbe.usable && currentProbe.reason !== "missing-dll"
				? CUDA_SOURCE_BUILD_HINT
				: null,
	};
}

// ── Probe ──

export type ProbeExec = (
	executablePath: string,
	args: string[],
	timeoutMs: number,
	env?: Record<string, string>,
) => Promise<{
	exitCode: number | string | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}>;

export const execProbe: ProbeExec = (executablePath, args, timeoutMs, env) =>
	new Promise((resolve) => {
		execFile(
			executablePath,
			args,
			{
				timeout: timeoutMs,
				maxBuffer: 20 * 1024 * 1024,
				windowsHide: true,
				env: env && Object.keys(env).length > 0 ? { ...process.env, ...env } : process.env,
			},
			(error, stdout, stderr) => {
				const failure = error as (NodeJS.ErrnoException & { killed?: boolean }) | null;
				resolve({
					exitCode: failure ? (failure.code ?? 1) : 0,
					stdout: String(stdout ?? ""),
					stderr: String(stderr ?? ""),
					timedOut: Boolean(failure?.killed),
				});
			},
		);
	});

/**
 * Run the CUDA whisper-cli once on 1 s of silence with the selected model and persist the
 * verdict. The process exits afterwards, so its VRAM is released immediately.
 */
export async function probeCudaRuntime(
	paths: CudaRuntimePaths,
	modelPath: string,
	deps: { exec?: ProbeExec; now?: () => Date } = {},
): Promise<CudaProbeRecord> {
	const found = await findCudaExecutable(paths);
	if (!found) throw new Error("The CUDA Whisper runtime is not installed.");
	const exec = deps.exec ?? execProbe;
	const wavPath = path.join(
		paths.tempDir,
		`recordly-cuda-probe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`,
	);
	await fs.mkdir(paths.tempDir, { recursive: true });
	await fs.writeFile(wavPath, createSilentWav(1000));
	let classification: CudaProbeClassification;
	try {
		// No `-np`: the CUDA device lines are what prove the GPU was actually used.
		const result = await exec(
			found.executablePath,
			["-m", modelPath, "-f", wavPath, "-l", "en", "-nt"],
			3 * 60 * 1000,
			buildCudaDeviceEnv(paths.gpuId),
		);
		classification = classifyCudaProbe(result);
	} finally {
		await fs.rm(wavPath, { force: true }).catch(() => undefined);
	}
	const record: CudaProbeRecord = {
		...classification,
		checkedAt: (deps.now?.() ?? new Date()).toISOString(),
		executablePath: found.executablePath,
		executableMtimeMs: (await fileMtimeMs(found.executablePath)) ?? 0,
		modelPath,
		gpuId: paths.gpuId ?? "",
	};
	await fs.mkdir(path.dirname(paths.probeFile), { recursive: true });
	await fs.writeFile(paths.probeFile, JSON.stringify(record, null, 2), "utf8");
	return record;
}

/** A job's CUDA run failed: persist it as unusable when the failure is CUDA-specific. */
export async function recordCudaRuntimeFailure(paths: CudaRuntimePaths, error: unknown) {
	const failure = (error ?? {}) as {
		code?: number | string;
		stderr?: unknown;
		message?: unknown;
	};
	const message = String(failure.message ?? "");
	// executeWhisper rewrites STATUS_DLL_NOT_FOUND into a "could not start" message.
	const classification = /could not start because/i.test(message)
		? classifyCudaProbe({ exitCode: -1073741515, stderr: "" })
		: classifyCudaProbe({
				exitCode: failure.code ?? 1,
				stderr: `${String(failure.stderr ?? "")}\n${message}`,
			});
	if (classification.reason === "failed") return null;
	const found = await findCudaExecutable(paths);
	if (!found) return null;
	const previous = await readJsonFile<CudaProbeRecord>(paths.probeFile);
	const record: CudaProbeRecord = {
		...classification,
		usable: false,
		gpuName: classification.gpuName ?? previous?.gpuName ?? null,
		computeCapability: classification.computeCapability ?? previous?.computeCapability ?? null,
		checkedAt: new Date().toISOString(),
		executablePath: found.executablePath,
		executableMtimeMs: (await fileMtimeMs(found.executablePath)) ?? 0,
		modelPath: previous?.modelPath ?? "",
		gpuId: paths.gpuId ?? "",
	};
	await fs.writeFile(paths.probeFile, JSON.stringify(record, null, 2), "utf8");
	return record;
}

/**
 * The CUDA executable a local job should use, or null for the CPU runtime. An installed but
 * never-probed runtime is probed once with the job's model before being trusted.
 */
export async function resolveCudaExecutableForJob(
	paths: CudaRuntimePaths,
	modelPath: string | null | undefined,
	deps: { exec?: ProbeExec } = {},
): Promise<string | null> {
	const status = await getCudaRuntimeStatus(paths);
	if (!status.installed || !status.executablePath) return null;
	if (status.probe) return status.usable ? status.executablePath : null;
	if (!modelPath) return null;
	try {
		const record = await probeCudaRuntime(paths, modelPath, deps);
		return record.usable ? record.executablePath : null;
	} catch (error) {
		console.warn("[auto-captions] CUDA runtime probe failed:", error);
		return null;
	}
}

// ── Install / delete ──

export type ArchiveExtractFn = (archivePath: string, destinationDir: string) => Promise<void>;

/** Windows 10+ ships bsdtar, which unpacks zip archives (same as the build script). */
export const extractWithTar: ArchiveExtractFn = (archivePath, destinationDir) =>
	new Promise((resolve, reject) => {
		execFile(
			"tar",
			["-xf", archivePath, "-C", destinationDir],
			{ timeout: 10 * 60 * 1000, windowsHide: true },
			(error) => (error ? reject(error) : resolve()),
		);
	});

async function findDirectoryContaining(rootPath: string, fileName: string): Promise<string | null> {
	const pending = [rootPath];
	while (pending.length > 0) {
		const current = pending.shift() as string;
		const entries = await fs.readdir(current, { withFileTypes: true });
		if (entries.some((item) => item.isFile() && item.name.toLowerCase() === fileName)) {
			return current;
		}
		for (const item of entries) {
			if (item.isDirectory()) pending.push(path.join(current, item.name));
		}
	}
	return null;
}

export function installCudaRuntime(
	paths: CudaRuntimePaths,
	onProgress: (progress: number) => void,
	deps: {
		download: ModelDownloadFn;
		verify?: typeof verifyDownloadedFile;
		extract?: ArchiveExtractFn;
	},
): Promise<CudaRuntimeStatus> {
	if (downloadInFlight) return downloadInFlight;
	if (!isCudaRuntimeSupported()) {
		return Promise.reject(
			new Error("The CUDA Whisper runtime is only available on Windows x64."),
		);
	}

	const run = async () => {
		const parentDir = path.dirname(paths.downloadDir);
		const archivePath = path.join(
			parentDir,
			`${WHISPER_CUDA_RUNTIME_RELEASE.assetName}.download`,
		);
		const stagingDir = `${paths.downloadDir}.staging`;
		await fs.mkdir(parentDir, { recursive: true });
		try {
			await fs.rm(archivePath, { force: true });
			await deps.download(WHISPER_CUDA_RUNTIME_RELEASE.url, archivePath, onProgress);
			const verification = await (deps.verify ?? verifyDownloadedFile)(
				archivePath,
				WHISPER_CUDA_RUNTIME_RELEASE,
			);
			if (!verification.ok) {
				throw new Error(
					`The CUDA runtime archive failed verification: ${verification.reason}.`,
				);
			}

			await fs.rm(stagingDir, { recursive: true, force: true });
			await fs.mkdir(stagingDir, { recursive: true });
			await (deps.extract ?? extractWithTar)(archivePath, stagingDir);
			const runtimeDir = await findDirectoryContaining(stagingDir, WHISPER_CLI);
			if (!runtimeDir) {
				throw new Error("The CUDA runtime archive does not contain whisper-cli.exe.");
			}

			await fs.rm(paths.downloadDir, { recursive: true, force: true });
			await fs.rename(runtimeDir, paths.downloadDir);
			await fs.writeFile(
				path.join(paths.downloadDir, MANIFEST_FILE),
				JSON.stringify(
					{
						version: WHISPER_CUDA_RUNTIME_RELEASE.version,
						asset: WHISPER_CUDA_RUNTIME_RELEASE.assetName,
						sha256: WHISPER_CUDA_RUNTIME_RELEASE.sha256,
						installedAt: new Date().toISOString(),
					},
					null,
					2,
				),
				"utf8",
			);
			// A previous verdict belongs to the old binaries.
			await fs.rm(paths.probeFile, { force: true });
		} finally {
			await Promise.allSettled([
				fs.rm(archivePath, { force: true }),
				fs.rm(stagingDir, { recursive: true, force: true }),
			]);
		}
		return { ...(await getCudaRuntimeStatus(paths)), downloading: false };
	};

	downloadInFlight = run().finally(() => {
		downloadInFlight = null;
	});
	return downloadInFlight;
}

export async function deleteCudaRuntime(paths: CudaRuntimePaths) {
	await fs.rm(paths.downloadDir, { recursive: true, force: true });
	await fs.rm(paths.probeFile, { force: true });
}
