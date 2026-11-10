import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	computeFileSha256,
	downloadWhisperModel,
	findWhisperModel,
	listWhisperModels,
	verifyDownloadedFile,
	WHISPER_MODEL_CATALOG,
	type WhisperModelCatalogEntry,
} from "./models";

const tempDirs: string[] = [];
async function makeTempDir() {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "recordly-stt-models-"));
	tempDirs.push(dir);
	return dir;
}
afterEach(async () => {
	await Promise.all(
		tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
	);
});

const sha256 = (data: string) => createHash("sha256").update(data).digest("hex");

function fakeModel(content: string): WhisperModelCatalogEntry {
	return {
		id: "small",
		label: "Fake",
		fileName: "ggml-fake.bin",
		url: "https://example.invalid/ggml-fake.bin",
		sizeBytes: Buffer.byteLength(content),
		sha256: sha256(content),
	};
}

describe("whisper model catalog", () => {
	it("lists the three supported ggml models with Hugging Face URLs and hashes", () => {
		expect(WHISPER_MODEL_CATALOG.map((model) => model.fileName)).toEqual([
			"ggml-small.bin",
			"ggml-large-v3-turbo-q5_0.bin",
			"ggml-large-v3-turbo.bin",
		]);
		for (const model of WHISPER_MODEL_CATALOG) {
			expect(model.url).toBe(
				`https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${model.fileName}`,
			);
			expect(model.sha256).toMatch(/^[0-9a-f]{64}$/);
		}
		expect(findWhisperModel("large-v3-turbo")?.sizeBytes).toBe(1_624_555_275);
		expect(findWhisperModel("large-v3-turbo-q5_0")?.sizeBytes).toBe(574_041_195);
		expect(findWhisperModel("tiny")).toBeNull();
	});
});

describe("verifyDownloadedFile", () => {
	it("checks size before hashing", async () => {
		let hashed = false;
		const result = await verifyDownloadedFile(
			"/x",
			{ sizeBytes: 10, sha256: "a".repeat(64) },
			{
				statSize: async () => 9,
				sha256: async () => {
					hashed = true;
					return "a".repeat(64);
				},
			},
		);
		expect(result).toEqual({ ok: false, reason: expect.stringContaining("size mismatch") });
		expect(hashed).toBe(false);
	});

	it("accepts a matching hash case-insensitively and rejects a different one", async () => {
		const expected = { sizeBytes: 3, sha256: "AB".repeat(32) };
		const deps = { statSize: async () => 3 };
		await expect(
			verifyDownloadedFile("/x", expected, { ...deps, sha256: async () => "ab".repeat(32) }),
		).resolves.toEqual({ ok: true });
		await expect(
			verifyDownloadedFile("/x", expected, { ...deps, sha256: async () => "cd".repeat(32) }),
		).resolves.toMatchObject({ ok: false });
	});

	it("hashes real file content", async () => {
		const dir = await makeTempDir();
		const file = path.join(dir, "a.bin");
		await fs.writeFile(file, "hello");
		expect(await computeFileSha256(file)).toBe(sha256("hello"));
	});
});

describe("downloadWhisperModel", () => {
	it("moves a verified download into place", async () => {
		const dir = await makeTempDir();
		const model = fakeModel("model-bytes");
		const progress: number[] = [];
		const finalPath = await downloadWhisperModel(model, dir, (p) => progress.push(p), {
			download: async (_url, destination, onProgress) => {
				await fs.writeFile(destination, "model-bytes");
				onProgress(100);
			},
		});
		expect(finalPath).toBe(path.join(dir, "ggml-fake.bin"));
		expect(await fs.readFile(finalPath, "utf8")).toBe("model-bytes");
		expect(progress).toEqual([100]);
		await expect(fs.access(`${finalPath}.download`)).rejects.toThrow();
	});

	it("deletes a corrupted download and reports the mismatch", async () => {
		const dir = await makeTempDir();
		const model = fakeModel("model-bytes");
		await expect(
			downloadWhisperModel(model, dir, () => undefined, {
				download: async (_url, destination) => {
					await fs.writeFile(destination, "MODEL-BYTES");
				},
			}),
		).rejects.toThrow(/SHA-256 mismatch/);
		expect(await fs.readdir(dir)).toEqual([]);
	});

	it("reports installed models by size", async () => {
		const dir = await makeTempDir();
		await fs.writeFile(path.join(dir, "ggml-small.bin"), "truncated");
		const models = await listWhisperModels(dir);
		expect(models.find((model) => model.id === "small")).toMatchObject({
			installed: false,
			path: path.join(dir, "ggml-small.bin"),
		});
	});
});
