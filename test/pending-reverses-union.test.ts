import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type PendingReversesMap,
	parsePendingReverses,
	readPendingReversesFile,
	summarizePendingReverses,
	unionPendingReverses,
} from "../scripts/pending-reverses-union.js";
import type { PendingReverse } from "../src/cache.js";
import type { Slug } from "../src/types.js";

// TRA-499: the repo and server pending-reverses.json are unioned before a migration run, so a
// migration that renames a slug rewrites ONE coherent file instead of leaving prod's stale keys.

const pr = (field: string, slug: string, name = slug): PendingReverse => ({
	field,
	cardinality: "list",
	edge: { slug: slug as Slug, type: slug.split(":")[0], name } as PendingReverse["edge"],
});

describe("unionPendingReverses", () => {
	it("unions lists per target key: repo {A:[e1]} + server {A:[e2], B:[e3]} -> {A:[e1,e2], B:[e3]}", () => {
		const e1 = pr("members", "artist:e1");
		const e2 = pr("members", "artist:e2");
		const e3 = pr("members", "artist:e3");
		const union = unionPendingReverses({ "artist:a": [e1] }, { "artist:a": [e2], "artist:b": [e3] });
		expect(union).toEqual({ "artist:a": [e1, e2], "artist:b": [e3] });
	});

	it("de-duplicates by (field, edge.slug) and keeps the repo's copy", () => {
		const repoCopy = pr("members", "artist:e1", "Repo spelling");
		const serverCopy = pr("members", "artist:e1", "Server spelling");
		const union = unionPendingReverses({ "artist:a": [repoCopy] }, { "artist:a": [serverCopy] });
		expect(union).toEqual({ "artist:a": [repoCopy] });
	});

	it("keeps the same edge slug under two different fields, and collapses a duplicate inside one side", () => {
		const asMember = pr("members", "artist:e1");
		const asCollab = pr("collaborators", "artist:e1");
		const union = unionPendingReverses({ "artist:a": [asMember, asMember] }, { "artist:a": [asCollab] });
		expect(union).toEqual({ "artist:a": [asMember, asCollab] });
	});

	it("is the identity when the server side is empty, and the server's file when the repo side is", () => {
		const side = { "artist:a": [pr("members", "artist:e1")] };
		expect(unionPendingReverses(side, {})).toEqual(side);
		expect(unionPendingReverses({}, side)).toEqual(side);
		expect(unionPendingReverses({}, {})).toEqual({});
	});

	it("lists the repo's keys first, then the keys only the server had, and mutates neither input", () => {
		const repo = { "artist:b": [pr("members", "artist:e1")] };
		const server = { "artist:a": [pr("members", "artist:e2")], "artist:b": [pr("members", "artist:e3")] };
		const repoBefore = structuredClone(repo);
		const serverBefore = structuredClone(server);
		const union = unionPendingReverses(repo, server);
		expect(Object.keys(union)).toEqual(["artist:b", "artist:a"]);
		expect(repo).toEqual(repoBefore);
		expect(server).toEqual(serverBefore);
	});
});

describe("summarizePendingReverses", () => {
	// Decision (TRA-499): a key whose target already exists in the union is KEPT, not dropped and not
	// applied here. NodeCache.write applies a node's pending reverses on its next write and only then
	// deletes the key, so a kept key loses nothing; dropping it would lose edges, and applying it
	// here would be a second writer of node files (the cache's write code is out of scope).
	it("counts the keys whose target already exists, without removing them", () => {
		const union = { "artist:a": [pr("members", "artist:e1")], "artist:b": [pr("members", "artist:e2")] };
		const summary = summarizePendingReverses(
			{ "artist:a": [] },
			{ "artist:b": [] },
			union,
			new Set(["artist:a"]),
		);
		expect(summary).toEqual({ repoKeys: 1, serverKeys: 1, unionKeys: 2, keysWithExistingTarget: 1 });
		expect(Object.keys(union)).toEqual(["artist:a", "artist:b"]);
	});
});

describe("parsePendingReverses", () => {
	const ok = JSON.stringify({ "artist:a": [pr("members", "artist:e1")] });

	it("accepts a well-formed file", () => {
		expect(parsePendingReverses(ok)).toEqual({ ok: true, value: JSON.parse(ok) });
		expect(parsePendingReverses("{}")).toEqual({ ok: true, value: {} });
	});

	it("accepts the committed cache/pending-reverses.json", async () => {
		const { readFile } = await import("node:fs/promises");
		const raw = await readFile(resolve("cache/pending-reverses.json"), "utf8");
		const parsed = parsePendingReverses(raw);
		expect(parsed.ok).toBe(true);
	});

	it.each([
		["invalid JSON", "{not json", /not valid JSON/],
		["an array", "[]", /JSON object/],
		["null", "null", /JSON object/],
		["a key that is not a slug", JSON.stringify({ "no-colon": [] }), /not a valid slug/],
		["a key with an unknown type", JSON.stringify({ "planet:x": [] }), /not a valid slug/],
		["a prototype key", '{"__proto__": []}', /not a valid slug/],
		["a non-array list", JSON.stringify({ "artist:a": {} }), /must be an array/],
		["an entry that is not an object", JSON.stringify({ "artist:a": ["x"] }), /entry 0/],
		[
			"an entry without a field",
			JSON.stringify({ "artist:a": [{ cardinality: "list", edge: { slug: "artist:e" } }] }),
			/field/,
		],
		[
			"an unknown cardinality",
			JSON.stringify({ "artist:a": [{ field: "members", cardinality: "many", edge: { slug: "artist:e" } }] }),
			/cardinality/,
		],
		[
			"an edge without a valid slug",
			JSON.stringify({ "artist:a": [{ field: "members", cardinality: "list", edge: { slug: "nope" } }] }),
			/edge\.slug/,
		],
	])("refuses %s", (_label, raw, message) => {
		const parsed = parsePendingReverses(raw);
		expect(parsed.ok).toBe(false);
		if (!parsed.ok) expect(parsed.error).toMatch(message);
	});
});

describe("readPendingReversesFile", () => {
	const dirs: string[] = [];
	afterEach(async () => {
		for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
	});
	async function dir(): Promise<string> {
		const d = await mkdtemp(join(tmpdir(), "odyssey-pending-"));
		dirs.push(d);
		return d;
	}

	it("reads a missing file as an empty map (a cache that never queued a reverse)", async () => {
		expect(await readPendingReversesFile(join(await dir(), "pending-reverses.json"))).toEqual({
			ok: true,
			value: {},
		});
	});

	it("reads a present file, and reports a malformed one with its path instead of throwing", async () => {
		const d = await dir();
		const good: PendingReversesMap = { "artist:a": [pr("members", "artist:e1")] };
		await writeFile(join(d, "good.json"), JSON.stringify(good));
		await writeFile(join(d, "bad.json"), "{oops");
		expect(await readPendingReversesFile(join(d, "good.json"))).toEqual({ ok: true, value: good });
		const bad = await readPendingReversesFile(join(d, "bad.json"));
		expect(bad.ok).toBe(false);
		if (!bad.ok) expect(bad.error).toContain(join(d, "bad.json"));
	});
});
