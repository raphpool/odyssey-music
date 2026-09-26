import { useState } from "react";
import { StyleSheet, Text, TextInput } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

export default function SearchScreen() {
	const [query, setQuery] = useState("");

	return (
		<SafeAreaView style={styles.safeArea}>
			<Text accessibilityRole="header" allowFontScaling style={styles.title}>
				Recherche
			</Text>
			<TextInput
				accessibilityLabel="Rechercher dans Odyssey"
				allowFontScaling
				autoCapitalize="none"
				autoCorrect={false}
				onChangeText={setQuery}
				placeholder="Rechercher un artiste ou une œuvre"
				style={styles.input}
				value={query}
			/>
			<Text allowFontScaling>La recherche sera disponible prochainement.</Text>
		</SafeAreaView>
	);
}

const styles = StyleSheet.create({
	input: {
		borderColor: "#767676",
		borderRadius: 8,
		borderWidth: 1,
		fontSize: 18,
		minHeight: 48,
		paddingHorizontal: 12,
	},
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
