import type { GenreCoverageReport } from "./genre-coverage.js";
import { GenreSeedSchema, type GenreSeeds, validateGenreSeeds } from "./genre-seeds.js";
import type { GenreTaxonomy } from "./genre-taxonomy.js";
import { type CatalogResult, createMusicBrainzCatalog } from "./musicbrainz.js";
import { makeSlug } from "./slug.js";
import type { Slug } from "./types.js";

export const BATCH_BUDGETS = { B4a: 58, B4b: 16, B4c: 20, B4e: 60, B4f: 67 } as const;
type Annex = keyof typeof BATCH_BUDGETS;

export interface PrescribedGenre {
	annex: Annex;
	number: number;
	id: string;
	name: string;
	qid?: string;
	slug: Slug;
	sourceSlugs: readonly Slug[];
	existingNeighbours: number;
	deficit: number;
	creations: number;
}

function prescribed(
	annex: Annex,
	number: number,
	id: string,
	name: string,
	source?: string,
	existingNeighbours = 0,
): PrescribedGenre {
	const sourceSlugs = source === undefined ? [] : [source as Slug];
	const deficit = 3 - existingNeighbours;
	const localName = id.startsWith("local:") ? id.slice("local:".length) : name;
	return {
		annex,
		number,
		id,
		name,
		...(id.startsWith("Q") ? { qid: id } : {}),
		slug: SLUG_OVERRIDES[id] ?? sourceSlugs[0] ?? makeSlug("genre", localName),
		sourceSlugs,
		existingNeighbours,
		deficit,
		creations: deficit + (source === undefined ? 1 : 0),
	};
}

// Targets whose slug is not the one derived from their display name. Trap keeps the hip-hop slug
// (genre:trap is EDM trap's historical redirect); Memphis was relabelled « Memphis Rap » by the TRA-229
// arbitration (2026-09-17, TRA-247) but its dossier and node keep genre:memphis.
const SLUG_OVERRIDES: Readonly<Record<string, Slug>> = {
	Q2913982: "genre:trap-hip-hop",
	Q6010117: "genre:memphis",
};

