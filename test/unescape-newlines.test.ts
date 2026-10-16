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
	textFieldsOf,
	unescapeEditorialText,
} from "../scripts/migrations/2026-10-15-unescape-newlines.js";
import { normalizeEditorialText } from "../src/editorial-text.js";
import { NODE_TYPES } from "../src/node-spec.js";
import { parseSlug } from "../src/slug.js";
import type { Slug } from "../src/types.js";

// A real article, long enough for the schema's minLength of 80 even after the escapes are gone.
const PARAGRAPH = "A real paragraph about the node, long enough for the cache invariants to hold, by far.";
const ESCAPED = `${PARAGRAPH}\\n\\n${PARAGRAPH}`;
const FIXED = `${PARAGRAPH}\n\n${PARAGRAPH}`;
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
	dir = await mkdtemp(join(tmpdir(), "unescape-newlines-"));
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

describe("unescape-newlines: the three cases of the ticket", () => {
	it("rewrites an article holding a literal \\n\\n with real line breaks", async () => {
		await writeCache([artist("artist:escaped", { editorial_article: ESCAPED })]);
		const manifest = await run(true);
		expect(manifest.written).toBe(1);
		expect(manifest.byField).toEqual({ editorial_article: 1 });
		expect((await readNode("artist:escaped")).editorial_article).toBe(FIXED);
	});

	it("does not rewrite a clean node", async () => {
		await writeCache([artist("artist:clean"), artist("artist:escaped", { editorial_article: ESCAPED })]);
		const before = (await snapshot())["artist/clean.json"];
		const manifest = await run(true);
		expect(manifest.changed.map((c) => c.slug)).toEqual(["artist:escaped"]);
		expect((await snapshot())["artist/clean.json"]).toBe(before);
	});

	it("is idempotent: a second run writes nothing", async () => {
		await writeCache([artist("artist:escaped", { editorial_article: ESCAPED })]);
		await run(true);
		const after = await snapshot();
		const second = await run(true);
		expect(second.written).toBe(0);
		expect(second.changed).toEqual([]);
		expect(await snapshot()).toEqual(after);
	});
});

