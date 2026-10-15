import { createHash } from "node:crypto";
import {
	isMobileNodeType,
	MOBILE_CATALOG_MAX_IDENTITIES,
	MOBILE_CATALOG_MAX_IDENTITIES_BYTES,
	type MobileCatalogEdge,
	type MobileCatalogNode,
	type MobileCatalogResponse,
	type MobileCatalogTaxonomy,
	type MobileTaxonomyFamily,
	type MobileTaxonomyGenre,
} from "./contracts.js";

interface MobileCatalogDependencies {
	getGraph(): Promise<unknown>;
}

export interface MobileCatalog {
	getCatalog(identities?: readonly string[]): Promise<MobileCatalogResponse>;
}

type UnknownRecord = Record<string, unknown>;

// `--` is the canonical separator for an identity disambiguator (for example a
// homonymous artist) and is emitted by src/slug.ts. Keep it accepted here so a
// mobile projection cannot silently lose materialized nodes.
const IDENTITY_PATTERN =
	/^(artist|project|track|genre|label):[a-z0-9]+(?:-[a-z0-9]+)*(?:--[a-z0-9]+(?:-[a-z0-9]+)*)?$/;

export function createMobileCatalog(dependencies: MobileCatalogDependencies): MobileCatalog {
	return {
		async getCatalog(identities) {
			const projection = toCatalogProjection(await dependencies.getGraph());
			const requested = identities ? new Set(identities) : null;
			const nodes = requested
				? projection.nodes.filter((node) => requested.has(node.identity))
				: projection.nodes;
			const available = new Set(nodes.map((node) => node.identity));
			const edges = projection.edges.filter(
				(edge) => available.has(edge.source) && available.has(edge.target),
			);
			const base = {
				version: "v1" as const,
				taxonomy: projection.taxonomy,
				nodes,
				edges,
			};
			const revision = `sha256:${createHash("sha256").update(JSON.stringify(base)).digest("hex")}`;
			return { ...base, revision };
		},
	};
}

export function parseMobileIdentities(raw: string | null): string[] | undefined {
	if (raw === null || raw === "") return undefined;
	if (Buffer.byteLength(raw, "utf8") > MOBILE_CATALOG_MAX_IDENTITIES_BYTES) {
		throw new MobileCatalogInputError(
			`identities accepts at most ${MOBILE_CATALOG_MAX_IDENTITIES_BYTES} bytes`,
		);
	}
	const identities = raw.split(",");
	if (identities.length > MOBILE_CATALOG_MAX_IDENTITIES) {
		throw new MobileCatalogInputError(
			`identities accepts at most ${MOBILE_CATALOG_MAX_IDENTITIES} identities`,
		);
	}
	const unique = new Set<string>();
	for (const identity of identities) {
		validateMobileIdentity(identity);
		if (unique.has(identity)) throw new MobileCatalogInputError("identities must be unique");
		unique.add(identity);
	}
	return identities;
}

export class MobileCatalogInputError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "MobileCatalogInputError";
	}
}

function toCatalogProjection(value: unknown): Omit<MobileCatalogResponse, "revision" | "version"> {
	const graph = record(value);
	const nodes = array(graph.nodes)
		.map(toMobileNode)
		.filter((node): node is MobileCatalogNode => node !== null)
		.sort((left, right) => left.identity.localeCompare(right.identity));
	const visible = new Set(nodes.map((node) => node.identity));
	const edges = array(graph.edges)
		.map(toMobileEdge)
		.filter((edge): edge is MobileCatalogEdge => edge !== null)
		.filter((edge) => visible.has(edge.source) && visible.has(edge.target))
		.sort((left, right) =>
			`${left.source}\u0000${left.target}\u0000${left.type}`.localeCompare(
				`${right.source}\u0000${right.target}\u0000${right.type}`,
			),
		);

	return {
		taxonomy: toMobileTaxonomy(graph.taxonomy),
		nodes,
		edges,
	};
}

