import { Image, StyleSheet, Text, View } from "react-native";
import { useEffect, useState } from "react";

type NodeImageProps = {
	altText: string;
	imageUrl: string | null | undefined;
};

export function NodeImage({ altText, imageUrl }: NodeImageProps) {
	const [failedUrl, setFailedUrl] = useState<string | undefined>();

	useEffect(() => {
		setFailedUrl(undefined);
	}, [imageUrl]);

	if (imageUrl === undefined || imageUrl === null || imageUrl === "" || failedUrl === imageUrl) {
		return (
			<View accessibilityLabel={`Image indisponible pour ${altText}`} style={styles.placeholder} testID="node-image-fallback">
				<Text allowFontScaling>Image indisponible</Text>
			</View>
		);
	}

	return (
		<Image
			accessibilityLabel={altText}
			resizeMode="cover"
			source={{ uri: imageUrl }}
			style={styles.image}
			testID="node-image"
			onError={() => setFailedUrl(imageUrl)}
		/>
	);
}

const styles = StyleSheet.create({
	image: { backgroundColor: "#eeeeee", borderRadius: 12, height: 220, marginBottom: 20, width: "100%" },
	placeholder: {
		alignItems: "center",
		backgroundColor: "#eeeeee",
		borderRadius: 12,
		height: 120,
		justifyContent: "center",
		marginBottom: 20,
		width: "100%",
	},
});

