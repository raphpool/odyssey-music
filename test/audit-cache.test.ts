import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type AuditReport,
	auditNodes,
	compareWithThresholds,
	coverageNodeType,
	formatViolation,
	INFORMATIVE_METRICS,
	main,
	parseCliArgs,
	parseThresholds,
	type RawNode,
	readRawNodes,
	type Thresholds,
	thresholdsFromReport,
	type Violation,
} from "../scripts/audit-cache.js";
import { EDGE_FIELDS_BY_TYPE, REVERSE_EDGE_PAIRS } from "../src/node-spec.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

type NodeType = "genre" | "label" | "artist" | "project" | "track";

function edge(slug: string, name?: string): RawNode {
	const type = slug.slice(0, slug.indexOf(":"));
	return { slug, type, name: name ?? slug.slice(slug.indexOf(":") + 1) };
}

/** A raw node with citations and an image by default, so each test only sets what it measures. */
function node(slug: string, fields: RawNode = {}): RawNode {
	const type = slug.slice(0, slug.indexOf(":")) as NodeType;
	const name = slug.slice(slug.indexOf(":") + 1);
	return {
		slug,
		type,
		name,
		citations: [{ url: "https://a.example" }, { url: "https://b.example" }],
		image_url: "https://img.example/x.jpg",
		...fields,
	};
}

function toMap(...nodes: RawNode[]): Map<string, RawNode> {
	return new Map(nodes.map((n) => [n.slug as string, n]));
}

/** Writes nodes the way the cache lays them out, without going through NodeCache. */
async function writeRawNode(root: string, n: RawNode): Promise<void> {
	const slug = n.slug as string;
	const idx = slug.indexOf(":");
	const file = join(root, "nodes", slug.slice(0, idx), `${slug.slice(idx + 1)}.json`);
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, JSON.stringify(n), "utf8");
}

function metric(report: AuditReport, name: string, key?: string): number {
	const value = report.metrics[name];
	if (typeof value === "number") return value;
	if (value === undefined || key === undefined) throw new Error(`no metric ${name}[${key}]`);
	return value[key] as number;
}

