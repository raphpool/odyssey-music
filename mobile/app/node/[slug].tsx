import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Button, Linking, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useAnalytics } from "../../src/analytics/provider";
import { type ApiClient, createApiClient } from "../../src/api/client";
import type { NodeResponse, NodeType } from "../../src/api/contracts";
import type { ClientError } from "../../src/api/errors";
import { NodeArticle } from "../../src/components/NodeArticle";
import { NodeImage } from "../../src/components/NodeImage";
import { NodeRelations } from "../../src/components/NodeRelations";
import { GenerationStatus } from "../../src/generation/status";
import {
	type GenerationInput,
	generationInputForSlug,
	normalizeGenerationInput,
} from "../../src/generation/store";
import {
	type ExternalListeningResult,
	type ListeningProvider,
	openExternalListening,
	providerLabel,
} from "../../src/listening/actions";
import { nodeNavigationParams, readNodeNavigationContext } from "../../src/navigation/context";

const nodeSlugPattern =
	/^(artist|project|track|genre|label):[a-z0-9]+(?:-[a-z0-9]+)*(?:--[a-z0-9]+(?:-[a-z0-9]+)*)?$/;

const typeLabels: Record<NodeType, string> = {
	artist: "Artiste",
	project: "Projet",
	track: "Morceau",
	genre: "Genre",
	label: "Label",
};

type NodeLoadState =
	| { kind: "loading" }
	| { kind: "success"; value: NodeResponse }
	| { kind: "missing"; identity: string }
	| { kind: "error" };

function firstParam(value: string | string[] | undefined): string | undefined {
	return typeof value === "string" ? value : value?.[0];
}

export function validateNodeSlug(value: unknown): value is string {
	return typeof value === "string" && nodeSlugPattern.test(value);
}

function isMissing(error: ClientError): boolean {
	return error.kind === "api" && error.status === 404;
}

function initialImageUrl(node: NodeResponse["node"]): string | null | undefined {
	return node.image_url;
}

function generationInputFromParams(
	params: Readonly<Record<string, string | string[] | undefined>>,
	slug: string | undefined,
): GenerationInput | undefined {
	const type = firstParam(params.generation_type);
	const name = firstParam(params.generation_name);
	if (type === undefined || name === undefined)
		return slug === undefined ? undefined : generationInputForSlug(slug);
	return normalizeGenerationInput({
		type,
		name,
		...(slug === undefined ? {} : { slug }),
		...(firstParam(params.generation_mbid) === undefined ? {} : { mbid: firstParam(params.generation_mbid) }),
		...(firstParam(params.generation_qid) === undefined ? {} : { qid: firstParam(params.generation_qid) }),
	});
}

function readableSearchQuery(slug: string | undefined): string | undefined {
	if (slug === undefined) return undefined;
	const separator = slug.indexOf(":");
	const value = separator === -1 ? slug : slug.slice(separator + 1);
	const readable = value.replace(/--/g, " ").replace(/-/g, " ").trim();
	return readable.length === 0 ? undefined : readable;
}

