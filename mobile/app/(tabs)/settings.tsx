import { router } from "expo-router";
import { useMemo, useRef, useState } from "react";
import { Alert, Button, ScrollView, StyleSheet, Text } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { analyticsStatusLabel, useAnalytics } from "../../src/analytics/provider";
import { ProfileStore } from "../../src/profile/store";
import { profileFromState, useProfile } from "../../src/profile/useProfile";

export default function SettingsScreen() {
	const analytics = useAnalytics();
	const profile = useProfile();
	const store = useMemo(() => new ProfileStore(), []);
	const [clearing, setClearing] = useState(false);
	const clearInProgress = useRef(false);
	const [profileMessage, setProfileMessage] = useState<string>();
	const current = profileFromState(profile.state);
	const clearProfile = () => {
		if (clearInProgress.current) return;
		Alert.alert(
			"Effacer le profil musical ?",
			"Vos goûts et vos découvertes enregistrées sur ce téléphone seront supprimés. Le choix de mesure et les rappels ne changent pas.",
			[
				{ text: "Annuler", style: "cancel" },
				{
					text: "Effacer",
					style: "destructive",
					onPress: () => {
						if (clearInProgress.current) return;
						clearInProgress.current = true;
						void (async () => {
							setClearing(true);
							setProfileMessage(undefined);
							const result = await store.clear();
							if (result.kind !== "cleared") {
								setProfileMessage("Le profil n’a pas pu être effacé. Réessayez.");
								setClearing(false);
								clearInProgress.current = false;
								return;
							}
							await profile.reload();
							void analytics.trackEvent(
								"preferences_updated",
								{ genres_count: 0, action: "cleared" },
								{ source: "settings" },
							);
							router.replace("/onboarding");
						})();
					},
				},
			],
		);
	};
	return (
		<SafeAreaView style={styles.safeArea}>
			<ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
				<Text accessibilityRole="header" allowFontScaling style={styles.title}>
					Réglages
				</Text>
				<Text allowFontScaling>Votre profil musical reste sur ce téléphone.</Text>
				<Text allowFontScaling style={styles.section}>
					Goûts musicaux
				</Text>
				{current === undefined ? (
					<Text allowFontScaling>Vos goûts ne sont pas encore définis.</Text>
				) : (
					<Text allowFontScaling>{current.genre_ids.length} genres sélectionnés.</Text>
				)}
				<Button
					accessibilityLabel="Modifier mes goûts musicaux"
					title="Modifier mes goûts"
					onPress={() => router.push("/onboarding?mode=edit")}
					disabled={current === undefined || clearing}
				/>
				<Button
					accessibilityLabel="Effacer le profil musical"
					title="Effacer le profil musical"
					onPress={clearProfile}
					disabled={current === undefined || clearing}
				/>
				{profileMessage === undefined ? null : (
					<Text accessibilityRole="alert" allowFontScaling style={styles.error}>
						{profileMessage}
					</Text>
				)}
				<Text allowFontScaling style={styles.section}>
					Mesure d’usage
				</Text>
				<Text allowFontScaling>
					{analytics.ready
						? `État : ${analyticsStatusLabel(analytics.consent.status)}.`
						: "Chargement du choix…"}
				</Text>
				{!analytics.configured ? (
					<Text allowFontScaling style={styles.note}>
						La clé de mesure n’est pas configurée : aucun événement n’est envoyé.
					</Text>
				) : null}
				{analytics.purgeIncomplete ? (
					<Text accessibilityRole="alert" allowFontScaling style={styles.error}>
						La suppression des données de mesure est incomplète. Refusez à nouveau pour réessayer.
					</Text>
				) : null}
				<Button
					accessibilityLabel="Modifier le choix de mesure d’usage"
					title="Modifier le choix"
					onPress={() =>
						router.push({
							pathname: "/privacy-choice",
							params: { mode: "edit", returnTo: "/(tabs)/settings" },
						})
					}
				/>
			</ScrollView>
		</SafeAreaView>
	);
}

const styles = StyleSheet.create({
	safeArea: {
		backgroundColor: "#ffffff",
		flex: 1,
	},
	content: { flexGrow: 1, padding: 24 },
	title: {
		fontSize: 32,
		fontWeight: "700",
		lineHeight: 40,
		marginBottom: 24,
	},
	section: { fontSize: 22, fontWeight: "700", lineHeight: 30, marginTop: 32, marginBottom: 8 },
	note: { marginTop: 8, marginBottom: 12 },
	error: { color: "#9c1c1c", marginTop: 8, marginBottom: 12 },
});
