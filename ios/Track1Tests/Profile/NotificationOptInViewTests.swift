import SwiftUI
import Track1Core
import UIKit
import XCTest

@testable import Track1

/// The notification opt-in screen (TRA-746), measured on the 393 x 852 frame of the ticket. The system prompt
/// is the system's: what is tested here is what the screen decides (the measures, the copy, one request per
/// passage, whatever the answer), when the screen is shown to a profile that already exists, and what a yes
/// then schedules.
@MainActor
final class NotificationOptInViewTests: XCTestCase {
	private typealias Metrics = NotificationOptInMetrics

	private func rgbaHex(_ color: Color) -> String {
		var red: CGFloat = 0
		var green: CGFloat = 0
		var blue: CGFloat = 0
		var alpha: CGFloat = 0
		UIColor(color).getRed(&red, green: &green, blue: &blue, alpha: &alpha)
		return [red, green, blue, alpha].map { String(format: "%02x", Int(($0 * 255).rounded())) }.joined()
	}

	// MARK: Measures

	func testTheFrameIs393By852() {
		XCTAssertEqual(Metrics.frameWidth, 393)
		XCTAssertEqual(Metrics.frameHeight, 852)
	}

	/// 78 - 59 = 19: the header lands at y 78 under the 59 pt status bar of the frame.
	func testTheHeaderIsAtY78UnderTheStatusBarOfTheFrame() {
		XCTAssertEqual(Metrics.headerTop, 78)
		XCTAssertEqual(Metrics.referenceTopInset, 59)
		XCTAssertEqual(Metrics.headerTopPadding, 19)
	}

	func testTheHeaderHasMarginsOf24OnTheSidesAnd16Below() {
		XCTAssertEqual(Metrics.headerSideInset, 24)
		XCTAssertEqual(Metrics.headerBottomInset, 16)
	}

	func testTheTitleIs345Wide() {
		XCTAssertEqual(Metrics.titleWidth, 345)
	}

	func testTheSubtitleIs8UnderTheTitle() {
		XCTAssertEqual(Metrics.headerTextSpacing, 8)
	}

	/// The title wraps on three lines of 34 and the subtitle on two of 22 in 345 pt: the header ends at the top
	/// of the scene.
	func testTheHeaderEndsWhereTheSceneStarts() {
		let titleLines: CGFloat = 3
		let subtitleLines: CGFloat = 2
		let header =
			Metrics.headerTop + titleLines * Metrics.titleRole.lineHeight + Metrics.headerTextSpacing
			+ subtitleLines * Metrics.subtitleRole.lineHeight + Metrics.headerBottomInset
		XCTAssertEqual(header, Metrics.sceneTop)
	}

	func testTheSceneIs345By520AtY248() {
		XCTAssertEqual(Metrics.sceneSize, CGSize(width: 345, height: 520))
		XCTAssertEqual(Metrics.sceneTop, 248)
	}

	/// The scene is centered: 24 pt on each side of 345 pt on the 393 pt frame.
	func testTheSceneIsCenteredOnTheFrame() {
		XCTAssertEqual((Metrics.frameWidth - Metrics.sceneSize.width) / 2, Metrics.headerSideInset)
	}

	func testTheDeviceOutlineIsAt35And99InTheScene() {
		XCTAssertEqual(Metrics.deviceOutlineOrigin, CGPoint(x: 35, y: 99))
	}

	func testThePreviewIsAt9And249InTheScene() {
		XCTAssertEqual(Metrics.previewOrigin, CGPoint(x: 9, y: 249))
	}

	func testThePreviewIs327Wide() {
		XCTAssertEqual(Metrics.previewWidth, 327)
		XCTAssertEqual(Metrics.previewWidth, NotificationPreviewMetrics.width)
	}

	/// Both layers fit in the scene they are cropped to.
	func testTheStagedLayersFitInTheScene() {
		let outlineRight = Metrics.deviceOutlineOrigin.x + DeviceOutlineMetrics.width
		let previewRight = Metrics.previewOrigin.x + Metrics.previewWidth
		XCTAssertLessThanOrEqual(outlineRight, Metrics.sceneSize.width)
		XCTAssertLessThanOrEqual(previewRight, Metrics.sceneSize.width)
		XCTAssertLessThan(Metrics.previewOrigin.y, Metrics.sceneSize.height)
	}