// Classic Disco and Rap left this list on 2026-09-17 (TRA-247): the TRA-229 arbitration folded them into
// Disco and Hip Hop as aliases, so they are no longer taxonomy entries (their S tickets were cancelled).
export const PRESCRIBED_GENRES: readonly PrescribedGenre[] = [
	prescribed("B4a", 312, "Q486263", "Bossa Nova"),
	prescribed("B4a", 318, "Q723418", "Cumbia"),
	prescribed("B4a", 343, "Q208239", "Salsa"),
	prescribed("B4a", 344, "Q11403", "Samba"),
	prescribed("B4a", 346, "Q14390274", "Tango"),
	prescribed("B4a", 378, "Q388296", "Afrobeat"),
	prescribed("B4a", 395, "Q3591962", "Ethiopian Jazz"),
	prescribed("B4a", 402, "Q2000173", "Gnawa"),
	prescribed("B4a", 408, "Q963061", "Highlife", "genre:highlife", 1),
	prescribed("B4a", 444, "Q1752683", "Soukous"),
	prescribed("B4a", 460, "Q6942022", "Bollywood"),
	prescribed("B4a", 468, "Q11307326", "City Pop"),
	prescribed("B4a", 472, "Q194492", "Gamelan"),
	prescribed("B4a", 478, "Q131578", "J-Pop"),
	prescribed("B4a", 481, "Q213665", "K-Pop"),
	prescribed("B4b", 276, "Q4942839", "Boogie"),
	prescribed("B4b", 279, "Q336567", "Cosmic Disco"),
	prescribed("B4b", 356, "Q474027", "Dancehall", "genre:dancehall"),
	prescribed("B4b", 372, "Q54365", "Ska", "genre:ska", 2),
	prescribed("B4c", 66, "Q25099840", "Afrobeats"),
	prescribed("B4c", 67, "Q85741139", "Amapiano"),
	prescribed("B4c", 226, "Q132438", "Black Metal"),
	prescribed("B4c", 227, "Q483251", "Death Metal", "genre:death-metal", 1),
	prescribed("B4c", 239, "Q7118426", "Alternative R&B", "genre:alternative-r-and-b", 2),
	prescribed("B4c", 247, "Q876171", "East Coast hip-hop", "genre:east-coast-hip-hop", 2),
	prescribed("B4c", 261, "Q2913982", "Trap"),
	prescribed("B4e", 1, "Q106528337", "Acid"),
	prescribed("B4e", 4, "Q481900", "Acid Trance", "genre:acid-trance"),
	prescribed("B4e", 6, "Q2866725", "Balearic House"),
	prescribed("B4e", 7, "Q65937774", "Breaks"),
	prescribed("B4e", 8, "Q2406633", "Broken Beat"),
	prescribed("B4e", 16, "Q30917612", "Euro House"),
	prescribed("B4e", 17, "Q216961", "Eurodance", "genre:eurodance", 2),
	prescribed("B4e", 19, "Q820049", "Gabber"),
	prescribed("B4e", 21, "Q2748817", "Ghetto House"),
	prescribed("B4e", 22, "Q1521688", "Ghettotech"),
	prescribed("B4e", 23, "Q339906", "Happy Hardcore"),
	prescribed("B4e", 24, "Q223840", "Hardstyle"),
	prescribed("B4e", 25, "Q601235", "Hip-House"),
	prescribed("B4e", 28, "Q105636940", "Leftfield House"),
	prescribed("B4e", 29, "local:leftfield-techno", "Leftfield Techno", "genre:leftfield-techno"),
	prescribed("B4e", 30, "Q3048168", "Makina"),
	prescribed("B4f", 238, "Q438503", "Alternative hip-hop", "genre:alternative-hip-hop", 1),
	prescribed("B4f", 240, "Q529742", "Boom bap", "genre:boom-bap", 1),
	prescribed("B4f", 241, "Q2261628", "Chopped N Screwed"),
	prescribed("B4f", 242, "Q19879476", "Classic Hip Hop"),
	prescribed("B4f", 243, "Q16829781", "Cloud Rap"),
	prescribed("B4f", 244, "Q141459", "Conscious hip-hop", "genre:conscious-hip-hop", 1),
	prescribed("B4f", 245, "Q8560269", "Dirty South"),
	prescribed("B4f", 246, "Q15697534", "Drill"),
	prescribed("B4f", 248, "Q12362064", "Emo Rap"),
	prescribed("B4f", 249, "Q5421158", "Experimental Hip Hop"),
	prescribed("B4f", 250, "Q1045541", "G-Funk"),
	prescribed("B4f", 251, "Q753679", "Gangsta Rap"),
	prescribed("B4f", 253, "Q255406", "Jazz Rap", "genre:jazz-rap", 1),
	prescribed("B4f", 254, "Q97265899", "Lofi Hip-Hop", "genre:lofi-hip-hop"),
	prescribed("B4f", 255, "Q6010117", "Memphis Rap"),
	prescribed("B4f", 256, "Q6918602", "Motswako"),
	prescribed("B4f", 257, "Q840065", "New Jack Swing"),
	prescribed("B4f", 260, "Q850412", "RnB"),
];

export interface GenreSeedProposalInputs {
	taxonomy: GenreTaxonomy;
	coverage: GenreCoverageReport;
	dossiers: GenreSeeds;
	requestedIds?: readonly string[];
}

function selectPrescribedGenres(requestedIds: readonly string[] | undefined): readonly PrescribedGenre[] {
	if (requestedIds === undefined) return PRESCRIBED_GENRES;
	if (requestedIds.length === 0) throw new Error("At least one requested genre id is required");
	const prescribedById = new Map(PRESCRIBED_GENRES.map((genre) => [genre.id, genre]));
	const selected: PrescribedGenre[] = [];
	const seen = new Set<string>();
	const unknown: string[] = [];
	for (const id of requestedIds) {
		if (seen.has(id)) continue;
		seen.add(id);
		const prescribed = prescribedById.get(id);
		if (prescribed === undefined) unknown.push(id);
		else selected.push(prescribed);
	}
	if (unknown.length > 0) throw new Error(`Unknown requested genre id: ${unknown.join(", ")}`);
	return selected;
}

