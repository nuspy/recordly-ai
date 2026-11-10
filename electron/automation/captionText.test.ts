import { describe, expect, it } from "vitest";
import {
	distributeNarrationCues,
	estimateSpeechDurationMs,
	groupWordsIntoCues,
	splitNarrationText,
} from "./captionText";

describe("narration caption helpers", () => {
	it("splits on sentence punctuation and long phrases", () => {
		expect(splitNarrationText("Apriamo l'app. Ora clicchiamo su Genera!")).toEqual([
			"Apriamo l'app.",
			"Ora clicchiamo su Genera!",
		]);
		const long = `${"parola ".repeat(30)}fine.`;
		const parts = splitNarrationText(long);
		expect(parts.length).toBeGreaterThan(1);
		expect(parts.every((part) => part.length <= 84)).toBe(true);
	});

	it("distributes cues proportionally over the audio duration without gaps", () => {
		const cues = distributeNarrationCues("Uno due tre. Quattro.", 1000, 3000, "n1", "narr-1");
		expect(cues).toHaveLength(2);
		expect(cues[0].startMs).toBe(1000);
		expect(cues[0].endMs).toBe(cues[1].startMs);
		expect(cues[1].endMs).toBe(4000);
		expect(cues[1].narrationId).toBe("narr-1");
	});

	it("estimates a bounded speaking duration", () => {
		expect(estimateSpeechDurationMs("ciao")).toBe(1200);
		expect(estimateSpeechDurationMs("x".repeat(1000))).toBe(12_000);
	});

	it("groups timed words into cues with offsets", () => {
		const cues = groupWordsIntoCues(
			[
				{ text: " Ciao", startMs: 0, endMs: 300 },
				{ text: " mondo.", startMs: 320, endMs: 700 },
				{ text: " Seconda", startMs: 900, endMs: 1300 },
			],
			5000,
			"w",
		);
		expect(cues.map((cue) => cue.text)).toEqual(["Ciao mondo.", "Seconda"]);
		expect(cues[0].startMs).toBe(5000);
		expect(cues[0].words?.[1]).toMatchObject({
			text: "mondo.",
			startMs: 5320,
			leadingSpace: true,
		});
	});
});
