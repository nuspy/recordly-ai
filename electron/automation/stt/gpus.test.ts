import { describe, expect, it } from "vitest";
import { DEFAULT_AUTOMATION_SETTINGS, normalizeAutomationSettings } from "../contract";
import { buildCudaDeviceEnv, listNvidiaGpus, parseNvidiaSmiGpuList } from "./gpus";

const TWO_GPUS = [
	"0, GPU-5559130f-b0f4-0f08-e7ce-034389b9861e, NVIDIA GeForce RTX 5090, 32607, 617.42, 12.0",
	"1, GPU-0a1b2c3d-1111-2222-3333-444455556666, NVIDIA GeForce RTX 3060, 12288, 617.42, 8.6",
].join("\r\n");

describe("parseNvidiaSmiGpuList", () => {
	it("reads one entry per GPU", () => {
		expect(parseNvidiaSmiGpuList(TWO_GPUS)).toEqual([
			{
				index: 0,
				id: "GPU-5559130f-b0f4-0f08-e7ce-034389b9861e",
				name: "NVIDIA GeForce RTX 5090",
				memoryMiB: 32607,
				driverVersion: "617.42",
				computeCapability: "12.0",
			},
			{
				index: 1,
				id: "GPU-0a1b2c3d-1111-2222-3333-444455556666",
				name: "NVIDIA GeForce RTX 3060",
				memoryMiB: 12288,
				driverVersion: "617.42",
				computeCapability: "8.6",
			},
		]);
	});

	it("skips blank, short and non-UUID lines and tolerates missing values", () => {
		const csv = [
			"",
			"No devices were found",
			"0, not-a-uuid, Some GPU, 1000, 500.0, 7.5",
			"2, GPU-abcd-ef01, Old GPU, [N/A], , [N/A]",
		].join("\n");
		expect(parseNvidiaSmiGpuList(csv)).toEqual([
			{
				index: 2,
				id: "GPU-abcd-ef01",
				name: "Old GPU",
				memoryMiB: null,
				driverVersion: null,
				computeCapability: null,
			},
		]);
	});
});

describe("listNvidiaGpus", () => {
	it("asks nvidia-smi for the GPU fields and parses the answer", async () => {
		const calls: string[][] = [];
		const gpus = await listNvidiaGpus(async (args) => {
			calls.push(args);
			return TWO_GPUS;
		});
		expect(gpus).toHaveLength(2);
		expect(calls[0]).toEqual([
			"--query-gpu=index,uuid,name,memory.total,driver_version,compute_cap",
			"--format=csv,noheader,nounits",
		]);
	});

	it("returns an empty list when nvidia-smi is missing or fails", async () => {
		expect(
			await listNvidiaGpus(async () => {
				throw new Error("spawn nvidia-smi ENOENT");
			}),
		).toEqual([]);
	});
});

describe("buildCudaDeviceEnv", () => {
	it("pins CUDA to the chosen GPU by UUID", () => {
		expect(buildCudaDeviceEnv("GPU-5559130f-b0f4-0f08-e7ce-034389b9861e")).toEqual({
			CUDA_DEVICE_ORDER: "PCI_BUS_ID",
			CUDA_VISIBLE_DEVICES: "GPU-5559130f-b0f4-0f08-e7ce-034389b9861e",
		});
	});

	it("leaves CUDA's choice for empty or malformed ids", () => {
		expect(buildCudaDeviceEnv("")).toEqual({});
		expect(buildCudaDeviceEnv(null)).toEqual({});
		expect(buildCudaDeviceEnv("0,1")).toEqual({});
		expect(buildCudaDeviceEnv("GPU-1; calc")).toEqual({});
	});
});

describe("sttGpuId setting", () => {
	it("defaults to automatic and keeps only well-formed GPU ids", () => {
		expect(DEFAULT_AUTOMATION_SETTINGS.sttGpuId).toBe("");
		expect(normalizeAutomationSettings({}).sttGpuId).toBe("");
		expect(normalizeAutomationSettings({ sttGpuId: " GPU-abc-123 " }).sttGpuId).toBe(
			"GPU-abc-123",
		);
		expect(normalizeAutomationSettings({ sttGpuId: "1" }).sttGpuId).toBe("");
		expect(normalizeAutomationSettings({ sttGpuId: 3 }).sttGpuId).toBe("");
	});
});
