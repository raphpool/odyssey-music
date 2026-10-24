import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	checkNode,
	classify,
	isPlainWebUrl,
	MAX_NODE_BYTES,
	main,
	nodePath,
	parseTombstones,
} from "../scripts/ci/pull-cache-validate.js";
import {
	artist,
	removeTmpDirsAfterEach,
	thresholdsOf,
	tmp,
	writeJson,
	writeNodes,
} from "./helpers/pull-cache.js";

// scripts/ci/pull-cache-validate.ts (TRA-493): classification of the nodes pulled from prod against the
// repo, and the checks a `new` node must pass before deploy/pull-cache.sh copies it.

removeTmpDirsAfterEach();

const REPO_NODES = [artist("repo-one"), artist("repo-two")];

interface Fixture {
	pulled: string;
	repo: string;
	out: string;
	redirects: string;
	genreRedirects: string;
	tombstones: string;
	thresholds: string;
}

/** A repo cache with REPO_NODES, an empty pulled dir, empty redirect tables and ceilings measured on `ceilingsOn`. */
function fixture(ceilingsOn: (typeof REPO_NODES)[number][] = REPO_NODES): Fixture {
	const root = tmp("pull-cache-validate-");
	const f: Fixture = {
		pulled: join(root, "pulled"),
		repo: join(root, "repo"),
		out: join(root, "out"),
		redirects: writeJson(join(root, "slug-redirects.json"), { redirects: {} }),
		genreRedirects: writeJson(join(root, "genre-redirects.json"), { redirects: {} }),
		tombstones: writeJson(join(root, "tombstones.json"), { tombstones: {} }),
		thresholds: writeJson(join(root, "thresholds.json"), thresholdsOf(ceilingsOn)),
	};
	mkdirSync(join(f.pulled, "nodes"), { recursive: true });
	writeNodes(f.repo, REPO_NODES);
	return f;
}

async function run(f: Fixture, extra: string[] = []) {
	const stderr: string[] = [];
	const stdout: string[] = [];
	const err = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
		stderr.push(String(chunk));
		return true;
	});
	const log = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
		stdout.push(a.join(" "));
	});
	try {
		const code = await main([
			f.pulled,
			f.repo,
			"--out-dir",
			f.out,
			"--thresholds",
			f.thresholds,
			"--redirects",
			f.redirects,
			"--tombstones",
			f.tombstones,
			"--genre-redirects",
			f.genreRedirects,
			...extra,
		]);
		return { code, stderr: stderr.join(""), stdout: stdout.join("\n") };
	} finally {
		err.mockRestore();
		log.mockRestore();
	}
}

const read = (f: Fixture, name: string) => readFileSync(join(f.out, name), "utf8");

function treeHash(root: string): string {
	const hash = createHash("sha256");
	const walk = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
			a.name.localeCompare(b.name),
		)) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) walk(path);
			else hash.update(path).update(readFileSync(path));
		}
	};
	walk(root);
	return hash.digest("hex");
}

