import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { badRequest } from "./http";

const execFileAsync = promisify(execFile);

export const SUPPORTED_AUDIO_EXTENSIONS = new Set([
	".wav",
	".mp3",
	".m4a",
	".aac",
	".flac",
	".ogg",
	".opus",
	".webm",
]);

const CONTENT_TYPE_EXTENSIONS: Record<string, string> = {
	"audio/wav": ".wav",
	"audio/x-wav": ".wav",
	"audio/wave": ".wav",
	"audio/mpeg": ".mp3",
	"audio/mp3": ".mp3",
	"audio/mp4": ".m4a",
	"audio/aac": ".aac",
	"audio/flac": ".flac",
	"audio/ogg": ".ogg",
	"audio/opus": ".opus",
	"audio/webm": ".webm",
};

export function extensionForContentType(contentType: string): string | null {
	return CONTENT_TYPE_EXTENSIONS[contentType.split(";")[0].trim().toLowerCase()] ?? null;
}

/** Duration of a PCM/float RIFF WAVE buffer, or null when it is not a parsable WAV. */
export function readWavDurationMs(buffer: Buffer): number | null {
	if (buffer.length < 12 || buffer.toString("ascii", 0, 4) !== "RIFF") return null;
	if (buffer.toString("ascii", 8, 12) !== "WAVE") return null;
	let offset = 12;
	let byteRate: number | null = null;
	while (offset + 8 <= buffer.length) {
		const chunkId = buffer.toString("ascii", offset, offset + 4);
		const chunkSize = buffer.readUInt32LE(offset + 4);
		const body = offset + 8;
		if (chunkId === "fmt " && body + 12 <= buffer.length) {
			byteRate = buffer.readUInt32LE(body + 8);
		} else if (chunkId === "data") {
			if (!byteRate) return null;
			// Streamed WAVs may carry a 0/0xFFFFFFFF placeholder size; trust the file length then.
			const available = buffer.length - body;
			const dataSize =
				chunkSize === 0 || chunkSize === 0xffffffff
					? available
					: Math.min(chunkSize, available);
			return Math.round((dataSize / byteRate) * 1000);
		}
		offset = body + chunkSize + (chunkSize % 2);
	}
	return null;
}

export async function probeAudioDurationMs(filePath: string, ffprobePath: string) {
	if (path.extname(filePath).toLowerCase() === ".wav") {
		const wavDuration = readWavDurationMs(await fs.readFile(filePath));
		if (wavDuration !== null) return wavDuration;
	}
	const { stdout } = await execFileAsync(
		ffprobePath,
		["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", filePath],
		{ timeout: 30_000 },
	);
	const seconds = Number.parseFloat(stdout.trim());
	if (!Number.isFinite(seconds) || seconds <= 0) {
		throw badRequest(`Could not read the duration of ${path.basename(filePath)}.`);
	}
	return Math.round(seconds * 1000);
}

export interface AudioSource {
	/** Absolute path of an existing local file (copied, so the caller may delete it). */
	path?: string;
	/** Base64 audio payload (`data:` URLs accepted). */
	base64?: string;
	/** Raw bytes from an `audio/*` request body. */
	buffer?: Buffer;
	/** Extension or MIME type when it cannot be derived from `path`. */
	format?: string;
}

export interface IngestedAudio {
	path: string;
	durationMs: number;
}

function normalizeExtension(format: string | undefined): string | null {
	if (!format) return null;
	const lowered = format.trim().toLowerCase();
	if (lowered.includes("/")) return extensionForContentType(lowered);
	const extension = lowered.startsWith(".") ? lowered : `.${lowered}`;
	return SUPPORTED_AUDIO_EXTENSIONS.has(extension) ? extension : null;
}

/** Copies/writes the audio into Recordly's own session folder and measures it. */
export async function ingestAudio(
	source: AudioSource,
	targetDir: string,
	fileStem: string,
	ffprobePath: string,
): Promise<IngestedAudio> {
	await fs.mkdir(targetDir, { recursive: true });

	if (source.path) {
		const sourcePath = path.resolve(source.path);
		const extension = path.extname(sourcePath).toLowerCase();
		if (!SUPPORTED_AUDIO_EXTENSIONS.has(extension)) {
			throw badRequest(`Unsupported audio format "${extension || "none"}".`);
		}
		try {
			await fs.access(sourcePath);
		} catch {
			throw badRequest(`Audio file not found: ${sourcePath}`);
		}
		const targetPath = path.join(targetDir, `${fileStem}${extension}`);
		await fs.copyFile(sourcePath, targetPath);
		return {
			path: targetPath,
			durationMs: await probeAudioDurationMs(targetPath, ffprobePath),
		};
	}

	let bytes: Buffer | null = source.buffer ?? null;
	let extension = normalizeExtension(source.format);
	if (!bytes && source.base64) {
		const dataUrl = /^data:([^;,]+)(;base64)?,/.exec(source.base64);
		if (dataUrl) {
			extension ??= extensionForContentType(dataUrl[1]);
			bytes = Buffer.from(source.base64.slice(dataUrl[0].length), "base64");
		} else {
			bytes = Buffer.from(source.base64, "base64");
		}
	}
	if (!bytes || bytes.length === 0) {
		throw badRequest("Provide audio as `path`, `base64` or an audio/* request body.");
	}
	extension ??= readWavDurationMs(bytes) !== null ? ".wav" : null;
	if (!extension) {
		throw badRequest('Cannot infer the audio format: pass `format` (e.g. "wav" or "mp3").');
	}
	const targetPath = path.join(targetDir, `${fileStem}${extension}`);
	await fs.writeFile(targetPath, bytes);
	return { path: targetPath, durationMs: await probeAudioDurationMs(targetPath, ffprobePath) };
}
