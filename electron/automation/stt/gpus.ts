import { execFile } from "node:child_process";
import { GPU_ID_PATTERN } from "../contract";
import type { SttGpuInfo } from "./types";

const NVIDIA_SMI_QUERY = "index,uuid,name,memory.total,driver_version,compute_cap";

export function isValidGpuId(value: unknown): value is string {
	return typeof value === "string" && GPU_ID_PATTERN.test(value);
}

/** Parses `nvidia-smi --query-gpu=... --format=csv,noheader,nounits` into one entry per GPU. */
export function parseNvidiaSmiGpuList(csv: string): SttGpuInfo[] {
	const gpus: SttGpuInfo[] = [];
	for (const line of csv.split(/\r?\n/)) {
		const fields = line.split(",").map((field) => field.trim());
		if (fields.length < 6) continue;
		const [index, id, name, memory, driverVersion, computeCapability] = fields;
		if (!isValidGpuId(id) || !/^\d+$/.test(index)) continue;
		const memoryMiB = Number.parseInt(memory, 10);
		gpus.push({
			index: Number.parseInt(index, 10),
			id,
			name,
			memoryMiB: Number.isFinite(memoryMiB) ? memoryMiB : null,
			driverVersion: driverVersion || null,
			computeCapability: /^\d+\.\d+$/.test(computeCapability) ? computeCapability : null,
		});
	}
	return gpus;
}

type NvidiaSmiExec = (args: string[], timeoutMs: number) => Promise<string>;

const execNvidiaSmi: NvidiaSmiExec = (args, timeoutMs) =>
	new Promise((resolve, reject) => {
		execFile(
			"nvidia-smi",
			args,
			{ timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 },
			(error, stdout) => (error ? reject(error) : resolve(String(stdout ?? ""))),
		);
	});

/** NVIDIA GPUs of this PC; an empty list when there is no NVIDIA driver (`nvidia-smi` missing). */
export async function listNvidiaGpus(exec: NvidiaSmiExec = execNvidiaSmi): Promise<SttGpuInfo[]> {
	try {
		const stdout = await exec(
			[`--query-gpu=${NVIDIA_SMI_QUERY}`, "--format=csv,noheader,nounits"],
			10_000,
		);
		return parseNvidiaSmiGpuList(stdout);
	} catch {
		return [];
	}
}

/**
 * Environment that makes whisper-cli see only the chosen GPU. The UUID is stable across
 * reboots and slot changes; PCI_BUS_ID keeps CUDA's numbering equal to nvidia-smi's. An empty
 * or invalid id leaves CUDA's own choice (the fastest GPU).
 */
export function buildCudaDeviceEnv(gpuId: string | null | undefined): Record<string, string> {
	if (!isValidGpuId(gpuId)) return {};
	return { CUDA_DEVICE_ORDER: "PCI_BUS_ID", CUDA_VISIBLE_DEVICES: gpuId };
}