describe("pull-cache-validate: acceptance", () => {
	it("two valid new nodes -> exit 0, both listed as the copy list", async () => {
		const f = fixture([...REPO_NODES, artist("new-one"), artist("new-two")]);
		writeNodes(f.pulled, [artist("new-one"), artist("new-two")]);
		const r = await run(f);
		expect(r.code).toBe(0);
		expect(r.stderr).toBe("");
		expect(r.stdout).toContain("new 2, changed 0, same 0");
		expect(read(f, "new.txt")).toBe("artist:new-one\nartist:new-two\n");
	});

	it("a new node that fails the schema -> exit 1 naming its slug, and an empty copy list", async () => {
		const f = fixture();
		writeNodes(f.pulled, [artist("good"), artist("broken", { editorial_article: "too short" })]);
		const r = await run(f);
		expect(r.code).toBe(1);
		expect(r.stderr).toContain("artist:broken: fails the node schema");
		expect(r.stderr).toContain("editorial_article");
		expect(read(f, "new.txt")).toBe("");
	});

	it("a new node that raises a correctness metric above its ceiling -> exit 1 naming the metric", async () => {
		const f = fixture();
		writeNodes(f.pulled, [
			artist("selfish", { influences: [{ slug: "artist:selfish", type: "artist", name: "selfish" }] }),
		]);
		const r = await run(f);
		expect(r.code).toBe(1);
		expect(r.stderr).toMatch(/audit: self-edges 1 > 0 \[correctness\]/);
		expect(read(f, "new.txt")).toBe("");
	});

	it("a coverage metric raised by the new node is reported as such, never absorbed", async () => {
		const f = fixture();
		writeNodes(f.pulled, [artist("bare")]);
		const r = await run(f);
		expect(r.code).toBe(1);
		expect(r.stderr).toMatch(/audit: missing-image\[artist\] 3 > 2 \[coverage\]/);
	});

	it("the audit sees the repo nodes too: a node already breaking a ceiling in the repo still fails", async () => {
		const f = fixture([artist("other")]);
		writeNodes(f.pulled, [artist("fine")]);
		const r = await run(f);
		expect(r.code).toBe(1);
		expect(r.stderr).toMatch(/audit: /);
	});
});

describe("pull-cache-validate: classification", () => {
	it("splits new / changed / same, ignores non-node files, and never lists a changed node for copy", async () => {
		const f = fixture([...REPO_NODES, artist("fresh")]);
		// same: byte-identical to the repo. changed: same slug, other content.
		writeNodes(f.pulled, [
			...REPO_NODES.filter((n) => n.slug === "artist:repo-one"),
			artist("repo-two", { origin: "Elsewhere" }),
			artist("fresh"),
		]);
		writeFileSync(join(f.pulled, "nodes", "artist", "fresh.json.tmp-1-abc"), "{");
		const c = await classify(f.pulled, f.repo);
		expect(c).toMatchObject({
			new: ["artist:fresh"],
			changed: ["artist:repo-two"],
			same: ["artist:repo-one"],
			ignored: ["nodes/artist/fresh.json.tmp-1-abc"],
			problems: [],
		});
		const r = await run(f);
		expect(r.code).toBe(0);
		expect(read(f, "new.txt")).toBe("artist:fresh\n");
		expect(read(f, "changed.txt")).toBe("artist:repo-two\n");
		expect(r.stdout).toContain("the repo wins");
	});

	it("never writes under the repo cache or the pulled copy", async () => {
		const f = fixture([...REPO_NODES, artist("fresh")]);
		writeNodes(f.pulled, [artist("fresh"), artist("repo-two", { origin: "Elsewhere" })]);
		const before = [treeHash(f.repo), treeHash(f.pulled)];
		await run(f);
		expect([treeHash(f.repo), treeHash(f.pulled)]).toEqual(before);
	});

	it("flags a symlink named like a node and a directory that is not a node type", async () => {
		const f = fixture();
		mkdirSync(join(f.pulled, "nodes", "artist"), { recursive: true });
		symlinkSync("/etc/hostname", join(f.pulled, "nodes", "artist", "linked.json"));
		mkdirSync(join(f.pulled, "nodes", "playlist"), { recursive: true });
		const c = await classify(f.pulled, f.repo);
		expect(c.problems).toEqual([
			"artist:linked: not a regular file (a symlink or directory named like a node)",
			"nodes/playlist: not a node type directory",
		]);
		expect(c.new).toEqual([]);
	});
});