export function validateGenreSeedProposalInputs({
	taxonomy,
	coverage,
	dossiers,
	requestedIds,
}: GenreSeedProposalInputs): void {
	const selectedGenres = selectPrescribedGenres(requestedIds);
	const prescribedIds = new Set(PRESCRIBED_GENRES.map(({ id }) => id));
	const missing = selectedGenres.filter(({ id }) => !Object.hasOwn(dossiers, id)).map(({ id }) => id);
	const foreign = Object.keys(dossiers).filter((id) => !prescribedIds.has(id));
	if (missing.length > 0) throw new Error(`Missing prescribed dossiers: ${missing.join(", ")}`);
	if (foreign.length > 0) throw new Error(`Foreign prescribed dossiers: ${foreign.join(", ")}`);
	const selectedDossiers: GenreSeeds = {};
	for (const { id } of selectedGenres) {
		const dossier = dossiers[id];
		if (dossier !== undefined) selectedDossiers[id] = dossier;
	}
	validateGenreSeeds(selectedDossiers, taxonomy.genres);

	const entries = new Map(taxonomy.genres.map((entry) => [entry.id, entry]));
	for (const prescribed of selectedGenres) {
		const entry = entries.get(prescribed.id);
		if (!entry) throw new Error(`Taxonomy is missing prescribed genre: ${prescribed.id}`);
		if (
			entry.name !== prescribed.name ||
			entry.qid !== prescribed.qid ||
			(entry.sourceSlugs ?? []).join("\u0000") !== prescribed.sourceSlugs.join("\u0000")
		)
			throw new Error(`Taxonomy identity does not match prescribed genre: ${prescribed.id}`);
		const dossier = dossiers[prescribed.id];
		if (!dossier || dossier.genre.name !== prescribed.name || dossier.genre.slug !== prescribed.slug)
			throw new Error(`Dossier identity does not match prescribed genre: ${prescribed.id}`);
		const measured = coverage.entries[prescribed.id];
		if (!measured) throw new Error(`Coverage is missing prescribed genre: ${prescribed.id}`);
		if (measured.resolvedSources.join("\u0000") !== prescribed.sourceSlugs.join("\u0000"))
			throw new Error(`Coverage sources do not match prescribed baseline: ${prescribed.id}`);
		if (measured.neighbourCount !== prescribed.existingNeighbours || measured.deficit !== prescribed.deficit)
			throw new Error(`Coverage deficit does not match prescribed baseline: ${prescribed.id}`);
	}
}

const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const QID = /^Q[1-9]\d*$/;
const CANDIDATE_SLUG =
	/^(?:genre|artist|project|track):[a-z0-9]+(?:-[a-z0-9]+)*(?:--[a-z0-9]+(?:-[a-z0-9]+)*)?$/;

export type Proof = { url: string; verified: boolean };

interface Candidate {
	name: string;
	slug: string;
	proofs: readonly Proof[];
	homonym?: boolean | undefined;
}
export interface TargetCandidate extends Candidate {
	type: "artist" | "project" | "track";
	mbid?: string | undefined;
	resolutionError?: string | undefined;
}

export interface AnchorCandidate extends Candidate {
	qid?: string | undefined;
	justification?: string | undefined;
}

export type ProposalCandidates = { targets: readonly TargetCandidate[]; anchors: readonly AnchorCandidate[] };

export type ProposalOptions = { trustedHosts: readonly string[]; requestedIds?: readonly string[] };

export type RejectedCandidate = { kind: "target" | "anchor"; name: string; slug: string; reason: string };

export interface GenreSeedProposal {
	requiredTargets: number;
	acceptedTargets: readonly TargetCandidate[];
	acceptedAnchors: readonly AnchorCandidate[];
	rejected: readonly RejectedCandidate[];
	missingTargets: number;
	missingAnchors: number;
	promotable: boolean;
	publishable: boolean;
}

