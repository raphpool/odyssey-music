import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Button, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useAnalytics } from "../../src/analytics/provider";
import { type ApiClient, createApiClient } from "../../src/api/client";
import type { NodeResponse, NodeType } from "../../src/api/contracts";
import type { ClientError } from "../../src/api/errors";
import { NodeArticle } from "../../src/components/NodeArticle";
import { NodeImage } from "../../src/components/NodeImage";
import { NodeRelations } from "../../src/components/NodeRelations";
import { readNodeNavigationContext } from "../../src/navigation/context";

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

export default function NodeScreen() {
	const params = useLocalSearchParams<{
		slug?: string | string[];
		source?: string | string[];
		recommendation_id?: string | string[];
		notification_id?: string | string[];
	}>();
	const rawSlug = firstParam(params.slug);
	const slug = validateNodeSlug(rawSlug) ? rawSlug : undefined;
	const navigationContext = readNodeNavigationContext(params);
	const analytics = useAnalytics();
	const client = useMemo<ApiClient>(() => createApiClient(), []);
	const [retryKey, setRetryKey] = useState(0);
	const [state, setState] = useState<NodeLoadState>({ kind: "loading" });
	const [imageUrl, setImageUrl] = useState<string | null | undefined>();
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

	if (state.kind === "loading") return <LoadingState />;
	if (state.kind === "missing")
		return (
			<StatusState
				title="Fiche introuvable"
				identity={state.identity}
				missing
				action={() => setRetryKey((current) => current + 1)}
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
	identity,
	missing = false,
	title,
}: {
	action?: () => void;
	identity?: string;
	missing?: boolean;
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
	statusSafeArea: { alignItems: "center", backgroundColor: "#ffffff", flex: 1, justifyContent: "center" },
	statusContent: { padding: 24, width: "100%" },
	statusTitle: { fontSize: 26, fontWeight: "700", lineHeight: 34, marginBottom: 12 },
	statusText: { fontSize: 17, lineHeight: 25, marginBottom: 16 },
});