describe("auditNodes", () => {
	it("counts a release link whose target credits someone else as a homonym link (acceptance case)", () => {
		const report = auditNodes(
			toMap(
				node("artist:rohff", { discography: [], notable_tracks: [edge("track:fitna")] }),
				node("artist:akuma"),
				node("track:fitna", { artists: [edge("artist:akuma")] }),
			),
		);
		expect(metric(report, "homonym-release-links")).toBe(1);
		expect(metric(report, "release-links-to-empty-credit")).toBe(0);
		expect(report.samples["homonym-release-links"]).toEqual(["artist:rohff"]);
	});

	it("does not count a link whose target credits the source, or a producer-credited source", () => {
		const report = auditNodes(
			toMap(
				node("artist:a", { discography: [edge("project:direct"), edge("project:produced")] }),
				node("project:direct", { artists: [edge("artist:a")] }),
				node("project:produced", { artists: [edge("artist:b")], producers: [edge("artist:a")] }),
				node("artist:b"),
			),
		);
		expect(metric(report, "homonym-release-links")).toBe(0);
	});

	it("does not count a release credited to a group whose members include the source", () => {
		const report = auditNodes(
			toMap(
				node("artist:roni-size", { discography: [edge("project:new-forms")] }),
				node("project:new-forms", { artists: [edge("artist:reprazent")] }),
				node("artist:reprazent", { members: [edge("artist:roni-size")] }),
			),
		);
		expect(metric(report, "homonym-release-links")).toBe(0);
	});

	it("counts a link to a target with no credited artist as an empty-credit link, not a homonym", () => {
		const report = auditNodes(
			toMap(node("artist:a", { discography: [edge("project:orphan")] }), node("project:orphan")),
		);
		expect(metric(report, "release-links-to-empty-credit")).toBe(1);
		expect(metric(report, "homonym-release-links")).toBe(0);
	});

	it("ignores release links to nodes that do not exist (dangling, informative only)", () => {
		const report = auditNodes(toMap(node("artist:a", { discography: [edge("project:nowhere")] })));
		expect(metric(report, "homonym-release-links")).toBe(0);
		expect(metric(report, "release-links-to-empty-credit")).toBe(0);
		expect(metric(report, "dangling-edges")).toBe(1);
	});

	it("counts nodes with no outgoing edge, and self edges", () => {
		const report = auditNodes(
			toMap(
				node("genre:lonely"),
				node("genre:loop", { related_genres: [edge("genre:loop")] }),
				node("genre:linked", { related_genres: [edge("genre:lonely")] }),
			),
		);
		expect(metric(report, "zero-edge-nodes")).toBe(1);
		expect(report.samples["zero-edge-nodes"]).toEqual(["genre:lonely"]);
		expect(metric(report, "self-edges")).toBe(1);
		expect(report.samples["self-edges"]).toEqual(["genre:loop"]);
	});

	it("counts discography edges without an mbid and artists with fewer than 3 entries (TRA-616)", () => {
		const report = auditNodes(
			toMap(
				node("artist:few", {
					discography: [
						{ ...edge("project:a--few"), mbid: "11111111-1111-1111-1111-111111111111" },
						edge("project:b--few"),
					],
				}),
				node("artist:full", {
					discography: ["a", "b", "c"].map((id) => ({
						...edge(`project:${id}--full`),
						mbid: `${id.repeat(8)}-2222-2222-2222-222222222222`,
					})),
				}),
			),
		);
		expect(metric(report, "discography-edge-without-mbid")).toBe(1);
		expect(report.samples["discography-edge-without-mbid"]).toEqual(["artist:few"]);
		expect(metric(report, "artist-discography-without-mbid")).toBe(1);
		expect(report.samples["artist-discography-without-mbid"]).toEqual(["artist:few"]);
		expect(metric(report, "artist-discography-under-3")).toBe(1);
		expect(report.samples["artist-discography-under-3"]).toEqual(["artist:few"]);
	});

	it("counts an artist once however many of its discography edges lack an mbid", () => {
		const bare = (id: string) => edge(`project:${id}--many`);
		const report = auditNodes(
			toMap(
				node("artist:many", { discography: [bare("a"), bare("b"), bare("c"), bare("d")] }),
				node("artist:none", { discography: [] }),
			),
		);
		expect(metric(report, "discography-edge-without-mbid")).toBe(4);
		expect(metric(report, "artist-discography-without-mbid")).toBe(1);
	});

	it("keeps the per-edge mbid count informative and the per-artist counts ratcheted (amends 8-D6)", () => {
		expect(INFORMATIVE_METRICS.has("discography-edge-without-mbid")).toBe(true);
		expect(INFORMATIVE_METRICS.has("artist-discography-without-mbid")).toBe(false);
		expect(INFORMATIVE_METRICS.has("artist-discography-under-3")).toBe(false);
		expect(coverageNodeType("artist-discography-without-mbid")).toBe("artist");
		expect(coverageNodeType("artist-discography-under-3")).toBe("artist");
		expect(coverageNodeType("discography-edge-without-mbid")).toBeNull();

		const report = auditNodes(toMap(node("artist:a", { discography: [edge("project:x--a")] })));
		const thresholds = thresholdsFromReport(report);
		expect(thresholds).not.toHaveProperty("discography-edge-without-mbid");
		expect(thresholds).toHaveProperty("artist-discography-without-mbid", 1);
		expect(thresholds).toHaveProperty("artist-discography-under-3", 1);
		// The per-edge count has no ceiling and is never reported as "no threshold".
		expect(compareWithThresholds(report, thresholds)).toEqual([]);
	});

	it("counts an empty or whitespace mbid as missing, per edge", () => {
		const report = auditNodes(
			toMap(
				node("artist:a", {
					discography: [
						{ ...edge("project:x--a"), mbid: "" },
						{ ...edge("project:y--a"), mbid: "  " },
						{ ...edge("project:z--a"), mbid: 42 },
						{ ...edge("project:w--a"), mbid: "33333333-3333-3333-3333-333333333333" },
					],
				}),
			),
		);
		expect(metric(report, "discography-edge-without-mbid")).toBe(3);
		expect(metric(report, "artist-discography-under-3")).toBe(0);
	});

	it("counts an artist with no discography field, or a non-array one, as under 3 entries", () => {
		const report = auditNodes(
			toMap(
				node("artist:absent"),
				node("artist:garbage", { discography: "none" }),
				node("genre:not-an-artist"),
			),
		);
		expect(metric(report, "artist-discography-under-3")).toBe(2);
		expect(report.samples["artist-discography-under-3"]).toEqual(["artist:absent", "artist:garbage"]);
		expect(metric(report, "discography-edge-without-mbid")).toBe(0);
	});

	it("reads single edges (project, label) as edges", () => {
		const report = auditNodes(
			toMap(
				node("track:t--x", { project: edge("project:p--x") }),
				node("project:p--x", { artists: [edge("artist:a")] }),
			),
		);
		expect(metric(report, "zero-edge-nodes")).toBe(0);
	});

	it("counts empty artists for projects and tracks only", () => {
		const report = auditNodes(
			toMap(
				node("project:p", { artists: [] }),
				node("project:q", { artists: [edge("artist:a")] }),
				node("track:t", { artists: [] }),
				node("track:u"),
				node("artist:a"),
			),
		);
		expect(metric(report, "empty-artists", "project")).toBe(1);
		expect(metric(report, "empty-artists", "track")).toBe(2);
		expect(Object.keys(report.metrics["empty-artists"] as object).sort()).toEqual(["project", "track"]);
	});

	it("groups same-type nodes whose names collapse to the same string, never across types", () => {
		const report = auditNodes(
			toMap(
				node("artist:aphex-twin", { name: "Aphex Twin" }),
				node("artist:aphex-twin--2", { name: "Aphex  Twin!" }),
				node("artist:aphex-twin--3", { name: "APHEX-TWIN" }),
				node("genre:aphex-twin", { name: "Aphex Twin" }),
				node("genre:other", { name: "Other" }),
			),
		);
		expect(metric(report, "duplicate-names")).toBe(1);
		expect(report.samples["duplicate-names"]).toEqual([
			"artist:aphex-twin",
			"artist:aphex-twin--2",
			"artist:aphex-twin--3",
		]);
	});

	it("flags project and track slugs without a `--` scope, not artists or genres", () => {
		const report = auditNodes(
			toMap(
				node("project:lp5"),
				node("project:lp5--autechre"),
				node("track:fitna"),
				node("artist:rohff"),
				node("genre:dub"),
			),
		);
		expect(metric(report, "unscoped-release-slugs")).toBe(2);
		expect(report.samples["unscoped-release-slugs"]).toEqual(["project:lp5", "track:fitna"]);
	});

	it("flags a literal backslash-n in a text field but not a real newline", () => {
		const report = auditNodes(
			toMap(
				node("genre:bad", { editorial_article: "line one\\nline two" }),
				node("genre:ok", { editorial_article: "line one\nline two" }),
			),
		);
		expect(metric(report, "literal-newlines")).toBe(1);
		expect(report.samples["literal-newlines"]).toEqual(["genre:bad"]);
	});

	it("flags a literal backslash-quote in a text field but not a plain quote (TRA-577)", () => {
		const report = auditNodes(
			toMap(
				node("track:bad", { editorial_article: 'its \\"frenetic romp\\" is loud' }),
				node("track:ok", { editorial_article: 'its "frenetic romp" is loud' }),
				node("track:path", { editorial_article: 'path C:\\dir\\\\"x"' }),
				node("track:code", { editorial_article: 'see\n```\nprintf(\\"hi\\")\n```' }),
				node("track:newline", { editorial_article: "line one\\nline two" }),
			),
		);
		expect(metric(report, "literal-escaped-quotes")).toBe(1);
		expect(report.samples["literal-escaped-quotes"]).toEqual(["track:bad"]);
		// The two measures are independent: a `\n` is not a `\"` and the other way round.
		expect(report.samples["literal-newlines"]).toEqual(["track:newline"]);
	});

	it("counts single-citation and missing-image per type", () => {
		const report = auditNodes(
			toMap(
				node("artist:a", { citations: [{ url: "https://a.example" }], image_url: undefined }),
				node("artist:b", { image_url: undefined, photo_url: "https://p.example/x.jpg" }),
				node("project:p--x", {
					citations: [{ url: "https://a.example" }],
					image_url: undefined,
					cover_url: "",
				}),
				node("genre:g", { citations: [], image_url: undefined }),
			),
		);
		expect(metric(report, "single-citation", "artist")).toBe(1);
		expect(metric(report, "single-citation", "project")).toBe(1);
		expect(metric(report, "single-citation", "genre")).toBe(0);
		expect(metric(report, "missing-image", "artist")).toBe(1);
		expect(metric(report, "missing-image", "project")).toBe(1);
		expect(metric(report, "missing-image", "genre")).toBe(1);
		expect(metric(report, "missing-image", "label")).toBe(0);
	});

	it("counts artists lacking similar_artists, landmark_project and reference_track", () => {
		const report = auditNodes(
			toMap(
				node("artist:bare"),
				node("artist:full", {
					similar_artists: [edge("artist:bare")],
					landmark_project: edge("project:p--x"),
					reference_track: edge("track:t--x"),
				}),
				node("genre:not-an-artist"),
			),
		);
		expect(metric(report, "missing-similar-artists")).toBe(1);
		expect(metric(report, "missing-landmark-project")).toBe(1);
		expect(metric(report, "missing-reference-track")).toBe(1);
	});

	it("measures reciprocity per emitted pair, only towards existing targets", () => {
		const report = auditNodes(
			toMap(
				node("artist:a", { labels: [edge("label:l1"), edge("label:l2"), edge("label:ghost")] }),
				node("label:l1", { roster: [edge("artist:a")] }),
				node("label:l2"),
				node("project:p--x", { artists: [edge("artist:a")] }),
			),
		);
		expect(metric(report, "reciprocity-missing", "artist.labels->label.roster")).toBe(1);
		expect(report.samples["reciprocity-missing[artist.labels->label.roster]"]).toEqual(["artist:a"]);
		expect(metric(report, "reciprocity-missing", "project.artists->artist.discography")).toBe(1);
		expect(metric(report, "reciprocity-missing", "track.artists->artist.notable_tracks")).toBe(0);
	});

	it("includes the emitted same-kind pairs and detects a missing reverse among them", () => {
		const report = auditNodes(
			toMap(
				node("artist:a", { influences: [edge("artist:b")] }),
				node("artist:b", { influenced: [] }),
				node("track:t1--x", { remix_of: edge("track:t2--x") }),
				node("track:t2--x", { remixed_by: [] }),
			),
		);
		expect(metric(report, "reciprocity-missing", "artist.influences->artist.influenced")).toBe(1);
		expect(metric(report, "reciprocity-missing", "track.remix_of->track.remixed_by")).toBe(1);
	});

	describe("pairs the runtime does not emit (TRA-567)", () => {
		const reciprocity = (vs: Violation[]) => vs.filter((v) => v.metric.startsWith("reciprocity"));

		// One missing reverse per declared pair that is NOT emitted, none for the emitted ones.
		const unemitted = (): AuditReport =>
			auditNodes(
				toMap(
					node("genre:g", {
						key_artists: [edge("artist:a")],
						key_labels: [edge("label:l")],
						landmark_projects: [edge("project:p--x")],
						landmark_tracks: [edge("track:t--x")],
					}),
					node("artist:a", { discography: [edge("project:p--x")] }),
					node("label:l", { roster: [edge("artist:a")], notable_releases: [edge("project:p--x")] }),
					node("project:p--x", { tracklist: [edge("track:t--x")] }),
					node("track:t--x", { project: edge("project:p--x"), remixed_by: [edge("track:u--x")] }),
					node("track:u--x"),
				),
			);

		it("does not flag a missing reverse for a pair that is not emitted (acceptance case)", () => {
			const report = unemitted();
			const capped = report.metrics["reciprocity-missing"] as Record<string, number>;
			for (const key of [
				"genre.key_artists->artist.genres",
				"genre.key_labels->label.genres",
				"genre.landmark_projects->project.genres",
				"genre.landmark_tracks->track.genres",
				"artist.discography->project.artists",
				"label.roster->artist.labels",
				"project.tracklist->track.project",
				"track.project->project.tracklist",
				"label.notable_releases->project.label",
				"track.remixed_by->track.remix_of",
			]) {
				expect(capped, key).not.toHaveProperty(key);
			}
			expect(Object.values(capped).every((n) => n === 0)).toBe(true);
			// Every ceiling at 0, even for the capped pairs: the 10 missing reverses are no reciprocity violation.
			const zero = Object.fromEntries(
				Object.entries(report.metrics).map(([m, v]) => [
					m,
					typeof v === "number" ? 0 : Object.fromEntries(Object.keys(v).map((k) => [k, 0])),
				]),
			);
			expect(reciprocity(compareWithThresholds(report, zero))).toEqual([]);
		});

		it("still measures those pairs, as an informative metric with its own samples", () => {
			const report = unemitted();
			expect(INFORMATIVE_METRICS.has("reciprocity-missing-not-emitted")).toBe(true);
			expect(metric(report, "reciprocity-missing-not-emitted", "genre.key_artists->artist.genres")).toBe(1);
			expect(metric(report, "reciprocity-missing-not-emitted", "label.roster->artist.labels")).toBe(1);
			expect(metric(report, "reciprocity-missing-not-emitted", "track.remixed_by->track.remix_of")).toBe(1);
			expect(report.samples["reciprocity-missing-not-emitted[genre.key_artists->artist.genres]"]).toEqual([
				"genre:g",
			]);
		});

		it("gives them no ceiling and never compares them, however high they are", () => {
			const report = unemitted();
			expect(thresholdsFromReport(report)).not.toHaveProperty("reciprocity-missing-not-emitted");
			expect(compareWithThresholds(report, thresholdsFromReport(report))).toEqual([]);
			// A legacy ceiling left in a thresholds file for such a pair is inert, not a violation.
			const legacy = {
				...thresholdsFromReport(report),
				"reciprocity-missing": {
					...(thresholdsFromReport(report)["reciprocity-missing"] as Record<string, number>),
					"genre.key_artists->artist.genres": 0,
				},
			};
			expect(reciprocity(compareWithThresholds(report, legacy))).toEqual([]);
		});

		it("splits the declared pairs into capped and informative ones, none lost, none twice", () => {
			const report = auditNodes(toMap());
			const capped = Object.keys(report.metrics["reciprocity-missing"] as Record<string, number>);
			const informative = Object.keys(
				report.metrics["reciprocity-missing-not-emitted"] as Record<string, number>,
			);
			const declared = REVERSE_EDGE_PAIRS.flatMap((p) =>
				(EDGE_FIELDS_BY_TYPE[p.sourceType] as Record<string, { targets: readonly NodeType[] }>)[
					p.sourceField
				]?.targets.map((t) => ({ ...p, targetType: t })),
			).filter((p) => p !== undefined);
			// Written out on purpose: deriving it from isEmittedReversePair would test that function against itself.
			expect([...capped].sort()).toEqual(
				[
					"artist.aliases->artist.aliases",
					"artist.collaborators->artist.collaborators",
					"artist.influenced->artist.influences",
					"artist.influences->artist.influenced",
					"artist.labels->label.roster",
					"artist.members->artist.members",
					"genre.parent_genres->genre.subgenres",
					"genre.related_genres->genre.related_genres",
					"genre.subgenres->genre.parent_genres",
					"project.artists->artist.discography",
					"project.label->label.notable_releases",
					"track.artists->artist.notable_tracks",
					"track.remix_of->track.remixed_by",
					"track.sampled_by->track.samples",
					"track.samples->track.sampled_by",
				].sort(),
			);
			expect([...capped, ...informative].sort()).toEqual(
				declared.map((p) => `${p.sourceType}.${p.sourceField}->${p.targetType}.${p.reverse.field}`).sort(),
			);
			// The capped cross-type pairs are exactly the four safe directions.
			const crossType = capped.filter((k) => {
				const [from, to] = k.split("->");
				return from?.split(".")[0] !== to?.split(".")[0];
			});
			expect(crossType.sort()).toEqual([
				"artist.labels->label.roster",
				"project.artists->artist.discography",
				"project.label->label.notable_releases",
				"track.artists->artist.notable_tracks",
			]);
		});

		it("has a committed ceiling for every capped pair (an emitted pair without one would be a violation)", async () => {
			const committed = parseThresholds(
				JSON.parse(await readFile(join(REPO_ROOT, "data", "integrity-thresholds.json"), "utf8")),
			);
			const capped = Object.keys(
				auditNodes(toMap()).metrics["reciprocity-missing"] as Record<string, number>,
			);
			const ceilings = committed["reciprocity-missing"] as Record<string, number>;
			for (const key of capped) expect(ceilings, key).toHaveProperty(key);
		});

		it("describes the emitted directions in the spec, not the ones dropped by TRA-563 / TRA-569", async () => {
			const spec = await readFile(join(REPO_ROOT, "src", "node-spec.ts"), "utf8");
			// The comment used to say that genre.key_* -> X.genres was "the only one kept": the runtime writes none of it.
			expect(spec).not.toContain("is the only one kept");
			expect(spec).toContain("isEmittedReversePair");
		});
	});

	it("measures informative metrics: dangling edges, name drift, pending reverse targets", () => {
		const report = auditNodes(
			toMap(
				node("artist:a", {
					collaborators: [edge("artist:b", "B."), edge("artist:c", "Totally other"), edge("artist:z")],
				}),
				node("artist:b", { name: "B" }),
				node("artist:c", { name: "C" }),
			),
			["artist:b", "artist:not-yet"],
		);
		expect(metric(report, "dangling-edges")).toBe(1);
		expect(metric(report, "edge-name-drift")).toBe(1);
		expect(metric(report, "pending-reverse-targets-existing")).toBe(1);
	});

	describe("artist edges to a redirect key (TRA-598)", () => {
		const redirects = new Map([
			["track:mr-tambourine-man", "track:mr-tambourine-man--bob-dylan"],
			["project:ghost", "project:ghost--the-ghosts"],
		]);
		const dylan = (): RawNode[] => [
			node("artist:bob-dylan"),
			node("track:mr-tambourine-man--bob-dylan", { artists: [edge("artist:bob-dylan")] }),
		];

		it("counts the Byrds -> Dylan edge: the redirect leads to a track that does not credit the artist (acceptance case)", () => {
			const report = auditNodes(
				toMap(node("artist:the-byrds", { notable_tracks: [edge("track:mr-tambourine-man")] }), ...dylan()),
				[],
				redirects,
			);
			expect(report.metrics["artist-edge-to-redirect-key"]).toEqual({
				discography: 0,
				notable_tracks: 1,
				landmark_project: 0,
				reference_track: 0,
			});
			expect(report.samples["artist-edge-to-redirect-key[notable_tracks]"]).toEqual(["artist:the-byrds"]);
			expect(report.cases["artist-edge-to-redirect-key"]).toEqual([
				"artist:the-byrds notable_tracks track:mr-tambourine-man -> track:mr-tambourine-man--bob-dylan",
			]);
		});

		it("counts each of the four artist work fields under its own key", () => {
			const report = auditNodes(
				toMap(
					node("artist:a", {
						discography: [edge("project:ghost")],
						notable_tracks: [edge("track:mr-tambourine-man")],
						landmark_project: edge("project:ghost"),
						reference_track: edge("track:mr-tambourine-man"),
					}),
					node("project:ghost--the-ghosts", { artists: [edge("artist:the-ghosts")] }),
					...dylan(),
				),
				[],
				redirects,
			);
			expect(report.metrics["artist-edge-to-redirect-key"]).toEqual({
				discography: 1,
				notable_tracks: 1,
				landmark_project: 1,
				reference_track: 1,
			});
		});

		it("does not count a redirect whose target credits the artist, as artist, producer or group member", () => {
			const table = new Map([
				["project:own", "project:own--a"],
				["project:produced", "project:produced--a"],
				["project:group", "project:group--reprazent"],
			]);
			const report = auditNodes(
				toMap(
					node("artist:a", {
						discography: [edge("project:own"), edge("project:produced"), edge("project:group")],
					}),
					node("project:own--a", { artists: [edge("artist:a")] }),
					node("project:produced--a", { artists: [edge("artist:b")], producers: [edge("artist:a")] }),
					node("project:group--reprazent", { artists: [edge("artist:reprazent")] }),
					node("artist:reprazent", { members: [edge("artist:a")] }),
					node("artist:b"),
				),
				[],
				table,
			);
			expect(metric(report, "artist-edge-to-redirect-key", "discography")).toBe(0);
			expect(report.cases["artist-edge-to-redirect-key"] ?? []).toEqual([]);
		});

		it("counts a redirect whose target has no credit: it credits no one", () => {
			const report = auditNodes(
				toMap(node("artist:a", { discography: [edge("project:ghost")] }), node("project:ghost--the-ghosts")),
				[],
				redirects,
			);
			expect(metric(report, "artist-edge-to-redirect-key", "discography")).toBe(1);
		});

		it("reports a redirect to a node missing from the cache apart, as informative: never compared, no ceiling", () => {
			const report = auditNodes(
				toMap(node("artist:a", { discography: [edge("project:ghost")] })),
				[],
				redirects,
			);
			expect(metric(report, "artist-edge-to-redirect-key", "discography")).toBe(0);
			expect(metric(report, "artist-edge-to-redirect-key-unresolved")).toBe(1);
			expect(report.cases["artist-edge-to-redirect-key-unresolved"]).toEqual([
				"artist:a discography project:ghost -> project:ghost--the-ghosts",
			]);
			// Its credit cannot be read here, and a backfill adding right identities raises it (#531: 8 -> 11):
			// a ceiling would turn legitimate data PRs red (TRA-616 trap).
			expect(INFORMATIVE_METRICS.has("artist-edge-to-redirect-key-unresolved")).toBe(true);
			const thresholds = thresholdsFromReport(report);
			expect(thresholds).not.toHaveProperty("artist-edge-to-redirect-key-unresolved");
			expect(compareWithThresholds(report, thresholds)).toEqual([]);
			// Even if the file still carries an old ceiling, rising above it is not a violation.
			expect(
				compareWithThresholds(report, { ...thresholds, "artist-edge-to-redirect-key-unresolved": 0 }),
			).toEqual([]);
		});

		it("measures every artist field that targets a project or a track, and only those", () => {
			const report = auditNodes(toMap(node("artist:a")));
			expect(Object.keys(report.metrics["artist-edge-to-redirect-key"] as object)).toEqual([
				"discography",
				"notable_tracks",
				"landmark_project",
				"reference_track",
			]);
		});

		it("ignores a key that is still a live node: a read does not redirect it", () => {
			const report = auditNodes(
				toMap(
					node("artist:a", { discography: [edge("project:ghost")] }),
					node("project:ghost", { artists: [edge("artist:a")] }),
					node("project:ghost--the-ghosts", { artists: [edge("artist:the-ghosts")] }),
				),
				[],
				redirects,
			);
			expect(metric(report, "artist-edge-to-redirect-key", "discography")).toBe(0);
			expect(metric(report, "artist-edge-to-redirect-key-unresolved")).toBe(0);
		});

		it("is 0 without a redirect table, and for edges to slugs that are not keys", () => {
			const nodes = toMap(node("artist:the-byrds", { notable_tracks: [edge("track:mr-tambourine-man")] }));
			expect(metric(auditNodes(nodes), "artist-edge-to-redirect-key", "notable_tracks")).toBe(0);
			const other = new Map([["track:elsewhere", "track:elsewhere--x"]]);
			expect(metric(auditNodes(nodes, [], other), "artist-edge-to-redirect-key", "notable_tracks")).toBe(0);
		});

		it("keeps every case, not only the 10 first slugs", () => {
			const artists = Array.from({ length: 12 }, (_, i) =>
				node(`artist:a${i}`, { notable_tracks: [edge("track:mr-tambourine-man")] }),
			);
			const report = auditNodes(toMap(...artists, ...dylan()), [], redirects);
			expect(metric(report, "artist-edge-to-redirect-key", "notable_tracks")).toBe(12);
			expect(report.samples["artist-edge-to-redirect-key[notable_tracks]"]).toHaveLength(10);
			expect(report.cases["artist-edge-to-redirect-key"]).toHaveLength(12);
		});

		it("is a strict metric: no node growth absorbs a rise (a data PR must not add such an edge)", () => {
			for (const field of ["discography", "notable_tracks", "landmark_project", "reference_track"]) {
				expect(coverageNodeType("artist-edge-to-redirect-key", field)).toBeNull();
			}
		});

		it("fails the comparison when the count exceeds its ceiling, naming the field", () => {
			const report = auditNodes(
				toMap(node("artist:the-byrds", { notable_tracks: [edge("track:mr-tambourine-man")] }), ...dylan()),
				[],
				redirects,
			);
			const thresholds = thresholdsFromReport(report);
			expect(compareWithThresholds(report, thresholds)).toEqual([]);
			(thresholds["artist-edge-to-redirect-key"] as Record<string, number>).notable_tracks = 0;
			const violations = compareWithThresholds(report, thresholds);
			expect(violations.map(formatViolation)).toEqual(["artist-edge-to-redirect-key[notable_tracks] 1 > 0"]);
		});
	});

	it("counts nodes per type", () => {
		const report = auditNodes(toMap(node("artist:a"), node("artist:b"), node("genre:g")));
		expect(report.nodeCount).toEqual({ genre: 1, label: 0, artist: 2, project: 0, track: 0 });
	});

	it("keeps at most 10 distinct sample slugs per metric", () => {
		const nodes = Array.from({ length: 15 }, (_, i) => node(`genre:g${i}`));
		const report = auditNodes(toMap(...nodes));
		expect(metric(report, "zero-edge-nodes")).toBe(15);
		expect(report.samples["zero-edge-nodes"]).toHaveLength(10);
	});
});

