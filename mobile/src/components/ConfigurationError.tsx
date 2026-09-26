import { ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

export type ConfigurationErrorProps = {
	cause?: string;
	instruction?: string;
};

export function ConfigurationError({
	cause = "La configuration publique est invalide ou indisponible.",
	instruction = "Configurez l'environnement de l'application puis relancez-la. Aucun appel réseau n'a été effectué.",
}: ConfigurationErrorProps) {
	return (
		<SafeAreaView style={styles.safeArea}>
			<ScrollView contentContainerStyle={styles.container}>
				<View accessible accessibilityRole="alert">
				<Text allowFontScaling style={styles.brand}>
					track1
				</Text>
				<Text allowFontScaling style={styles.description}>
					Your daily music recommendation starts here.
				</Text>
				<Text accessibilityRole="header" allowFontScaling style={styles.title}>
					Configuration requise
				</Text>
				<Text allowFontScaling style={styles.body}>
					{cause}
				</Text>
				<Text allowFontScaling style={styles.body}>
					{instruction}
				</Text>
				</View>
			</ScrollView>
		</SafeAreaView>
	);
}

const styles = StyleSheet.create({
	brand: {
		fontSize: 36,
		fontWeight: "700",
	},
	body: {
		fontSize: 18,
		lineHeight: 26,
		marginTop: 16,
	},
	container: {
		flexGrow: 1,
		justifyContent: "center",
		padding: 24,
	},
	description: {
		fontSize: 18,
		lineHeight: 26,
		marginTop: 12,
	},
	safeArea: {
		backgroundColor: "#ffffff",
		flex: 1,
	},
	title: {
		fontSize: 32,
		fontWeight: "700",
		lineHeight: 40,
	},
});
