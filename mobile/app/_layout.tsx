import { router, Stack, useGlobalSearchParams, usePathname } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";

import { AnalyticsProvider, useAnalytics } from "../src/analytics/provider";
import { ConfigurationError } from "../src/components/ConfigurationError";
import { readPublicConfig } from "../src/config";
import { ProfileStore } from "../src/profile/store";
import { ProfileProvider, useProfile } from "../src/profile/useProfile";

export default function RootLayout() {
	try {
		const config = readPublicConfig();
		if (!config.ok) return <ConfigurationError />;
		return (
			<AnalyticsProvider
				environment={config.value.appEnvironment}
				{...(config.value.segmentWriteKey === undefined ? {} : { writeKey: config.value.segmentWriteKey })}
			>
				<ProfileProvider>
					<AnalyticsNavigation />
				</ProfileProvider>
			</AnalyticsProvider>
		);
	} catch {
		// Configuration failures stay public and actionable; provider details must not leak into the UI.
		return <ConfigurationError />;
	}
}

function AnalyticsNavigation() {
	const analytics = useAnalytics();
	const profile = useProfile();
	const pathname = usePathname();
	const params = useGlobalSearchParams();
	const onPrivacyChoice = pathname === "/privacy-choice";
	const onOnboarding = pathname === "/onboarding";
	const onSearch = pathname === "/search";
	const onSearchResult = pathname.startsWith("/node/") && params.source === "search";
	const onSettings = pathname === "/settings";
	const [outboxSignal, setOutboxSignal] = useState(0);
	const replayingEventIds = useRef(new Set<string>());
	const retryAttempts = useRef(new Map<string, number>());
	const destination = useMemo(() => {
		const query = new URLSearchParams();
		for (const [key, value] of Object.entries(params)) if (typeof value === "string") query.set(key, value);
		return `${pathname}${query.size === 0 ? "" : `?${query.toString()}`}`;
	}, [params, pathname]);
	const profileRedirect =
		profile.ready &&
		profile.state.kind !== "profile" &&
		!onOnboarding &&
		!onSearch &&
		!onSearchResult &&
		!onSettings &&
		!onPrivacyChoice;
	const blocked =
		!analytics.ready ||
		!profile.ready ||
		(analytics.consent.status === "unknown" && !onPrivacyChoice) ||
		profileRedirect;

	useEffect(() => {
		if (analytics.ready && analytics.consent.status === "unknown" && !onPrivacyChoice)
			router.replace({ pathname: "/privacy-choice", params: { returnTo: destination } });
	}, [analytics.consent.status, analytics.ready, destination, onPrivacyChoice]);

	useEffect(() => {
		if (analytics.ready && analytics.consent.status !== "unknown" && profile.ready && profileRedirect)
			router.replace("/onboarding");
	}, [analytics.consent.status, analytics.ready, profile.ready, profileRedirect]);

	useEffect(() => ProfileStore.subscribeOnboardingOutbox(() => setOutboxSignal((signal) => signal + 1)), []);

	useEffect(() => {
		if (!analytics.ready || analytics.consent.status === "unknown") return;
		const store = new ProfileStore();
		let active = true;
		const retry = (operation: string, scheduledFor = outboxSignal) => {
			const attempts = retryAttempts.current.get(operation) ?? 0;
			if (!active || scheduledFor < 0 || attempts >= 2) return;
			retryAttempts.current.set(operation, attempts + 1);
			setTimeout(() => active && setOutboxSignal((signal) => signal + 1), 1_000);
		};
		const complete = (operation: string) => {
			retryAttempts.current.delete(operation);
		};
		if (analytics.consent.status === "denied") {
			void store.discardOnboardingOutboxes().then((discarded) => {
				if (discarded) complete("outbox-purge");
				else retry("outbox-purge");
			});
			return () => {
				active = false;
			};
		}
		void store.onboardingOutboxPurgePending().then(async (purgePending) => {
			if (!active) return;
			if (purgePending) {
				if (await store.discardOnboardingOutboxes()) complete("outbox-purge");
				else retry("outbox-purge");
				return;
			}
			complete("outbox-purge");
			const [started, completion] = await Promise.all([
				store.readOnboardingStarted(),
				store.readOnboardingCompletion(),
			]);
			if (!active) return;
			if (!profile.ready || analytics.transportReady !== true) return;
			if (started !== undefined) {
				const replayKey = `onboarding_started:${started.event_id}`;
				if (!replayingEventIds.current.has(replayKey)) {
					replayingEventIds.current.add(replayKey);
					try {
						const result = await analytics.trackEvent(
							"onboarding_started",
							{ flow_id: started.flow_id },
							{ source: "onboarding", event_id: started.event_id, occurred_at: started.occurred_at },
						);
						if (result.kind === "accepted" && (await store.acknowledgeOnboardingStarted(started.event_id)))
							complete(replayKey);
						else retry(replayKey);
					} finally {
						replayingEventIds.current.delete(replayKey);
					}
				}
			}
			if (completion !== undefined && profile.state.kind === "profile") {
				const replayKey = `onboarding_completed:${completion.event_id}`;
				if (!replayingEventIds.current.has(replayKey)) {
					replayingEventIds.current.add(replayKey);
					try {
						const result = await analytics.trackEvent(
							"onboarding_completed",
							{ flow_id: completion.flow_id, genres_count: completion.genres_count },
							{
								source: "onboarding",
								event_id: completion.event_id,
								occurred_at: completion.occurred_at,
							},
						);
						if (
							result.kind === "accepted" &&
							(await store.acknowledgeOnboardingCompletion(completion.event_id))
						)
							complete(replayKey);
						else retry(replayKey);
					} finally {
						replayingEventIds.current.delete(replayKey);
					}
				}
			}
		});
		return () => {
			active = false;
		};
	}, [analytics, outboxSignal, profile.ready, profile.state]);

	return (
		<View style={styles.root}>
			<View
				accessibilityElementsHidden={blocked}
				importantForAccessibility={blocked ? "no-hide-descendants" : "auto"}
				style={styles.navigator}
				testID="application-navigator"
			>
				<Stack initialRouteName="privacy-choice" screenOptions={{ headerShown: false }}>
					<Stack.Screen name="privacy-choice" options={{ title: "Mesure d’usage" }} />
					<Stack.Screen name="(tabs)" options={{ headerShown: false }} />
					<Stack.Screen name="node/[slug]" options={{ title: "Fiche" }} />
					<Stack.Screen name="onboarding" options={{ title: "Bienvenue" }} />
				</Stack>
			</View>
			{blocked ? (
				<View accessibilityLabel="Chargement du choix de mesure" accessibilityViewIsModal style={styles.gate}>
					<ActivityIndicator />
				</View>
			) : null}
		</View>
	);
}

const styles = StyleSheet.create({
	root: { flex: 1 },
	navigator: { flex: 1 },
	gate: {
		alignItems: "center",
		backgroundColor: "#ffffff",
		bottom: 0,
		justifyContent: "center",
		left: 0,
		position: "absolute",
		right: 0,
		top: 0,
	},
});
