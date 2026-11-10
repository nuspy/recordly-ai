import { describe, expect, it } from "vitest";
import { mapBridgeTranscriptToCues, mapBridgeWords } from "./bridgeMapping";

describe("mapBridgeWords", () => {
	it("converts seconds to ms with the segment offset and marks word breaks", () => {
		const words = mapBridgeWords(
			[
				{ start_s: 0.1, end_s: 0.4, text: " Ciao" },
				{ start_s: 0.45, end_s: 0.9, text: " mondo," },
				{ start_s: 1.0, end_s: 1.3, text: " come" },
			],
			30_000,
		);
		expect(words).toEqual([
			{ text: "Ciao", startMs: 30_100, endMs: 30_400 },
			{ text: "mondo,", startMs: 30_450, endMs: 30_900, leadingSpace: true },
			{ text: "come", startMs: 31_000, endMs: 31_300, leadingSpace: true },
		]);
	});

	it("glues sub-word pieces and bare punctuation onto the previous word", () => {
		const words = mapBridgeWords(
			[
				{ start_s: 0, end_s: 0.3, text: " Recor" },
				{ start_s: 0.3, end_s: 0.6, text: "dly" },
				{ start_s: 0.6, end_s: 0.7, text: " ." },
			],
			0,
		);
		expect(words).toEqual([{ text: "Recordly.", startMs: 0, endMs: 700 }]);
	});

	it("keeps zero-length words non-empty and drops blank or untimed ones", () => {
		const words = mapBridgeWords(
			[
				{ start_s: 1, end_s: 1, text: " Si" },
				{ start_s: 2, end_s: 2.5, text: "   " },
				{ start_s: Number.NaN, end_s: 3, text: " no" },
			],
			0,
		);
		expect(words).toEqual([{ text: "Si", startMs: 1000, endMs: 1001 }]);
	});
});

describe("mapBridgeTranscriptToCues", () => {
	it("maps segments to cues with words, text rebuilt from the words", () => {
		const cues = mapBridgeTranscriptToCues(
			{
				text: "Hello world. Bye.",
				segments: [
					{
						start_s: 0,
						end_s: 1.2,
						text: "Hello world.",
						words: [
							{ start_s: 0.1, end_s: 0.5, text: " Hello" },
							{ start_s: 0.6, end_s: 1.1, text: " world." },
						],
					},
					{ start_s: 2, end_s: 2.5, text: " Bye. " },
				],
			},
			10_000,
			40_000,
		);
		expect(cues).toEqual([
			{
				id: "caption-1",
				startMs: 10_000,
				endMs: 11_200,
				text: "Hello world.",
				words: [
					{ text: "Hello", startMs: 10_100, endMs: 10_500 },
					{ text: "world.", startMs: 10_600, endMs: 11_100, leadingSpace: true },
				],
			},
			{ id: "caption-2", startMs: 12_000, endMs: 12_500, text: "Bye." },
		]);
	});

	it("clamps a segment end to the audio segment and skips empty segments", () => {
		const cues = mapBridgeTranscriptToCues(
			{
				text: "",
				segments: [
					{ start_s: 29, end_s: 31, text: "tail" },
					{ start_s: 1, end_s: 2, text: "  " },
				],
			},
			0,
			30_000,
		);
		expect(cues).toEqual([{ id: "caption-1", startMs: 29_000, endMs: 30_000, text: "tail" }]);
	});
});
