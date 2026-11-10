// Minimal PCM WAV helpers: the caption pipeline always extracts 16 kHz mono s16le with ffmpeg,
// so bridge segments are sliced in memory instead of spawning ffmpeg once per segment.

export interface PcmWavInfo {
	sampleRate: number;
	channels: number;
	bitsPerSample: number;
	dataOffset: number;
	dataLength: number;
	durationMs: number;
}

export function parsePcmWav(buffer: Buffer): PcmWavInfo {
	if (
		buffer.length < 12 ||
		buffer.toString("ascii", 0, 4) !== "RIFF" ||
		buffer.toString("ascii", 8, 12) !== "WAVE"
	) {
		throw new Error("Not a RIFF/WAVE file.");
	}

	let offset = 12;
	let format: { audioFormat: number; channels: number; sampleRate: number; bits: number } | null =
		null;
	while (offset + 8 <= buffer.length) {
		const chunkId = buffer.toString("ascii", offset, offset + 4);
		const chunkSize = buffer.readUInt32LE(offset + 4);
		const bodyOffset = offset + 8;
		if (chunkId === "fmt ") {
			format = {
				audioFormat: buffer.readUInt16LE(bodyOffset),
				channels: buffer.readUInt16LE(bodyOffset + 2),
				sampleRate: buffer.readUInt32LE(bodyOffset + 4),
				bits: buffer.readUInt16LE(bodyOffset + 14),
			};
		} else if (chunkId === "data") {
			if (!format) throw new Error("WAV data chunk precedes its fmt chunk.");
			// WAVE_FORMAT_PCM, or WAVE_FORMAT_EXTENSIBLE carrying PCM.
			if ((format.audioFormat !== 1 && format.audioFormat !== 0xfffe) || format.bits !== 16) {
				throw new Error("Only 16-bit PCM WAV audio is supported.");
			}
			// Streamed writers leave a placeholder size; trust the bytes actually present.
			const dataLength = Math.min(chunkSize, buffer.length - bodyOffset);
			const bytesPerSecond = format.sampleRate * format.channels * 2;
			return {
				sampleRate: format.sampleRate,
				channels: format.channels,
				bitsPerSample: format.bits,
				dataOffset: bodyOffset,
				dataLength,
				durationMs: Math.floor((dataLength / bytesPerSecond) * 1000),
			};
		}
		offset = bodyOffset + chunkSize + (chunkSize % 2);
	}
	throw new Error("WAV file has no data chunk.");
}

export function encodePcmWav(pcm: Buffer, sampleRate: number, channels = 1): Buffer {
	const header = Buffer.alloc(44);
	const byteRate = sampleRate * channels * 2;
	header.write("RIFF", 0, "ascii");
	header.writeUInt32LE(36 + pcm.length, 4);
	header.write("WAVE", 8, "ascii");
	header.write("fmt ", 12, "ascii");
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20);
	header.writeUInt16LE(channels, 22);
	header.writeUInt32LE(sampleRate, 24);
	header.writeUInt32LE(byteRate, 28);
	header.writeUInt16LE(channels * 2, 32);
	header.writeUInt16LE(16, 34);
	header.write("data", 36, "ascii");
	header.writeUInt32LE(pcm.length, 40);
	return Buffer.concat([header, pcm]);
}

/** A standalone WAV holding [startMs, endMs) of the source audio. */
export function sliceWav(buffer: Buffer, info: PcmWavInfo, startMs: number, endMs: number): Buffer {
	const frameBytes = info.channels * 2;
	const toByte = (ms: number) => {
		const frame = Math.round((Math.max(0, ms) / 1000) * info.sampleRate);
		return Math.min(info.dataLength, frame * frameBytes);
	};
	const start = info.dataOffset + toByte(startMs);
	const end = info.dataOffset + Math.max(toByte(startMs), toByte(endMs));
	return encodePcmWav(buffer.subarray(start, end), info.sampleRate, info.channels);
}

export function createSilentWav(durationMs: number, sampleRate = 16_000): Buffer {
	const frames = Math.round((durationMs / 1000) * sampleRate);
	return encodePcmWav(Buffer.alloc(frames * 2), sampleRate, 1);
}
