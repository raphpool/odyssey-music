import { StyleSheet, Text, View } from "react-native";

import type { NodeNavigationContext } from "../navigation/context";
import { NodeRelations, type NodeEdgeRef } from "./NodeRelations";

export type ArtistDetailsProps = {
	edges: Record<string, NodeEdgeRef | NodeEdgeRef[]>;
	facts: Record<string, string>;
	fromNodeId: string;
	navigationContext: NodeNavigationContext;
};

const factLabels = [
	["origin", "Origine"],
	["active_years", "Période d’activité"],
] as const;

function factEntries(facts: Record<string, string>): Array<readonly [string, string]> {
	return factLabels.flatMap(([key, label]) => {
		const value = facts[key]?.trim();
		return value === undefined || value === "" ? [] : [[label, value]];
	});
}

export function ArtistDetails({ edges, facts, fromNodeId, navigationContext }: ArtistDetailsProps) {
	const entries = factEntries(facts);

	return (
		<>
			{entries.length === 0 ? null : (
				<View>
					<Text accessibilityRole="header" allowFontScaling style={styles.heading}>
						Informations sur l’artiste
					</Text>
					{entries.map(([label, value]) => (
						<View key={label} style={styles.fact}>
							<Text allowFontScaling style={styles.label}>
								{label}
							</Text>
							<Text allowFontScaling style={styles.value}>
								{value}
							</Text>
						</View>
					))}
				</View>
			)}
			<NodeRelations edges={edges} fromNodeId={fromNodeId} navigationContext={navigationContext} />
		</>
	);
}

const styles = StyleSheet.create({
	heading: { fontSize: 22, fontWeight: "700", lineHeight: 30, marginTop: 28, marginBottom: 12 },
	fact: { marginBottom: 14 },
	label: { color: "#4d4d4d", fontSize: 15, fontWeight: "600", lineHeight: 21 },
	value: { fontSize: 17, lineHeight: 26, marginTop: 2 },
});
