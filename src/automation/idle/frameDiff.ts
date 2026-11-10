export interface NormalizedRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** Luma of an RGBA buffer into a reused grayscale buffer (Rec. 601 weights). */
export function rgbaToLuma(rgba: Uint8ClampedArray, target?: Uint8Array): Uint8Array {
	const pixels = rgba.length / 4;
	const luma = target && target.length === pixels ? target : new Uint8Array(pixels);
	for (let index = 0, offset = 0; index < pixels; index++, offset += 4) {
		luma[index] = (rgba[offset] * 77 + rgba[offset + 1] * 150 + rgba[offset + 2] * 29) >> 8;
	}
	return luma;
}

/** 1 = pixel counts, 0 = ignored (spinners, clocks, progress text the agent masked out). */
export function buildIgnoreMask(
	width: number,
	height: number,
	ignoreRects: readonly NormalizedRect[],
): Uint8Array {
	const mask = new Uint8Array(width * height).fill(1);
	for (const rect of ignoreRects) {
		const x0 = Math.max(0, Math.floor(rect.x * width));
		const y0 = Math.max(0, Math.floor(rect.y * height));
		const x1 = Math.min(width, Math.ceil((rect.x + rect.width) * width));
		const y1 = Math.min(height, Math.ceil((rect.y + rect.height) * height));
		for (let y = y0; y < y1; y++) {
			mask.fill(0, y * width + x0, y * width + x1);
		}
	}
	return mask;
}

/**
 * Share of considered pixels whose luma moved by more than `delta`. Compression noise and
 * cursor-free captures keep this near 0 for a static window; a real UI update moves it up.
 */
export function changedFraction(
	previous: Uint8Array,
	next: Uint8Array,
	mask: Uint8Array | null,
	delta = 12,
): number {
	let considered = 0;
	let changed = 0;
	for (let index = 0; index < next.length; index++) {
		if (mask && mask[index] === 0) continue;
		considered++;
		if (Math.abs(next[index] - previous[index]) > delta) changed++;
	}
	return considered === 0 ? 0 : changed / considered;
}