describe("homonym-tracklist-links (TRA-561)", () => {
	const credit = (slug: string, extra: RawNode = {}): RawNode => ({ ...edge(slug), ...extra });
	const project = (credits: RawNode[], tracklist: string[]): RawNode =>
		node("project:fitna--rohff", { artists: credits, tracklist: tracklist.map((s) => edge(s)) });
	const track = (slug: string, credits: RawNode[]): RawNode => node(slug, { artists: credits });
	const measure = (...nodes: RawNode[]): AuditReport => auditNodes(toMap(...nodes));

	it("counts a tracklist entry credited to a namesake: Fitna by Rohff lists Akuma's track (acceptance case)", () => {
		const report = measure(
			project([credit("artist:rohff")], ["track:fitna--akuma"]),
			track("track:fitna--akuma", [credit("artist:akuma"), credit("artist:axmo")]),
		);
		expect(metric(report, "homonym-tracklist-links")).toBe(1);
		expect(report.samples["homonym-tracklist-links"]).toEqual(["project:fitna--rohff"]);
		expect(report.cases["homonym-tracklist-links"]).toEqual([
			"project:fitna--rohff tracklist track:fitna--akuma",
		]);
	});

	it("counts one hit per entry, not per project", () => {
		const report = measure(
			project([credit("artist:rohff")], ["track:a--x", "track:b--y", "track:c--rohff"]),
			track("track:a--x", [credit("artist:x")]),
			track("track:b--y", [credit("artist:y")]),
			track("track:c--rohff", [credit("artist:rohff")]),
		);
		expect(metric(report, "homonym-tracklist-links")).toBe(2);
	});

	it("does not count a featuring: the track is also credited to the project's artist", () => {
		const report = measure(
			project([credit("artist:rohff")], ["track:duo--rohff"]),
			track("track:duo--rohff", [credit("artist:guest"), credit("artist:rohff")]),
		);
		expect(metric(report, "homonym-tracklist-links")).toBe(0);
	});

	it("with several credited artists, one shared credit is enough, none is a hit", () => {
		const credits = [credit("artist:a"), credit("artist:b")];
		const shared = measure(project(credits, ["track:t--b"]), track("track:t--b", [credit("artist:b")]));
		expect(metric(shared, "homonym-tracklist-links")).toBe(0);
		const foreign = measure(project(credits, ["track:t--c"]), track("track:t--c", [credit("artist:c")]));
		expect(metric(foreign, "homonym-tracklist-links")).toBe(1);
	});

	it("follows members in both directions: a group's album lists a member's track and the reverse", () => {
		const group = node("artist:reprazent", { members: [edge("artist:roni-size")] });
		const person = node("artist:roni-size");
		const memberTrack = measure(
			group,
			person,
			project([credit("artist:reprazent")], ["track:t--roni-size"]),
			track("track:t--roni-size", [credit("artist:roni-size")]),
		);
		expect(metric(memberTrack, "homonym-tracklist-links")).toBe(0);
		const groupTrack = measure(
			group,
			person,
			project([credit("artist:roni-size")], ["track:t--reprazent"]),
			track("track:t--reprazent", [credit("artist:reprazent")]),
		);
		expect(metric(groupTrack, "homonym-tracklist-links")).toBe(0);
	});

	it("follows aliases, and a duo whose members are aliases of the credited artists (Mike & Rich)", () => {
		const nodes = [
			node("artist:aphex-twin", { aliases: [edge("artist:polygon-window"), edge("artist:richard-d-james")] }),
			node("artist:polygon-window", { aliases: [edge("artist:aphex-twin")] }),
			node("artist:mike-and-rich", {
				members: [edge("artist:richard-d-james"), edge("artist:mike-paradinas")],
			}),
		];
		for (const slug of ["artist:polygon-window", "artist:mike-and-rich"]) {
			const report = measure(
				...nodes,
				project([credit("artist:aphex-twin")], ["track:t--x"]),
				track("track:t--x", [credit(slug)]),
			);
			expect(metric(report, "homonym-tracklist-links"), slug).toBe(0);
		}
	});

	it("treats the same name with a leading 'The' as one artist when no mbid says otherwise", () => {
		const variant = measure(
			project(
				[credit("artist:the-jimi-hendrix-experience", { name: "The Jimi Hendrix Experience" })],
				["track:hey-joe--x"],
			),
			track("track:hey-joe--x", [
				credit("artist:jimi-hendrix-experience", { name: "Jimi Hendrix Experience" }),
			]),
		);
		expect(metric(variant, "homonym-tracklist-links")).toBe(0);
		const differentMbids = measure(
			project(
				[credit("artist:akuma", { name: "Akuma", mbid: "11111111-1111-4111-8111-111111111111" })],
				["track:t--x"],
			),
			track("track:t--x", [
				credit("artist:akuma-2", { name: "Akuma", mbid: "22222222-2222-4222-8222-222222222222" }),
			]),
		);
		expect(metric(differentMbids, "homonym-tracklist-links")).toBe(1);
	});

	it("does not judge a compilation credited to Various Artists", () => {
		const bySlug = measure(
			project([credit("artist:various-artists")], ["track:axel-f--harold-faltermeyer"]),
			track("track:axel-f--harold-faltermeyer", [credit("artist:harold-faltermeyer")]),
		);
		expect(metric(bySlug, "homonym-tracklist-links")).toBe(0);
		const byMbid = measure(
			project(
				[credit("artist:va", { name: "Various Artists", mbid: "89ad4ac3-39f7-470e-963a-56509c546377" })],
				["track:t--x"],
			),
			track("track:t--x", [credit("artist:x")]),
		);
		expect(metric(byMbid, "homonym-tracklist-links")).toBe(0);
	});

	it("leaves out what it cannot compare: no project credit, no track credit, a target not in the cache, a non-track", () => {
		expect(
			metric(
				measure(project([], ["track:t--x"]), track("track:t--x", [credit("artist:x")])),
				"homonym-tracklist-links",
			),
		).toBe(0);
		expect(
			metric(
				measure(project([credit("artist:rohff")], ["track:t--x"]), track("track:t--x", [])),
				"homonym-tracklist-links",
			),
		).toBe(0);
		expect(
			metric(measure(project([credit("artist:rohff")], ["track:gone--x"])), "homonym-tracklist-links"),
		).toBe(0);
		expect(metric(measure(project([credit("artist:rohff")], [])), "homonym-tracklist-links")).toBe(0);
	});

	it("has a ceiling in the committed thresholds file", async () => {
		const thresholds = parseThresholds(
			JSON.parse(await readFile(join(REPO_ROOT, "data", "integrity-thresholds.json"), "utf8")),
		);
		expect(typeof thresholds["homonym-tracklist-links"]).toBe("number");
	});
});