describe("unescape-newlines: which fields and which text", () => {
	it("rewrites the article, the teaser of the type and the text facts, and reports each field", async () => {
		await writeCache([
			artist("artist:a", {
				editorial_article: ESCAPED,
				editorial_bio: "First.\\n\\nSecond.",
				origin: "x\\ny",
			}),
			track("track:t", { editorial_teaser: "Line one.\\nLine two.", samples_notes: "a\\r\\nb" }),
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
		expect([a.editorial_bio, a.origin]).toEqual(["First.\n\nSecond.", "x\ny"]);
		const t = await readNode("track:t");
		expect([t.editorial_teaser, t.samples_notes]).toEqual(["Line one.\nLine two.", "a\nb"]);
	});

	it("never touches a slug, a URL, an edge or a citation, even when they hold a literal \\n", async () => {
		const edge = { slug: "genre:house", type: "genre", name: "House\\nMusic" };
		const node = artist("artist:keep", {
			editorial_article: ESCAPED,
			photo_url: "https://example.com/a\\nb.jpg",
			genres: [edge],
			citations: [{ url: "https://example.com/x\\ny", title: "Source\\nTitle" }],
		});
		await writeCache([node]);
		await run(true);
		const after = await readNode("artist:keep");
		expect(after.editorial_article).toBe(FIXED);
		expect({ ...after, editorial_article: node.editorial_article }).toEqual(node);
	});

	it("declares no URL field among the text fields of any type", () => {
		for (const type of NODE_TYPES) {
			const fields = textFieldsOf(type);
			expect(fields).toContain("editorial_article");
			expect(fields.filter((f) => f.endsWith("_url"))).toEqual([]);
		}
	});

	it("leaves a field with only trailing spaces or extra blank lines alone (another normalization)", async () => {
		const untidy = `${PARAGRAPH}   \n\n\n\n${PARAGRAPH}  `;
		await writeCache([artist("artist:untidy", { editorial_article: untidy })]);
		const before = await snapshot();
		const manifest = await run(true);
		expect(manifest.written).toBe(0);
		expect(await snapshot()).toEqual(before);
	});

	it("normalizes a rewritten field exactly as a new write would (TRA-458's function)", () => {
		for (const text of [
			ESCAPED,
			`${PARAGRAPH}\\n\\n\\n\\n${PARAGRAPH}  \\n`,
			"a\\r\\nb",
			"x \\n y",
			"\\n\\nlead",
		]) {
			expect(unescapeEditorialText(text)).toEqual({
				text: normalizeEditorialText(text),
				kept: 0,
				converted: true,
			});
		}
	});
});

describe("unescape-newlines: a \\n that is content is not an escape", () => {
	it("keeps an escaped backslash followed by n (an even run) and converts the odd one", () => {
		// `\\n` is a backslash then the letter n (a Windows path, a printf format); `\\\n` is a backslash then an escape.
		const text = 'Path C:\\\\new then\\n\\nnext, format "%d\\\\n" and \\\\\\n done.';
		const result = unescapeEditorialText(text);
		expect(result.text).toBe('Path C:\\\\new then\n\nnext, format "%d\\\\n" and \\\\\n done.');
		expect(result.kept).toBe(2);
	});

	it("keeps a \\n inside a fenced code block, and converts the one outside", () => {
		const text = 'Use \\n\\n between:\\n\\n```\nx = "a\\nb"\n```';
		const result = unescapeEditorialText(text);
		expect(result.text).toBe('Use\n\n between:\n\n```\nx = "a\\nb"\n```');
		expect(result.kept).toBe(1);
	});

	it("does not take two stray backticks for a code span: the escapes between them are converted", () => {
		// The broken articles hold no real line break, so an apostrophe-like backtick pairs across paragraphs.
		const result = unescapeEditorialText("l`album\\n\\nl`autre");
		expect(result).toEqual({ text: "l`album\n\nl`autre", kept: 0, converted: true });
	});

	it("says a text converted nothing when only content escapes are left", () => {
		const result = unescapeEditorialText("Path C:\\\\new   \n\n\n\nend");
		expect(result.converted).toBe(false);
		expect(result.kept).toBe(1);
	});

	it("works when the text already holds the private-use character used to shield backslashes", () => {
		const text = "\uE000 stays, \\\\n stays, \\n\\n goes";
		expect(unescapeEditorialText(text).text).toBe("\uE000 stays, \\\\n stays,\n\n goes");
	});

	it("reports the kept sequences and rewrites the real escapes of the same field", async () => {
		await writeCache([artist("artist:mixed", { editorial_article: `${PARAGRAPH}\\n\\nPath C:\\\\new.` })]);
		const manifest = await run(true);
		expect(manifest.kept).toBe(1);
		expect((await readNode("artist:mixed")).editorial_article).toBe(`${PARAGRAPH}\n\nPath C:\\\\new.`);
		// The kept \n is still there for the audit to flag: a human decides.
		expect((await run(true)).written).toBe(0);
	});
});

describe("unescape-newlines: fields outside the migration", () => {
	it("does not rewrite a field whose only escapes are content, whatever else normalization would change", async () => {
		const kept = `${PARAGRAPH} C:\\\\new   \n\n\n\n${PARAGRAPH}`;
		await writeCache([artist("artist:content", { editorial_article: kept })]);
		const before = await snapshot();
		const manifest = await run(true);
		expect(manifest.written).toBe(0);
		expect(manifest.kept).toBe(1);
		expect(await snapshot()).toEqual(before);
	});

	it("lists, without touching it, a literal \\n in a top-level string the migration does not read", async () => {
		await writeCache([
			artist("artist:gap", { editorial_article: ESCAPED, name: "Odd\\nName", disambiguator: "x\\ny" }),
			artist("artist:gap2", { name: "Other\\nName" }),
		]);
		const manifest = await run(true);
		expect(manifest.uncovered).toEqual([
			{ slug: "artist:gap", fields: ["name", "disambiguator"] },
			{ slug: "artist:gap2", fields: ["name"] },
		]);
		const node = await readNode("artist:gap");
		expect([node.name, node.disambiguator]).toEqual(["Odd\\nName", "x\\ny"]);
		expect(node.editorial_article).toBe(FIXED);
	});
});

describe("unescape-newlines: the schema gate", () => {
	it("refuses, lists, and writes nothing when a node would fall under the 80-character minimum", async () => {
		// 79 characters once the literal escapes are gone and the text is trimmed.
		const short = `${"x".repeat(79)}\\n\\n`;
		await writeCache([
			artist("artist:short", { editorial_article: short }),
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
		expect(applied.manifest.errors[0]).toContain("editorial_article");
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

describe("unescape-newlines: dry-run, manifest and CLI", () => {
	it("a dry-run plans the same count and writes no node", async () => {
		await writeCache([artist("artist:escaped", { editorial_article: ESCAPED })]);
		const before = await snapshot();
		const manifest = await run(false);
		expect(manifest.mode).toBe("dry-run");
		expect(manifest.written).toBe(1);
		expect(await snapshot()).toEqual(before);
	});

	it("the manifest carries the channel's contract and the changed nodes and fields", async () => {
		await writeCache([artist("artist:escaped", { editorial_article: ESCAPED })]);
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
			changed: [{ slug: "artist:escaped", fields: ["editorial_article"] }],
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
		await writeCache([artist("artist:escaped", { editorial_article: ESCAPED }), artist("artist:clean")]);
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
		expect((await readNode("artist:escaped")).editorial_article).toBe(FIXED);
		expect(await readdir(dataDir)).toEqual([]);
	});

	it("exits 2 on a usage error and on a directory that is not a cache", () => {
		const script = join(process.cwd(), "scripts", "migrations", `${MIGRATION_NAME}.ts`);
		const tsx = join(process.cwd(), "node_modules", ".bin", "tsx");
		expect(spawnSync(tsx, [script, dir, "--bogus"], { encoding: "utf8" }).status).toBe(2);
		expect(spawnSync(tsx, [script, dir], { encoding: "utf8" }).status).toBe(2);
	});
});

describe("unescape-newlines: the migration channel", () => {
	const script = readFileSync(join(process.cwd(), "deploy", "sync-genre-cache.sh"), "utf8");
	const workflow = readFileSync(join(process.cwd(), ".github", "workflows", "sync-genre-cache.yml"), "utf8");

	it("its name passes the channel's whitelist, is the file's name, and is the one the workflow documents", () => {
		const pattern = /^MIGRATION_NAME_PATTERN='(.+)'$/m.exec(script)?.[1];
		expect(pattern).toBeDefined();
		expect(new RegExp(pattern as string).test(MIGRATION_NAME)).toBe(true);
		expect(existsSync(join(process.cwd(), "scripts", "migrations", `${MIGRATION_NAME}.ts`))).toBe(true);
		expect(workflow).toContain(MIGRATION_NAME);
	});

	it("the channel has no per-name list to extend: any name of that shape whose script exists is accepted", () => {
		expect(script).toContain('if [[ ! -f "$MIGRATIONS_DIR/$name.ts" ]]');
	});
});