describe("pull-cache-validate: a new node is untrusted data", () => {
	const problemsOf = (slug: string, node: unknown) =>
		checkNode(slug, typeof node === "string" ? node : JSON.stringify(node)).problems;

	it("accepts a valid node", () => {
		expect(problemsOf("artist:ok", artist("ok"))).toEqual([]);
	});

	it("refuses invalid JSON, a non-object and an oversized file", () => {
		expect(problemsOf("artist:ok", "{")[0]).toMatch(/^artist:ok: not valid JSON/);
		expect(problemsOf("artist:ok", "[1]")).toEqual(["artist:ok: not a JSON object"]);
		expect(problemsOf("artist:ok", " ".repeat(MAX_NODE_BYTES + 1))[0]).toMatch(/larger than/);
	});

	it("refuses bytes that are not valid UTF-8 (they would be copied raw), and a BOM", () => {
		const latin1 = Buffer.from(
			JSON.stringify(artist("ok", { origin: "BEYONCE" })).replace("BEYONCE", "Beyonc\u00e9"),
			"latin1",
		);
		expect(checkNode("artist:ok", latin1).problems).toEqual(["artist:ok: not valid UTF-8"]);
		const utf8 = Buffer.from(JSON.stringify(artist("ok", { origin: "Beyonc\u00e9" })), "utf8");
		expect(checkNode("artist:ok", utf8).problems).toEqual([]);
		expect(
			checkNode("artist:ok", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), utf8])).problems[0],
		).toMatch(/not valid JSON/);
	});

	it("refuses a node whose slug is not the one its path implies", () => {
		expect(problemsOf("artist:other", artist("ok"))).toEqual([
			'artist:other: node slug "artist:ok" does not match its path',
		]);
	});

	it("refuses a non-canonical slug (path traversal, quotes, uppercase)", () => {
		for (const slug of ["artist:Ok", 'artist:x" onmouseover="y', "artist:../../etc"]) {
			expect(problemsOf(slug, artist("ok", { slug })).length).toBeGreaterThan(0);
		}
	});

	it("skips and lists a node under a redirect source slug, without failing the rest of the batch", async () => {
		const f = fixture([...REPO_NODES, artist("fresh")]);
		const table = { redirects: { "artist:old-name": "artist:repo-one" } };
		writeJson(f.redirects, table);
		writeNodes(f.pulled, [artist("old-name"), artist("fresh")]);
		const c = await classify(f.pulled, f.repo, new Map(Object.entries(table.redirects)));
		expect(c).toMatchObject({ new: ["artist:fresh"], superseded: ["artist:old-name"], problems: [] });
		const r = await run(f);
		expect(r.code).toBe(0);
		expect(read(f, "new.txt")).toBe("artist:fresh\n");
		expect(read(f, "superseded.txt")).toBe("artist:old-name\n");
	});

	it("skips and lists a tombstoned node (deleted on purpose, no redirect) without failing the batch", async () => {
		const f = fixture([...REPO_NODES, artist("fresh")]);
		writeJson(f.tombstones, { tombstones: { "artist:deleted-on-purpose": "TRA-1: wrong entity" } });
		writeNodes(f.pulled, [artist("deleted-on-purpose"), artist("fresh")]);
		const r = await run(f);
		expect(r.code).toBe(0);
		expect(r.stdout).toContain("tombstoned 1");
		expect(read(f, "new.txt")).toBe("artist:fresh\n");
		expect(read(f, "tombstoned.txt")).toBe("artist:deleted-on-purpose\n");
		// Once the repo holds the slug again it is no tombstone: a pulled copy is a plain same/changed node.
		writeNodes(f.repo, [artist("deleted-on-purpose")]);
		const c = await classify(f.pulled, f.repo, new Map(), new Set(["artist:deleted-on-purpose"]));
		expect(c.tombstoned).toEqual([]);
		expect(c.same).toContain("artist:deleted-on-purpose");
	});

	it("refuses a tombstones file without a reason, or with a non-canonical slug (exit 2)", async () => {
		const f = fixture();
		writeNodes(f.pulled, [artist("fresh")]);
		for (const bad of [
			{ tombstones: { "artist:x": "" } },
			{ tombstones: { "Artist:X": "why" } },
			{ nope: 1 },
		]) {
			writeJson(f.tombstones, bad);
			expect((await run(f)).code).toBe(2);
		}
	});

	it("the committed tombstones: Incubus is listed, and no tombstone has a node in the repo", () => {
		const slugs = parseTombstones(
			JSON.parse(readFileSync(join("data", "pull-cache-tombstones.json"), "utf8")),
		);
		expect(slugs.has("track:incubus--1987-death-metal-band-from-atlanta")).toBe(true);
		for (const slug of slugs) {
			expect(existsSync(join("cache", nodePath(slug))), slug).toBe(false);
		}
	});

	it("refuses an oversized new file from its size alone, before reading it", async () => {
		const f = fixture();
		writeNodes(f.pulled, [artist("huge")], { "artist:huge": " ".repeat(MAX_NODE_BYTES + 1) });
		const c = await classify(f.pulled, f.repo);
		expect(c.new).toEqual([]);
		expect(c.problems[0]).toMatch(/^artist:huge: file larger than/);
	});

	it("refuses a field the schema would strip, at any depth", () => {
		expect(problemsOf("artist:ok", artist("ok", { debug_blob: 1 }))).toEqual([
			"artist:ok: field(s) the schema would strip: debug_blob",
		]);
		const nested = artist("ok", { citations: [{ url: "https://example.org/a", note: "x" }] });
		expect(problemsOf("artist:ok", nested)).toEqual([
			"artist:ok: field(s) the schema would strip: citations[0].note",
		]);
	});

	it("refuses URLs that are not plain http(s) URLs, wherever the node holds one", () => {
		const bad = [
			["citations", [{ url: "javascript:alert(1)" }]],
			["citations", [{ url: "https://user:secret@example.org/a" }]],
			["citations", [{ url: "http://127.0.0.1/admin" }]],
			["citations", [{ url: "http://localhost:8080/" }]],
			["photo_url", "ftp://example.org/a.jpg"],
			["photo_url", "data:text/html,<script>1</script>"],
		] as const;
		for (const [field, value] of bad) {
			const problems = problemsOf("artist:ok", artist("ok", { [field]: value }));
			expect(problems, `${field}: ${JSON.stringify(value)}`).toHaveLength(1);
			expect(problems[0]).toMatch(/URL is not a plain http\(s\) URL/);
		}
	});

	it("keeps the schema's own image host allowlist", () => {
		const problems = problemsOf("artist:ok", artist("ok", { image_url: "https://evil.example.net/a.jpg" }));
		expect(problems.join("\n")).toContain("image_url host not allowed");
	});

	it("isPlainWebUrl: plain http(s) only", () => {
		expect(isPlainWebUrl("https://en.wikipedia.org/wiki/X")).toBe(true);
		expect(isPlainWebUrl("http://www.allmusic.com/a")).toBe(true);
		for (const url of [
			"//example.org",
			"https://[::1]/",
			"https://10.0.0.1/",
			"https://intranet/",
			'https://example.org/"><img src=x>',
			"https://example.org/a b",
			"not a url",
		]) {
			expect(isPlainWebUrl(url), url).toBe(false);
		}
	});
});

describe("pull-cache-validate: usage and read errors", () => {
	it("exits 2 on bad usage", async () => {
		const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		try {
			expect(await main([])).toBe(2);
			expect(await main(["only-one-dir"])).toBe(2);
			expect(await main(["a", "b", "--nope"])).toBe(2);
			expect(await main(["a", "b", "--out-dir"])).toBe(2);
		} finally {
			err.mockRestore();
		}
	});

	it("exits 2 when the pulled copy has no nodes/ directory, and when the repo cache is empty", async () => {
		const f = fixture();
		const missing = { ...f, pulled: join(f.pulled, "absent") };
		expect((await run(missing)).code).toBe(2);
		const empty = { ...f, repo: tmp("pull-cache-empty-") };
		const r = await run(empty);
		expect(r.code).toBe(2);
		expect(r.stderr).toContain("is empty or has unreadable nodes");
	});

	it("exits 2 on unreadable ceilings rather than certifying without them", async () => {
		const f = fixture();
		writeNodes(f.pulled, [artist("new-one")]);
		const r = await run({ ...f, thresholds: join(f.out, "absent.json") });
		expect(r.code).toBe(2);
	});
});
