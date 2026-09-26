import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Button, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useAnalytics } from "../src/analytics/provider";

export default function PrivacyChoiceScreen() {
	const analytics = useAnalytics();
	const { mode, returnTo } = useLocalSearchParams<{ mode?: string; returnTo?: string }>();
	const editing = mode === "edit";
	const [saving, setSaving] = useState(false);
	const choiceInFlight = useRef(false);
	useEffect(() => {
		if (!editing && returnTo === undefined && analytics.ready && analytics.consent.status !== "unknown")
			router.replace("/");
	}, [analytics.consent.status, analytics.ready, editing, returnTo]);
	const choose = async (choice: "grant" | "deny") => {
		if (choiceInFlight.current) return;
		choiceInFlight.current = true;
		setSaving(true);
		try {
			if (choice === "grant") await analytics.grant();
			else await analytics.deny();
			if (editing) router.back();
			else router.replace(safeInternalReturnTo(returnTo));
		} finally {
			choiceInFlight.current = false;
			setSaving(false);
		}
	};
	if (!analytics.ready)
		return (
			<SafeAreaView style={styles.safeArea}>
				<ActivityIndicator accessibilityLabel="Chargement du choix de mesure" />
			</SafeAreaView>
		);
	return (
		<SafeAreaView style={styles.safeArea}>
			<View style={styles.content}>
				<Text accessibilityRole="header" allowFontScaling style={styles.title}>
					Mesure d’usage
				</Text>
				<Text allowFontScaling style={styles.text}>
					Vous pouvez choisir de partager des événements anonymes pour améliorer track1. Aucun profil musical,
					texte de recherche, e-mail ou identifiant publicitaire n’est mesuré.
				</Text>
				<View style={styles.actions}>
					<Button
						accessibilityLabel="Accepter la mesure d’usage"
						title="Accepter"
						onPress={() => void choose("grant")}
						disabled={saving || analytics.purgeIncomplete}
					/>
					<Button
						accessibilityLabel="Refuser la mesure d’usage"
						title="Refuser"
						onPress={() => void choose("deny")}
						disabled={saving}
					/>
				</View>
				{analytics.purgeIncomplete ? (
					<Text accessibilityRole="alert" allowFontScaling style={styles.error}>
						La suppression locale doit être réessayée avant de pouvoir accepter la mesure.
					</Text>
				) : null}
				<Text allowFontScaling style={styles.note}>
					Ce choix est facultatif et modifiable à tout moment dans Réglages.
				</Text>
			</View>
		</SafeAreaView>
	);
}

export function safeInternalReturnTo(value: unknown): string {
	if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) {
		return "/";
	}
	// A route may carry ordinary query encoding, but a path/host separator hidden behind
	// percent encoding is ambiguous to native navigation and must never redirect externally.
	if (/%(?:2f|5c|25)/i.test(value)) return "/";
	try {
		const url = new URL(value, "https://track1.invalid");
		if (
			url.origin !== "https://track1.invalid" ||
			!url.pathname.startsWith("/") ||
			url.pathname.startsWith("//") ||
			url.hash
		)
			return "/";
		return `${url.pathname}${url.search}`;
	} catch {
		return "/";
	}
}

const styles = StyleSheet.create({
	safeArea: { flex: 1, backgroundColor: "#ffffff" },
	content: { flex: 1, justifyContent: "center", padding: 24 },
	title: { fontSize: 32, fontWeight: "700", lineHeight: 40, marginBottom: 16 },
	text: { fontSize: 17, lineHeight: 25 },
	actions: { gap: 12, marginTop: 28 },
	note: { fontSize: 14, lineHeight: 20, marginTop: 24 },
	error: { color: "#9c1c1c", fontSize: 14, lineHeight: 20, marginTop: 16 },
});
