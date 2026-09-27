import { router } from "expo-router";
import { useRef } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { useAnalytics } from "../analytics/provider";
import { rememberGenerationInput } from "../generation/store";
import type { NodeNavigationContext } from "../navigation/context";
import { nodeNavigationParams } from "../navigation/context";
import type { NodeEdgeRef } from "./NodeRelations";

type DetailsNode = {
	edges: Record<string, NodeEdgeRef | NodeEdgeRef[]>;
	facts: Record<string, string>;
	id: string;
};

type DetailProps = {
	navigationContext: NodeNavigationContext;
	node: DetailsNode;
};

const factLabels = [
	["founded", "Fondé en"],
	["location", "Localisation"],
	["founders", "Fondateurs"],
	["active_years", "Années d'activité"],
] as const;

const relationLabels = [
	["genres", "Genres"],
	["roster", "Artistes du catalogue"],
	["notable_releases", "Sorties notables"],
] as const;

type RelationGroup = {
	kind: string;
	label: string;
	relations: NodeEdgeRef[];
};

const PRESS_DEBOUNCE_MS = 750;

function edgeList(value: NodeEdgeRef | NodeEdgeRef[]): NodeEdgeRef[] {
	return Array.isArray(value) ? value : [value];
}

function readGroups(edges: DetailsNode["edges"]): RelationGroup[] {
	return relationLabels.flatMap(([kind, label]) => {
		const value = edges[kind];
		if (value === undefined) return [];
		const relations = edgeList(value);
		return relations.length === 0 ? [] : [{ kind, label, relations }];
	});
}

function readFacts(facts: DetailsNode["facts"]): Array<{ label: string; value: string }> {
	return factLabels.flatMap(([key, label]) => {
		const value = facts[key]?.trim();
		return value === undefined || value.length === 0 ? [] : [{ label, value }];
	});
}

export function LabelDetails({ navigationContext, node }: DetailProps) {
	const facts = readFacts(node.facts);
	const groups = readGroups(node.edges);

	if (facts.length === 0 && groups.length === 0) return null;

	return (
		<View style={styles.container}>
			{facts.length === 0 ? null : (
				<View>
					<Text accessibilityRole="header" allowFontScaling style={styles.heading}>
						Repères du label
					</Text>
					{facts.map(({ label, value }) => (
						<View key={label} style={styles.fact}>
							<Text allowFontScaling style={styles.factLabel}>
								{label}
							</Text>
							<Text allowFontScaling style={styles.factValue}>
								{value}
							</Text>
						</View>
					))}
				</View>
			)}
			<LocalizedRelations
				fromNodeId={node.id}
				navigationContext={navigationContext}
				groups={groups}
			/>
		</View>
	);
}

function LocalizedRelations({
	fromNodeId,
	groups,
	navigationContext,
}: {
	fromNodeId: string;
	groups: RelationGroup[];
	navigationContext: NodeNavigationContext;
}) {
	const analytics = useAnalytics();
	const lastPressed = useRef<{ key: string; at: number } | undefined>(undefined);

	if (groups.length === 0) return null;

	return (
		<View>
			<Text accessibilityRole="header" allowFontScaling style={styles.heading}>
				Explorer les relations du label
			</Text>
			{groups.map(({ kind, label, relations }) => (
				<View key={kind} style={styles.group}>
					<Text accessibilityRole="header" allowFontScaling style={styles.groupHeading}>
						{label}
					</Text>
					{relations.map((relation) => (
						<Pressable
							accessibilityLabel={`Ouvrir ${relation.name}`}
							accessibilityRole="button"
							key={`${kind}-${relation.slug}`}
							onPress={() => {
								const now = Date.now();
								const key = `${kind}-${relation.slug}`;
								if (
									lastPressed.current?.key === key &&
									lastPressed.current !== undefined &&
									now - lastPressed.current.at < PRESS_DEBOUNCE_MS
								)
									return;
								lastPressed.current = { key, at: now };
								rememberGenerationInput({
									type: relation.type,
									name: relation.name,
									slug: relation.slug,
									...(relation.mbid === undefined ? {} : { mbid: relation.mbid }),
									...(relation.qid === undefined ? {} : { qid: relation.qid }),
								});
								if (analytics.consent.status === "granted") {
									void analytics.trackEvent(
										"relation_opened",
										{
											from_node_id: fromNodeId,
											node_id: relation.slug,
											node_type: relation.type,
											relation_kind: kind,
											...(navigationContext.recommendation_id === undefined
												? {}
												: { recommendation_id: navigationContext.recommendation_id }),
											...(navigationContext.notification_id === undefined
												? {}
												: { notification_id: navigationContext.notification_id }),
										},
										{
											source: "relation",
											...(navigationContext.recommendation_id === undefined
												? {}
												: { recommendation_id: navigationContext.recommendation_id }),
											...(navigationContext.notification_id === undefined
												? {}
												: { notification_id: navigationContext.notification_id }),
										},
									);
								}
								router.push({
									pathname: "/node/[slug]",
									params: nodeNavigationParams(relation.slug, navigationContext),
								});
							}}
							style={styles.relation}
						>
							<Text allowFontScaling style={styles.relationName}>
								{relation.name}
							</Text>
							{relation.year !== undefined || relation.releaseType !== undefined ? (
								<Text allowFontScaling style={styles.relationMeta}>
									{[relation.year, relation.releaseType].filter((value) => value !== undefined).join(" · ")}
								</Text>
							) : null}
						</Pressable>
					))}
				</View>
			))}
		</View>
	);
}

const styles = StyleSheet.create({
	container: { marginTop: 4 },
	heading: { fontSize: 22, fontWeight: "700", lineHeight: 30, marginTop: 28, marginBottom: 12 },
	fact: { marginBottom: 12 },
	factLabel: { color: "#4d4d4d", fontSize: 15, fontWeight: "600", lineHeight: 22 },
	factValue: { fontSize: 17, lineHeight: 25, marginTop: 2 },
	group: { marginBottom: 16 },
	groupHeading: { fontSize: 18, fontWeight: "600", lineHeight: 25, marginBottom: 8 },
	relation: { borderColor: "#d0d0d0", borderRadius: 8, borderWidth: 1, marginBottom: 8, padding: 12 },
	relationName: { fontSize: 17, lineHeight: 24 },
	relationMeta: { color: "#4d4d4d", fontSize: 14, lineHeight: 20, marginTop: 4 },
});
