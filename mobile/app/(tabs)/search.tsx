import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { AppState, Button, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useAnalytics } from "../../src/analytics/provider";
import { type ApiClient, createApiClient } from "../../src/api/client";
import type { SearchResponse } from "../../src/api/contracts";
import { CatalogCache, searchCachedCatalog } from "../../src/cache/catalog";
import { NodeCache } from "../../src/cache/nodes";
import { RequestState } from "../../src/components/RequestState";
import { SearchResults } from "../../src/components/SearchResults";
import { readPublicConfig } from "../../src/config";
import { nodeNavigationParams } from "../../src/navigation/context";
import {
	normalizeSearchQuery,
	resultAvailability,
	SEARCH_DEBOUNCE_MS,
	SEARCH_FILTERS,
	SEARCH_LIMIT,
	SEARCH_MAX_QUERY_LENGTH,
	type SearchFilter,
	type SearchResult,
	searchKey,
	searchQueryState,
	searchType,
} from "../../src/search/model";

const FILTER_LABELS: Record<SearchFilter, string> = {
	all: "Tout",
	artist: "Artistes",
	project: "Projets",
	track: "Titres",
	genre: "Genres",
	label: "Labels",
};

type SearchStatus = "idle" | "loading" | "success" | "empty" | "error";

export type SearchScreenProps = {
	apiClient?: ApiClient;
};

function configuredApiClient(): ApiClient | undefined {
	try {
		const config = readPublicConfig();
		return config.ok ? createApiClient({ config: config.value }) : undefined;
	} catch {
		return undefined;
	}
}

function trackEventSafely(
	analytics: ReturnType<typeof useAnalytics>,
	name: "search_submitted" | "search_result_opened",
	properties: Record<string, string | number>,
): void {
	if (analytics.consent.status !== "granted") return;
	void analytics.trackEvent(name, properties, { source: "search" }).catch(() => undefined);
}

