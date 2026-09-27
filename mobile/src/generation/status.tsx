import { useEffect, useMemo, useRef, useState } from "react";
import { AppState, Button, StyleSheet, Text, View } from "react-native";

import { type AnalyticsSource } from "../analytics/contracts";
import { useAnalytics } from "../analytics/provider";
import { type ApiClient, createApiClient } from "../api/client";
import { CatalogCache } from "../cache/catalog";
import { readPublicConfig } from "../config";
import {
	createGenerationController,
	type GenerationApi,
	type GenerationRequestController,
	type GenerationViewState,
} from "./request";
import type { GenerationInput, GenerationStore } from "./store";

export type GenerationStatusProps = {
	input: GenerationInput;
	source: AnalyticsSource;
	apiClient?: GenerationApi;
	store?: GenerationStore;
	onOpenNode?: (nodeId: string) => void;
};

function configuredApiClient(): ApiClient | undefined {
	try {
		const config = readPublicConfig();
		return config.ok ? createApiClient({ config: config.value }) : undefined;
	} catch {
		return undefined;
	}
}

function statusLabel(state: GenerationViewState): string | undefined {
	if (state.message !== undefined) return state.message;
	if (state.phase === "confirming" || state.phase === "unknown")
		return "Statut à confirmer : votre demande n’a pas été déclarée comme échouée.";
	if (state.phase === "expired") return "Cette demande a expiré. Vous pouvez lancer une nouvelle action.";
	if (state.phase === "interrupted") return "La création a été interrompue. Vous pouvez réessayer explicitement.";
	if (state.phase === "failed") return "La fiche n’a pas pu être créée. Vous pouvez réessayer explicitement.";
	return undefined;
}

function useController(
	apiClient: GenerationApi | undefined,
	store: GenerationStore | undefined,
	source: AnalyticsSource,
	analyticsRef: React.MutableRefObject<ReturnType<typeof useAnalytics>>,
	inputKey: string,
	analyticsEnabled: boolean,
): GenerationRequestController | undefined {
	return useMemo(() => {
		if (apiClient === undefined) return undefined;
		return createGenerationController({
			apiClient,
			...(store === undefined ? {} : { store }),
			source,
			...(analyticsEnabled
				? { trackEvent: (name: unknown, properties: unknown, context: Parameters<ReturnType<typeof useAnalytics>["trackEvent"]>[2]) => analyticsRef.current.trackEvent(name, properties, context) }
				: {}),
		});
	}, [analyticsEnabled, analyticsRef, apiClient, inputKey, source, store]);
}

export function GenerationStatus({ input, source, apiClient, store, onOpenNode }: GenerationStatusProps) {
	const analytics = useAnalytics();
	const analyticsRef = useRef(analytics);
	analyticsRef.current = analytics;
	const resolvedApiClient = useMemo(() => apiClient ?? configuredApiClient(), [apiClient]);
	const catalogCache = useMemo(() => new CatalogCache(), []);
	const cacheAwareApiClient = useMemo(
		() => {
			if (resolvedApiClient?.getCatalog === undefined) return resolvedApiClient;
			const getCatalog = resolvedApiClient.getCatalog;
			return {
				...resolvedApiClient,
				refreshCatalog: async () => void (await catalogCache.load({ getCatalog }, { forceRevalidate: true })),
			};
		},
		[catalogCache, resolvedApiClient],
	);
	const inputKey = [input.type, input.name, input.slug ?? "", input.mbid ?? "", input.qid ?? "", input.disambiguator ?? ""].join(
		"\u0000",
	);
	const controller = useController(
		cacheAwareApiClient,
		store,
		source,
		analyticsRef,
		inputKey,
		analytics.consent.status === "granted",
	);
	const [state, setState] = useState<GenerationViewState>(
		controller?.getState() ?? { phase: "storage_error", message: "La création est indisponible pour le moment." },
	);
	const openedRequestId = useRef<string | undefined>(undefined);

	useEffect(() => {
		if (controller === undefined) return;
		setState(controller.getState());
		const unsubscribe = controller.subscribe(setState);
		controller.setForeground(AppState.currentState === "active");
		void controller.hydrate(input);
		const subscription = AppState.addEventListener("change", (next) => {
			controller.setForeground(next === "active");
		});
		return () => {
			subscription.remove();
			unsubscribe();
			controller.dispose();
		};
	}, [controller, inputKey]);

	useEffect(() => {
		if (state.phase !== "succeeded" || state.nodeId === undefined) return;
		const successKey = state.requestId ?? `node:${state.nodeId}`;
		if (openedRequestId.current === successKey) return;
		openedRequestId.current = successKey;
		onOpenNode?.(state.nodeId);
	}, [onOpenNode, state.nodeId, state.phase, state.requestId]);

	if (resolvedApiClient === undefined || controller === undefined) {
		return (
			<View accessibilityRole="alert" style={styles.container}>
				<Text allowFontScaling style={styles.error}>
					La création est indisponible pour le moment. Les fiches existantes restent consultables.
				</Text>
			</View>
		);
	}

	if (state.phase === "queued" || state.phase === "running" || state.phase === "submitting" || state.phase === "checking") {
		return (
			<View accessibilityLabel="Création de la fiche en cours" accessibilityRole="progressbar" style={styles.container}>
				<Text allowFontScaling style={styles.pending}>
					{state.phase === "checking" ? "Vérification de la fiche…" : "Création de la fiche en cours…"}
				</Text>
			</View>
		);
	}

	if (state.phase === "succeeded") {
		return (
			<View accessibilityRole="alert" style={styles.container}>
				<Text allowFontScaling>Fiche créée. Ouverture de la fiche canonique…</Text>
			</View>
		);
	}

	if (state.phase === "idle") {
		return (
			<View style={styles.container}>
				<Button accessibilityLabel="Créer cette fiche" title="Créer cette fiche" onPress={() => void controller.start(input)} />
			</View>
		);
	}

	if (state.phase === "storage_error") {
		return (
			<View accessibilityRole="alert" style={styles.container}>
				<Text allowFontScaling style={styles.error}>
					Impossible d’enregistrer la demande. Réessayez.
				</Text>
				<Button accessibilityLabel="Créer cette fiche" title="Créer cette fiche" onPress={() => void controller.start(input)} />
			</View>
		);
	}

	const label = statusLabel(state) ?? "La création n’a pas pu aboutir.";
	return (
		<View accessibilityRole="alert" style={styles.container}>
			<Text allowFontScaling style={styles.error}>
				{label}
			</Text>
			{state.retryAfterSeconds === undefined ? null : (
				<Text allowFontScaling style={styles.hint}>
					Réessayez explicitement dans {state.retryAfterSeconds} secondes.
				</Text>
			)}
			<Button
				accessibilityLabel="Réessayer la création"
				title="Réessayer la création"
				onPress={() => void controller.retry()}
			/>
		</View>
	);
}

const styles = StyleSheet.create({
	container: { gap: 8, marginTop: 12 },
	error: { color: "#9c1c1c", lineHeight: 22 },
	hint: { color: "#555555", lineHeight: 20 },
	pending: { color: "#444444", lineHeight: 22 },
});
