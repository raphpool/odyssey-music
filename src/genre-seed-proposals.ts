import type { GenreCoverageReport } from "./genre-coverage.js";
import { type GenreSeeds, validateGenreSeeds } from "./genre-seeds.js";
import type { GenreTaxonomy } from "./genre-taxonomy.js";
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
		slug: id === "Q2913982" ? "genre:trap-hip-hop" : (sourceSlugs[0] ?? makeSlug("genre", localName)),
		sourceSlugs,
		existingNeighbours,
		deficit,
		creations: deficit + (source === undefined ? 1 : 0),
	};
}

export const PRESCRIBED_GENRES: readonly PrescribedGenre[] = [
	prescribed("B4a", 312, "Q486263", "Bossa Nova"),
	prescribed("B4a", 318, "Q723418", "Cumbia"),
	prescribed("B4a", 343, "Q208239", "Salsa"),
	prescribed("B4a", 344, "Q11403", "Samba"),
	prescribed("B4a", 346, "Q14390274", "Tango"),
	prescribed("B4a", 378, "Q388296", "Afrobeat"),
	prescribed("B4a", 395, "local:ethiopian-jazz", "Ethiopian Jazz"),
	prescribed("B4a", 402, "Q2000173", "Gnawa"),
	prescribed("B4a", 408, "Q963061", "Highlife", "genre:highlife", 1),
	prescribed("B4a", 444, "Q1752683", "Soukous"),
	prescribed("B4a", 460, "local:bollywood", "Bollywood"),
	prescribed("B4a", 468, "Q11307326", "City Pop"),
	prescribed("B4a", 472, "Q194492", "Gamelan"),
	prescribed("B4a", 478, "Q131578", "J-Pop"),
	prescribed("B4a", 481, "Q213665", "K-Pop"),
	prescribed("B4b", 276, "Q4942839", "Boogie"),
	prescribed("B4b", 278, "local:classic-disco", "Classic Disco"),
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
	prescribed("B4e", 6, "local:balearic-house", "Balearic House"),
	prescribed("B4e", 7, "Q65937774", "Breaks"),
	prescribed("B4e", 8, "Q2406633", "Broken Beat"),
	prescribed("B4e", 16, "local:euro-house", "Euro House"),
	prescribed("B4e", 17, "Q216961", "Eurodance", "genre:eurodance", 2),
	prescribed("B4e", 19, "Q820049", "Gabber"),
	prescribed("B4e", 21, "Q2748817", "Ghetto House"),
	prescribed("B4e", 22, "Q1521688", "Ghettotech"),
	prescribed("B4e", 23, "Q339906", "Happy Hardcore"),
	prescribed("B4e", 24, "Q223840", "Hardstyle"),
	prescribed("B4e", 25, "Q601235", "Hip-House"),
	prescribed("B4e", 28, "Q105636940", "Leftfield House"),
	prescribed("B4e", 29, "local:leftfield-techno", "Leftfield Techno"),
	prescribed("B4e", 30, "Q3048168", "Makina"),
	prescribed("B4f", 238, "Q438503", "Alternative hip-hop", "genre:alternative-hip-hop", 1),
	prescribed("B4f", 240, "Q529742", "Boom bap", "genre:boom-bap", 1),
	prescribed("B4f", 241, "local:chopped-n-screwed", "Chopped N Screwed"),
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
	prescribed("B4f", 255, "local:memphis", "Memphis"),
	prescribed("B4f", 256, "Q6918602", "Motswako"),
	prescribed("B4f", 257, "Q840065", "New Jack Swing"),
	prescribed("B4f", 258, "local:rap", "Rap"),
	prescribed("B4f", 260, "local:rnb", "RnB"),
];

export interface GenreSeedProposalInputs {
	taxonomy: GenreTaxonomy;
	coverage: GenreCoverageReport;
	dossiers: GenreSeeds;
}

export function validateGenreSeedProposalInputs({
	taxonomy,
	coverage,
	dossiers,
}: GenreSeedProposalInputs): void {
	const prescribedIds = new Set(PRESCRIBED_GENRES.map(({ id }) => id));
	const missing = PRESCRIBED_GENRES.filter(({ id }) => !Object.hasOwn(dossiers, id)).map(({ id }) => id);
	const foreign = Object.keys(dossiers).filter((id) => !prescribedIds.has(id));
	if (missing.length > 0) throw new Error(`Missing prescribed dossiers: ${missing.join(", ")}`);
	if (foreign.length > 0) throw new Error(`Foreign prescribed dossiers: ${foreign.join(", ")}`);
	validateGenreSeeds(dossiers, taxonomy.genres);

	const entries = new Map(taxonomy.genres.map((entry) => [entry.id, entry]));
	for (const prescribed of PRESCRIBED_GENRES) {
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