export default function NodeScreen() {
	const params = useLocalSearchParams<{
		slug?: string | string[];
		source?: string | string[];
		recommendation_id?: string | string[];
		notification_id?: string | string[];
		generation_name?: string | string[];
		generation_type?: string | string[];
		generation_mbid?: string | string[];
		generation_qid?: string | string[];
	}>();
	const rawSlug = firstParam(params.slug);
	const slug = validateNodeSlug(rawSlug) ? rawSlug : undefined;
	const navigationContext = readNodeNavigationContext(params);
	const generationInput = generationInputFromParams(params, slug);
	const searchQuery = readableSearchQuery(slug);
	const analytics = useAnalytics();
	const client = useMemo<ApiClient>(() => createApiClient(), []);
	const [retryKey, setRetryKey] = useState(0);
	const [state, setState] = useState<NodeLoadState>({ kind: "loading" });
	const [imageUrl, setImageUrl] = useState<string | null | undefined>();
	const [listeningResult, setListeningResult] = useState<ExternalListeningResult | undefined>();
	const [openingProvider, setOpeningProvider] = useState<ListeningProvider | undefined>();
	const openingProviderRef = useRef<ListeningProvider | undefined>(undefined);
	const listeningAttemptRef = useRef(0);
	const listeningControllerRef = useRef<AbortController | undefined>(undefined);
	const activeListeningSlugRef = useRef<string | undefined>(slug);
	activeListeningSlugRef.current = slug;
	const viewedNodeId = useRef<string | undefined>(undefined);
	const pendingView = useRef<
		| {
				nodeId: string;
				timer: ReturnType<typeof setTimeout> | undefined;
				attempts: number;
		  }
		| undefined
	>(undefined);

	useEffect(() => {
		// The attempt counter intentionally re-runs this effect when the user retries a failed request.
		void retryKey;
		const controller = new AbortController();
		let active = true;
		setState({ kind: "loading" });
		setImageUrl(undefined);

		if (slug === undefined) {
			setState({ kind: "missing", identity: rawSlug ?? "fiche inconnue" });
			return () => controller.abort();
		}

		void client
			.getNode(slug, controller.signal)
			.then((result) => {
				if (!active) return;
				if (result.kind === "success") {
					setState({ kind: "success", value: result.value });
					return;
				}
				setState(isMissing(result.error) ? { kind: "missing", identity: slug } : { kind: "error" });
			})
			.catch(() => {
				if (active) setState({ kind: "error" });
			});

		return () => {
			active = false;
			controller.abort();
		};
	}, [client, rawSlug, retryKey, slug]);

	const loadedNode = state.kind === "success" ? state.value.node : undefined;

	useEffect(() => {
		if (loadedNode === undefined) return;
		const controller = new AbortController();
		setImageUrl(initialImageUrl(loadedNode));
		void client.getImage(loadedNode.id, controller.signal).then((result) => {
			if (result.kind === "success") setImageUrl(result.value.image_url);
		});
		return () => controller.abort();
	}, [client, loadedNode]);

	useEffect(() => {
		if (
			loadedNode === undefined ||
			analytics.consent.status !== "granted" ||
			viewedNodeId.current === loadedNode.id
		)
			return;
		if (pendingView.current?.nodeId === loadedNode.id) return;

		let cancelled = false;
		const nodeId = loadedNode.id;
		const recommendationId = navigationContext.recommendation_id;
		const notificationId = navigationContext.notification_id;
		const attempt: NonNullable<typeof pendingView.current> = {
			nodeId,
			timer: undefined,
			attempts: 0,
		};
		pendingView.current = attempt;

		const send = async (): Promise<void> => {
			if (cancelled || analytics.consent.status !== "granted") {
				if (pendingView.current === attempt) pendingView.current = undefined;
				return;
			}
			const result = await analytics.trackEvent(
				"node_viewed",
				{
					node_id: nodeId,
					node_type: loadedNode.type,
					...(recommendationId === undefined ? {} : { recommendation_id: recommendationId }),
					...(notificationId === undefined ? {} : { notification_id: notificationId }),
				},
				{
					source: navigationContext.source,
					...(recommendationId === undefined ? {} : { recommendation_id: recommendationId }),
					...(notificationId === undefined ? {} : { notification_id: notificationId }),
				},
			);
			if (cancelled || pendingView.current !== attempt) return;
			if (result.kind === "accepted") {
				viewedNodeId.current = nodeId;
				pendingView.current = undefined;
				return;
			}
			if (analytics.consent.status !== "granted" || attempt.attempts >= 20) {
				pendingView.current = undefined;
				return;
			}
			attempt.attempts += 1;
			attempt.timer = setTimeout(() => void send(), 250);
		};

		void send();
		return () => {
			cancelled = true;
			if (attempt.timer !== undefined) clearTimeout(attempt.timer);
			if (pendingView.current === attempt) pendingView.current = undefined;
		};
	}, [
		analytics.consent.status,
		analytics.trackEvent,
		navigationContext.notification_id,
		navigationContext.recommendation_id,
		navigationContext.source,
		loadedNode,
	]);

	useEffect(() => {
		activeListeningSlugRef.current = slug;
		// This effect setup runs for a newly mounted route only, never for an unmount. It clears UI state
		// owned by the previous fiche after its cleanup has invalidated the old asynchronous attempt.
		setOpeningProvider(undefined);
		setListeningResult(undefined);
		return () => {
			// Route changes retain this component briefly; cancel the old lookup before it can open a service for it.
			listeningAttemptRef.current += 1;
			listeningControllerRef.current?.abort();
			listeningControllerRef.current = undefined;
			openingProviderRef.current = undefined;
		};
	}, [slug]);

	if (state.kind === "loading") return <LoadingState />;
	if (state.kind === "missing")
		return (
			<StatusState
				title="Fiche introuvable"
				identity={state.identity}
				missing
				action={() => setRetryKey((current) => current + 1)}
				apiClient={client}
				source={navigationContext.source}
				{...(generationInput === undefined ? {} : { generationInput })}
				{...(searchQuery === undefined ? {} : { searchQuery })}
				onOpenNode={(nodeId) =>
					router.push({
						pathname: "/node/[slug]",
						params: nodeNavigationParams(nodeId, navigationContext),
					})
				}
			/>
		);
	if (state.kind === "error") {
		return (
			<StatusState
				title="Impossible de charger cette fiche"
				action={() => setRetryKey((current) => current + 1)}
			/>
		);
	}
	const node = state.value.node;
	const openListening = async (provider: ListeningProvider): Promise<void> => {
		if (openingProviderRef.current !== undefined) return;
		openingProviderRef.current = provider;
		const attempt = listeningAttemptRef.current + 1;
		listeningAttemptRef.current = attempt;
		const controller = new AbortController();
		listeningControllerRef.current = controller;
		const isCurrent = () =>
			listeningAttemptRef.current === attempt &&
			!controller.signal.aborted &&
			activeListeningSlugRef.current === slug;
		setOpeningProvider(provider);
		setListeningResult(undefined);
		let exactUrl: string | null | undefined;
		try {
			try {
				const links = await client.getLinks(node.id, controller.signal);
				if (!isCurrent()) return;
				if (links.kind === "success")
					exactUrl = provider === "spotify" ? links.value.spotify : links.value.apple;
			} catch {
				// A failed optional lookup still has a deterministic, explicitly disclosed search fallback.
				if (!isCurrent()) return;
			}
			if (!isCurrent()) return;
			const result = await openExternalListening({
				node,
				provider,
				...(exactUrl === undefined ? {} : { exactUrl }),
				navigationContext,
				openUrl: (url) => Linking.openURL(url),
				...(analytics.consent.status === "granted"
					? {
							analytics: {
								trackEvent: (name, properties, context) =>
									isCurrent()
										? analytics.trackEvent(name, properties, context)
										: Promise.resolve({ kind: "disabled" }),
							},
						}
					: {}),
			});
			if (!isCurrent()) return;
			setListeningResult(result);
		} finally {
			if (isCurrent()) {
				listeningControllerRef.current = undefined;
				openingProviderRef.current = undefined;
				setOpeningProvider(undefined);
			}
		}
	};

	return (
		<SafeAreaView style={styles.safeArea}>
			<ScrollView contentContainerStyle={styles.content}>
				<Button
					accessibilityLabel="Retour à la fiche précédente"
					title="Retour"
					onPress={() => router.back()}
				/>
				<NodeImage altText={`Image de ${node.name}`} imageUrl={imageUrl} />
				<Text allowFontScaling style={styles.identity}>
					{node.id}
				</Text>
				<Text accessibilityRole="header" allowFontScaling style={styles.title}>
					{node.name}
				</Text>
				<Text allowFontScaling style={styles.type}>
					{`Type : ${typeLabels[node.type]}`}
				</Text>
				{node.teaser === null ? null : (
					<Text allowFontScaling style={styles.teaser}>
						{node.teaser}
					</Text>
				)}
				<View style={styles.listening}>
					<Text accessibilityRole="header" allowFontScaling style={styles.listeningHeading}>
						Écouter ailleurs
					</Text>
					<Text allowFontScaling style={styles.listeningHint}>
						Nous ouvrons la page exacte si elle est disponible ; sinon, une recherche dans le service.
					</Text>
					<Button
						accessibilityLabel="Ouvrir dans Spotify"
						disabled={openingProvider !== undefined}
						title={openingProvider === "spotify" ? "Ouverture…" : "Ouvrir dans Spotify"}
						onPress={() => void openListening("spotify")}
					/>
					<View style={styles.listeningButton}>
						<Button
							accessibilityLabel="Ouvrir dans Apple Music"
							disabled={openingProvider !== undefined}
							title={openingProvider === "apple_music" ? "Ouverture…" : "Ouvrir dans Apple Music"}
							onPress={() => void openListening("apple_music")}
						/>
					</View>
					{listeningResult?.kind === "opened" && listeningResult.linkKind === "search" ? (
						<Text allowFontScaling style={styles.listeningHint}>
							{`Recherche ${providerLabel(listeningResult.provider)} ouverte.`}
						</Text>
					) : null}
					{listeningResult?.kind === "failed" ? (
						<Text accessibilityRole="alert" allowFontScaling style={styles.listeningError}>
							{listeningResult.errorCode === "unsafe_url"
								? "Ce lien a été bloqué pour votre sécurité."
								: "Impossible d’ouvrir ce service. Réessayez plus tard."}
						</Text>
					) : null}
				</View>
				<NodeArticle article={node.article} citations={node.citations} />
				<NodeRelations edges={node.edges} fromNodeId={node.id} navigationContext={navigationContext} />
			</ScrollView>
		</SafeAreaView>
	);
}

