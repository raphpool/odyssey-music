import { StyleSheet, Text, View } from "react-native";

import { readPublicConfig } from "../src/config";

export default function BootstrapScreen() {
	const config = readPublicConfig();

	return (
		<View accessibilityRole="summary" style={styles.container}>
			<Text style={styles.title}>track1</Text>
			<Text style={styles.description}>Your daily music recommendation starts here.</Text>
			<Text style={styles.status}>
				{config.ok ? "Bootstrap ready" : "Configuration required before connecting."}
			</Text>
		</View>
	);
}

const styles = StyleSheet.create({
	container: {
		alignItems: "center",
		backgroundColor: "#101114",
		flex: 1,
		justifyContent: "center",
		padding: 24,
	},
	title: {
		color: "#ffffff",
		fontSize: 36,
		fontWeight: "700",
	},
	description: {
		color: "#c6c8d0",
		fontSize: 17,
		marginTop: 12,
		textAlign: "center",
	},
	status: {
		color: "#8ee5ae",
		fontSize: 14,
		marginTop: 20,
		textAlign: "center",
	},
});
