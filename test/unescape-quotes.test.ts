import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	DEFAULT_MANIFEST_PATH,
	formatSummary,
	type Manifest,
	MIGRATION_NAME,
	parseCliArgs,
	runMigration,
} from "../scripts/migrations/2026-10-24-unescape-quotes.js";
import { parseSlug } from "../src/slug.js";
import type { Slug } from "../src/types.js";

// TRA-577: 19 articles of the cache print `\"Seaqz\"` (Gemini double-escaped the quotation marks as it did the
// newlines). This migration removes that backslash, and only that, from the generated text fields.
const PARAGRAPH = "A real paragraph about the node, long enough for the cache invariants to hold, by far.";
const ESCAPED = `${PARAGRAPH} Its \\"frenetic romp\\" is loud.`;
const FIXED = `${PARAGRAPH} Its "frenetic romp" is loud.`;
const CITATIONS = [{ url: "https://example.com/source", title: "Source" }];

type Obj = Record<string, unknown>;

function artist(slug: Slug, o: Obj = {}): Obj {
	return {
		type: "artist",
		slug,
		name: slug,
		editorial_article: PARAGRAPH,
		editorial_bio: "A short bio.",
		citations: CITATIONS,
		materialized_at: "2026-10-16T00:00:00.000Z",
		genres: [],
		labels: [],
		discography: [],
		notable_tracks: [],
		influences: [],
		influenced: [],
		collaborators: [],
		aliases: [],
		members: [],
		similar_artists: [],
		...o,
	};
}

function track(slug: Slug, o: Obj = {}): Obj {
	return {
		type: "track",
		slug,
		name: slug,
		editorial_article: PARAGRAPH,
		editorial_teaser: "A teaser.",
		citations: CITATIONS,
		materialized_at: "2026-10-16T00:00:00.000Z",
		artists: [],
		genres: [],
		producers: [],
		personnel: [],
		samples: [],
		sampled_by: [],
		remixed_by: [],
		...o,
	};
}

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "unescape-quotes-"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

async function writeCache(nodes: readonly Obj[]): Promise<void> {
	for (const node of nodes) {
		const { type, body } = parseSlug(node.slug as Slug);
		const file = join(dir, "nodes", type, `${body}.json`);
		await mkdir(dirname(file), { recursive: true });
		await writeFile(file, `${JSON.stringify(node, null, 2)}\n`, "utf8");
	}
}

async function readNode(slug: Slug): Promise<Obj> {
	const { type, body } = parseSlug(slug);
	return JSON.parse(await readFile(join(dir, "nodes", type, `${body}.json`), "utf8")) as Obj;
}

async function snapshot(): Promise<Record<string, string>> {
	const out: Record<string, string> = {};
	for (const type of await readdir(join(dir, "nodes"))) {
		for (const f of await readdir(join(dir, "nodes", type))) {
			out[`${type}/${f}`] = await readFile(join(dir, "nodes", type, f), "utf8");
		}
	}
	return out;
}

async function run(apply: boolean): Promise<Manifest> {
	const result = await runMigration({ cacheDir: dir, apply });
	expect(result.manifest.errors).toEqual([]);
	expect(result.exitCode).toBe(0);
	return result.manifest;
}

describe("unescape-quotes: the cases of the ticket", () => {
	it("rewrites an article holding a literal backslash-quote with a plain quote", async () => {
		await writeCache([track("track:escaped", { editorial_article: ESCAPED })]);
		const manifest = await run(true);
		expect(manifest.written).toBe(1);
		expect(manifest.byField).toEqual({ editorial_article: 1 });
		expect((await readNode("track:escaped")).editorial_article).toBe(FIXED);
	});

	it("does not rewrite a node whose quotes are already plain", async () => {
		await writeCache([
			track("track:clean", { editorial_article: FIXED }),
			track("track:escaped", { editorial_article: ESCAPED }),
		]);
		const before = (await snapshot())["track/clean.json"];
		const manifest = await run(true);
		expect(manifest.changed.map((c) => c.slug)).toEqual(["track:escaped"]);
		expect((await snapshot())["track/clean.json"]).toBe(before);
	});

	it("is idempotent: a second run writes nothing", async () => {
		await writeCache([track("track:escaped", { editorial_article: ESCAPED })]);
		await run(true);
		const after = await snapshot();
		const second = await run(true);
		expect(second.written).toBe(0);
		expect(second.changed).toEqual([]);
		expect(await snapshot()).toEqual(after);
	});
});

