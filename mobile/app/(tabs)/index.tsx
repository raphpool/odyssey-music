import { StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

export default function TodayScreen() {
	return (
		<SafeAreaView style={styles.safeArea}>
			<View style={styles.container}>
				<Text accessibilityRole="header" allowFontScaling style={styles.title}>
					Votre recommandation du jour
				</Text>
				<Text allowFontScaling>Une découverte musicale pensée pour vous attend ici.</Text>
			</View>
		</SafeAreaView>
	);
}

const styles = StyleSheet.create({
	container: {
		flex: 1,
		justifyContent: "center",
		padding: 24,
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
