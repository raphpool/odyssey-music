import { router } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState, Button, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useAnalytics } from "../../src/analytics/provider";
import { createApiClient } from "../../src/api/client";
import { CatalogCache } from "../../src/cache/catalog";
import { NodeCache } from "../../src/cache/nodes";
import { NodeImage } from "../../src/components/NodeImage";
import { RequestState } from "../../src/components/RequestState";
import { nodeNavigationParams } from "../../src/navigation/context";
import { profileFromState, useProfile } from "../../src/profile/useProfile";
import {
	type DailyRecommendation,
	DailyRecommendationStore,
	type DailyResult,
	recommendDaily,
} from "../../src/recommendation/daily";

type TodayState = { kind: "loading" } | { kind: "catalog_error"; offline: boolean } | DailyResult;

function localDate(): string {
	const now = new Date();
	return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function recommendationProperties(recommendation: DailyRecommendation) {
	return {
		recommendation_id: recommendation.recommendation_id,
		local_date: recommendation.local_date,
		node_id: recommendation.node_id,
		node_type: recommendation.node_type,
	};
}

export default function TodayScreen() {
	const analytics = useAnalytics();
	const profileState = useProfile();
	const profile = profileFromState(profileState.state);
	const client = useMemo(() => createApiClient(), []);
	const store = useMemo(() => new DailyRecommendationStore(), []);
	const catalogCache = useMemo(() => new CatalogCache(), []);
	const nodeCache = useMemo(() => new NodeCache(), []);
	const [state, setState] = useState<TodayState>({ kind: "loading" });
	const [offline, setOffline] = useState(false);
	const [refresh, setRefresh] = useState(0);
	const [viewRetry, setViewRetry] = useState(0);
	const [imageUrl, setImageUrl] = useState<string | null | undefined>();
	const markingView = useRef<string | undefined>(undefined);
	const loadAttempt = useRef(0);

	const load = useCallback(async () => {
		const attempt = loadAttempt.current + 1;
		loadAttempt.current = attempt;
		const isCurrent = () => loadAttempt.current === attempt;
		if (!profileState.ready) return;
		if (profile === undefined) {
			if (isCurrent()) setState({ kind: "missing_profile" });
			return;
		}
		setState({ kind: "loading" });
		const response = await catalogCache.load(client, { forceRevalidate: refresh > 0 });
		if (!isCurrent()) return;
		setOffline(response.stale);
		if (response.value === undefined) {
			const offlineError = response.error?.kind === "network_error" || response.error?.kind === "timeout";
			setState({ kind: "catalog_error", offline: offlineError });
			return;
		}
		const next = await recommendDaily({ store, profile, catalog: response.value, localDate: localDate() });
		if (next.kind === "recommendation") await nodeCache.protect([next.recommendation.node_id]);
		if (isCurrent()) setState(next);
	}, [catalogCache, client, nodeCache, profile, profileState.ready, refresh, store]);

	useEffect(() => {
		void refresh;
		void load();
		return () => {
			loadAttempt.current += 1;
		};
	}, [load, refresh]);

	useEffect(() => {
		const subscription = AppState.addEventListener("change", (next) => {
			if (next === "active") {
				setRefresh((current) => current + 1);
				setViewRetry((current) => current + 1);
			}
		});
		return () => subscription.remove();
	}, []);

	const recommendation = state.kind === "recommendation" ? state.recommendation : undefined;
	useEffect(() => {
		if (recommendation === undefined) {
			setImageUrl(undefined);
			return;
		}
		let active = true;
		setImageUrl(null);
		void client.getImage(recommendation.node_id).then((response) => {
			if (active && response.kind === "success") setImageUrl(response.value.image_url);
		});
		return () => {
			active = false;
		};
	}, [client, recommendation]);

	useEffect(() => {
		void viewRetry;
		if (!analytics.ready || analytics.consent.status === "unknown") return;
		if (
			recommendation === undefined ||
			recommendation.view_recorded ||
			markingView.current === recommendation.recommendation_id
		)
			return;
		if (analytics.consent.status === "granted" && analytics.transportReady !== true) return;
		markingView.current = recommendation.recommendation_id;
		const persistViewed = async (): Promise<void> => {
			const saved = await store.markViewed(recommendation.recommendation_id);
			if (!saved) {
				markingView.current = undefined;
				return;
			}
			setState((current) =>
				current.kind === "recommendation" &&
				current.recommendation.recommendation_id === recommendation.recommendation_id
					? { kind: "recommendation", recommendation: { ...current.recommendation, view_recorded: true } }
					: current,
			);
		};
		void (async () => {
			if (analytics.consent.status !== "granted") {
				await persistViewed();
				return;
			}
			try {
				const result = await analytics.trackEvent(
					"daily_recommendation_viewed",
					recommendationProperties(recommendation),
					{
						source: "home",
						event_id: recommendation.view_event_id,
					},
				);
				if (result.kind === "accepted") await persistViewed();
				else markingView.current = undefined;
			} catch {
				markingView.current = undefined;
			}
		})();
	}, [analytics, recommendation, store, viewRetry]);

	const openRecommendation = (): void => {
		if (recommendation === undefined) return;
		if (analytics.consent.status === "granted")
			void analytics.trackEvent("daily_recommendation_opened", recommendationProperties(recommendation), {
				source: "home",
			});
		router.push({
			pathname: "/node/[slug]",
			params: nodeNavigationParams(recommendation.node_id, {
				source: "home",
				recommendation_id: recommendation.recommendation_id,
			}),
		});
	};

	if (state.kind === "loading") return <Status title="Préparation de votre découverte" />;
	if (state.kind === "missing_profile")
		return (
			<Status
				title="Choisissez vos goûts pour recevoir une découverte."
				actionLabel="Choisir mes goûts"
				onAction={() => router.push("/onboarding")}
			/>
		);
	if (state.kind === "empty_catalog")
		return (
			<Status
				title="Aucune découverte ne peut être proposée pour le moment."
				actionLabel="Réessayer"
				onAction={() => setRefresh((current) => current + 1)}
			/>
		);
	if (state.kind === "catalog_error")
		return (
			<Status
				title={
					state.offline
						? "Hors connexion : aucune découverte enregistrée n’est disponible."
						: "La découverte est momentanément indisponible."
				}
				actionLabel="Réessayer"
				onAction={() => setRefresh((current) => current + 1)}
			/>
		);
	if (state.kind === "unavailable")
		return (
			<Status
				title="Votre découverte ne peut pas être enregistrée sur cet appareil."
				actionLabel="Réessayer"
				onAction={() => setRefresh((current) => current + 1)}
			/>
		);
	if (recommendation === undefined)
		return <Status title="Aucune découverte ne peut être proposée pour le moment." />;

	return (
		<SafeAreaView style={styles.safeArea}>
			<ScrollView contentContainerStyle={styles.container}>
				{offline ? <RequestState kind="offline" /> : null}
				<Text accessibilityRole="header" allowFontScaling style={styles.heading}>
					Votre découverte du jour
				</Text>
				<NodeImage altText={`Image de ${recommendation.name}`} imageUrl={imageUrl} />
				<Text accessibilityRole="header" allowFontScaling style={styles.title}>
					{recommendation.name}
				</Text>
				{recommendation.teaser === null ? null : (
					<Text allowFontScaling style={styles.teaser}>
						{recommendation.teaser}
					</Text>
				)}
				<Text accessibilityRole="header" allowFontScaling style={styles.whyHeading}>
					Pourquoi cette découverte ?
				</Text>
				{recommendation.reasons.map((reason) => (
					<Text allowFontScaling key={reason} style={styles.reason}>
						{reason}
					</Text>
				))}
				<Button
					accessibilityLabel={`Découvrir ${recommendation.name}`}
					title="Découvrir"
					onPress={openRecommendation}
				/>
			</ScrollView>
		</SafeAreaView>
	);
}

function Status({
	title,
	actionLabel,
	onAction,
}: {
	title: string;
	actionLabel?: string;
	onAction?: () => void;
}) {
	return (
		<SafeAreaView style={styles.safeArea}>
			<View accessibilityRole="alert" style={styles.container}>
				<Text accessibilityRole="header" allowFontScaling style={styles.heading}>
					{title}
				</Text>
				{actionLabel === undefined || onAction === undefined ? null : (
					<Button accessibilityLabel={actionLabel} title={actionLabel} onPress={onAction} />
				)}
			</View>
		</SafeAreaView>
	);
}

const styles = StyleSheet.create({
	container: {
		flexGrow: 1,
		justifyContent: "center",
		padding: 24,
	},
	safeArea: {
		backgroundColor: "#ffffff",
		flex: 1,
	},
	heading: { fontSize: 24, fontWeight: "700", lineHeight: 32, marginBottom: 20 },
	title: { fontSize: 30, fontWeight: "700", lineHeight: 38 },
	teaser: { fontSize: 18, lineHeight: 26, marginTop: 12 },
	whyHeading: { fontSize: 18, fontWeight: "700", marginTop: 24 },
	reason: { fontSize: 16, lineHeight: 24, marginTop: 6 },
});