	func testTheActionBarIsAtY657AndFills195() {
		XCTAssertEqual(Metrics.barTop, 657)
		XCTAssertEqual(Metrics.barHeight, 195)
		XCTAssertEqual(Metrics.barTop + Metrics.barHeight, Metrics.frameHeight)
	}

	/// The bar draws its own fade: the screen's number must be the one it really uses.
	func testTheBarHeightIsTheFadeOfBottomActionBar() {
		XCTAssertEqual(Metrics.barHeight, BottomActionBar.fadeHeight)
	}

	// MARK: Style

	func testTitleIsTitle1InTextPrimary() {
		XCTAssertEqual(Metrics.titleRole, .title1)
		XCTAssertEqual(Metrics.titleRole.face, .jetBrainsMonoBold)
		XCTAssertEqual(Metrics.titleRole.size, 28)
		XCTAssertEqual(Metrics.titleRole.lineHeight, 34)
		XCTAssertEqual(rgbaHex(Metrics.titleColor), "f6e9d8ff", "text/primary")
	}

	func testSubtitleIsBodyMediumInTextSecondary() {
		XCTAssertEqual(Metrics.subtitleRole, .bodyMedium)
		XCTAssertEqual(Metrics.subtitleRole.size, 15)
		XCTAssertEqual(Metrics.subtitleRole.lineHeight, 22)
		XCTAssertEqual(rgbaHex(Metrics.subtitleColor), "c8b6a3ff", "text/secondary")
	}

	/// `screen/gradient-top` at the top to `background/elevated` at 33.099 %, as on the neighbouring screens.
	func testBackgroundIsTheVerticalGradientOfTheScreen() {
		let stops = Metrics.backgroundStops
		XCTAssertEqual(stops.count, 2)
		XCTAssertEqual(stops.map { rgbaHex($0.color) }, ["3d3429ff", "1a110eff"])
		XCTAssertEqual(stops[0].location, 0, accuracy: 0.000001)
		XCTAssertEqual(stops[1].location, 0.33099, accuracy: 0.000001)
	}

	// MARK: Copy, identifiers and accessibility

	func testTextsAreTheFrenchOnesOfTheTicket() {
		XCTAssertEqual(NotificationOptInView.title, "Obtiens ta recommandation quotidienne")
		XCTAssertEqual(
			NotificationOptInView.subtitle, "Chaque jour, un track ou album de tes genres sélectionnés")
		XCTAssertEqual(NotificationOptInView.continueTitle, "Continuer")
	}

	func testThePreviewShowsTheTitleOfTheRealReminderAndTheExampleOfTheTicket() {
		XCTAssertEqual(NotificationOptInView.previewTitle, "Ta recommandation du jour")
		XCTAssertEqual(NotificationOptInView.previewTitle, ReminderPlan.title)
		XCTAssertEqual(NotificationOptInView.previewBody, "Aphex Twin, album Selected Ambient Works 85-92")
	}

	func testIdentifiersAreTheOnesOfTheTicket() {
		XCTAssertEqual(NotificationOptInView.identifier, "onboarding-notifications")
		XCTAssertEqual(NotificationOptInView.continueIdentifier, "onboarding-notifications-continue")
	}

	func testTheTitleIsAHeading() {
		XCTAssertTrue(NotificationOptInView.titleTraits.contains(.isHeader))
	}

	/// VoiceOver reads the preview as one example, and skips the outline of the phone.
	func testThePreviewIsReadAsAnExampleAndTheOutlineIsSkipped() {
		XCTAssertTrue(DeviceOutlineMetrics.isAccessibilityHidden)
		let label = NotificationPreviewMetrics.accessibilityLabel(
			title: NotificationOptInView.previewTitle, body: NotificationOptInView.previewBody)
		XCTAssertEqual(
			label,
			"Exemple de notification : Ta recommandation du jour. "
				+ "Aphex Twin, album Selected Ambient Works 85-92")
	}

