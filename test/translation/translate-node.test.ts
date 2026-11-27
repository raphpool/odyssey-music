import { describe, expect, it } from "vitest";
import { pricingConfig, translationConfig } from "../../src/config.js";
import { nodeTranslationSchema } from "../../src/schemas.js";
import { translationSourceHash, translationSourceOf } from "../../src/translation/source.js";
import {
	createNodeTranslator,
	type GenerateJson,
	type GenerateJsonRequest,
	type GenerateJsonResult,
} from "../../src/translation/translate-node.js";
import { artistNode, edge } from "../images/helpers.js";

const SOURCE_P1 =
	"Marlow Quartet is the project of Elias Marlow, a composer born in Cornwall and raised in a small town " +
	"near the sea. His early records for Warp shaped the sound of ambient techno in the early nineties.";
const SOURCE_P2 =
	"Over the following decades he released many albums and singles, and became known as much for his " +
	"humour as for the complexity of his rhythms, which still influence many producers today.";
const FRENCH_P1 =
	"Le Marlow Quartet est le projet du compositeur Elias Marlow, né en Cornouailles et élevé dans une " +
	"petite ville près de la mer. Ses premiers disques pour le label Warp ont façonné le son de la techno " +
	"ambient dans les années quatre-vingt-dix.";
const FRENCH_P2 =
	"Au fil des décennies, il a publié de nombreux albums et singles, et il est devenu aussi célèbre pour " +
	"son humour que pour la complexité de ses rythmes, qui influencent encore de nombreux producteurs.";
const FRENCH_TEASER =
	"Un projet électronique agité de Cornouailles qui a transformé la techno ambient en terrain de jeu " +
	"pour des rythmes étranges et des mélodies chaleureuses.";

const NOW = new Date("2026-11-24T09:30:00.000Z");

const node = artistNode("marlow-quartet", "Marlow Quartet", {
	editorial_bio:
		"A restless electronic project from Cornwall that turned ambient techno into a playground of strange " +
		"rhythms and warm melodies.",
	editorial_article: `${SOURCE_P1}\n\n${SOURCE_P2}`,
	origin: "Cornwall, England",
	active_years: "1991-present",
	labels: [edge("label", "warp", "Warp")],
});
const nodeWithoutFacts = artistNode("bare", "Bare Name", {
	editorial_bio: node.editorial_bio,
	editorial_article: node.editorial_article,
});

function answer(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		teaser: FRENCH_TEASER,
		article: `${FRENCH_P1}\n\n${FRENCH_P2}`,
		facts: { origin: "Cornouailles, Angleterre", active_years: "De 1991 à aujourd'hui" },
		...overrides,
	});
}

function reply(text: string, inputTokens = 100, outputTokens = 50): GenerateJsonResult {
	return { ok: true, text, inputTokens, outputTokens };
}

/** Runs the translator against a fake provider that plays `results` in order and records every request. */
async function run(
	results: GenerateJsonResult[],
	target = node,
	now: () => Date = () => NOW,
	model?: string,
) {
	const requests: GenerateJsonRequest[] = [];
	const generate: GenerateJson = async (request) => {
		requests.push(request);
		return results[requests.length - 1] ?? { ok: false, reason: "provider_unavailable" };
	};
	return {
		outcome: await createNodeTranslator({ generate, now, ...(model === undefined ? {} : { model }) })(
			target,
			"fr",
		),
		requests,
	};
}

const rejected = reply(answer({ teaser: "" }));

