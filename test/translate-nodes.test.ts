import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatSummary, parseCliArgs, runCli, runTranslation } from "../scripts/translate-nodes.js";
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

// TRA-811: throughput, quota stop and sample. No real timer: the clock and the wait are injected, and a
// "slow" translator only yields to the event loop.

/** `n` untranslated artists `artist:n00`, `artist:n01`... (slug order is creation order). */
function manyNodes(n: number): string[] {
	const nodes = Array.from({ length: n }, (_, i) =>
		artistNode(`n${String(i).padStart(2, "0")}`, `Node ${i}`),
	);
	for (const node of nodes) put(node);
	return nodes.map((node) => node.slug);
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const USAGE = { inputTokens: 10, outputTokens: 5, costUsd: 0.001 };

type Step = "ok" | TranslationFailure;
/** A translator that gives `steps[i]` to its i-th call (then "ok"); calls start in slug order. */
function scripted(steps: readonly Step[]) {
	const calls: string[] = [];
	const translate: NodeTranslator = async (node) => {
		const step = steps[calls.length] ?? "ok";
		calls.push(node.slug);
		return step === "ok"
			? { ok: true, translation: translationOf(node), attempts: 1, usage: USAGE }
			: { ok: false, reason: step, issues: [], attempts: 2, usage: USAGE };
	};
	return { calls, translate };
}

/** A clock that only moves when the tool waits. */
function fakeClock() {
	let t = 1_000;
	const sleeps: number[] = [];
	return {
		sleeps,
		now: () => t,
		sleep: async (ms: number) => {
			sleeps.push(ms);
			t += ms;
		},
	};
}

describe("throughput", () => {
	it("never has more than --concurrency calls in flight, and lists translated and failed in slug order", async () => {
		const slugs = manyNodes(6);
		const inner = fake().translate;
		let inFlight = 0;
		let peak = 0;
		let started = 0;
		const translate: NodeTranslator = async (node, locale) => {
			const mine = started++;
			inFlight++;
			peak = Math.max(peak, inFlight);
			// The first call is the slowest, so results arrive out of slug order. The first two are refused.
			for (let i = 0; i < (mine === 0 ? 6 : 1); i++) await tick();
			inFlight--;
			if (mine < 2) return { ok: false, reason: "invalid_output", issues: [], attempts: 2, usage: USAGE };
			return inner(node, locale);
		};
		const manifest = await run(translate, { concurrency: 2 });
		expect(peak).toBe(2);
		expect(manifest.translated).toEqual(slugs.slice(2));
		expect(manifest.failed.map((f) => f.slug)).toEqual(slugs.slice(0, 2));
	});

	it.each([
		["the 4th call only after 60 simulated seconds", 4, 4, [1_000, 1_000, 1_000, 61_000]],
		[
			"never more than 3 in any minute, the window sliding",
			7,
			1,
			[1_000, 1_000, 1_000, 61_000, 61_000, 61_000, 121_000],
		],
	])("with --rpm 3 starts %s", async (_name, count, concurrency, expected) => {
		manyNodes(count);
		const clock = fakeClock();
		const inner = fake().translate;
		const starts: number[] = [];
		const translate: NodeTranslator = (node, locale) => {
			starts.push(clock.now());
			return inner(node, locale);
		};
		await run(translate, { rpm: 3, concurrency, now: clock.now, sleep: clock.sleep });
		expect(starts).toEqual(expected);
	});

	it("refuses bounds the CLI would refuse", async () => {
		await expect(run(fake().translate, { concurrency: 0 })).rejects.toThrow(/concurrency/);
		await expect(run(fake().translate, { rpm: 0 })).rejects.toThrow(/rpm/);
	});
});

describe("quota stop", () => {
	it("stops after three quota_exhausted in a row: exit 3, manifest written, nothing started after, earlier nodes kept", async () => {
		const slugs = manyNodes(6);
		const { calls, translate } = scripted([
			"ok",
			"ok",
			"quota_exhausted",
			"quota_exhausted",
			"quota_exhausted",
		]);
		const manifestPath = join(dir, "out", "m.json");
		const code = await runCli(
			[dir, "--apply", "--concurrency", "1", "--manifest", manifestPath],
			"key",
			translate,
		);
		expect(code).toBe(3);
		expect(calls).toEqual(slugs.slice(0, 5));
		// The three nodes that raised the stop are not failures: they are simply left for the next run.
		expect(JSON.parse(readFileSync(manifestPath, "utf8"))).toMatchObject({
			stopped: "quota_exhausted",
			translated: slugs.slice(0, 2),
			failed: [],
		});
		for (const slug of slugs.slice(0, 2)) expect(JSON.parse(bytes(slug)).l10n.fr.model).toBe("fake-model");
		for (const slug of slugs.slice(2)) expect(JSON.parse(bytes(slug)).l10n).toBeUndefined();
	});

	const [Q, U, I]: Step[] = ["quota_exhausted", "provider_unavailable", "invalid_output"];
	it.each([
		["two provider_unavailable, a success, two more do not stop", [U, U, "ok", U, U], undefined],
		["an invalid_output resets the series", [Q, Q, I, Q, Q], undefined],
		["quota, quota, unavailable stop on the last reason: unavailable", [Q, Q, U], U],
		["quota, unavailable, quota stop on the last reason: quota", [Q, U, Q], Q],
	] as [string, Step[], Step | undefined][])("%s", async (_name, steps, stopped) => {
		manyNodes(6);
		const { calls, translate } = scripted(steps);
		const manifest = await run(translate, { concurrency: 1 });
		expect(manifest.stopped).toBe(stopped);
		expect(calls).toHaveLength(stopped ? 3 : 6);
		expect(manifest.failed).toHaveLength(stopped ? 0 : steps.filter((s) => s !== "ok").length);
	});

	it("lets the calls in flight finish and writes their valid results, but starts nothing new", async () => {
		const slugs = manyNodes(6);
		const inner = fake().translate;
		const calls: string[] = [];
		const translate: NodeTranslator = async (node, locale) => {
			calls.push(node.slug);
			if (node.slug !== slugs[1]) {
				return { ok: false, reason: "quota_exhausted", issues: [], attempts: 2, usage: USAGE };
			}
			// Still running when the third quota answer stops the batch.
			while (calls.length < 4) await tick();
			for (let i = 0; i < 5; i++) await tick();
			return inner(node, locale);
		};
		const manifest = await run(translate, { concurrency: 2 });
		expect(calls).toEqual(slugs.slice(0, 4));
		expect(manifest).toMatchObject({ stopped: "quota_exhausted", translated: [slugs[1]], failed: [] });
		expect(JSON.parse(bytes(slugs[1] as string)).l10n.fr.model).toBe("fake-model");
	});

	it("a second run with a translator that answers finishes the batch without translating again", async () => {
		const slugs = manyNodes(6);
		const first = await run(
			scripted(["ok", "ok", "provider_unavailable", "provider_unavailable", "provider_unavailable"])
				.translate,
			{ concurrency: 1 },
		);
		expect(first.stopped).toBe("provider_unavailable");
		const written = slugs.slice(0, 2).map(bytes);
		const { calls, translate } = fake();
		const second = await run(translate, { concurrency: 1 });
		expect(second).not.toHaveProperty("stopped");
		expect(calls).toEqual(slugs.slice(2));
		expect(second.translated).toEqual(slugs.slice(2));
		expect(slugs.slice(0, 2).map(bytes)).toEqual(written);
	});
});

describe("--sample", () => {
	const english = translationSourceOf(artistNode("x", "X"));
	const sections = (text: string) => text.split(/^## /m).slice(1);
	const slugOf = (section: string) => section.split("\n")[0];

	it("holds both versions of a regular draw of the nodes translated in the pass; the same nodes draw the same", async () => {
		const slugs = manyNodes(10);
		const inner = fake().translate;
		const translate: NodeTranslator = async (node, locale) => {
			const outcome = await inner(node, locale);
			return outcome.ok
				? { ...outcome, translation: { ...outcome.translation, facts: { origin: "Né à Lyon." } } }
				: outcome;
		};
		const first = join(dir, "out", "first.md");
		await run(translate, { samplePath: first, sampleSize: 4 });
		const text = readFileSync(first, "utf8");
		expect(sections(text).map(slugOf)).toEqual([0, 2, 5, 7].map((i) => slugs[i]));
		for (const section of sections(text)) {
			const order = [
				english.teaser,
				english.article,
				"Un teaser français.",
				"Un article français",
				"Né à Lyon.",
			];
			const positions = order.map((part) => section.indexOf(part));
			expect(positions.every((p) => p >= 0)).toBe(true);
			expect(positions).toEqual([...positions].sort((a, b) => a - b));
		}
		const second = join(dir, "out", "second.md");
		await run(translate, { samplePath: second, sampleSize: 4, force: true });
		expect(readFileSync(second, "utf8")).toBe(text);
	});

	it("takes only the nodes translated in this pass, and all of them when there are fewer than the size", async () => {
		fourNodes();
		const path = join(dir, "out", "sample.md");
		await run(fake().translate, { samplePath: path });
		expect(sections(readFileSync(path, "utf8")).map(slugOf)).toEqual([
			"artist:two",
			"project:one",
			"track:one",
		]);
	});

	it("is written after a quota stop, and not by a preview", async () => {
		const slugs = manyNodes(5);
		const path = join(dir, "out", "sample.md");
		await run(fake().translate, { apply: false, samplePath: path });
		expect(existsSync(path)).toBe(false);
		const stopped = scripted(["ok", "quota_exhausted", "quota_exhausted", "quota_exhausted"]);
		await run(stopped.translate, { concurrency: 1, samplePath: path });
		expect(sections(readFileSync(path, "utf8")).map(slugOf)).toEqual([slugs[0]]);
	});
});

describe("a sample that cannot be written", () => {
	it("warns and keeps the manifest, quota stop included", async () => {
		manyNodes(4);
		const manifestPath = join(dir, "m.json");
		const { translate } = scripted(["ok", "quota_exhausted", "quota_exhausted", "quota_exhausted"]);
		// The sample path is a directory: writeFile fails after every node is paid for and written.
		const argv = [dir, "--apply", "--concurrency", "1", "--sample", dir, "--manifest", manifestPath];
		expect(await runCli(argv, "key", translate)).toBe(3);
		expect(JSON.parse(readFileSync(manifestPath, "utf8"))).toMatchObject({ stopped: "quota_exhausted" });
		expect(
			vi
				.mocked(process.stderr.write)
				.mock.calls.map(([text]) => String(text))
				.join(""),
		).toContain("sample not written");
	});
});

describe("CLI flags of TRA-811", () => {
	it("parses the defaults and the bounds that are allowed", () => {
		expect(parseCliArgs(["c"])).toMatchObject({ concurrency: 4, rpm: 120, sampleSize: 30 });
		expect(parseCliArgs(["c"])).not.toHaveProperty("samplePath");
		expect(
			parseCliArgs([
				"c",
				"--concurrency",
				"16",
				"--rpm",
				"2000",
				"--sample",
				"out/s.md",
				"--sample-size",
				"5",
			]),
		).toMatchObject({ concurrency: 16, rpm: 2000, samplePath: "out/s.md", sampleSize: 5 });
		expect(parseCliArgs(["c", "--concurrency", "1", "--rpm", "1"])).toMatchObject({ concurrency: 1, rpm: 1 });
	});

	it.each([
		[["c", "--concurrency", "0"]],
		[["c", "--concurrency", "17"]],
		[["c", "--rpm", "2001"]],
		[["c", "--sample-size", "0"]],
		[["c", "--sample"]],
	])("rejects %j", (argv) => expect(parseCliArgs(argv)).toBeNull());

	it.each([
		["--concurrency", "0"],
		["--rpm", "5000"],
	])("%s %s exits 2", async (flag, value) => {
		expect(await runCli([dir, flag, value], "key")).toBe(2);
	});
});

// TRA-836 (2026-11-26): a model without a known tariff must not produce a cost that looks real.
describe("run cost", () => {
	const priced =
		(costUsd: number | null): NodeTranslator =>
		async (node) => ({
			ok: true,
			translation: translationOf(node),
			attempts: 1,
			usage: { inputTokens: 10, outputTokens: 5, costUsd },
		});

	it("sums the cost of the translations", async () => {
		fourNodes();
		const manifest = await run(priced(0.25));

		expect(manifest.usage.costUsd).toBeCloseTo(0.75, 10);
		expect(formatSummary(manifest, "m.json")).toContain("cost $0.7500");
	});

	it("turns unknown as soon as one translation has no known cost, and says so in the summary", async () => {
		fourNodes();
		const manifest = await run(priced(null));

		expect(manifest.usage.costUsd).toBeNull();
		expect(formatSummary(manifest, "m.json")).toContain("cost unknown (no tariff for the model)");
		expect(formatSummary(manifest, "m.json")).not.toContain("cost $");
	});
});