describe("unescape-quotes: only the backslash goes", () => {
	it("leaves the other escapes, the spacing and the line breaks of the field as they are", async () => {
		// Not this migration's job: the `\n` have their own (TRA-492), and trimming is another normalization.
		const text = `${PARAGRAPH} \\"A\\"\\n\\n\\n\\n  and C:\\\\new   \n\n\n`;
		await writeCache([track("track:mixed", { editorial_article: text })]);
		await run(true);
		expect((await readNode("track:mixed")).editorial_article).toBe(
			`${PARAGRAPH} "A"\\n\\n\\n\\n  and C:\\\\new   \n\n\n`,
		);
	});

	it("keeps a quote after an escaped backslash, a quote in a code block, and a plain quote", async () => {
		const kept = `${PARAGRAPH} C:\\dir\\\\"x" and "y"\n\`\`\`\nprintf(\\"hi\\")\n\`\`\``;
		await writeCache([track("track:kept", { editorial_article: kept })]);
		const before = await snapshot();
		const manifest = await run(true);
		expect(manifest.written).toBe(0);
		expect(await snapshot()).toEqual(before);
	});

	it("rewrites the article, the teaser of the type and the text facts, and reports each field", async () => {
		await writeCache([
			artist("artist:a", {
				editorial_article: ESCAPED,
				editorial_bio: 'Known as \\"Funk\\".',
				origin: 'the \\"Motor City\\"',
			}),
			track("track:t", { editorial_teaser: 'A \\"teaser\\".', samples_notes: 'the \\"Amen\\" break' }),
		]);
		const manifest = await run(true);
		expect(manifest.written).toBe(2);
		expect(manifest.byField).toEqual({
			editorial_article: 1,
			editorial_bio: 1,
			editorial_teaser: 1,
			origin: 1,
			samples_notes: 1,
		});
		expect(manifest.changed).toEqual([
			{ slug: "artist:a", fields: ["editorial_article", "editorial_bio", "origin"] },
			{ slug: "track:t", fields: ["editorial_teaser", "samples_notes"] },
		]);
		const a = await readNode("artist:a");
		expect([a.editorial_bio, a.origin]).toEqual(['Known as "Funk".', 'the "Motor City"']);
		const t = await readNode("track:t");
		expect([t.editorial_teaser, t.samples_notes]).toEqual(['A "teaser".', 'the "Amen" break']);
	});

	it("never touches a slug, a URL or an edge, and lists the ones that hold the escape", async () => {
		const edge = { slug: "genre:house", type: "genre", name: 'House \\"Music\\"' };
		const node = artist("artist:keep", {
			editorial_article: ESCAPED,
			photo_url: 'https://example.com/a\\"b.jpg',
			genres: [edge],
		});
		await writeCache([node]);
		const manifest = await run(true);
		const after = await readNode("artist:keep");
		expect(after.editorial_article).toBe(FIXED);
		expect({ ...after, editorial_article: node.editorial_article }).toEqual(node);
		expect(manifest.uncovered).toEqual([{ slug: "artist:keep", fields: ["genres[].name", "photo_url"] }]);
	});
});

