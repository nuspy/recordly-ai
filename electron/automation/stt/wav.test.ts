import { describe, expect, it } from "vitest";
import { createSilentWav, encodePcmWav, parsePcmWav, sliceWav } from "./wav";

function rampWav(durationMs: number) {
	const frames = (durationMs / 1000) * 16_000;
	const pcm = Buffer.alloc(frames * 2);
	for (let index = 0; index < frames; index += 1) pcm.writeInt16LE(index % 30_000, index * 2);
	return encodePcmWav(pcm, 16_000);
}

describe("wav helpers", () => {
	it("parses the header written by encodePcmWav", () => {
		const info = parsePcmWav(createSilentWav(1000));
		expect(info).toMatchObject({ sampleRate: 16_000, channels: 1, bitsPerSample: 16 });
		expect(info.durationMs).toBe(1000);
		expect(info.dataLength).toBe(32_000);
	});

	it("skips extra chunks such as LIST before data", () => {
		const base = createSilentWav(500);
		const list = Buffer.alloc(12);
		list.write("LIST", 0, "ascii");
		list.writeUInt32LE(4, 4);
		const withList = Buffer.concat([base.subarray(0, 36), list, base.subarray(36)]);
		expect(parsePcmWav(withList).durationMs).toBe(500);
	});

	it("slices a time range into a standalone wav", () => {
		const wav = rampWav(2000);
		const info = parsePcmWav(wav);
		const slice = sliceWav(wav, info, 500, 1500);
		const sliceInfo = parsePcmWav(slice);
		expect(sliceInfo.durationMs).toBe(1000);
		expect(slice.readInt16LE(sliceInfo.dataOffset)).toBe(8000);
		expect(sliceWav(wav, info, 1500, 9000).length - 44).toBe(16_000);
	});

	it("rejects non-WAV input", () => {
		expect(() => parsePcmWav(Buffer.from("not a wav file at all"))).toThrow();
	});
});
