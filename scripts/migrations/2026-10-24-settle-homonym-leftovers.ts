/**
 * What the homonym-identity run (2026-10-20-fix-homonym-work-identity, TRA-604, prod apply of 2026-10-18) left
 * behind, settled work by work from a CLOSED list (TRA-610, PR 2). Offline and deterministic: no detection and no
 * MusicBrainz request, every decision below was read in the prod export and the work's own prose on 2026-10-24.
 * The works live mostly in prod: the migration is written for the union (repo + prod) and does nothing for a work
 * the cache it runs on does not hold, so the repo run changes only what the repo has (Harvest Records).
 *
 * 1. Around the World. The first run stripped `track:around-the-world--stanley-black-and-his-orchestra` (MusicBrainz
 *    holds 113 recordings of the title by Daft Punk: no single answer) and kept its slug. Daft Punk's own node,
 *    `track:around-the-world--daft-punk`, exists in prod: the stripped node is a duplicate of it and is MERGED into
 *    it (the target wins, the homonym's personnel, cover and 2:54 duration go with the node), its slug and the
 *    bare `track:around-the-world` redirect to the survivor.
 * 2. The seven works the first run reported and left. Three have the right prose and the homonym's identity
 *    (Digital Love credited to Logistics, Human After All to Twin Atlantic, Public Image to Fraebbblarnir):
 *    re-credited to the artist the prose is about, slug moved to its scope, the homonym's mbid, project, label,
 *    cover, year, duration and image removed (the identity backfill resolves the right ones when the credit maps
 *    onto a cache artist). Four keep their slug and their identity, which is right, and have a prose that is
 *    wrong (a Versailles album under IAM's "Noble Art", a Freddie Mercury discography under De Cylinders'
 *    single, a series text under Earth, Wind and Fire's "The Essential", and under Lou Johnson's "Tears" the
 *    B-side of Mad World that MusicBrainz does not know): only a new article can fix the prose, so only what it
 *    or the cover brought in goes (edges to the artists it names, the Clean Bandit cover of "Tears", IAM's
 *    reference track, which is a node whose article is not about it, cleared as TRA-605 does).
 * 3. The five corrected works: the covers of the homonym stay on `project:human-after-all--daft-punk` (Twin
 *    Atlantic's single, UPC 884977687170) and `project:temps-mort--booba` (Corbillard's 2020 album, UPC
 *    5051083220071), checked against the iTunes catalogue; they go. An edge to the homonym in `personnel` /
 *    `producers` goes too. The other three have nothing of the kind in the prod export.
 * 4. Harvest Records lists *Wish You Were Here* under its bare slug and under the scoped one: a new run of the
 *    homonym migration cannot touch it (the work is no longer suspect), so every edge naming a redirect key of the
 *    five corrected works is rewritten to the work, and a node that named both ends with one edge.
 *
 * It runs the engine of the homonym migration (`runFix` with `onlyForced`): same collision checks, same edge
 * rewriting, folding, pending-reverses handling, redirect table and manifest. Usage:
 * tsx scripts/migrations/2026-10-24-settle-homonym-leftovers.ts <cache-dir> [--apply]
 *     [--manifest out/settle-homonym-leftovers.json] [--data-dir <dir>]
 */
import { pathToFileURL } from "node:url";
import { looksLikeCacheDir } from "./2026-09-04-merge-genre-duplicates.js";
import {
	type ForcedFix,
	formatSummary,
	parseCliArgs,
	runFix,
} from "./2026-10-20-fix-homonym-work-identity.js";

export const MIGRATION_NAME = "2026-10-24-settle-homonym-leftovers";
export const DEFAULT_MANIFEST_PATH = "out/settle-homonym-leftovers.json";

const DAFT_PUNK = { slug: "artist:daft-punk", name: "Daft Punk" };