describe("unescape-quotes: citation titles (TRA-687)", () => {
	const TITLE = 'INTER ARMA \\"New Heaven\\" - Relapse Records';
	const TITLE_FIXED = 'INTER ARMA "New Heaven" - Relapse Records';

	it("rewrites the escaped title of a citation and nothing else of the node", async () => {
		const citations = [
			{ url: "https://example.com/a", title: "Plain" },
			{ url: "https://example.com/b", title: TITLE },
			{ url: "https://example.com/c" },
		];
		const node = track("track:titled", { citations });
		await writeCache([node]);
		const manifest = await run(true);
		expect(manifest.written).toBe(1);
		expect(manifest.byField).toEqual({ "citations[].title": 1 });
		expect(manifest.changed).toEqual([{ slug: "track:titled", fields: ["citations[].title"] }]);
		expect(manifest.uncovered).toEqual([]);
		const after = await readNode("track:titled");
		expect(after.citations).toEqual([
			citations[0],
			{ url: "https://example.com/b", title: TITLE_FIXED },
			citations[2],
		]);
		expect({ ...after, citations: node.citations }).toEqual(node);
	});

	it("counts the node once for its titles, next to its text fields, and is idempotent", async () => {
		await writeCache([
			track("track:both", {
				editorial_article: ESCAPED,
				citations: [
					{ url: "https://example.com/a", title: TITLE },
					{ url: "https://example.com/b", title: 'a \\"second\\" one' },
				],
			}),
		]);
		const manifest = await run(true);
		expect(manifest.changed).toEqual([
			{ slug: "track:both", fields: ["editorial_article", "citations[].title"] },
		]);
		expect(manifest.byField).toEqual({ "citations[].title": 1, editorial_article: 1 });
		expect(manifest.uncovered).toEqual([]);
		const after = await readNode("track:both");
		expect((after.citations as Obj[]).map((c) => c.title)).toEqual([TITLE_FIXED, 'a "second" one']);

		const again = await run(true);
		expect(again.written).toBe(0);
	});

	it("keeps a title whose quote follows a real backslash, a plain quote and an absent title", async () => {
		await writeCache([
			track("track:kept", {
				citations: [
					{ url: "https://example.com/a", title: 'C:\\dir\\\\"x"' },
					{ url: "https://example.com/b", title: 'Already "plain"' },
					{ url: "https://example.com/c" },
				],
			}),
		]);
		const before = await snapshot();
		const manifest = await run(true);
		expect(manifest.written).toBe(0);
		expect(await snapshot()).toEqual(before);
	});

	it("lists, and does not rewrite, an escape held by a title that is not a string", async () => {
		await writeCache([
			track("track:odd", { citations: [{ url: "https://example.com/a", title: { en: 'x \\"y\\"' } }] }),
		]);
		const before = await snapshot();
		const manifest = await run(true);
		expect(manifest.written).toBe(0);
		expect(manifest.uncovered).toEqual([{ slug: "track:odd", fields: ["citations[].title.en"] }]);
		expect(await snapshot()).toEqual(before);
	});

	it("a dry-run plans the title and writes nothing", async () => {
		await writeCache([
			track("track:titled", { citations: [{ url: "https://example.com/a", title: TITLE }] }),
		]);
		const before = await snapshot();
		const manifest = await run(false);
		expect(manifest.written).toBe(1);
		expect(manifest.byField).toEqual({ "citations[].title": 1 });
		expect(await snapshot()).toEqual(before);
	});
});

describe("unescape-quotes: the schema gate", () => {
	it("refuses, lists, and writes nothing when a node would no longer pass the schema", async () => {
		// An article under the schema's minimum of 80 characters stays under it: the node is refused as it is.
		await writeCache([
			artist("artist:short", { editorial_article: 'x \\"y\\"' }),
			artist("artist:fine", { editorial_article: ESCAPED }),
		]);
		const before = await snapshot();

		const dry = await runMigration({ cacheDir: dir, apply: false });
		expect(dry.exitCode).toBe(1);
		const applied = await runMigration({ cacheDir: dir, apply: true });
		expect(applied.exitCode).toBe(2);
		expect(applied.manifest.blocked).toBe(true);
		expect(applied.manifest.errors).toHaveLength(1);
		expect(applied.manifest.errors[0]).toContain("artist:short");
		// All or nothing: the node that could be written is not.
		expect(await snapshot()).toEqual(before);
	});

	it("blocks the run on an unreadable node file", async () => {
		await writeCache([artist("artist:fine", { editorial_article: ESCAPED })]);
		await writeFile(join(dir, "nodes", "artist", "broken.json"), "{ not json", "utf8");
		const before = await snapshot();
		const result = await runMigration({ cacheDir: dir, apply: true });
		expect(result.exitCode).toBe(2);
		expect(result.manifest.errors.join("\n")).toContain("broken");
		expect(await snapshot()).toEqual(before);
	});

	it("only changes the text: the node keeps the keys it has, and none is added", async () => {
		const node = artist("artist:lean", { editorial_article: ESCAPED });
		delete node.similar_artists; // the schema defaults it to []: the parsed copy would add it
		await writeCache([node]);
		await run(true);
		const after = await readNode("artist:lean");
		expect(Object.keys(after)).toEqual(Object.keys(node));
	});
});

