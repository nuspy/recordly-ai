import { buildIgnoreMask, changedFraction, type NormalizedRect, rgbaToLuma } from "./frameDiff";

export const SAMPLE_WIDTH = 64;
export const SAMPLE_HEIGHT = 36;

export interface SourceSampler {
	/** Grabs a frame and returns its changed fraction vs the previous one (null = no frame). */
	sampleChange(): number | null;
	setIgnoreRects(rects: readonly NormalizedRect[]): void;
	close(): void;
}

/**
 * Low-rate second capture of the recorded source, downscaled to 64×36 grayscale. It costs
 * almost nothing next to the real recording and works for screens and windows on every
 * platform (no native helper changes).
 */
export async function openSourceSampler(
	sourceId: string,
	options: { frameRate?: number; ignoreRects?: readonly NormalizedRect[]; delta?: number } = {},
): Promise<SourceSampler> {
	const stream = await navigator.mediaDevices.getUserMedia({
		audio: false,
		video: {
			mandatory: {
				chromeMediaSource: "desktop",
				chromeMediaSourceId: sourceId,
				maxWidth: 320,
				maxHeight: 180,
				maxFrameRate: options.frameRate ?? 2,
			},
		},
	} as unknown as MediaStreamConstraints);

	const video = document.createElement("video");
	video.muted = true;
	video.playsInline = true;
	video.srcObject = stream;
	await video.play().catch(() => undefined);

	const canvas = new OffscreenCanvas(SAMPLE_WIDTH, SAMPLE_HEIGHT);
	const context = canvas.getContext("2d", { willReadFrequently: true });
	let previous: Uint8Array | null = null;
	let current: Uint8Array = new Uint8Array(SAMPLE_WIDTH * SAMPLE_HEIGHT);
	let mask: Uint8Array | null = options.ignoreRects?.length
		? buildIgnoreMask(SAMPLE_WIDTH, SAMPLE_HEIGHT, options.ignoreRects)
		: null;

	return {
		sampleChange() {
			if (!context || video.readyState < 2 || video.videoWidth === 0) return null;
			context.drawImage(video, 0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT);
			const pixels = context.getImageData(0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT).data;
			current = rgbaToLuma(pixels, current);
			if (!previous) {
				previous = current.slice();
				return 0;
			}
			const fraction = changedFraction(previous, current, mask, options.delta ?? 12);
			previous.set(current);
			return fraction;
		},
		setIgnoreRects(rects) {
			mask = rects.length ? buildIgnoreMask(SAMPLE_WIDTH, SAMPLE_HEIGHT, rects) : null;
		},
		close() {
			for (const track of stream.getTracks()) track.stop();
			video.srcObject = null;
		},
	};
}
