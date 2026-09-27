import { ActivityIndicator, Button, Pressable, StyleSheet, Text, View } from "react-native";

import {
	resultAvailability,
	resultKey,
	type SearchQueryState,
	type SearchResult,
} from "../search/model";
import type { SearchResponse } from "../api/contracts";

export type SearchResultsStatus = "idle" | "loading" | "success" | "empty" | "error";

export type SearchResultsProps = {
	status: SearchResultsStatus;
	queryState: SearchQueryState;
	response?: SearchResponse;
	error?: string;
	onRetry(): void;
	onOpenCached(result: SearchResult): void;
	onOpenMissing(result: SearchResult): void;
};

const TYPE_LABELS: Record<SearchResult["type"], string> = {
	artist: "Artiste",
	project: "Projet",
	track: "Titre",
	genre: "Genre",
	label: "Label",
};

function sourceLabel(result: SearchResult): string {
	return result.source === "cache" ? "Fiche disponible · source cache" : "Fiche à créer · source catalogue";
}

function queryHelp(queryState: SearchQueryState): string | undefined {
	if (queryState === "empty") return "Saisissez au moins 2 caractères pour lancer une recherche.";
	if (queryState === "too_short") return "Saisissez au moins 2 caractères pour lancer une recherche.";
	if (queryState === "too_long") return "La recherche doit contenir au maximum 120 caractères.";
	return undefined;
}

export function SearchResults({
	status,
	queryState,
	response,
	error,
	onRetry,
	onOpenCached,
	onOpenMissing,
}: SearchResultsProps) {
	const help = queryHelp(queryState);
	if (help !== undefined) {
		return (
			<Text allowFontScaling style={styles.hint}>
				{help}
			</Text>
		);
	}

	if (status === "loading") {
		return (
			<View accessibilityLabel="Recherche en cours" accessibilityRole="progressbar" style={styles.feedback}>
				<ActivityIndicator />
				<Text allowFontScaling>Recherche en cours…</Text>
			</View>
		);
	}

	if (status === "error") {
		return (
			<View style={styles.feedback}>
				<Text accessibilityRole="alert" allowFontScaling style={styles.error}>
					{error ?? "La recherche n’a pas pu aboutir."}
				</Text>
				<Button accessibilityLabel="Réessayer la recherche" title="Réessayer" onPress={onRetry} />
			</View>
		);
	}

	if (status === "empty") {
		return (
			<Text allowFontScaling style={styles.hint}>
				Aucun résultat.
			</Text>
		);
	}

	if (status !== "success" || response === undefined) return null;

	return (
		<View accessibilityLabel="Résultats de recherche" style={styles.results}>
			<Text allowFontScaling style={styles.resultSummary}>
				{response.hits.length} résultat{response.hits.length > 1 ? "s" : ""} · {response.sources.cache} cache
				{response.sources.cache > 1 ? "s" : ""} · {response.sources.catalog} catalogue
				{response.sources.catalog > 1 ? "s" : ""}
			</Text>
			{response.hits.map((result, index) => (
				<Pressable
					accessibilityHint={
						result.source === "cache" ? "Ouvre la fiche disponible." : "Affiche l’état de la fiche à créer."
					}
					accessibilityLabel={`${result.name}, ${sourceLabel(result)}`}
					accessibilityRole="button"
					key={resultKey(result, index)}
					onPress={() =>
						resultAvailability(result) === "cached" ? onOpenCached(result) : onOpenMissing(result)
					}
					style={styles.result}
				>
					<View style={styles.resultHeading}>
						<Text allowFontScaling style={styles.resultName}>
							{result.name}
						</Text>
						<Text allowFontScaling style={styles.resultType}>
							{TYPE_LABELS[result.type]}
						</Text>
					</View>
					{result.subtitle !== undefined ? <Text allowFontScaling>{result.subtitle}</Text> : null}
					{result.extra !== undefined ? <Text allowFontScaling>{result.extra}</Text> : null}
					<Text allowFontScaling style={styles.source}>
						{sourceLabel(result)}
					</Text>
				</Pressable>
			))}
		</View>
	);
}

const styles = StyleSheet.create({
	error: { color: "#9c1c1c", marginBottom: 12, textAlign: "center" },
	feedback: { alignItems: "center", gap: 8, marginTop: 24 },
	hint: { color: "#444444", lineHeight: 22, marginTop: 16 },
	result: { borderBottomColor: "#d5d5d5", borderBottomWidth: 1, paddingVertical: 16 },
	resultHeading: { alignItems: "center", flexDirection: "row", gap: 12, justifyContent: "space-between" },
	resultName: { flex: 1, fontSize: 18, fontWeight: "600" },
	resultSummary: { color: "#444444", marginBottom: 4 },
	resultType: { color: "#444444", fontSize: 14 },
	results: { marginTop: 12 },
	source: { color: "#555555", fontSize: 14, marginTop: 6 },
});
