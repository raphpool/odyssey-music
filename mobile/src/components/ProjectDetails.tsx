import { StyleSheet, Text, View } from "react-native";

import type { NodeNavigationContext } from "../navigation/context";
import { NodeRelations, type NodeEdgeRef } from "./NodeRelations";

export type ProjectDetailsProps = {
	edges: Record<string, NodeEdgeRef | NodeEdgeRef[]>;
	facts: Record<string, string>;
	fromNodeId: string;
	navigationContext: NodeNavigationContext;
};

const factLabels = [
	["year", "Année"],
	["bpm", "BPM"],
	["musical_key", "Tonalité"],
	["vocals", "Voix"],
	["samples_notes", "Samples"],
	["inspirations", "Inspirations"],
] as const;

const releaseTypeLabels: Record<string, string> = {
	album: "Album",
	ep: "EP",
	single: "Single",
};

function factEntries(facts: Record<string, string>): Array<readonly [string, string]> {
	return factLabels.flatMap(([key, label]) => {
		const value = facts[key]?.trim();
		return value === undefined || value === "" ? [] : [[label, value]];
	});
}

function releaseTypeLabel(value: string | undefined): string {
	const normalized = value?.trim().toLowerCase();
	return normalized === undefined ? "Projet" : (releaseTypeLabels[normalized] ?? "Projet");
}

export function ProjectDetails({ edges, facts, fromNodeId, navigationContext }: ProjectDetailsProps) {
	const entries = factEntries(facts);

	return (
		<>
			<Text accessibilityRole="header" allowFontScaling style={styles.releaseType}>
				{releaseTypeLabel(facts.release_type)}
			</Text>
			{entries.length === 0 ? null : (
				<View>
					<Text accessibilityRole="header" allowFontScaling style={styles.heading}>
						Détails du projet
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
	releaseType: { fontSize: 20, fontWeight: "700", lineHeight: 28, marginTop: 12 },
	heading: { fontSize: 22, fontWeight: "700", lineHeight: 30, marginTop: 28, marginBottom: 12 },
	fact: { marginBottom: 14 },
	label: { color: "#4d4d4d", fontSize: 15, fontWeight: "600", lineHeight: 21 },
	value: { fontSize: 17, lineHeight: 26, marginTop: 2 },
});