describe("compareWithThresholds", () => {
	const clean = (): AuditReport =>
		auditNodes(
			toMap(
				node("genre:a", { related_genres: [edge("genre:b")] }),
				node("genre:b", { related_genres: [edge("genre:a")] }),
			),
		);

	it("reports no violation when thresholds equal the measured values", () => {
		const report = clean();
		expect(compareWithThresholds(report, thresholdsFromReport(report))).toEqual([]);
	});

	it("never puts informative metrics in generated thresholds, and never compares them", () => {
		const report = auditNodes(toMap(node("artist:a", { collaborators: [edge("artist:ghost")] })));
		const thresholds = thresholdsFromReport(report);
		for (const name of INFORMATIVE_METRICS) expect(thresholds).not.toHaveProperty(name);
		expect(metric(report, "dangling-edges")).toBe(1);
		expect(compareWithThresholds(report, thresholds)).toEqual([]);
	});

	it("flags a scalar metric above its ceiling, named like `metric measured > threshold`", () => {
		const report = auditNodes(toMap(node("genre:lonely")));
		const thresholds = { ...thresholdsFromReport(report), "zero-edge-nodes": 0 };
		const violations = compareWithThresholds(report, thresholds);
		expect(violations).toEqual([{ metric: "zero-edge-nodes", measured: 1, threshold: 0 }]);
		expect(formatViolation(violations[0] as Violation)).toBe("zero-edge-nodes 1 > 0");
	});

	it("compares per-type metrics key by key", () => {
		const report = auditNodes(toMap(node("project:p", { artists: [] }), node("track:t")));
		const thresholds = thresholdsFromReport(report);
		(thresholds["empty-artists"] as Record<string, number>).track = 0;
		const violations = compareWithThresholds(report, thresholds);
		expect(violations).toEqual([{ metric: "empty-artists", key: "track", measured: 1, threshold: 0 }]);
		expect(formatViolation(violations[0] as Violation)).toBe("empty-artists[track] 1 > 0");
	});

	it("treats a metric absent from the thresholds as a violation", () => {
		const report = clean();
		const { "self-edges": _dropped, ...thresholds } = thresholdsFromReport(report);
		expect(compareWithThresholds(report, thresholds)).toEqual([
			{ metric: "self-edges", measured: 0, threshold: null },
		]);
		expect(formatViolation({ metric: "self-edges", measured: 0, threshold: null })).toBe(
			"self-edges 0 > (no threshold)",
		);
	});

	it("treats a missing key of a per-type metric, or a scalar where an object is expected, as a violation", () => {
		const report = clean();
		const thresholds = thresholdsFromReport(report) as Record<string, unknown>;
		thresholds["missing-image"] = { genre: 5 };
		thresholds["single-citation"] = 3;
		const names = compareWithThresholds(report, thresholds as Thresholds).map((v) => `${v.metric}[${v.key}]`);
		expect(names).toContain("missing-image[artist]");
		expect(names).toContain("single-citation[genre]");
		expect(names).not.toContain("missing-image[genre]");
	});
});

