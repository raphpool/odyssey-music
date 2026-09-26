import { Redirect } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { type ConsentStatus, ConsentStore } from "../src/analytics/consent";
import { ConfigurationError } from "../src/components/ConfigurationError";
import { readPublicConfig } from "../src/config";

export default function BootstrapScreen() {
	const [consent, setConsent] = useState<ConsentStatus | undefined>();
	let configured = false;
	try {
		const config = readPublicConfig();
		configured = config.ok;
	} catch {
		// Configuration failures stay public and actionable; provider details must not leak into the UI.
	}
	useEffect(() => {
		if (!configured) return;
		let active = true;
		void new ConsentStore().read().then((value) => {
			if (active) setConsent(value.status);
		});
		return () => {
			active = false;
		};
	}, [configured]);

	if (!configured) return <ConfigurationError />;
	if (consent === undefined)
		return (
			<View accessibilityLabel="Chargement du choix de mesure">
				<ActivityIndicator />
			</View>
		);
	if (consent === "unknown") return <Redirect href="/privacy-choice" />;
	return <Redirect href="/(tabs)" />;
}