	/// No counter, the fade over the scene, one button with the identifier of the screen.
	func testTheBarHasNoCounterAndTheFade() {
		let bar = NotificationOptInView.actionBar {}
		XCTAssertEqual(bar.identifier, "onboarding-notifications-continue")
		XCTAssertTrue(bar.showsFade)
		XCTAssertEqual(bar.parts, [.button])
	}

	// MARK: One request per passage

	func testContinueAsksTheSystemOnceThenContinuesWhateverTheAnswer() async {
		for answer in [true, false] {
			let center = OptInFakeCenter(answer: answer)
			let passage = NotificationOptInPassage()
			let received = Received()

			await passage.proceed(center: center, onContinue: { received.values.append($0) })

			let requests = await center.requests
			XCTAssertEqual(requests, 1, "answer \(answer)")
			XCTAssertEqual(received.values, [answer], "answer \(answer)")
			XCTAssertEqual(passage.phase, .answered(granted: answer))
		}
	}

	/// Nothing is asked until "Continuer" is touched: building the screen does not reach the center.
	func testNothingIsAskedBeforeContinue() async {
		let center = OptInFakeCenter(answer: true)
		_ = NotificationOptInView(center: center) { _ in }
		let passage = NotificationOptInPassage()

		let requests = await center.requests
		XCTAssertEqual(requests, 0)
		XCTAssertEqual(passage.phase, .idle)
	}

	func testASecondTouchWhileTheSystemIsAskingDoesNothing() async throws {
		let center = OptInFakeCenter(answer: true, holdsRequest: true)
		let passage = NotificationOptInPassage()
		let received = Received()
		let first = Task { await passage.proceed(center: center, onContinue: { received.values.append($0) }) }
		var polls = 0
		while await center.requests == 0, polls < 500 {
			polls += 1
			try await Task.sleep(nanoseconds: 10_000_000)
		}

		await passage.proceed(center: center, onContinue: { received.values.append($0) })

		let whileAsking = await center.requests
		XCTAssertEqual(whileAsking, 1)
		XCTAssertEqual(received.values, [], "the second touch must not continue before the answer")
		XCTAssertEqual(passage.phase, .requesting)

		await center.release()
		await first.value

		let requests = await center.requests
		XCTAssertEqual(requests, 1)
		XCTAssertEqual(received.values, [true])
	}

	/// The onboarding keeps the screen when the profile cannot be written and asks for another touch: it goes
	/// on with the answer already given, and the system is not asked again.
	func testATouchAfterTheAnswerContinuesAgainWithoutAskingAgain() async {
		let center = OptInFakeCenter(answer: false)
		let passage = NotificationOptInPassage()
		let received = Received()

		await passage.proceed(center: center, onContinue: { received.values.append($0) })
		await passage.proceed(center: center, onContinue: { received.values.append($0) })

		let requests = await center.requests
		XCTAssertEqual(requests, 1)
		XCTAssertEqual(received.values, [false, false])
	}

	// MARK: When a profile that already exists sees the screen

	func testTheScreenIsClaimedOnceWhenTheSystemWasNeverAsked() async throws {
		let defaults = try makeDefaults()
		let flag = ReminderPromptFlag(defaults: defaults)
		let center = OptInFakeCenter(status: .notDetermined)

		XCTAssertFalse(flag.hasBeenSeen)
		let first = await flag.claimPresentation(center: center)
		XCTAssertTrue(first)
		XCTAssertTrue(flag.hasBeenSeen, "the flag is raised as the screen is claimed")
		let second = await flag.claimPresentation(center: center)
		XCTAssertFalse(second, "never shown twice")
	}

	/// The flag is read again at the next launch: a new instance on the same defaults finds it raised.
	func testTheFlagSurvivesTheNextLaunch() async throws {
		let defaults = try makeDefaults()
		let center = OptInFakeCenter(status: .notDetermined)
		let claimed = await ReminderPromptFlag(defaults: defaults).claimPresentation(center: center)
		XCTAssertTrue(claimed)

		let nextLaunch = ReminderPromptFlag(defaults: defaults)

		XCTAssertTrue(nextLaunch.hasBeenSeen)
		let again = await nextLaunch.claimPresentation(center: center)
		XCTAssertFalse(again)
	}