describe("parseThresholds / parseCliArgs", () => {
	it("accepts numbers and objects of numbers, rejects anything else", () => {
		expect(parseThresholds({ a: 1, b: { x: 2 } })).toEqual({ a: 1, b: { x: 2 } });
		expect(() => parseThresholds({ a: "1" })).toThrow();
		expect(() => parseThresholds([1])).toThrow();
	});

	it("requires a cache-dir and rejects unknown or valueless flags", () => {
		expect(parseCliArgs([])).toBeNull();
		expect(parseCliArgs(["--json", "x.json"])).toBeNull();
		expect(parseCliArgs(["cache", "--json"])).toBeNull();
		expect(parseCliArgs(["cache", "--bogus"])).toBeNull();
		expect(parseCliArgs(["cache", "other"])).toBeNull();
		expect(parseCliArgs(["cache", "--thresholds", "t.json", "--json", "o.json"])).toMatchObject({
			cacheDir: "cache",
			thresholdsPath: "t.json",
			jsonPath: "o.json",
		});
	});

	it("reads the redirect table from data/slug-redirects.json unless --redirects overrides it", () => {
		expect(parseCliArgs(["cache"])?.redirectsPath).toBe(join(REPO_ROOT, "data", "slug-redirects.json"));
		expect(parseCliArgs(["cache", "--redirects", "r.json"])?.redirectsPath).toBe("r.json");
		expect(parseCliArgs(["cache", "--redirects"])).toBeNull();
	});
});