function LoadingState() {
	return (
		<SafeAreaView style={styles.statusSafeArea}>
			<ActivityIndicator accessibilityLabel="Chargement de la fiche" />
		</SafeAreaView>
	);
}

function StatusState({
	action,
	apiClient,
	generationInput,
	identity,
	missing = false,
	onOpenNode,
	searchQuery,
	source = "deeplink",
	title,
}: {
	action?: () => void;
	apiClient?: ApiClient;
	generationInput?: GenerationInput;
	identity?: string;
	missing?: boolean;
	onOpenNode?: (nodeId: string) => void;
	searchQuery?: string;
	source?: "app" | "onboarding" | "settings" | "home" | "search" | "relation" | "notification" | "deeplink";
	title: string;
}) {
	return (
		<SafeAreaView style={styles.statusSafeArea}>
			<View accessibilityRole="alert" accessible style={styles.statusContent}>
				<Text accessibilityRole="header" allowFontScaling style={styles.statusTitle}>
					{title}
				</Text>
				{identity === undefined ? null : (
					<Text allowFontScaling style={styles.statusText}>
						{`Identité demandée : ${identity}`}
					</Text>
				)}
				{missing ? (
					<Text allowFontScaling style={styles.statusText}>
						Cette fiche n'est pas encore disponible.
					</Text>
				) : null}
				{generationInput === undefined && searchQuery !== undefined ? (
					<Button
						accessibilityLabel="Rechercher cette fiche"
						title="Rechercher cette fiche"
						onPress={() => router.push({ pathname: "/(tabs)/search", params: { q: searchQuery } })}
					/>
				) : null}
				{generationInput !== undefined && apiClient !== undefined ? (
					<GenerationStatus
						apiClient={apiClient}
						input={generationInput}
						source={source}
						{...(onOpenNode === undefined ? {} : { onOpenNode })}
					/>
				) : null}
				{action === undefined ? null : (
					<Button accessibilityLabel="Réessayer de charger la fiche" title="Réessayer" onPress={action} />
				)}
			</View>
		</SafeAreaView>
	);
}