export type GenreSeedProposalReport = { entries: Record<string, GenreSeedProposal>; seeds: GenreSeeds };

interface CandidateState {
	slugs: Set<string>;
	mbids: Set<string>;
	qids: Set<string>;
	targets: TargetCandidate[];
	anchors: AnchorCandidate[];
	rejected: RejectedCandidate[];
}

function reject(
	kind: RejectedCandidate["kind"],
	candidate: Pick<TargetCandidate | AnchorCandidate, "name" | "slug">,
	reason: string,
): RejectedCandidate {
	return { kind, name: candidate.name, slug: candidate.slug, reason };
}

function proofError(proofs: readonly Proof[], trustedHosts: readonly string[]): string | undefined {
	if (!Array.isArray(proofs) || proofs.length === 0) return "no proof provided";
	const trusted = new Set(trustedHosts.map((host) => host.toLowerCase()));
	for (const proof of proofs) {
		if (proof?.verified !== true) return "proof is not verified";
		let url: URL;
		try {
			url = new URL(proof.url);
		} catch {
			return "proof URL is invalid";
		}
		if (url.protocol !== "https:" || !url.hostname || url.username || url.password)
			return "proof URL must be HTTPS with a plain host";
		const host = url.hostname.toLowerCase();
		if (![...trusted].some((allowed) => host === allowed || host.endsWith(`.${allowed}`)))
			return `proof host is not trusted: ${host}`;
	}
}

function candidateError(
	candidate: TargetCandidate | AnchorCandidate,
	kind: RejectedCandidate["kind"],
	trustedHosts: readonly string[],
): RejectedCandidate | undefined {
	if (!candidate.name.trim()) return reject(kind, candidate, "empty name");
	if (!CANDIDATE_SLUG.test(candidate.slug)) return reject(kind, candidate, "invalid explicit slug");
	if (candidate.homonym) return reject(kind, candidate, "homonym");
	if (kind === "target" && (candidate as TargetCandidate).resolutionError)
		return reject(kind, candidate, (candidate as TargetCandidate).resolutionError as string);
	const error = proofError(candidate.proofs, trustedHosts);
	if (error) return reject(kind, candidate, error);
	if (kind === "target") {
		const target = candidate as TargetCandidate;
		if (!(["artist", "project", "track"] as string[]).includes(target.type))
			return reject(kind, candidate, "invalid target type");
		if (!target.slug.startsWith(`${target.type}:`))
			return reject(kind, candidate, "target type and slug disagree");
		if (target.mbid !== undefined && !MBID.test(target.mbid)) return reject(kind, candidate, "invalid MBID");
	} else {
		const anchor = candidate as AnchorCandidate;
		if (!anchor.slug.startsWith("genre:")) return reject(kind, candidate, "anchor must be a genre slug");
		if (!anchor.justification?.trim())
			return reject(kind, candidate, "missing anchor relation justification");
		if (anchor.qid !== undefined && !QID.test(anchor.qid))
			return reject(kind, candidate, "invalid anchor QID");
	}
}

function addCandidate(
	candidate: TargetCandidate | AnchorCandidate,
	kind: RejectedCandidate["kind"],
	state: CandidateState,
	trustedHosts: readonly string[],
	requiredTargets: number,
): void {
	const error = candidateError(candidate, kind, trustedHosts);
	if (error) return void state.rejected.push(error);
	const mbid = kind === "target" ? (candidate as TargetCandidate).mbid?.toLowerCase() : undefined;
	const qid = kind === "anchor" ? (candidate as AnchorCandidate).qid : undefined;
	if (
		state.slugs.has(candidate.slug) ||
		(mbid !== undefined && state.mbids.has(mbid)) ||
		(qid !== undefined && state.qids.has(qid))
	)
		return void state.rejected.push(reject(kind, candidate, "duplicate seed identity"));
	if (kind === "target" && state.targets.length === requiredTargets)
		return void state.rejected.push(reject(kind, candidate, "exceeds materialized deficit"));
	state.slugs.add(candidate.slug);
	if (mbid !== undefined) state.mbids.add(mbid);
	if (qid !== undefined) state.qids.add(qid);
	if (kind === "target") state.targets.push(candidate as TargetCandidate);
	else state.anchors.push(candidate as AnchorCandidate);
}

