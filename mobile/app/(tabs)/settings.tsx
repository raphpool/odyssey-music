import { StyleSheet, Text } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

export default function SettingsScreen() {
	return (
		<SafeAreaView style={styles.safeArea}>
			<Text accessibilityRole="header" allowFontScaling style={styles.title}>
				Réglages
			</Text>
			<Text allowFontScaling>Votre profil local et vos préférences seront disponibles ici.</Text>
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
});
