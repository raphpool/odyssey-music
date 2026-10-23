import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyReenrich } from "../scripts/verify-reenrich-thin-nodes.js";

// TRA-487: the proof that a re-enrichment run touched the text and the citations of the thin nodes only.
const ARTICLE =
	"An article about a fixture artist, long enough to pass the schema floor of eighty characters.";

function artist(slug: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		slug,
		type: "artist",
		name: "Fixture",
		editorial_article: ARTICLE,
		editorial_bio: "Bio.",
		citations: [{ url: "https://en.wikipedia.org/wiki/Fixture" }],
		materialized_at: "2026-01-01T00:00:00.000Z",
		mbid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
		genres: [{ type: "genre", slug: "genre:techno", name: "Techno" }],
		labels: [],
		discography: [],
		notable_tracks: [],
		influences: [],
		influenced: [],
		collaborators: [],
		aliases: [],
		members: [],
		similar_artists: [],
		...overrides,
	};
}

const TWO = [
	{ url: "https://en.wikipedia.org/wiki/Fixture" },
	{ url: "https://www.discogs.com/artist/1-Fixture" },
];
const REWRITTEN = {
	editorial_article: `${ARTICLE} More.`,
	citations: TWO,
	materialized_at: "2026-10-24T00:00:00.000Z",
};

describe("verifyReenrich (TRA-487)", () => {
	let root: string;
	let before: string;
	let after: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "odyssey-verify-reenrich-"));
		before = join(root, "before");
		after = join(root, "after");
		await mkdir(join(before, "nodes", "artist"), { recursive: true });
		await writeFile(join(before, "nodes", "artist", "thin.json"), JSON.stringify(artist("artist:thin")));
		await writeFile(
			join(before, "nodes", "artist", "rich.json"),
			JSON.stringify(artist("artist:rich", { citations: TWO })),
		);
		await writeFile(join(before, "pending-reverses.json"), "[]");
		await cp(before, after, { recursive: true });
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	const write = (rel: string, node: unknown) =>
		writeFile(join(after, rel), typeof node === "string" ? node : JSON.stringify(node));

	it("proves a run that changed only the text and the citations of a thin node", async () => {
		await write("nodes/artist/thin.json", artist("artist:thin", REWRITTEN));
		expect(await verifyReenrich(before, after)).toEqual({
			changed: ["nodes/artist/thin.json"],
			unchanged: 2,
			violations: [],
		});
	});

	it("names every other kind of change", async () => {
		await write(
			"nodes/artist/thin.json",
			artist("artist:thin", {
				...REWRITTEN,
				mbid: "ffffffff-ffff-ffff-ffff-ffffffffffff",
				genres: [],
				image_url: "https://upload.wikimedia.org/wikipedia/commons/a/a1/X.jpg",
			}),
		);
		await write("nodes/artist/rich.json", artist("artist:rich", { ...REWRITTEN, editorial_bio: "Other." }));
		await write("pending-reverses.json", "[1]");
		await write("nodes/artist/new.json", artist("artist:new"));

		const { violations } = await verifyReenrich(before, after);

		expect(violations).toEqual(
			expect.arrayContaining([
				expect.stringContaining('thin.json: "mbid" changed'),
				expect.stringContaining('thin.json: "genres" changed'),
				expect.stringContaining('thin.json: "image_url" changed'),
				expect.stringContaining("rich.json: was not thin"),
				"pending-reverses.json: changed, and it is not a node file",
				"nodes/artist/new.json: added",
			]),
		);
	});

	it("checks the guards again: lost citation, social source, shrunk article, unconfirmed identity", async () => {
		const { mbid: _mbid, ...noMbid } = artist("artist:thin", {
			editorial_article: ARTICLE.repeat(2),
			labels: [{ type: "label", slug: "label:old-records", name: "Old Records" }],
		});
		await writeFile(join(before, "nodes", "artist", "thin.json"), JSON.stringify(noMbid));
		await write(
			"nodes/artist/thin.json",
			artist("artist:thin", {
				...REWRITTEN,
				mbid: undefined,
				labels: [{ type: "label", slug: "label:old-records", name: "Old Records" }],
				editorial_article: ARTICLE.slice(0, 40).padEnd(80, "."),
				citations: [
					{ url: "https://www.discogs.com/artist/1-Fixture" },
					{ url: "https://www.facebook.com/x/posts/1" },
				],
			}),
		);

		const { violations } = await verifyReenrich(before, after);

		expect(violations).toEqual(
			expect.arrayContaining([
				expect.stringContaining("lost its citation https://en.wikipedia.org/wiki/Fixture"),
				expect.stringContaining("new social/streaming citation https://www.facebook.com/x/posts/1"),
				expect.stringContaining("article shrank"),
				expect.stringContaining("names no linked entity"),
			]),
		);
	});

	it("refuses a node that is still thin, a stale stamp, and a node that no longer validates", async () => {
		await write("nodes/artist/thin.json", artist("artist:thin", { editorial_article: `${ARTICLE} More.` }));
		await write(
			"nodes/artist/rich.json",
			artist("artist:rich", { citations: TWO, editorial_article: "short" }),
		);

		const { violations } = await verifyReenrich(before, after);

		expect(violations).toEqual(
			expect.arrayContaining([
				expect.stringContaining("thin.json: still thin after"),
				expect.stringContaining("thin.json: materialized_at did not move forward"),
				expect.stringContaining("rich.json: no longer validates"),
			]),
		);
	});
});
