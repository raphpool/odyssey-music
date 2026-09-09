import { describe, expect, it } from "vitest";
import { normalizeEdge } from "../src/pipeline.js";

// TRA-18 will extend this file with MusicBrainz-producer coverage. For TRA-17, normalizeEdge
// is the only qid-aware code path exercised here — no MusicBrainz mock needed.
describe("normalizeEdge — qid propagation (TRA-17)", () => {
	it("keeps a valid qid", () => {
		const out = normalizeEdge({ type: "genre", name: "Techno", qid: "Q170611" });
		expect(out).not.toBeNull();
		expect(out?.qid).toBe("Q170611");
	});

	it("discards a malformed qid without dropping the edge", () => {
		const out = normalizeEdge({ type: "genre", name: "Techno", qid: "170611" });
		expect(out).not.toBeNull();
		expect(out?.name).toBe("Techno");
		expect(out?.qid).toBeUndefined();
	});
});
