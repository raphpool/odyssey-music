import { router } from "expo-router";
import { Button, StyleSheet, Text } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { analyticsStatusLabel, useAnalytics } from "../../src/analytics/provider";

export default function SettingsScreen() {
	const analytics = useAnalytics();
	return (
		<SafeAreaView style={styles.safeArea}>
			<Text accessibilityRole="header" allowFontScaling style={styles.title}>
				Réglages
			</Text>
			<Text allowFontScaling>Votre profil local et vos préférences seront disponibles ici.</Text>
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
				onPress={() => router.push({ pathname: "/privacy-choice", params: { mode: "edit" } })}
			/>
		</SafeAreaView>
	);
}

const styles = StyleSheet.create({
	safeArea: {
		backgroundColor: "#ffffff",
		flex: 1,
		padding: 24,
	},
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
