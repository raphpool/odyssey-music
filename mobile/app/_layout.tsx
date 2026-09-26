import { Stack } from "expo-router";

import { ConfigurationError } from "../src/components/ConfigurationError";
import { readPublicConfig } from "../src/config";

export default function RootLayout() {
	try {
		if (!readPublicConfig().ok) {
			return <ConfigurationError />;
		}
	} catch {
		// Configuration failures stay public and actionable; provider details must not leak into the UI.
		return <ConfigurationError />;
	}

	return (
		<Stack initialRouteName="index" screenOptions={{ headerShown: false }}>
			<Stack.Screen name="(tabs)" options={{ headerShown: false }} />
			<Stack.Screen name="node/[slug]" options={{ title: "Fiche" }} />
			<Stack.Screen name="onboarding" options={{ title: "Bienvenue" }} />
		</Stack>
	);
}
