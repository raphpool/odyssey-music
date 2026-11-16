import XCTest

@testable import Track1Core

final class ArticleSentencesTests: XCTestCase {
	// MARK: - Mockup (Figma 338:2479, 338:2480, 338:2491)

	private static let mockupSentences = [
		"\"Pulse X\" by the producer Youngstar (of the crew Musical Mob) is widely considered the foundational "
			+ "\"year zero\" document of the grime genre.",
		"First released on 12-inch vinyl in early 2002, the track served as a radical departure from the UK "
			+ "garage and 2-step sounds that dominated London’s underground at the time.",
		"With its aggressive, stripped-back minimalism—built on a recurring 16-bar loop that alternates between "
			+ "2-step patterns and a dry, brutalist kick-and-snare rhythm—the track created essential empty space "
			+ "that allowed MCs to command the spotlight.",
	]

	func testMockupTextGivesExactlyItsThreeSentences() {
		let article = Self.mockupSentences.joined(separator: " ")
		XCTAssertEqual(ArticleSentences.split(article), Self.mockupSentences)
	}

	// MARK: - No cut inside an abbreviation or a number

	func testDottedAbbreviationDoesNotCut() {
		let sentence = "Many producers shaped the U.K. garage scene in the late nineties."
		XCTAssertEqual(ArticleSentences.split(sentence), [sentence])
	}

	/// Foundation may cut after `feat.` because a capital letter follows. The tail is then shorter than the
	/// 25-character floor and rule 7 glues it back, which is the behaviour this test pins down.
	func testFeaturingAbbreviationDoesNotCut() {
		let sentence = "The single was a collaboration with Flying Lotus feat. Thundercat."
		XCTAssertEqual(ArticleSentences.split(sentence), [sentence])
	}

	func testDecimalNumberDoesNotCut() {
		let sentence = "The label reported 2.5 million streams in its first month."
		XCTAssertEqual(ArticleSentences.split(sentence), [sentence])
	}

	// MARK: - Line markers

	private static let markedLines = [
		"# A short history of grime music",
		"",
		"Grime emerged in East London in the early 2000s.",
		"",
		"## The first generation of artists",
		"- Wiley produced the early instrumentals.",
		"* Dizzee Rascal released his debut album.",
		"  1. Skepta won the Mercury Prize in 2016.",
	]

	func testHeadingAndListMarkersAreRemovedAndTheirTextKept() {
		let sentences = ArticleSentences.split(Self.markedLines.joined(separator: "\n"))
		XCTAssertEqual(
			sentences,
			[
				"A short history of grime music",
				"Grime emerged in East London in the early 2000s.",
				"The first generation of artists",
				"Wiley produced the early instrumentals.",
				"Dizzee Rascal released his debut album.",
				"Skepta won the Mercury Prize in 2016.",
			])
	}

	func testOnlyAMarkerFollowedByASpaceIsRemoved() {
		// "2.5" and a year at the start of a line are text, not list markers.
		XCTAssertEqual(
			ArticleSentences.split("2.5 million people streamed the record in its first week."),
			["2.5 million people streamed the record in its first week."])
		XCTAssertEqual(
			ArticleSentences.split("#1 on the chart for six weeks after the release date."),
			["#1 on the chart for six weeks after the release date."])
	}

	// MARK: - Line endings

	func testWindowsLineEndingsGiveTheSameSentencesAsUnixOnes() {
		let unix = Self.markedLines.joined(separator: "\n")
		let windows = Self.markedLines.joined(separator: "\r\n")
		XCTAssertEqual(ArticleSentences.split(windows), ArticleSentences.split(unix))
	}

	// MARK: - Inline markup and note calls

	func testInlineMarkupAndNoteCallsAreRemoved() {
		let article =
			"**Grime** is a genre of [electronic music](https://en.wikipedia.org/wiki/Electronic_music_(genre)) "
			+ "with *dark* bass.[1] It began in East London in the early 2000s.[12]"
		XCTAssertEqual(
			ArticleSentences.split(article),
			[
				"Grime is a genre of electronic music with dark bass.",
				"It began in East London in the early 2000s.",
			])
	}

	func testABracketedTempoInATitleIsNotTakenForANoteCall() {
		let sentence = "Some titles end with a bracketed tempo, as in XMAS EVET10 [120] and minipops 67 [120.2]."
		XCTAssertEqual(ArticleSentences.split(sentence), [sentence])
	}

	func testALinkTargetNeverSurvivesInTheOutput() {
		let article = "Read the [full history of grime music](https://example.com/grime) before the gig."
		let sentences = ArticleSentences.split(article)
		XCTAssertEqual(sentences, ["Read the full history of grime music before the gig."])
		XCTAssertFalse(sentences.joined().contains("example.com"))
	}

	// MARK: - Short fragments (rule 7)

	func testSeeAlsoNoteCallLeavesAFragmentGluedToThePreviousSentence() {
		let article = "It was released in 2002 on an independent label. Voir aussi [3]."
		XCTAssertEqual(
			ArticleSentences.split(article),
			["It was released in 2002 on an independent label. Voir aussi."])
	}

