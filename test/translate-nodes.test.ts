import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseCliArgs, runCli, runTranslation } from "../scripts/translate-nodes.js";
import { translationSourceHash, translationSourceOf } from "../src/translation/source.js";
import type { NodeTranslator, TranslationFailure } from "../src/translation/translate-node.js";
import type { NodePayload } from "../src/types.js";
import { writeNode } from "./helpers/migration-channel.js";
import { artistNode, edge, projectNode, trackNode } from "./images/helpers.js";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "translate-nodes-"));
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => {
	vi.restoreAllMocks();
	rmSync(dir, { recursive: true, force: true });
});

const bytes = (slug: string) => readFileSync(join(dir, "nodes", `${slug.replace(":", "/")}.json`), "utf8");
const put = (node: object) => writeNode(dir, node as Record<string, unknown>);
const translationOf = (node: NodePayload) => ({
	teaser: "Un teaser français.",
	article: "Un article français assez long pour passer le plancher du schéma. ".repeat(2),
	source_sha256: translationSourceHash(translationSourceOf(node)),
	model: "fake-model",
	translated_at: "2026-11-24T10:00:00.000Z",
});
const translated = (node: NodePayload) => ({ ...node, l10n: { fr: translationOf(node) } });

/** A translator double: records the slugs it is asked for; answers with a valid translation or `fail`. */
function fake(fail?: TranslationFailure) {
	const calls: string[] = [];
	const usage = { inputTokens: 10, outputTokens: 5, costUsd: 0.001 };
	const translate: NodeTranslator = async (node) => {
		calls.push(node.slug);
		return fail
			? { ok: false, reason: fail, issues: [], attempts: 2, usage }
			: { ok: true, translation: translationOf(node), attempts: 1, usage };
	};
	return { calls, translate };
}
const run = (translate: NodeTranslator, options: Record<string, unknown> = {}) =>
	runTranslation({ cacheDir: dir, locale: "fr", force: false, apply: true, ...options }, translate);

const SLUGS = ["artist:done", "artist:two", "project:one", "track:one"];
/** 4 nodes, the first one already translated. */
function fourNodes() {
	const nodes = [
		translated(artistNode("done", "Done")),
		artistNode("two", "Two", { labels: [edge("label", "warp", "Warp")] }),
		projectNode("one", "One"),
		trackNode("one", "One"),
	];
	for (const n of nodes) put(n);
	return nodes;
}

describe("preview and apply", () => {
	it("a preview announces 3 missing, calls no translator and writes no node", async () => {
		fourNodes();
		const before = SLUGS.map(bytes);
		const { calls, translate } = fake();
		const manifest = await run(translate, { apply: false });
		expect(calls).toEqual([]);
		expect(SLUGS.map(bytes)).toEqual(before);
		expect(manifest).toMatchObject({ applied: false, translated: [], failed: [] });
		expect(manifest.counts.artist).toMatchObject({ total: 2, current: 1, missing: 1 });
		expect(manifest.counts.project).toMatchObject({ total: 1, missing: 1 });
		expect(manifest.counts.track).toMatchObject({ total: 1, missing: 1 });
	});

	it("adds l10n.fr to the 3 missing nodes and nothing else; a second pass does nothing", async () => {
		const nodes = fourNodes();
		const before = SLUGS.map(bytes);
		const { calls, translate } = fake();
		expect((await run(translate)).translated).toEqual(["artist:two", "project:one", "track:one"]);
		expect(bytes(SLUGS[0] as string)).toBe(before[0]);
		for (const i of [1, 2, 3]) {
			const { l10n, ...rest } = JSON.parse(bytes(SLUGS[i] as string));
			const original = JSON.parse(before[i] as string);
			expect(l10n.fr.model).toBe("fake-model");
			expect(rest).toEqual(original);
			expect(Object.keys(JSON.parse(bytes(SLUGS[i] as string)))).toEqual([...Object.keys(original), "l10n"]);
			expect(rest.materialized_at).toBe((nodes[i] as NodePayload).materialized_at);
		}
		const after = SLUGS.map(bytes);
		calls.length = 0;
		expect((await run(translate)).translated).toEqual([]);
		expect(calls).toEqual([]);
		expect(SLUGS.map(bytes)).toEqual(after);
	});

	it("counts a node whose article changed since its translation as stale and translates it again", async () => {
		const node = artistNode("moved", "Moved");
		const edited = { ...node, editorial_article: `${node.editorial_article} Edited.` };
		put({ ...translated(node), editorial_article: edited.editorial_article });
		const { calls, translate } = fake();
		expect((await run(translate, { apply: false })).counts.artist).toMatchObject({
			stale: 1,
			missing: 0,
			current: 0,
		});
		expect((await run(translate)).translated).toEqual(["artist:moved"]);
		expect(JSON.parse(bytes("artist:moved")).l10n.fr.source_sha256).toBe(
			translationSourceHash(translationSourceOf(edited)),
		);
		expect(calls).toEqual(["artist:moved"]);
	});
});

