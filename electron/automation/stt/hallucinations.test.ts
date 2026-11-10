import { describe, expect, it } from "vitest";
import { filterHallucinatedCues, isHallucinatedCaptionText } from "./hallucinations";

describe("hallucination filter", () => {
	it("recognizes subtitle credits produced from silence", () => {
		expect(isHallucinatedCaptionText("Sottotitoli e revisione a cura di QTSS")).toBe(true);
		expect(isHallucinatedCaptionText("Sottotitoli creati dalla comunità Amara.org")).toBe(true);
		expect(isHallucinatedCaptionText("Thanks for watching!")).toBe(true);
		expect(isHallucinatedCaptionText("ご視聴ありがとうございました")).toBe(true);
	});

	it("keeps real speech, including long cues that merely contain a marker", () => {
		expect(isHallucinatedCaptionText("Grazie a tutti per essere qui")).toBe(false);
		expect(
			isHallucinatedCaptionText(
				"In this tutorial we configure the recorder and export the video, thanks for watching",
			),
		).toBe(false);
		expect(isHallucinatedCaptionText("")).toBe(false);
	});

	it("drops only hallucinated cues", () => {
		const cues = [
			{ id: "a", startMs: 0, endMs: 1000, text: "Ciao a tutti." },
			{ id: "b", startMs: 5000, endMs: 6000, text: "Sottotitoli a cura di QTSS" },
		];
		expect(filterHallucinatedCues(cues).map((cue) => cue.id)).toEqual(["a"]);
	});
});