	func testTheFlagIsStoredUnderTheKeyOfTheTicket() throws {
		let defaults = try makeDefaults()

		ReminderPromptFlag(defaults: defaults).markSeen()

		XCTAssertEqual(ReminderPromptFlag.key, "track1.reminder-prompt-seen")
		XCTAssertTrue(defaults.bool(forKey: "track1.reminder-prompt-seen"))
	}

	/// A granted or refused authorization is never asked again: the screen stays out of the way, and the flag
	/// stays down, as nothing was shown.
	func testTheScreenIsNeverClaimedOnceTheSystemWasAsked() async throws {
		for status in [ReminderAuthorization.authorized, .denied] {
			let flag = ReminderPromptFlag(defaults: try makeDefaults())

			let claimed = await flag.claimPresentation(center: OptInFakeCenter(status: status))

			XCTAssertFalse(claimed, "\(status)")
			XCTAssertFalse(flag.hasBeenSeen, "\(status)")
		}
	}

	func testResettingBeforeUseLowersTheFlag() throws {
		let defaults = try makeDefaults()
		ReminderPromptFlag(defaults: defaults).markSeen()

		let flag = ReminderPromptFlag(defaults: defaults, resetBeforeUse: true)

		XCTAssertFalse(flag.hasBeenSeen)
	}

	// MARK: What a yes schedules

	/// 2026-11-17 12:00 UTC: the plan is the seven days from the 18th, all of them in the future.
	private nonisolated static let fixed = Date(timeIntervalSince1970: 1_794_916_800)
	private static let days = [
		"2026-11-18", "2026-11-19", "2026-11-20", "2026-11-21", "2026-11-22", "2026-11-23", "2026-11-24",
	]
	private static let identifiers = days.map { "daily-\($0)" }

	// XCTest builds one instance per test method, so the directory is fresh without a `setUp`.
	private nonisolated let directoryURL = FileManager.default.temporaryDirectory.appending(
		path: UUID().uuidString, directoryHint: .isDirectory)

	override func tearDownWithError() throws {
		try? FileManager.default.removeItem(at: directoryURL)
	}

	/// Today was served from the cache for days: its plan is complete on disk, so a load plans nothing and
	/// `ReminderSync.sync` has nothing to send. The yes schedules the plan on disk all the same.
	func testAYesSchedulesTheCompletePlanThatIsOnDisk() async throws {
		let store = makeStore()
		let taste = try profile(revision: 1, genre: "rock")
		let first = try makeModel(store: store)
		await first.load(for: taste)
		let planned = first.upcoming
		XCTAssertEqual(planned.map(\.localDate), Self.days)

		let center = OptInFakeCenter(status: .authorized, pending: ["other-1"])
		let sync = makeSync(center)
		let served = try makeModel(store: store)
		await served.load(for: taste)
		await sync.sync(served, for: taste)
		XCTAssertEqual(served.upcoming, [], "the premise: Today alone schedules nothing")
		let before = await center.pendingIdentifiers()
		XCTAssertEqual(before, ["other-1"])

		await scheduleStoredPlan(sync, for: taste, store: store)

		let pending = await center.pendingIdentifiers()
		XCTAssertEqual(pending, ["other-1"] + Self.identifiers)
		let added = await center.added
		XCTAssertEqual(added.map(\.body), planned.map(\.body))
		XCTAssertEqual(added.map(\.title), planned.map(\.title))
	}

	/// An app update: today's entry is on disk and no plan is. Nothing is written and nothing is scheduled:
	/// Today's next load completes the plan.
	func testAYesWithAMissingPlanSchedulesNothingAndWritesNothing() async throws {
		let store = makeStore()
		let taste = try profile(revision: 1, genre: "rock")
		await makeModelAndLoad(store: store, taste: taste)
		let history = await store.history()
		let today = try XCTUnwrap(history.first { $0.localDate == "2026-11-17" })
		_ = await store.save([today])
		let center = OptInFakeCenter(status: .authorized, pending: ["other-1"])

		await scheduleStoredPlan(makeSync(center), for: taste, store: store)

		let added = await center.added
		let removals = await center.removals
		XCTAssertEqual(added, [])
		XCTAssertEqual(removals, [])
		let after = await store.history()
		XCTAssertEqual(after, [today], "the history is only read")
	}