	func testShortFirstFragmentIsGluedToTheNextSentence() {
		let article = "Voir aussi [3].\n\nGrime emerged in East London in the early 2000s."
		XCTAssertEqual(
			ArticleSentences.split(article),
			["Voir aussi. Grime emerged in East London in the early 2000s."])
	}

	func testSeveralShortFragmentsInARowAllJoinTheSentenceBeforeThem() {
		let article = "Grime emerged in East London in the early 2000s. Yes. No."
		XCTAssertEqual(ArticleSentences.split(article), [article])
	}

	func testAnArticleMadeOfOneShortFragmentIsKeptRatherThanDropped() {
		XCTAssertEqual(ArticleSentences.split("Hello there."), ["Hello there."])
	}

	// MARK: - Empty

	func testEmptyOrBlankArticleGivesNoSentence() {
		XCTAssertEqual(ArticleSentences.split(""), [])
		XCTAssertEqual(ArticleSentences.split("   \n\t \r\n  "), [])
		XCTAssertEqual(ArticleSentences.split("#\n-\n[1]"), [])
	}

	// MARK: - Real articles (copied from cache/nodes, read-only)

	/// `cache/nodes/project/100-rap-francais--jarod.json`, field `editorial_article`.
	private static let projectArticle = """
		100% Rap Français represents a recurring branding and compilation series within the French \
		hip-hop landscape, documenting the evolution of the genre from the turn of the millennium \
		through the late 2000s. These compilations and mixtapes, which frequently appeared in various \
		formats including CD and cassette, served as essential platforms for showcasing both \
		established figures and emerging talent within the local scene. By aggregating tracks from \
		diverse artists, these releases provided a comprehensive snapshot of the stylistic shifts and \
		lyrical themes prevalent in French rap during this era, ranging from underground street anthems \
		to more mainstream-oriented productions. The series remains a significant archival touchstone \
		for collectors and enthusiasts of the French hip-hop movement, reflecting the vibrant and often \
		fragmented nature of the industry during the early 2000s.
		"""

	/// `cache/nodes/track/1-1--brian-eno.json`, field `editorial_article`: two paragraphs and an italic title.
	private static let trackArticle = """
		"1/1" is the seminal opening track of Brian Eno’s 1978 masterpiece, *Ambient 1: Music for \
		Airports*. Widely considered the defining moment of the ambient genre, the piece emerged from \
		Eno's desire to create music that functioned as a sound installation, specifically designed to \
		counteract the "nervous" and "tingly" piped-in music he encountered at Cologne Bonn Airport. By \
		moving away from the conventional structures of popular music, Eno sought to create an \
		environment that could be both listened to attentively and ignored—a concept that has since \
		become a cornerstone of ambient theory.

		Technically, the track is a triumph of generative sound design. It was constructed using a \
		sophisticated system of twenty-two tape loops of varying lengths—some up to seventy feet long. \
		These loops featured fragmented recordings of piano notes and choral vocal clusters, which were \
		left to run and interact with one another according to the laws of chance and superposition. \
		Because the loops were of different, non-harmonic lengths, their cycles shifted constantly \
		against each other, ensuring that the musical pattern would not repeat in the same way for a \
		massive duration of time. This approach created a sense of "eternal" music, where the \
		composition feels suspended in space, perfectly embodying Eno’s philosophy of the studio as a \
		compositional tool. "1/1" remains a profound achievement, influencing decades of experimental, \
		minimalist, and electronic composers who look to its gentle, atmospheric textures as a primary \
		inspiration.
		"""

	func testRealProjectArticleGivesNoEmptySentenceAndNoShortFragment() {
		let sentences = ArticleSentences.split(Self.projectArticle)
		assertWellFormed(sentences)
		XCTAssertEqual(sentences.count, 4)
		// A plain one-paragraph text loses nothing: the sentences put back end to end are the article.
		XCTAssertEqual(sentences.joined(separator: " "), Self.projectArticle)
	}

	func testRealTrackArticleGivesNoEmptySentenceAndNoShortFragment() {
		let sentences = ArticleSentences.split(Self.trackArticle)
		assertWellFormed(sentences)
		XCTAssertFalse(sentences.contains { $0.contains("*") }, "the italic markers are removed")
		XCTAssertEqual(sentences.first?.hasSuffix("Music for Airports."), true)
	}

	private func assertWellFormed(_ sentences: [String], file: StaticString = #filePath, line: UInt = #line) {
		XCTAssertFalse(sentences.isEmpty, file: file, line: line)
		for sentence in sentences {
			let trimmed = sentence.trimmingCharacters(in: .whitespacesAndNewlines)
			XCTAssertEqual(sentence, trimmed, file: file, line: line)
			// 25 on purpose, not read from the implementation: the test must fail if the floor is lowered.
			XCTAssertGreaterThanOrEqual(sentence.count, 25, sentence, file: file, line: line)
		}
	}
}