export const FORCED: readonly ForcedFix[] = [
	// 1. A duplicate of Daft Punk's own node.
	{
		slug: "track:around-the-world--stanley-black-and-his-orchestra",
		into: "track:around-the-world--daft-punk",
		wrongArtists: ["artist:stanley-black", "artist:stanley-black-and-his-orchestra"],
	},
	// 2. Right prose, homonym's identity.
	{ slug: "track:digital-love--logistics", credit: DAFT_PUNK, wrongArtists: ["artist:logistics"] },
	{ slug: "track:human-after-all--twin-atlantic", credit: DAFT_PUNK, wrongArtists: ["artist:twin-atlantic"] },
	{
		slug: "track:public-image--fraebbblarnir",
		credit: { slug: "artist:public-image-ltd", name: "Public Image Ltd" },
		wrongArtists: ["artist:fraebbblarnir"],
	},
	// 2b. Right identity, wrong prose: only what the prose and the cover brought in goes (the prose and the
	// identity stay). Tears: Lou Johnson's track (Sweet Southern Soul, 1969) is real, MusicBrainz holds no
	// "Tears" by Tears for Fears (the B-sides of Mad World are Ideas as Opiates and Saxophones as Opiates), and
	// the cover is Clean Bandit's "Tears (acoustic piano version)", UPC 190295927530.
	{
		slug: "track:tears--lou-johnson",
		wrongArtists: [
			"artist:roland-orzabal",
			"artist:curt-smith",
			"artist:manny-elias",
			"artist:ian-stanley",
			"artist:mike-howlett",
		],
		wrongCovers: ["89ce7a97-bfea-c31b-ae6d-9bc6587097a4"],
	},
	// Noble Art: the prose is Versailles' album, so its members (producers) and Jasmine You (personnel) are not
	// IAM's, and IAM's reference track is a node whose article is not about it (cleared, as TRA-605 does).
	{
		slug: "track:noble-art--iam",
		wrongArtists: ["artist:kamijo", "artist:hizaki", "artist:teru", "artist:jasmine-you"],
		detach: [{ artist: "artist:iam", field: "reference_track" }],
	},
	// Freddie Mercury (De Cylinders): the prose is the discography of the Queen singer.
	{
		slug: "project:freddie-mercury--de-cylinders",
		wrongArtists: ["artist:montserrat-caballe", "artist:giorgio-moroder"],
		wrongEdges: ["project:queen--mia"],
	},
	// 3. The corrected works: the homonym's cover and edges.
	{
		slug: "project:human-after-all--daft-punk",
		wrongArtists: ["artist:twin-atlantic"],
		wrongCovers: ["dcfac16a-2e52-4034-979c-69280b9c06c2"],
	},
	{
		slug: "project:temps-mort--booba",
		wrongArtists: ["artist:corbillard"],
		wrongCovers: ["b55c5a37-fcd7-e95b-5702-81e548d68f81"],
	},
	{ slug: "project:roir-dub-sessions--bill-laswell", wrongArtists: ["artist:ub40"] },
	{ slug: "project:welcome-to-the-real-world--mr-mister", wrongArtists: ["artist:utkf"] },
	{ slug: "project:wish-you-were-here--pink-floyd", wrongArtists: ["artist:american-hot-wax"] },
];

/** 4. The corrected works: their redirect keys are rewritten to them in every edge. */
export const CANONICAL_TARGETS: readonly string[] = [
	"project:human-after-all--daft-punk",
	"project:roir-dub-sessions--bill-laswell",
	"project:temps-mort--booba",
	"project:welcome-to-the-real-world--mr-mister",
	"project:wish-you-were-here--pink-floyd",
];

async function main(): Promise<void> {
	const args = parseCliArgs(process.argv.slice(2));
	if (!args) {
		process.stderr.write(
			"usage: 2026-10-24-settle-homonym-leftovers.ts <cache-dir> [--apply] [--manifest <path>] [--data-dir <dir>]\n",
		);
		process.exit(2);
	}
	if (!(await looksLikeCacheDir(args.cacheDir))) {
		process.stderr.write(`error: ${args.cacheDir} is not a cache directory (no nodes/ subdirectory)\n`);
		process.exit(2);
	}
	const manifestPath =
		args.manifestPath === "out/fix-homonym-work-identity.json" ? DEFAULT_MANIFEST_PATH : args.manifestPath;
	const result = await runFix({
		...args,
		manifestPath,
		forced: FORCED,
		canonicalTargets: CANONICAL_TARGETS,
		onlyForced: true,
		migrationName: MIGRATION_NAME,
		log: (line) => process.stdout.write(`${line}\n`),
	});
	console.log(formatSummary(result, args.apply, manifestPath));
	process.exit(result.exitCode);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	main().catch((e: unknown) => {
		process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
		process.exit(1);
	});
}