describe("createNodeTranslator", () => {
	it("returns a valid translation on the first attempt, and the block passes the l10n.fr schema", async () => {
		const { outcome } = await run([reply(answer())], node, () => NOW);

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.attempts).toBe(1);
		expect(nodeTranslationSchema.safeParse(outcome.translation).success).toBe(true);
		expect(outcome.translation.source_sha256).toBe(translationSourceHash(translationSourceOf(node)));
		expect(outcome.translation.model).toBe(translationConfig.model);
		expect(outcome.translation.translated_at).toBe("2026-11-24T09:30:00.000Z");
		expect(outcome.translation.facts).toEqual({
			origin: "Cornouailles, Angleterre",
			active_years: "De 1991 à aujourd'hui",
		});
	});

	it("sends the configured model, temperature 0.2 and a schema keyed by the source facts", async () => {
		const { requests } = await run([reply(answer())]);

		expect(requests[0]?.model).toBe(translationConfig.model);
		expect(requests[0]?.temperature).toBe(0.2);
		expect(requests[0]?.responseSchema).toMatchObject({
			required: ["teaser", "article"],
			properties: {
				facts: {
					properties: { origin: { type: "STRING" }, active_years: { type: "STRING" } },
					required: ["origin", "active_years"],
				},
			},
		});
	});

	it("leaves facts out of the schema, and out of the result, for a source without facts", async () => {
		const { outcome, requests } = await run([reply(answer({ facts: undefined }))], nodeWithoutFacts);

		const schema = requests[0]?.responseSchema as { properties: Record<string, unknown> };
		expect(Object.keys(schema.properties)).toEqual(["teaser", "article"]);
		expect(outcome.ok && "facts" in outcome.translation).toBe(false);
	});

	it("puts every proper noun in the user prompt", async () => {
		const { requests } = await run([reply(answer())]);

		for (const noun of translationSourceOf(node).properNouns) expect(requests[0]?.prompt).toContain(noun);
		expect(requests[0]?.prompt).toContain("Keep verbatim");
	});

	it("retries once at temperature 0 with the refusal codes, then accepts", async () => {
		const { outcome, requests } = await run([rejected, reply(answer())]);

		expect(outcome.ok && outcome.attempts).toBe(2);
		expect(requests[1]?.temperature).toBe(0);
		expect(requests[1]?.prompt).toContain("empty (teaser)");
		expect(requests[0]?.prompt).not.toContain("rejected");
	});

	it("gives up after two refusals and reports the issues of the second", async () => {
		const { outcome } = await run([rejected, reply(answer({ article: "Trop court." }))]);

		expect(outcome).toMatchObject({ ok: false, reason: "invalid_output", attempts: 2 });
		const issues = outcome.ok ? [] : outcome.issues;
		expect(issues.map((issue) => issue.code)).toContain("too_short");
		expect(issues.map((issue) => issue.field)).not.toContain("teaser");
	});

	it.each(["not json at all", "[1, 2]", '"text"', "null"])("counts %s as a refused attempt", async (text) => {
		const { outcome, requests } = await run([reply(text), reply(answer())]);

		expect(outcome.ok && outcome.attempts).toBe(2);
		expect(requests[1]?.prompt).toContain("not a JSON object");
	});

	it("refuses a non-string field instead of throwing", async () => {
		const { outcome } = await run([reply(answer({ article: 42 })), reply(answer({ article: 42 }))]);

		expect(!outcome.ok && outcome.issues.map((issue) => issue.code)).toContain("empty");
	});

	it("hands the provider's detail to the caller on a refusal, and adds none when the provider gave none", async () => {
		const detail = { status: 404, message: "model gone" };
		const withDetail = await run([{ ok: false, reason: "provider_rejected", detail }]);
		expect(withDetail.outcome).toMatchObject({ ok: false, reason: "provider_rejected", attempts: 1, detail });
		expect(withDetail.requests).toHaveLength(1);

		const without = await run([{ ok: false, reason: "provider_unavailable" }]);
		expect(without.outcome).not.toHaveProperty("detail");
	});

	it.each(["quota_exhausted", "provider_unavailable"] as const)("stops at once on %s", async (reason) => {
		const { outcome, requests } = await run([{ ok: false, reason }]);

		expect(outcome).toMatchObject({ ok: false, reason, issues: [], attempts: 1 });
		expect(requests).toHaveLength(1);
	});

	it("keeps the tokens already spent when the provider fails on the retry", async () => {
		const { outcome } = await run([
			reply(answer({ teaser: "" }), 120, 40),
			{ ok: false, reason: "quota_exhausted" },
		]);

		expect(outcome).toMatchObject({
			ok: false,
			reason: "quota_exhausted",
			attempts: 2,
			usage: { inputTokens: 120, outputTokens: 40 },
		});
	});

	it("normalizes the accepted text: no-break spaces, real line breaks", async () => {
		const teaser = `${FRENCH_TEASER} Un disque « inclassable » !`;
		const article = `${FRENCH_P1}\\n\\n${FRENCH_P2}`; // double-escaped by the model
		const { outcome } = await run([reply(answer({ teaser, article }))]);

		expect(outcome.ok && outcome.translation.teaser).toContain("«\u00a0inclassable\u00a0»\u00a0!");
		expect(outcome.ok && outcome.translation.article).toBe(`${FRENCH_P1}\n\n${FRENCH_P2}`);
	});

	it("adds up the tokens of both attempts", async () => {
		const { outcome } = await run([reply(answer({ teaser: "" }), 1_000, 400), reply(answer(), 1_200, 500)]);

		expect(outcome.usage).toMatchObject({ inputTokens: 2_200, outputTokens: 900 });
	});

	// TRA-836 (2026-11-26): the pilot ran on gemini-3.1-flash-lite but was priced at the 2.5 tariff
	// (reported $0.0060 for a real cost of about $0.028).
	describe("cost follows the translation model", () => {
		const replies = () => [reply(answer(), 1_000_000, 1_000_000)];

		it("prices gemini-3.1-flash-lite at 0.25 / 1.50 USD per million tokens", async () => {
			const { outcome } = await run(replies(), node, () => NOW, "gemini-3.1-flash-lite");

			expect(outcome.usage.costUsd).toBeCloseTo(1.75, 10);
		});

		it("keeps gemini-2.5-flash-lite at the 2.5 tariff", async () => {
			const { outcome } = await run(replies(), node, () => NOW, "gemini-2.5-flash-lite");

			expect(outcome.usage.costUsd).toBeCloseTo(
				pricingConfig.geminiFlashLiteInputUsdPerMillion + pricingConfig.geminiFlashLiteOutputUsdPerMillion,
				10,
			);
		});

		it("marks the cost unknown for a model without a known tariff, instead of guessing", async () => {
			const { outcome } = await run(replies(), node, () => NOW, "gemini-9-unpriced");

			expect(outcome.ok).toBe(true);
			expect(outcome.usage).toEqual({ inputTokens: 1_000_000, outputTokens: 1_000_000, costUsd: null });
		});
	});
});
