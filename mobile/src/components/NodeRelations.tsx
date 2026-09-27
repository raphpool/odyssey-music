import { router } from "expo-router";
import { useRef } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { useAnalytics } from "../analytics/provider";
import type { NodeType } from "../api/contracts";
import { nodeNavigationParams, type NodeNavigationContext } from "../navigation/context";
import { rememberGenerationInput } from "../generation/store";

export type NodeEdgeRef = {
	slug: string;
	type: NodeType;
	name: string;
	mbid?: string | undefined;
	qid?: string | undefined;
	year?: string | undefined;
	releaseType?: "album" | "ep" | "single" | undefined;
};

type NodeRelationsProps = {
	edges: Record<string, NodeEdgeRef | NodeEdgeRef[]>;
	fromNodeId: string;
	navigationContext: NodeNavigationContext;
};

const PRESS_DEBOUNCE_MS = 750;

const relationLabels: Record<string, string> = {
	artists: "Artistes",
	projects: "Projets",
	tracks: "Titres",
	genres: "Genres",
	labels: "Labels",
};

function edgeList(value: NodeEdgeRef | NodeEdgeRef[]): NodeEdgeRef[] {
	return Array.isArray(value) ? value : [value];
}

function relationLabel(kind: string): string {
	return relationLabels[kind] ?? kind.replace(/[-_]+/g, " ");
}

export function NodeRelations({ edges, fromNodeId, navigationContext }: NodeRelationsProps) {
	const analytics = useAnalytics();
	const lastPressed = useRef<{ key: string; at: number } | undefined>(undefined);
	const groups = Object.entries(edges).flatMap(([kind, value]) => {
		const relations = edgeList(value);
		return relations.length === 0 ? [] : [{ kind, relations }];
	});

	if (groups.length === 0) return null;

	return (
		<View>
			<Text accessibilityRole="header" allowFontScaling style={styles.heading}>
				Explorer les relations
			</Text>
			{groups.map(({ kind, relations }) => (
				<View key={kind} style={styles.group}>
					<Text accessibilityRole="header" allowFontScaling style={styles.groupHeading}>
						{relationLabel(kind)}
					</Text>
					{relations.map((relation) => (
						<Pressable
							accessibilityLabel={`Ouvrir ${relation.name}`}
							accessibilityRole="button"
							key={`${kind}-${relation.slug}`}
							onPress={() => {
								const now = Date.now();
								if (
									lastPressed.current?.key === `${kind}-${relation.slug}` &&
									lastPressed.current !== undefined &&
									now - lastPressed.current.at < PRESS_DEBOUNCE_MS
								)
									return;
								lastPressed.current = { key: `${kind}-${relation.slug}`, at: now };
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
	heading: { fontSize: 22, fontWeight: "700", lineHeight: 30, marginTop: 28, marginBottom: 12 },
	group: { marginBottom: 16 },
	groupHeading: { fontSize: 18, fontWeight: "600", lineHeight: 25, marginBottom: 8 },
	relation: { borderColor: "#d0d0d0", borderRadius: 8, borderWidth: 1, marginBottom: 8, padding: 12 },
	relationName: { fontSize: 17, lineHeight: 24 },
	relationMeta: { color: "#4d4d4d", fontSize: 14, lineHeight: 20, marginTop: 4 },
});

export { relationLabel };
