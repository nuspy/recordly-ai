export interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/**
 * Converts a rectangle in screen pixels (e.g. a UIA BoundingRectangle) into the normalized
 * 0..1 space of the recorded source. Both rectangles must use the same coordinate space.
 * Returns null when the rectangle lies completely outside the source.
 */
export function normalizeRectToSource(rect: Rect, sourceBounds: Rect): Rect | null {
	if (!(sourceBounds.width > 0 && sourceBounds.height > 0)) return null;
	const x0 = clamp01((rect.x - sourceBounds.x) / sourceBounds.width);
	const y0 = clamp01((rect.y - sourceBounds.y) / sourceBounds.height);
	const x1 = clamp01((rect.x + rect.width - sourceBounds.x) / sourceBounds.width);
	const y1 = clamp01((rect.y + rect.height - sourceBounds.y) / sourceBounds.height);
	if (x1 <= x0 || y1 <= y0) return null;
	return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** Adds breathing room around a zoom target so the element is not glued to the frame edge. */
export function padNormalizedRect(rect: Rect, padding = 0.04): Rect {
	const x = clamp01(rect.x - padding);
	const y = clamp01(rect.y - padding);
	return {
		x,
		y,
		width: Math.min(1 - x, rect.width + padding * 2),
		height: Math.min(1 - y, rect.height + padding * 2),
	};
}

export function isNormalizedRect(value: unknown): value is Rect {
	if (!value || typeof value !== "object") return false;
	const rect = value as Record<string, unknown>;
	return ["x", "y", "width", "height"].every(
		(key) => typeof rect[key] === "number" && Number.isFinite(rect[key] as number),
	);
}
