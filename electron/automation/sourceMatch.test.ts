import { describe, expect, it } from "vitest";
import { normalizeRectToSource, padNormalizedRect } from "./geometry";
import { matchSource } from "./sourceMatch";

const SOURCES = [
	{ id: "screen:0:0", name: "Screen 1", sourceType: "screen" as const },
	{ id: "screen:1:0", name: "Screen 2", sourceType: "screen" as const },
	{
		id: "window:10:0",
		name: "LTX Studio — Generate",
		windowTitle: "LTX Studio — Generate",
		appName: "chrome",
		sourceType: "window" as const,
	},
	{
		id: "window:11:0",
		name: "Notepad",
		windowTitle: "Notepad",
		appName: "notepad",
		sourceType: "window" as const,
	},
];

describe("matchSource", () => {
	it("matches by id, display index, app and title regex", () => {
		expect(matchSource(SOURCES, { id: "window:11:0" }).source?.name).toBe("Notepad");
		expect(matchSource(SOURCES, { displayIndex: 1 }).source?.id).toBe("screen:1:0");
		expect(matchSource(SOURCES, { appName: "chrome" }).source?.id).toBe("window:10:0");
		expect(matchSource(SOURCES, { title: "ltx.*generate" }).source?.id).toBe("window:10:0");
	});

	it("prefers exact titles and falls back to substring for invalid regexes", () => {
		const sources = [
			...SOURCES,
			{
				id: "window:12:0",
				name: "Notepad++",
				windowTitle: "Notepad++",
				sourceType: "window" as const,
			},
		];
		expect(matchSource(sources, { title: "notepad" }).source?.id).toBe("window:11:0");
		expect(matchSource(sources, { title: "Notepad++" }).source?.id).toBe("window:12:0");
	});

	it("returns nothing for an empty selector", () => {
		expect(matchSource(SOURCES, {}).source).toBeNull();
	});
});

describe("geometry", () => {
	it("normalizes screen-pixel rectangles to the recorded source", () => {
		expect(
			normalizeRectToSource(
				{ x: 300, y: 200, width: 200, height: 100 },
				{ x: 100, y: 100, width: 1000, height: 500 },
			),
		).toEqual({ x: 0.2, y: 0.2, width: 0.2, height: 0.2 });
		expect(
			normalizeRectToSource(
				{ x: 0, y: 0, width: 10, height: 10 },
				{ x: 100, y: 100, width: 50, height: 50 },
			),
		).toBeNull();
	});

	it("pads without leaving the frame", () => {
		const padded = padNormalizedRect({ x: 0.98, y: 0, width: 0.02, height: 0.1 }, 0.04);
		expect(padded.x).toBeCloseTo(0.94);
		expect(padded.y).toBe(0);
		expect(padded.width).toBeCloseTo(0.06);
		expect(padded.height).toBeCloseTo(0.18);
	});
});