describe("selection", () => {
	it.each([
		["--types project,track", { types: ["project", "track"] }, ["project:one", "track:one"], 2],
		["--slugs", { slugs: ["artist:two"] }, ["artist:two"], 1],
		["--limit 2", { limit: 2 }, ["artist:two", "project:one"], 4],
		["--force --slugs on a current node", { force: true, slugs: ["artist:done"] }, ["artist:done"], 1],
	])("%s", async (_name, options, expected, total) => {
		fourNodes();
		const { calls, translate } = fake();
		const manifest = await run(translate, options);
		expect(manifest.translated).toEqual(expected);
		expect(calls).toEqual(expected);
		expect(Object.values(manifest.counts).reduce((sum, c) => sum + c.total, 0)).toBe(total);
	});
});

describe("refusals", () => {
	it.each([
		["an article of 40 characters", { editorial_article: "x".repeat(40) }],
		["an empty teaser", { editorial_bio: "  " }],
	])("%s is counted ineligible and never sent to the translator", async (_name, overrides) => {
		put(artistNode("short", "Short", overrides));
		const before = bytes("artist:short");
		const { calls, translate } = fake();
		for (const force of [false, true]) {
			const manifest = await run(translate, { force });
			expect(manifest.counts.artist).toMatchObject({ total: 1, ineligible: 1, missing: 0 });
			expect(manifest.translated).toEqual([]);
		}
		expect(calls).toEqual([]);
		expect(bytes("artist:short")).toBe(before);
	});

	it("an invalid_output leaves the file byte for byte, is listed in failed and exits 1", async () => {
		put(artistNode("one", "One"));
		const before = bytes("artist:one");
		const manifest = await run(fake("invalid_output").translate);
		expect(manifest.failed).toEqual([{ slug: "artist:one", reason: "invalid_output", issues: [] }]);
		expect(bytes("artist:one")).toBe(before);
		expect(
			await runCli(
				[dir, "--apply", "--manifest", join(dir, "m.json")],
				"key",
				fake("invalid_output").translate,
			),
		).toBe(1);
	});

	it("refuses, before any translator call, a node the schema would make lose a field", async () => {
		put({ ...artistNode("odd", "Odd"), undeclared_field: "the schema strips this" });
		const before = bytes("artist:odd");
		const { calls, translate } = fake();
		const manifest = await run(translate);
		expect(calls).toEqual([]);
		expect(manifest.translated).toEqual([]);
		expect(manifest.failed.map((f) => f.slug)).toEqual(["artist:odd"]);
		expect(bytes("artist:odd")).toBe(before);
	});

	it("counts an unusable l10n.fr as stale and replaces it", async () => {
		put({ ...artistNode("bad", "Bad"), l10n: { fr: null } });
		expect((await run(fake().translate, { apply: false })).counts.artist.stale).toBe(1);
		expect((await run(fake().translate)).translated).toEqual(["artist:bad"]);
		expect(JSON.parse(bytes("artist:bad")).l10n.fr.model).toBe("fake-model");
	});

	it("stops without overwriting a node that changed on disk during the run", async () => {
		put(artistNode("moving", "Moving"));
		const changed = `${JSON.stringify({ ...artistNode("moving", "Moving"), name: "Renamed" })}\n`;
		const inner = fake().translate;
		const translate: NodeTranslator = async (node, locale) => {
			writeFileSync(join(dir, "nodes", "artist", "moving.json"), changed);
			return inner(node, locale);
		};
		await expect(run(translate)).rejects.toThrow(/changed on disk/);
		expect(bytes("artist:moving")).toBe(changed);
	});
});

describe("CLI", () => {
	it("--apply without a key exits 2 without reading the cache; a preview needs no key", async () => {
		fourNodes();
		const manifestPath = join(dir, "out", "m.json");
		expect(await runCli([dir, "--apply", "--manifest", manifestPath], "")).toBe(2);
		expect(existsSync(manifestPath)).toBe(false);
		expect(String(vi.mocked(process.stderr.write).mock.calls[0]?.[0])).toContain("GEMINI_API_KEY");
		expect(await runCli([dir, "--manifest", manifestPath], "")).toBe(0);
		expect(JSON.parse(readFileSync(manifestPath, "utf8")).counts.artist).toMatchObject({ missing: 1 });
	});

	it.each([
		[[]],
		[["--apply"]],
		[["c", "--types", "album"]],
		[["c", "--limit", "0"]],
		[["c", "--slugs", "nope"]],
		[["c", "--bogus"]],
	])("rejects %j", (argv) => expect(parseCliArgs(argv)).toBeNull());
});