const styles = StyleSheet.create({
	safeArea: { backgroundColor: "#ffffff", flex: 1 },
	content: { padding: 24 },
	identity: { color: "#5c5c5c", fontSize: 14, lineHeight: 20 },
	title: { fontSize: 32, fontWeight: "700", lineHeight: 40, marginTop: 4 },
	type: { color: "#444444", fontSize: 17, lineHeight: 24, marginTop: 8 },
	teaser: { fontSize: 19, lineHeight: 28, marginTop: 20 },
	listening: { borderColor: "#d0d0d0", borderRadius: 8, borderWidth: 1, marginTop: 24, padding: 16 },
	listeningHeading: { fontSize: 22, fontWeight: "700", lineHeight: 30, marginBottom: 8 },
	listeningHint: { fontSize: 15, lineHeight: 22, marginBottom: 12 },
	listeningButton: { marginTop: 10 },
	listeningError: { color: "#a40000", fontSize: 15, lineHeight: 22, marginTop: 12 },
	statusSafeArea: { alignItems: "center", backgroundColor: "#ffffff", flex: 1, justifyContent: "center" },
	statusContent: { padding: 24, width: "100%" },
	statusTitle: { fontSize: 26, fontWeight: "700", lineHeight: 34, marginBottom: 12 },
	statusText: { fontSize: 17, lineHeight: 25, marginBottom: 16 },
});
