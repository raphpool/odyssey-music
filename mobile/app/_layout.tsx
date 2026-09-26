import { router, Stack, useGlobalSearchParams, usePathname } from "expo-router";
import { useEffect, useMemo } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { AnalyticsProvider, useAnalytics } from "../src/analytics/provider";
import { ConfigurationError } from "../src/components/ConfigurationError";
import { readPublicConfig } from "../src/config";

export default function RootLayout() {
	try {
		const config = readPublicConfig();
		if (!config.ok) return <ConfigurationError />;
		return (
			<AnalyticsProvider
				environment={config.value.appEnvironment}
				{...(config.value.segmentWriteKey === undefined ? {} : { writeKey: config.value.segmentWriteKey })}
			>
				<Stack initialRouteName="privacy-choice" screenOptions={{ headerShown: false }}>
					<Stack.Screen name="privacy-choice" options={{ title: "Mesure d’usage" }} />
					<Stack.Screen name="(tabs)" options={{ headerShown: false }} />
					<Stack.Screen name="node/[slug]" options={{ title: "Fiche" }} />
					<Stack.Screen name="onboarding" options={{ title: "Bienvenue" }} />
				</Stack>
				<ConsentNavigationGate />
			</AnalyticsProvider>
		);
	} catch {
		// Configuration failures stay public and actionable; provider details must not leak into the UI.
		return <ConfigurationError />;
	}
}

function ConsentNavigationGate() {
	const analytics = useAnalytics();
	const pathname = usePathname();
	const params = useGlobalSearchParams();
	const onPrivacyChoice = pathname === "/privacy-choice";
	const destination = useMemo(() => {
		const query = new URLSearchParams();
		for (const [key, value] of Object.entries(params)) if (typeof value === "string") query.set(key, value);
		return `${pathname}${query.size === 0 ? "" : `?${query.toString()}`}`;
	}, [params, pathname]);
	const blocked = !analytics.ready || (analytics.consent.status === "unknown" && !onPrivacyChoice);
	useEffect(() => {
		if (analytics.ready && analytics.consent.status === "unknown" && !onPrivacyChoice)
			router.replace({ pathname: "/privacy-choice", params: { returnTo: destination } });
	}, [analytics.consent.status, analytics.ready, destination, onPrivacyChoice]);
	if (!blocked) return null;
	return (
		<View accessibilityLabel="Chargement du choix de mesure" style={styles.gate}>
			<ActivityIndicator />
		</View>
	);
}

const styles = StyleSheet.create({
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
