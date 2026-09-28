import { Linking, Pressable, StyleSheet, Text, View } from "react-native";

export type NodeCitation = {
	url: string;
	title?: string | undefined;
};

type ArticleBlock =
	| { kind: "paragraph"; text: string }
	| { kind: "list"; items: string[] };

function isSafeCitationUrl(value: string): boolean {
	try {
		const url = new URL(value);
		const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
		if (
			url.protocol !== "https:" ||
			url.username !== "" ||
			url.password !== "" ||
			url.port !== "" ||
			hostname === "localhost" ||
			hostname.endsWith(".localhost") ||
			hostname === "::1" ||
			hostname === "::"
		)
			return false;
		if (hostname.includes(":")) return !hostname.startsWith("fc") && !hostname.startsWith("fd");
		const octets = hostname.split(".").map((part) => Number(part));
		if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
		const first = octets[0] ?? 0;
		const second = octets[1] ?? 0;
		return !(
			first === 0 ||
			first === 10 ||
			first === 127 ||
			(first === 169 && second === 254) ||
			(first === 172 && second >= 16 && second <= 31) ||
			(first === 192 && second === 168)
		);
	} catch {
		return false;
	}
}

function parseArticle(article: string): ArticleBlock[] {
	const lines = article.replace(/\r\n?/g, "\n").split("\n");
	const blocks: ArticleBlock[] = [];
	let paragraph: string[] = [];
	let list: string[] = [];

	const flushParagraph = () => {
		if (paragraph.length > 0) {
			blocks.push({ kind: "paragraph", text: paragraph.join(" ") });
			paragraph = [];
		}
	};
	const flushList = () => {
		if (list.length > 0) {
			blocks.push({ kind: "list", items: list });
			list = [];
		}
	};

	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed === "") {
			flushParagraph();
			flushList();
			continue;
		}
		const item = /^(?:[-*•]|\d+[.)])\s+(.+)$/.exec(trimmed)?.[1];
		if (item !== undefined) {
			flushParagraph();
			list.push(item);
		} else {
			flushList();
			paragraph.push(trimmed);
		}
	}
	flushParagraph();
	flushList();
	return blocks;
}

export function NodeArticle({ article, citations }: { article: string; citations: NodeCitation[] }) {
	const blocks = parseArticle(article);
	return (
		<View>
			<Text accessibilityRole="header" allowFontScaling style={styles.heading}>
				Article
			</Text>
			<View>
				{blocks.map((block, index) =>
					block.kind === "paragraph" ? (
						<Text allowFontScaling key={`paragraph-${index}`} style={styles.paragraph}>
							{block.text}
						</Text>
					) : (
						<View key={`list-${index}`} style={styles.list}>
							{block.items.map((item, itemIndex) => (
								<Text allowFontScaling key={`${index}-${itemIndex}`} style={styles.listItem}>
									{`• ${item}`}
								</Text>
							))}
						</View>
					),
				)}
			</View>
			<Text accessibilityRole="header" allowFontScaling style={styles.heading}>
				Sources
			</Text>
			{citations.length === 0 ? (
				<Text allowFontScaling>Aucune source disponible.</Text>
			) : (
				<View>
					{citations.map((citation, index) => {
						const label = citation.title ?? citation.url;
						const content = (
							<View>
								<Text allowFontScaling style={styles.sourceTitle}>
									{label}
								</Text>
								<Text allowFontScaling style={styles.sourceUrl}>
									{citation.url}
								</Text>
							</View>
						);
						return isSafeCitationUrl(citation.url) ? (
							<Pressable
								accessibilityLabel={`Ouvrir la source ${label}`}
								accessibilityRole="link"
								key={`citation-${index}`}
								onPress={() => void Linking.openURL(citation.url).catch(() => undefined)}
								style={styles.source}
							>
								{content}
							</Pressable>
						) : (
							<View key={`citation-${index}`} style={styles.source}>
								{content}
							</View>
						);
					})}
				</View>
			)}
		</View>
	);
}

const styles = StyleSheet.create({
	heading: { fontSize: 22, fontWeight: "700", lineHeight: 30, marginTop: 28, marginBottom: 12 },
	paragraph: { fontSize: 17, lineHeight: 26, marginBottom: 14 },
	list: { marginBottom: 14 },
	listItem: { fontSize: 17, lineHeight: 26, marginBottom: 6, paddingLeft: 4 },
	source: { borderColor: "#d0d0d0", borderRadius: 8, borderWidth: 1, marginBottom: 10, padding: 12 },
	sourceTitle: { fontSize: 16, fontWeight: "600", lineHeight: 22 },
	sourceUrl: { color: "#4d4d4d", fontSize: 14, lineHeight: 20, marginTop: 4 },
});

export { isSafeCitationUrl, parseArticle };