	/// A plan that stops short of the horizon is scheduled as it is, and left as it is on disk.
	func testAYesWithAShortPlanSchedulesWhatIsOnDiskAndWritesNothing() async throws {
		let store = makeStore()
		let taste = try profile(revision: 1, genre: "rock")
		await makeModelAndLoad(store: store, taste: taste)
		let history = await store.history()
		let kept = history.filter { $0.localDate <= "2026-11-19" }
		_ = await store.save(kept)
		let center = OptInFakeCenter(status: .authorized)

		await scheduleStoredPlan(makeSync(center), for: taste, store: store)

		let pending = await center.pendingIdentifiers()
		XCTAssertEqual(pending, ["daily-2026-11-18", "daily-2026-11-19"])
		let after = await store.history()
		XCTAssertEqual(after, kept)
	}

	/// No work for the days to come, nothing to schedule: an empty plan never cancels what is pending.
	func testAYesWithNoRecommendationLeavesThePendingNotifications() async throws {
		let store = makeStore()
		let center = OptInFakeCenter(status: .authorized, pending: ["daily-2026-11-18"])
		let taste = try profile(revision: 1, genre: "rock")

		await scheduleStoredPlan(makeSync(center), for: taste, store: store, readable: false)

		let removals = await center.removals
		XCTAssertEqual(removals, [])
		let pending = await center.pendingIdentifiers()
		XCTAssertEqual(pending, ["daily-2026-11-18"])
	}

	/// A plan on disk but a catalog that cannot be read: the bodies cannot be written, nothing is sent.
	func testAYesWithAnUnreadableCatalogSchedulesNothingAndRemovesNothing() async throws {
		let store = makeStore()
		let taste = try profile(revision: 1, genre: "rock")
		await makeModelAndLoad(store: store, taste: taste)
		let center = OptInFakeCenter(status: .authorized, pending: ["daily-2026-11-18"])

		await scheduleStoredPlan(makeSync(center), for: taste, store: store, readable: false)

		let removals = await center.removals
		XCTAssertEqual(removals, [])
		let added = await center.added
		XCTAssertEqual(added, [])
	}

	/// New tastes since the plan on disk was made: the old plan is not announced for them. Today's load
	/// replaces it and schedules the new one.
	func testAYesDoesNotScheduleThePlanOfOtherTastes() async throws {
		let store = makeStore()
		await makeModelAndLoad(store: store, taste: try profile(revision: 1, genre: "rock"))
		let before = await store.history()
		let center = OptInFakeCenter(status: .authorized, pending: ["daily-2026-11-18"])
		let jazz = try profile(revision: 2, genre: "jazz")

		await scheduleStoredPlan(makeSync(center), for: jazz, store: store)

		let added = await center.added
		let removals = await center.removals
		XCTAssertEqual(added, [])
		XCTAssertEqual(removals, [])
		let after = await store.history()
		XCTAssertEqual(after, before)
	}

	// MARK: Helpers

	private func makeDefaults() throws -> UserDefaults {
		let name = "track1.tests.opt-in.\(UUID().uuidString)"
		addTeardownBlock { UserDefaults(suiteName: name)?.removePersistentDomain(forName: name) }
		return try XCTUnwrap(UserDefaults(suiteName: name))
	}

	private func makeSync(_ center: OptInFakeCenter) -> ReminderSync {
		var calendar = Calendar(identifier: .gregorian)
		calendar.timeZone = .gmt
		return ReminderSync(
			scheduler: ReminderScheduler(center: center, calendar: calendar, now: { Self.fixed }))
	}

	private func scheduleStoredPlan(
		_ sync: ReminderSync, for taste: Profile, store: DailyRecommendationStore, readable: Bool = true
	) async {
		let result: APIResult<Catalog>
		if readable, let loaded = try? catalog() {
			result = .success(loaded, etag: nil)
		} else {
			result = .failure(.network)
		}
		await sync.scheduleStoredPlan(
			for: taste, readCatalog: { result }, store: store, now: { Self.fixed }, timeZone: { .gmt })
	}