function proposalGenre(prescribed: PrescribedGenre): { slug: Slug; name: string; qid?: string } {
	return {
		slug: prescribed.slug,
		name: prescribed.name,
		...(prescribed.qid === undefined ? {} : { qid: prescribed.qid }),
	};
}

export function proposeGenreSeeds(
	taxonomy: GenreTaxonomy,
	coverage: GenreCoverageReport,
	candidates: Readonly<Record<string, ProposalCandidates>>,
	options: ProposalOptions,
): GenreSeedProposalReport {
	const selectedGenres = selectPrescribedGenres(options.requestedIds);
	const emptySeeds: GenreSeeds = Object.fromEntries(
		selectedGenres.map((prescribed) => [
			prescribed.id,
			{ genre: proposalGenre(prescribed), targets: [], anchors: [] },
		]),
	);
	validateGenreSeedProposalInputs({
		taxonomy,
		coverage,
		dossiers: emptySeeds,
		...(options.requestedIds === undefined ? {} : { requestedIds: options.requestedIds }),
	});
	const expectedIds = new Set(PRESCRIBED_GENRES.map(({ id }) => id));
	const missing = selectedGenres.filter(({ id }) => !Object.hasOwn(candidates, id)).map(({ id }) => id);
	const foreign = Object.keys(candidates).filter((id) => !expectedIds.has(id));
	if (missing.length > 0) throw new Error(`Missing prescribed candidates: ${missing.join(", ")}`);
	if (foreign.length > 0) throw new Error(`Foreign prescribed candidates: ${foreign.join(", ")}`);

	const entries: Record<string, GenreSeedProposal> = {};
	const seeds: GenreSeeds = {};
	for (const prescribed of selectedGenres) {
		const dossier = candidates[prescribed.id];
		const measured = coverage.entries[prescribed.id];
		if (!dossier || !measured) throw new Error(`Prescribed input disappeared: ${prescribed.id}`);
		const genre = proposalGenre(prescribed);
		const state: CandidateState = {
			slugs: new Set([genre.slug]),
			mbids: new Set(),
			qids: new Set(genre.qid === undefined ? [] : [genre.qid]),
			targets: [],
			anchors: [],
			rejected: [],
		};
		for (const candidate of dossier.targets)
			addCandidate(candidate, "target", state, options.trustedHosts, prescribed.deficit);
		for (const candidate of dossier.anchors)
			addCandidate(candidate, "anchor", state, options.trustedHosts, prescribed.deficit);
		const missingTargets = prescribed.deficit - state.targets.length;
		const missingAnchors = state.anchors.length === 0 ? 1 : 0;
		const promotable = missingTargets === 0 && missingAnchors === 0;
		entries[prescribed.id] = {
			requiredTargets: prescribed.deficit,
			acceptedTargets: state.targets,
			acceptedAnchors: state.anchors,
			rejected: state.rejected,
			missingTargets,
			missingAnchors,
			promotable,
			publishable: measured.publishable,
		};
		if (promotable)
			seeds[prescribed.id] = GenreSeedSchema.parse({
				genre,
				targets: state.targets.map(({ type, name, slug, mbid }) => ({
					type,
					name,
					slug,
					...(mbid === undefined ? {} : { mbid }),
				})),
				anchors: state.anchors.map(({ slug, name, qid }) => ({
					slug,
					name,
					...(qid === undefined ? {} : { qid }),
				})),
			});
	}
	return { entries, seeds: validateGenreSeeds(seeds, taxonomy.genres) };
}

function normalizedName(name: string): string {
	return name
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.trim()
		.toLowerCase();
}