export default function SearchScreen({ apiClient: providedApiClient }: SearchScreenProps = {}) {
	const params = useLocalSearchParams<{ q?: string | string[] }>();
	const routeQuery = Array.isArray(params.q) ? params.q[0] : params.q;
	const analytics = useAnalytics();
	const analyticsRef = useRef(analytics);
	analyticsRef.current = analytics;
	const apiClient = useMemo(() => providedApiClient ?? configuredApiClient(), [providedApiClient]);
	const catalogCache = useMemo(() => new CatalogCache(), []);
	const nodeCache = useMemo(() => new NodeCache(), []);
	const [query, setQuery] = useState("");
	const [filter, setFilter] = useState<SearchFilter>("all");
	const [response, setResponse] = useState<SearchResponse | undefined>();
	const [requestKey, setRequestKey] = useState("");
	const [responseKey, setResponseKey] = useState("");
	const [error, setError] = useState<string | undefined>();
	const [status, setStatus] = useState<SearchStatus>("idle");
	const [retryToken, setRetryToken] = useState(0);
	const [missingResult, setMissingResult] = useState<SearchResult | undefined>();
	const [offline, setOffline] = useState(false);
	const requestSequence = useRef(0);
	const offlineKey = useRef<string | undefined>(undefined);
	const appliedRouteQuery = useRef<string | undefined>(undefined);
	const normalizedQuery = normalizeSearchQuery(query);
	const queryState = searchQueryState(normalizedQuery);
	const currentKey = searchKey(normalizedQuery, filter);

	useEffect(() => {
		if (routeQuery === undefined || routeQuery === appliedRouteQuery.current) return;
		appliedRouteQuery.current = routeQuery;
		setQuery(routeQuery.slice(0, SEARCH_MAX_QUERY_LENGTH + 1));
	}, [routeQuery]);

	useEffect(() => {
		const sequence = ++requestSequence.current;
		let active = true;
		const isCurrent = () => active && requestSequence.current === sequence;

		setResponse(undefined);
		setRequestKey(currentKey);
		setResponseKey("");
		setMissingResult(undefined);

		if (queryState !== "admissible") {
			setStatus("idle");
			return () => {
				active = false;
			};
		}

		if (apiClient === undefined) {
			setError("La recherche est indisponible pour le moment.");
			setStatus("error");
			return () => {
				active = false;
			};
		}

		const applyLocalSearch = async (): Promise<void> => {
			const catalog = await catalogCache.cached();
			if (!isCurrent()) return;
			if (catalog === undefined) {
				setError("La recherche n’a pas pu aboutir.");
				setStatus("error");
				return;
			}
			const hits = searchCachedCatalog(
				catalog,
				normalizedQuery,
				requestType,
				new Set(await nodeCache.identities()),
			);
			if (!isCurrent()) return;
			setError(undefined);
			setResponse({
				q: normalizedQuery,
				hits,
				sources: {
					cache: hits.filter((hit) => hit.source === "cache").length,
					catalog: hits.filter((hit) => hit.source === "catalog").length,
				},
			});
			setResponseKey(currentKey);
			setStatus(hits.length === 0 ? "empty" : "success");
		};

		const requestType = searchType(filter);
		if (offlineKey.current === currentKey) {
			void applyLocalSearch();
			return () => {
				active = false;
			};
		}

		if (retryToken > 0) setError(undefined);
		setStatus("loading");
		const controller = new AbortController();
		const timeout = setTimeout(() => {
			trackEventSafely(analyticsRef.current, "search_submitted", { filter });
			void apiClient
				.search({
					q: normalizedQuery,
					limit: SEARCH_LIMIT,
					...(requestType === undefined ? {} : { type: requestType }),
					signal: controller.signal,
				})
				.then((result) => {
					if (!isCurrent()) return;
					if (result.kind === "success") {
						offlineKey.current = undefined;
						setOffline(false);
						setError(undefined);
						setResponse(result.value);
						setResponseKey(currentKey);
						setStatus(result.value.hits.length === 0 ? "empty" : "success");
						return;
					}
					if (result.error.kind === "cancelled") return;
					if (result.error.kind === "network_error" || result.error.kind === "timeout") {
						offlineKey.current = currentKey;
						setOffline(true);
						void applyLocalSearch();
						return;
					}
					setError("La recherche n’a pas pu aboutir.");
					setStatus("error");
				})
				.catch(() => {
					if (!isCurrent()) return;
					setError("La recherche n’a pas pu aboutir.");
					setStatus("error");
				});
		}, SEARCH_DEBOUNCE_MS);

		return () => {
			active = false;
			clearTimeout(timeout);
			controller.abort();
		};
	}, [apiClient, catalogCache, currentKey, filter, nodeCache, normalizedQuery, queryState, retryToken]);

	useEffect(() => {
		const subscription = AppState.addEventListener("change", (next) => {
			if (next === "active") {
				offlineKey.current = undefined;
				setOffline(false);
				setRetryToken((token) => token + 1);
			}
		});
		return () => subscription.remove();
	}, []);

	const recordResultOpened = (result: SearchResult) => {
		trackEventSafely(analyticsRef.current, "search_result_opened", {
			node_type: result.type,
			availability: resultAvailability(result),
			results_count: response?.hits.length ?? 0,
			...(result.slug === undefined ? {} : { node_id: result.slug }),
		});
	};

	const openCachedResult = (result: SearchResult) => {
		recordResultOpened(result);
		if (result.slug !== undefined)
			router.push({
				pathname: "/node/[slug]",
				params: nodeNavigationParams(result.slug, { source: "search" }),
			});
	};

	const currentRequest = requestKey === currentKey;
	const visibleResponse = currentRequest && responseKey === currentKey ? response : undefined;
	const visibleStatus = queryState === "admissible" ? (currentRequest ? status : "loading") : "idle";

	return (
		<SafeAreaView style={styles.safeArea}>
			<ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
				<Text accessibilityRole="header" allowFontScaling style={styles.title}>
					Recherche
				</Text>
				<TextInput
					accessibilityLabel="Rechercher dans Odyssey"
					allowFontScaling
					autoCapitalize="none"
					autoCorrect={false}
					placeholder="Rechercher un artiste ou une œuvre"
					returnKeyType="search"
					value={query}
					maxLength={SEARCH_MAX_QUERY_LENGTH + 1}
					onChangeText={setQuery}
					style={styles.input}
				/>
				<Text allowFontScaling style={styles.counter}>
					{normalizedQuery.length}/{SEARCH_MAX_QUERY_LENGTH}
				</Text>
				<ScrollView
					accessibilityLabel="Filtrer les résultats"
					horizontal
					showsHorizontalScrollIndicator={false}
					contentContainerStyle={styles.filters}
				>
					{SEARCH_FILTERS.map((candidate) => {
						const selected = candidate === filter;
						return (
							<Pressable
								accessibilityRole="button"
								accessibilityState={{ selected }}
								key={candidate}
								onPress={() => setFilter(candidate)}
								style={[styles.filter, selected && styles.selectedFilter]}
							>
								<Text allowFontScaling style={[styles.filterText, selected && styles.selectedFilterText]}>
									{FILTER_LABELS[candidate]}
								</Text>
							</Pressable>
						);
					})}
				</ScrollView>

				<SearchResults
					queryState={queryState}
					status={visibleStatus}
					{...(error === undefined ? {} : { error })}
					{...(visibleResponse === undefined ? {} : { response: visibleResponse })}
					onRetry={() => {
						offlineKey.current = undefined;
						setOffline(false);
						setRetryToken((token) => token + 1);
					}}
					onOpenCached={openCachedResult}
					onOpenMissing={(result) => {
						recordResultOpened(result);
						setMissingResult(result);
					}}
					generationSuspended={offline}
				/>
				{offline ? <RequestState kind="offline" /> : null}

				{missingResult !== undefined ? (
					<View style={styles.missingState}>
						<Text accessibilityRole="alert" allowFontScaling style={styles.missingTitle}>
							Fiche à créer
						</Text>
						<Text allowFontScaling>
							{missingResult.name} · {FILTER_LABELS[missingResult.type]}
						</Text>
						<Text allowFontScaling style={styles.missingText}>
							Cette fiche n’est pas encore disponible. Sa création sera proposée explicitement dans une
							prochaine étape.
						</Text>
						<Button title="Fermer" onPress={() => setMissingResult(undefined)} />
					</View>
				) : null}
			</ScrollView>
		</SafeAreaView>
	);
}

const styles = StyleSheet.create({
	content: { padding: 24 },
	counter: { color: "#555555", fontSize: 13, marginTop: 6, textAlign: "right" },
	filter: {
		borderColor: "#767676",
		borderRadius: 18,
		borderWidth: 1,
		marginRight: 8,
		paddingHorizontal: 14,
		paddingVertical: 9,
	},
	filterText: { fontSize: 15 },
	filters: { paddingVertical: 16 },
	input: {
		borderColor: "#767676",
		borderRadius: 8,
		borderWidth: 1,
		fontSize: 18,
		minHeight: 48,
		paddingHorizontal: 12,
	},
	missingState: {
		borderColor: "#767676",
		borderRadius: 8,
		borderWidth: 1,
		gap: 8,
		marginTop: 20,
		padding: 16,
	},
	missingText: { lineHeight: 22 },
	missingTitle: { fontSize: 20, fontWeight: "700" },
	safeArea: { backgroundColor: "#ffffff", flex: 1 },
	selectedFilter: { backgroundColor: "#202020", borderColor: "#202020" },
	selectedFilterText: { color: "#ffffff" },
	title: { fontSize: 32, fontWeight: "700", lineHeight: 40, marginBottom: 24 },
});
