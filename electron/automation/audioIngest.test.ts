import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { extensionForContentType, ingestAudio, readWavDurationMs } from "./audioIngest";

function makeWav(durationMs: number, sampleRate = 16000) {
	const samples = Math.round((sampleRate * durationMs) / 1000);
	const dataSize = samples * 2;
	const buffer = Buffer.alloc(44 + dataSize);
	buffer.write("RIFF", 0, "ascii");
	buffer.writeUInt32LE(36 + dataSize, 4);
	buffer.write("WAVE", 8, "ascii");
	buffer.write("fmt ", 12, "ascii");
	buffer.writeUInt32LE(16, 16);
	buffer.writeUInt16LE(1, 20);
	buffer.writeUInt16LE(1, 22);
	buffer.writeUInt32LE(sampleRate, 24);
	buffer.writeUInt32LE(sampleRate * 2, 28);
	buffer.writeUInt16LE(2, 32);
	buffer.writeUInt16LE(16, 34);
	buffer.write("data", 36, "ascii");
	buffer.writeUInt32LE(dataSize, 40);
	return buffer;
}

describe("audio ingest", () => {
	it("reads WAV durations, including streamed placeholder sizes", () => {
		expect(readWavDurationMs(makeWav(1500))).toBe(1500);
		const streamed = makeWav(500);
		streamed.writeUInt32LE(0xffffffff, 40);
		expect(readWavDurationMs(streamed)).toBe(500);
		expect(readWavDurationMs(Buffer.from("not a wav"))).toBeNull();
	});

	it("maps content types to extensions", () => {
		expect(extensionForContentType("audio/mpeg")).toBe(".mp3");
		expect(extensionForContentType("audio/wav; codecs=1")).toBe(".wav");
		expect(extensionForContentType("text/plain")).toBeNull();
	});

	it("writes base64 WAV payloads and measures them without ffprobe", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rai-ingest-"));
		try {
			const result = await ingestAudio(
				{ base64: makeWav(2000).toString("base64") },
				dir,
				"narration-1",
				"ffprobe-not-needed",
			);
			expect(result.durationMs).toBe(2000);
			expect(path.basename(result.path)).toBe("narration-1.wav");
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("rejects unknown payloads", async () => {
		await expect(ingestAudio({}, os.tmpdir(), "x", "ffprobe")).rejects.toThrow(/Provide audio/);
		await expect(
			ingestAudio(
				{ base64: Buffer.from("garbage").toString("base64") },
				os.tmpdir(),
				"x",
				"p",
			),
		).rejects.toThrow(/infer the audio format/);
	});
});