// Independent of the internal GenreTaxonomyProjection type (plan D1): copied field by field from `unknown`,
// so `qid` and extra fields never reach a client. `order` must be an integer (the iOS decoder reads an Int).
function toMobileTaxonomy(value: unknown): MobileCatalogTaxonomy {
	const degraded = { mode: "degraded", available: false } as const;
	if (!isRecord(value) || value.version !== 2) return degraded;
	const families = mapAll(value.families, toTaxonomyFamily);
	const genres = mapAll(value.genres, toTaxonomyGenre);
	const legacySelectionBySlug = toSelectionTable(value.legacySelectionBySlug);
	if (!families || !genres || !legacySelectionBySlug) return degraded;
	return { mode: "editorial", version: 2, families, genres, legacySelectionBySlug };
}

function toTaxonomyFamily(value: unknown): MobileTaxonomyFamily | null {
	if (!isRecord(value)) return null;
	const { key, label, order, slug } = value;
	if (typeof key !== "string" || typeof label !== "string") return null;
	if (typeof order !== "number" || !Number.isInteger(order)) return null;
	if (slug === undefined) return { key, label, order };
	return isGenreSlug(slug) ? { key, label, order, slug } : null;
}

function toTaxonomyGenre(value: unknown): MobileTaxonomyGenre | null {
	if (!isRecord(value)) return null;
	const { id, name, family, slugs } = value;
	if (typeof id !== "string" || typeof name !== "string" || typeof family !== "string") return null;
	if (!Array.isArray(slugs) || !slugs.every(isGenreSlug)) return null;
	return { id, name, family, slugs: [...slugs] };
}

function toSelectionTable(value: unknown): Record<string, string[]> | null {
	if (!isRecord(value)) return null;
	const table: Record<string, string[]> = {};
	for (const [slug, ids] of Object.entries(value)) {
		if (!isGenreSlug(slug) || !Array.isArray(ids) || !ids.every((id) => typeof id === "string")) return null;
		table[slug] = [...ids];
	}
	return table;
}

function mapAll<T>(value: unknown, convert: (item: unknown) => T | null): T[] | null {
	if (!Array.isArray(value)) return null;
	const items: T[] = [];
	for (const entry of value) {
		const item = convert(entry);
		if (item === null) return null;
		items.push(item);
	}
	return items;
}

function isGenreSlug(value: unknown): value is string {
	return typeof value === "string" && value.startsWith("genre:") && isValidMobileIdentity(value);
}

function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toMobileNode(value: unknown): MobileCatalogNode | null {
	const node = record(value);
	const identity = string(node.id);
	const type = string(node.type);
	const name = string(node.name);
	if (!identity || !type || !name || !isMobileNodeType(type) || !isValidMobileIdentity(identity)) return null;
	if (!identity.startsWith(`${type}:`)) return null;
	return { identity, type, name, teaser: optionalString(node.teaser) };
}

function toMobileEdge(value: unknown): MobileCatalogEdge | null {
	const edge = record(value);
	const source = string(edge.source) ?? string(edge.from);
	const target = string(edge.target) ?? string(edge.to);
	if (!source || !target || !isValidMobileIdentity(source) || !isValidMobileIdentity(target)) return null;
	const type =
		optionalString(edge.type) ?? optionalString(edge.kind) ?? optionalString(edge.relation) ?? "related";
	return { source, target, type };
}

function validateMobileIdentity(identity: string): void {
	const separator = identity.indexOf(":");
	if (separator <= 0) throw new MobileCatalogInputError("invalid identity");
	const type = identity.slice(0, separator);
	if (!isMobileNodeType(type)) throw new MobileCatalogInputError("unsupported identity type");
	if (!isValidMobileIdentity(identity)) throw new MobileCatalogInputError("invalid identity");
}

function isValidMobileIdentity(value: string): boolean {
	return IDENTITY_PATTERN.test(value);
}

function record(value: unknown): UnknownRecord {
	return isRecord(value) ? value : {};
}

function array(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function string(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function optionalString(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}
