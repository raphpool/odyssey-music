import type { Catalog } from "../api/contracts";

type RecommendableNode = Omit<Catalog["nodes"][number], "type"> & {
	type: "artist" | "project" | "track";
};

export type AffinityCandidate = {
	node: RecommendableNode;
	score: number;
	reasons: string[];
};

type MutableCandidate = {
	node: RecommendableNode;
	score: number;
	reasons: Set<string>;
	contributions: Set<string>;
};

const curatedWeights: Record<string, { weight: number; label: string }> = {
	key_artists: { weight: 3, label: "Artiste clé" },
	landmark_projects: { weight: 4, label: "Projet repère" },
	landmark_tracks: { weight: 4, label: "Morceau repère" },
};

function isRecommendable(node: Catalog["nodes"][number] | undefined): node is RecommendableNode {
	return node?.type === "artist" || node?.type === "project" || node?.type === "track";
}

/**
 * Scores only musical works locally. Catalog edges are untrusted API data, so missing or incoherent
 * identities never become recommendations.
 */
export function rankAffinity(catalog: Catalog, genreIds: readonly string[]): AffinityCandidate[] {
	const nodes = new Map(catalog.nodes.map((node) => [node.identity, node]));
	const selected = [...new Set(genreIds)].filter((identity) => nodes.get(identity)?.type === "genre");
	const candidates = new Map<string, MutableCandidate>();

	const add = (nodeId: string, contribution: string, weight: number, reason: string): void => {
		const node = nodes.get(nodeId);
		if (!isRecommendable(node)) return;
		const current = candidates.get(nodeId) ?? {
			node,
			score: 0,
			reasons: new Set<string>(),
			contributions: new Set<string>(),
		};
		if (current.contributions.has(contribution)) return;
		current.contributions.add(contribution);
		current.score += weight;
		current.reasons.add(reason);
		candidates.set(nodeId, current);
	};

	const selectedNames = new Map(
		selected.map((identity) => [identity, nodes.get(identity)?.name ?? identity]),
	);
	const nearby = new Map<string, Array<{ selectedId: string; relation: string }>>();
	for (const edge of catalog.edges) {
		if (!selected.includes(edge.source) || (edge.type !== "subgenres" && edge.type !== "related_genres"))
			continue;
		if (nodes.get(edge.target)?.type !== "genre") continue;
		const entries = nearby.get(edge.target) ?? [];
		if (!entries.some((entry) => entry.selectedId === edge.source && entry.relation === edge.type)) {
			entries.push({ selectedId: edge.source, relation: edge.type });
			nearby.set(edge.target, entries);
		}
	}

	for (const edge of catalog.edges) {
		const name = selectedNames.get(edge.source);
		const curated = curatedWeights[edge.type];
		if (name !== undefined && curated !== undefined) {
			add(edge.target, `curated:${edge.source}:${edge.type}`, curated.weight, `${curated.label} d’${name}`);
		}
		if (edge.type !== "genres") continue;
		const directName = selectedNames.get(edge.target);
		if (directName !== undefined) add(edge.source, `direct:${edge.target}`, 3, `Lié à ${directName}`);
		for (const near of nearby.get(edge.target) ?? []) {
			const selectedName = selectedNames.get(near.selectedId);
			if (selectedName !== undefined)
				add(
					edge.source,
					`near:${near.selectedId}:${near.relation}:${edge.target}`,
					1,
					`Proche de ${selectedName}`,
				);
		}
	}

	return [...candidates.values()]
		.filter((candidate) => candidate.score > 0)
		.map((candidate) => ({
			node: candidate.node,
			score: candidate.score,
			reasons: [...candidate.reasons].sort((left, right) => left.localeCompare(right, "fr")),
		}))
		.sort(
			(left, right) =>
				right.score - left.score ||
				(left.node.identity < right.node.identity ? -1 : left.node.identity > right.node.identity ? 1 : 0),
		)
		.slice(0, 60);
}