function matchingCatalogResult(candidate: TargetCandidate, value: unknown): CatalogResult | undefined {
	if (value === null || typeof value !== "object") return undefined;
	const result = value as Partial<CatalogResult>;
	if (
		result.type !== candidate.type ||
		typeof result.name !== "string" ||
		typeof result.mbid !== "string" ||
		!MBID.test(result.mbid) ||
		normalizedName(result.name) !== normalizedName(candidate.name) ||
		(candidate.mbid !== undefined && result.mbid.toLowerCase() !== candidate.mbid.toLowerCase())
	)
		return undefined;
	return { type: result.type, name: result.name, mbid: result.mbid, subtitle: "" };
}

function musicBrainzProof({ type, mbid }: CatalogResult): Proof {
	const entity = type === "artist" ? "artist" : type === "project" ? "release-group" : "recording";
	return { url: `https://musicbrainz.org/${entity}/${mbid}`, verified: true };
}

const MUSICBRAINZ_REQUEST_INTERVAL_MS = 1_000;

function waitForMusicBrainzRequest(durationMs: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, durationMs));
}

export interface MusicBrainzResolutionOptions {
	wait?: (durationMs: number) => Promise<void>;
}

export async function resolveMusicBrainzCandidates(
	candidates: readonly TargetCandidate[],
	{ wait = waitForMusicBrainzRequest }: MusicBrainzResolutionOptions = {},
): Promise<TargetCandidate[]> {
	const catalog = createMusicBrainzCatalog();
	const resolved: TargetCandidate[] = [];
	let hasRequested = false;
	for (const candidate of candidates) {
		if (candidate.homonym) {
			resolved.push(candidate);
			continue;
		}
		if (hasRequested) await wait(MUSICBRAINZ_REQUEST_INTERVAL_MS);
		hasRequested = true;
		try {
			const matches = (await catalog.searchByType(candidate.type, candidate.name, 8))
				.map((result) => matchingCatalogResult(candidate, result))
				.filter((result): result is CatalogResult => result !== undefined);
			if (matches.length === 0) {
				resolved.push({ ...candidate, resolutionError: "MusicBrainz identity unresolved" });
				continue;
			}
			if (new Set(matches.map(({ mbid }) => mbid.toLowerCase())).size !== 1) {
				resolved.push({ ...candidate, resolutionError: "MusicBrainz identity ambiguous" });
				continue;
			}
			const hit = matches[0];
			if (!hit) {
				resolved.push({ ...candidate, resolutionError: "MusicBrainz identity unresolved" });
				continue;
			}
			const proof = musicBrainzProof(hit);
			resolved.push({
				...candidate,
				name: hit.name,
				mbid: hit.mbid,
				proofs: candidate.proofs.some(({ url }) => url === proof.url)
					? candidate.proofs
					: [...candidate.proofs, proof],
			});
		} catch {
			resolved.push({ ...candidate, resolutionError: "MusicBrainz lookup failed" });
		}
	}
	return resolved;
}

export async function proposeGenreSeedsFromMusicBrainz(
	taxonomy: GenreTaxonomy,
	coverage: GenreCoverageReport,
	candidates: Readonly<Record<string, ProposalCandidates>>,
	options: ProposalOptions,
	resolutionOptions?: MusicBrainzResolutionOptions,
): Promise<GenreSeedProposalReport> {
	const selectedIds = new Set(selectPrescribedGenres(options.requestedIds).map(({ id }) => id));
	const targeted = options.requestedIds !== undefined;
	const dossiers = Object.entries(candidates);
	const targets = dossiers.flatMap(([id, dossier]) =>
		targeted && !selectedIds.has(id) ? [] : dossier.targets,
	);
	const resolvedTargets = await resolveMusicBrainzCandidates(targets, resolutionOptions);
	const resolved: Record<string, ProposalCandidates> = {};
	let targetIndex = 0;
	for (const [id, dossier] of dossiers) {
		if (targeted && !selectedIds.has(id)) {
			resolved[id] = dossier;
			continue;
		}
		const nextTargetIndex = targetIndex + dossier.targets.length;
		resolved[id] = { ...dossier, targets: resolvedTargets.slice(targetIndex, nextTargetIndex) };
		targetIndex = nextTargetIndex;
	}
	return proposeGenreSeeds(taxonomy, coverage, resolved, options);
}