describe("audit-cache CLI", () => {
	let dir: string;
	let cacheDir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "audit-cache-"));
		cacheDir = join(dir, "cache");
		for (const n of [
			node("artist:rohff", { notable_tracks: [edge("track:fitna")] }),
			node("artist:akuma"),
			node("track:fitna", { artists: [edge("artist:akuma")] }),
		]) {
			await writeRawNode(cacheDir, n);
		}
		await writeFile(join(cacheDir, "pending-reverses.json"), JSON.stringify({ "artist:akuma": [] }), "utf8");
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	async function snapshot(root: string): Promise<Record<string, string>> {
		const out: Record<string, string> = {};
		const walk = async (d: string): Promise<void> => {
			for (const name of await readdir(d)) {
				const p = join(d, name);
				if ((await stat(p)).isDirectory()) await walk(p);
				else out[p] = `${(await stat(p)).mtimeMs}:${await readFile(p, "utf8")}`;
			}
		};
		await walk(root);
		return out;
	}

	async function thresholdsFile(mutate: (t: Thresholds) => void = () => {}): Promise<string> {
		const { nodes } = await readRawNodes(cacheDir);
		const thresholds = thresholdsFromReport(auditNodes(nodes, ["artist:akuma"]));
		mutate(thresholds);
		const path = join(dir, "thresholds.json");
		await writeFile(path, JSON.stringify(thresholds), "utf8");
		return path;
	}

	function run(...args: string[]): { status: number | null; stdout: string; stderr: string } {
		const tsx = join(REPO_ROOT, "node_modules", ".bin", "tsx");
		const r = spawnSync(tsx, [join(REPO_ROOT, "scripts", "audit-cache.ts"), ...args], { encoding: "utf8" });
		return { status: r.status, stdout: r.stdout, stderr: r.stderr };
	}

	it("exits 0 and prints every metric with its value and threshold", async () => {
		const thresholds = await thresholdsFile();
		const r = run(cacheDir, "--thresholds", thresholds);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("homonym-release-links");
		expect(r.stdout).toMatch(/homonym-release-links\s+1\s+\(threshold 1\)/);
		expect(r.stdout).toMatch(/empty-artists\[track\]\s+0\s+\(threshold 0\)/);
		expect(r.stdout).toMatch(/dangling-edges\s+0\s+\(informative\)/);
		expect(r.stdout).toMatch(/pending-reverse-targets-existing\s+1\s+\(informative\)/);
		expect(r.stderr).toBe("");
	});

	// A reverse pair added to REVERSE_EDGE_PAIRS without its `reciprocity-missing` ceiling in
	// data/integrity-thresholds.json reads as a violation (TRA-454: 9 pairs were added without one).
	it("passes on the committed cache with the committed thresholds", () => {
		const r = run(join(REPO_ROOT, "cache"));
		expect(r.stderr).toBe("");
		expect(r.status).toBe(0);
	}, 60_000);

	it("exits 1 naming the metric when homonym-release-links exceeds a threshold of 0", async () => {
		const thresholds = await thresholdsFile((t) => {
			t["homonym-release-links"] = 0;
		});
		const r = run(cacheDir, "--thresholds", thresholds);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("homonym-release-links 1 > 0");
	});

	it("exits 1 when a measured metric has no threshold", async () => {
		const thresholds = await thresholdsFile((t) => {
			delete t["self-edges"];
		});
		const r = run(cacheDir, "--thresholds", thresholds);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("self-edges 0 > (no threshold)");
	});

	it("exits 2 on usage errors, an unreadable thresholds file, or an empty cache", async () => {
		const thresholds = await thresholdsFile();
		expect(run().status).toBe(2);
		expect(run(cacheDir, "--bogus").status).toBe(2);
		expect(run(cacheDir, "--thresholds", join(dir, "nope.json")).status).toBe(2);
		expect(run(join(dir, "empty-cache"), "--thresholds", thresholds).status).toBe(2);
	});

	it("exits 2 rather than certify a cache with an unreadable node file", async () => {
		const thresholds = await thresholdsFile();
		await writeFile(join(cacheDir, "nodes", "artist", "broken.json"), "{not json", "utf8");
		const r = run(cacheDir, "--thresholds", thresholds);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("broken.json");
	});

	it("--json writes a serialized AuditReport with at most 10 samples per metric", async () => {
		const thresholds = await thresholdsFile();
		const out = join(dir, "report.json");
		expect(run(cacheDir, "--thresholds", thresholds, "--json", out).status).toBe(0);
		const report = JSON.parse(await readFile(out, "utf8")) as AuditReport;
		expect(Number.isNaN(Date.parse(report.generatedAt))).toBe(false);
		expect(report.nodeCount).toEqual({ genre: 0, label: 0, artist: 2, project: 0, track: 1 });
		expect(report.metrics["homonym-release-links"]).toBe(1);
		expect(report.metrics["empty-artists"]).toEqual({ project: 0, track: 0 });
		expect(report.samples["homonym-release-links"]).toEqual(["artist:rohff"]);
		for (const list of Object.values(report.samples)) expect(list.length).toBeLessThanOrEqual(10);
	});

	it("refuses a --json path inside the cache directory", async () => {
		const thresholds = await thresholdsFile();
		const before = await snapshot(cacheDir);
		const r = run(cacheDir, "--thresholds", thresholds, "--json", join(cacheDir, "report.json"));
		expect(r.status).toBe(2);
		expect(await snapshot(cacheDir)).toEqual(before);
	});

	describe("with a redirect table (TRA-598)", () => {
		async function byrdsCache(): Promise<string> {
			for (const n of [
				node("artist:the-byrds", { notable_tracks: [edge("track:mr-tambourine-man")] }),
				node("artist:bob-dylan"),
				node("track:mr-tambourine-man--bob-dylan", { artists: [edge("artist:bob-dylan")] }),
			]) {
				await writeRawNode(cacheDir, n);
			}
			const redirects = join(dir, "slug-redirects.json");
			await writeFile(
				redirects,
				JSON.stringify({ redirects: { "track:mr-tambourine-man": "track:mr-tambourine-man--bob-dylan" } }),
				"utf8",
			);
			return redirects;
		}

		it("exits 1 naming the field and lists the cases when the ceiling is exceeded", async () => {
			const redirects = await byrdsCache();
			const thresholds = await thresholdsFile();
			const r = run(cacheDir, "--thresholds", thresholds, "--redirects", redirects);
			expect(r.status).toBe(1);
			expect(r.stderr).toContain("artist-edge-to-redirect-key[notable_tracks] 1 > 0");
			expect(r.stdout).toContain(
				"artist:the-byrds notable_tracks track:mr-tambourine-man -> track:mr-tambourine-man--bob-dylan",
			);
		});

		it("exits 0 once the ceiling is committed at the measured value", async () => {
			const redirects = await byrdsCache();
			const thresholds = await thresholdsFile((t) => {
				t["artist-edge-to-redirect-key"] = {
					discography: 0,
					notable_tracks: 1,
					landmark_project: 0,
					reference_track: 0,
				};
			});
			const r = run(cacheDir, "--thresholds", thresholds, "--redirects", redirects);
			expect(r.status).toBe(0);
			expect(r.stdout).toMatch(/artist-edge-to-redirect-key\[notable_tracks\]\s+1\s+\(threshold 1\)/);
		});

		it("exits 2 rather than report 0 when the redirect table is unreadable or malformed", async () => {
			const thresholds = await thresholdsFile();
			const missing = run(cacheDir, "--thresholds", thresholds, "--redirects", join(dir, "nope.json"));
			expect(missing.status).toBe(2);
			expect(missing.stderr).toContain("cannot read redirects");
			const bad = join(dir, "bad-redirects.json");
			await writeFile(bad, JSON.stringify({ redirects: { "track:a": "project:b" } }), "utf8");
			expect(run(cacheDir, "--thresholds", thresholds, "--redirects", bad).status).toBe(2);
		});
	});

	it("never writes inside the cache directory", async () => {
		const thresholds = await thresholdsFile();
		const before = await snapshot(cacheDir);
		const out = join(dir, "report.json");
		const status = await main([cacheDir, "--thresholds", thresholds, "--json", out]);
		expect(status).toBe(0);
		expect(await snapshot(cacheDir)).toEqual(before);
	});
});
