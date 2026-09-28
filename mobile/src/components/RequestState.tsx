import { StyleSheet, Text, View } from "react-native";

export function RequestState({ kind }: { kind: "offline" | "stale" }) {
	return (
		<View accessibilityRole="alert" style={styles.container}>
			<Text allowFontScaling style={styles.message}>
				{kind === "offline"
					? "Hors connexion : les fiches enregistrées restent consultables."
					: "Affichage de la dernière version enregistrée pendant la mise à jour."}
			</Text>
			{kind === "offline" ? (
				<Text allowFontScaling style={styles.message}>
					La recherche externe et la création sont suspendues.
				</Text>
			) : null}
		</View>
	);
}

const styles = StyleSheet.create({
	container: { backgroundColor: "#f4f1e8", borderRadius: 8, gap: 4, marginTop: 12, padding: 12 },
	message: { color: "#444444", lineHeight: 20 },
});
