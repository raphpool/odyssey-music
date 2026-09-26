import { createHash } from "node:crypto";
import {
	isMobileNodeType,
	MOBILE_CATALOG_MAX_IDENTITIES,
	MOBILE_CATALOG_MAX_IDENTITIES_BYTES,
	type MobileCatalogEdge,
	type MobileCatalogNode,
	type MobileCatalogResponse,
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
		taxonomy: { mode: "degraded", available: graph.taxonomy !== undefined && graph.taxonomy !== null },
		nodes,
		edges,
	};
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
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as UnknownRecord) : {};
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