	/// Each store has a directory of its own; a test that needs the same disk twice passes the same store.
	private func makeStore() -> DailyRecommendationStore {
		DailyRecommendationStore(
			localStore: LocalStore(directoryURL: directoryURL.appending(path: UUID().uuidString)))
	}

	private func makeModel(store: DailyRecommendationStore) throws -> TodayViewModel {
		let result = APIResult<Catalog>.success(try catalog(), etag: nil)
		return TodayViewModel(readCatalog: { result }, store: store, now: { Self.fixed }, timeZone: { .gmt })
	}

	private func makeModelAndLoad(store: DailyRecommendationStore, taste: Profile) async {
		guard let model = try? makeModel(store: store) else { return XCTFail("no catalog") }
		await model.load(for: taste)
	}

	private func profile(revision: Int, genre: String) throws -> Profile {
		let json: [String: Any] = [
			"version": Profile.version, "local_id": "5B1D3F0A-0000-4000-8000-0000000000AA",
			"genre_ids": ["genre:\(genre)"], "revision": revision, "onboarding_completed": true,
			"flow_id": "5B1D3F0A-0000-4000-8000-0000000000BB", "created_at": 0,
		]
		return try JSONDecoder().decode(Profile.self, from: JSONSerialization.data(withJSONObject: json))
	}

	/// Two genres, each with an album and a track: other tastes give other works.
	private func catalog() throws -> Catalog {
		let works = [
			("project:beta", "genre:rock"), ("track:gamma", "genre:rock"),
			("project:epsilon", "genre:jazz"), ("track:zeta", "genre:jazz"),
		]
		let genres = [("genre:rock", "Rock"), ("genre:jazz", "Jazz")]
		let titles = [
			("project:beta", "Beta"), ("track:gamma", "Gamma"), ("project:epsilon", "Epsilon"), ("track:zeta", "Zeta"),
		]
		let nodes = genres + titles
		let payload: [String: Any] = [
			"version": "v1", "revision": "sha256:" + String(repeating: "0123456789abcdef", count: 4),
			"taxonomy": ["mode": "degraded", "available": true],
			"nodes": nodes.map { id, name in
				["identity": id, "type": String(id.prefix { $0 != ":" }), "name": name, "teaser": NSNull()]
			},
			"edges": works.map { ["source": $0.0, "target": $0.1, "type": "genres"] },
		]
		return try JSONDecoder().decode(Catalog.self, from: JSONSerialization.data(withJSONObject: payload))
	}
}

/// What `onContinue` received, in order. A reference, so that a closure that is not isolated can write it.
@MainActor
private final class Received {
	var values: [Bool] = []
}

/// A notification center that records what the screen and the scheduler ask of it.
private actor OptInFakeCenter: ReminderCenter {
	struct Added: Equatable, Sendable {
		let identifier: String
		let title: String
		let body: String
	}

	private let status: ReminderAuthorization
	private let answer: Bool
	private let holdsRequest: Bool
	private var gate: CheckedContinuation<Void, Never>?
	private var pending: [String]
	private(set) var added: [Added] = []
	private(set) var removals: [[String]] = []
	private(set) var requests = 0

	/// `holdsRequest` keeps the system prompt open: `requestAuthorization()` waits for `release()`.
	init(
		status: ReminderAuthorization = .notDetermined, answer: Bool = true, holdsRequest: Bool = false,
		pending: [String] = []
	) {
		self.status = status
		self.answer = answer
		self.holdsRequest = holdsRequest
		self.pending = pending
	}

	func authorization() async -> ReminderAuthorization { status }

	func requestAuthorization() async -> Bool {
		requests += 1
		if holdsRequest {
			await withCheckedContinuation { gate = $0 }
		}
		return answer
	}

	func release() {
		gate?.resume()
		gate = nil
	}

	func pendingIdentifiers() async -> [String] { pending }

	func remove(identifiers: [String]) async {
		removals.append(identifiers)
		pending.removeAll { identifiers.contains($0) }
	}

	func add(identifier: String, title: String, body: String, date: DateComponents) async {
		added.append(Added(identifier: identifier, title: title, body: body))
		pending.removeAll { $0 == identifier }
		pending.append(identifier)
	}
}