describe("unescape-quotes: dry-run, manifest and CLI", () => {
	it("a dry-run plans the same count and writes no node", async () => {
		await writeCache([track("track:escaped", { editorial_article: ESCAPED })]);
		const before = await snapshot();
		const manifest = await run(false);
		expect(manifest.mode).toBe("dry-run");
		expect(manifest.written).toBe(1);
		expect(await snapshot()).toEqual(before);
	});

	it("the manifest carries the channel's contract and the changed nodes and fields", async () => {
		await writeCache([track("track:escaped", { editorial_article: ESCAPED })]);
		const manifestPath = join(dir, "out", "unescape.json");
		await runMigration({ cacheDir: dir, apply: true, manifestPath });
		const m = JSON.parse(await readFile(manifestPath, "utf8")) as Manifest;
		expect(m).toMatchObject({
			migration: MIGRATION_NAME,
			mode: "apply",
			blocked: false,
			removed: [],
			renamed: {},
			redirects: {},
			written: 1,
			byField: { editorial_article: 1 },
			changed: [{ slug: "track:escaped", fields: ["editorial_article"] }],
			uncovered: [],
			errors: [],
		});
		expect(typeof m.generated_at).toBe("string");
		expect(formatSummary(m, manifestPath)).toContain("node files written");
	});

	it("parses the arguments of the channel, --data-dir included and ignored", () => {
		expect(parseCliArgs(["/c", "--apply", "--manifest", "/m.json", "--data-dir", "/d"])).toEqual({
			cacheDir: "/c",
			apply: true,
			manifestPath: "/m.json",
			dataDir: "/d",
		});
		expect(parseCliArgs(["/c"])).toEqual({
			cacheDir: "/c",
			apply: false,
			manifestPath: DEFAULT_MANIFEST_PATH,
			dataDir: undefined,
		});
		for (const bad of [
			[],
			["--apply"],
			["/c", "--bogus"],
			["/c", "--manifest"],
			["/c", "--data-dir"],
			["/c", "--data-dir", "--apply"],
			["/c", "--apply", "--apply"],
		]) {
			expect(parseCliArgs(bad)).toBeNull();
		}
	});

	it("runs end to end with the exact arguments deploy/sync-genre-cache.sh passes", async () => {
		await writeCache([track("track:escaped", { editorial_article: ESCAPED }), track("track:clean")]);
		const dataDir = join(dir, "scratch-data");
		await mkdir(dataDir);
		const manifestPath = join(dir, "channel.manifest.json");
		const out = execFileSync(
			join(process.cwd(), "node_modules", ".bin", "tsx"),
			[
				join(process.cwd(), "scripts", "migrations", `${MIGRATION_NAME}.ts`),
				dir,
				"--apply",
				"--manifest",
				manifestPath,
				"--data-dir",
				dataDir,
			],
			{ encoding: "utf8" },
		);
		expect(out).toContain("node files written");
		const m = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
		expect([m.migration, m.written, m.removed, m.renamed, m.redirects]).toEqual([
			MIGRATION_NAME,
			1,
			[],
			{},
			{},
		]);
		expect((await readNode("track:escaped")).editorial_article).toBe(FIXED);
		expect(await readdir(dataDir)).toEqual([]);
	});

	it("exits 2 on a usage error and on a directory that is not a cache", () => {
		const script = join(process.cwd(), "scripts", "migrations", `${MIGRATION_NAME}.ts`);
		const tsx = join(process.cwd(), "node_modules", ".bin", "tsx");
		expect(spawnSync(tsx, [script, dir, "--bogus"], { encoding: "utf8" }).status).toBe(2);
		expect(spawnSync(tsx, [script, dir], { encoding: "utf8" }).status).toBe(2);
	});
});

describe("unescape-quotes: the migration channel", () => {
	const script = readFileSync(join(process.cwd(), "deploy", "sync-genre-cache.sh"), "utf8");

	it("its name passes the channel's whitelist and is the name of the script file", () => {
		const pattern = /^MIGRATION_NAME_PATTERN='(.+)'$/m.exec(script)?.[1];
		expect(pattern).toBeDefined();
		expect(new RegExp(pattern as string).test(MIGRATION_NAME)).toBe(true);
		expect(existsSync(join(process.cwd(), "scripts", "migrations", `${MIGRATION_NAME}.ts`))).toBe(true);
	});

	it("the channel has no per-name list to extend: any name of that shape whose script exists is accepted", () => {
		expect(script).toContain('if [[ ! -f "$MIGRATIONS_DIR/$name.ts" ]]');
	});
});
