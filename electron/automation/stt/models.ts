import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { WhisperModelId, WhisperModelStatus } from "./types";

export type { WhisperModelId, WhisperModelStatus };

export const WHISPER_MODEL_BASE_URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";

export interface WhisperModelCatalogEntry {
	id: WhisperModelId;
	label: string;
	fileName: string;
	url: string;
	sizeBytes: number;
	/** LFS object id reported by the Hugging Face tree API (= SHA-256 of the file). */
	sha256: string;
}

function entry(
	id: WhisperModelId,
	label: string,
	fileName: string,
	sizeBytes: number,
	sha256: string,
): WhisperModelCatalogEntry {
	return { id, label, fileName, url: `${WHISPER_MODEL_BASE_URL}/${fileName}`, sizeBytes, sha256 };
}

export const WHISPER_MODEL_CATALOG: readonly WhisperModelCatalogEntry[] = [
	entry(
		"small",
		"Small (multilingual)",
		"ggml-small.bin",
		487_601_967,
		"1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
	),
	entry(
		"large-v3-turbo-q5_0",
		"Large v3 Turbo (Q5_0)",
		"ggml-large-v3-turbo-q5_0.bin",
		574_041_195,
		"394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
	),
	entry(
		"large-v3-turbo",
		"Large v3 Turbo",
		"ggml-large-v3-turbo.bin",
		1_624_555_275,
		"1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69",
	),
];

export function findWhisperModel(id: string): WhisperModelCatalogEntry | null {
	return WHISPER_MODEL_CATALOG.find((model) => model.id === id) ?? null;
}

export function getWhisperModelPath(model: WhisperModelCatalogEntry, modelDir: string) {
	return path.join(modelDir, model.fileName);
}

export async function computeFileSha256(filePath: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(filePath)) {
		hash.update(chunk as Buffer);
	}
	return hash.digest("hex");
}

export type FileVerification = { ok: true } | { ok: false; reason: string };

/** Size first (cheap, catches truncated downloads), then the SHA-256 of the content. */
export async function verifyDownloadedFile(
	filePath: string,
	expected: { sizeBytes: number; sha256: string },
	deps: {
		statSize?: (filePath: string) => Promise<number>;
		sha256?: (filePath: string) => Promise<string>;
	} = {},
): Promise<FileVerification> {
	const statSize = deps.statSize ?? (async (file: string) => (await fs.stat(file)).size);
	const sha256 = deps.sha256 ?? computeFileSha256;
	const size = await statSize(filePath);
	if (size !== expected.sizeBytes) {
		return {
			ok: false,
			reason: `size mismatch (expected ${expected.sizeBytes} bytes, got ${size})`,
		};
	}
	const digest = (await sha256(filePath)).toLowerCase();
	if (digest !== expected.sha256.toLowerCase()) {
		return {
			ok: false,
			reason: `SHA-256 mismatch (expected ${expected.sha256}, got ${digest})`,
		};
	}
	return { ok: true };
}

const inFlightDownloads = new Map<WhisperModelId, Promise<string>>();

export async function listWhisperModels(modelDir: string): Promise<WhisperModelStatus[]> {
	return Promise.all(
		WHISPER_MODEL_CATALOG.map(async (model) => {
			const modelPath = getWhisperModelPath(model, modelDir);
			// A size match is the cheap "installed" check; the hash is verified on download.
			const installed = await fs
				.stat(modelPath)
				.then((stats) => stats.isFile() && stats.size === model.sizeBytes)
				.catch(() => false);
			return {
				id: model.id,
				label: model.label,
				fileName: model.fileName,
				sizeBytes: model.sizeBytes,
				installed,
				path: modelPath,
				downloading: inFlightDownloads.has(model.id),
			};
		}),
	);
}

export type ModelDownloadFn = (
	url: string,
	destinationPath: string,
	onProgress: (progress: number) => void,
) => Promise<void>;

export interface ModelDownloadDeps {
	download: ModelDownloadFn;
	verify?: typeof verifyDownloadedFile;
}

/** Download into `<file>.download`, verify size + SHA-256, then move into place. */
export function downloadWhisperModel(
	model: WhisperModelCatalogEntry,
	modelDir: string,
	onProgress: (progress: number) => void,
	deps: ModelDownloadDeps,
): Promise<string> {
	const existing = inFlightDownloads.get(model.id);
	if (existing) return existing;

	const run = async () => {
		const finalPath = getWhisperModelPath(model, modelDir);
		const tempPath = `${finalPath}.download`;
		await fs.mkdir(modelDir, { recursive: true });
		await fs.rm(tempPath, { force: true });
		try {
			await deps.download(model.url, tempPath, onProgress);
			const verification = await (deps.verify ?? verifyDownloadedFile)(tempPath, model);
			if (!verification.ok) {
				throw new Error(
					`Downloaded ${model.fileName} failed verification: ${verification.reason}.`,
				);
			}
			await fs.rm(finalPath, { force: true });
			await fs.rename(tempPath, finalPath);
			return finalPath;
		} catch (error) {
			await fs.rm(tempPath, { force: true }).catch(() => undefined);
			throw error;
		}
	};

	const promise = run().finally(() => inFlightDownloads.delete(model.id));
	inFlightDownloads.set(model.id, promise);
	return promise;
}

export async function deleteWhisperModel(model: WhisperModelCatalogEntry, modelDir: string) {
	await fs.rm(getWhisperModelPath(model, modelDir), { force: true });
}
