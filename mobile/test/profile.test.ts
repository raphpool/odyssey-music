import { isUuid, MINIMUM_GENRES, parseProfile, selectionIsComplete } from "../src/profile/model";
import {
	PROFILE_DRAFT_STORAGE_KEY,
	PROFILE_ONBOARDING_COMPLETION_STORAGE_KEY,
	PROFILE_ONBOARDING_PURGE_STORAGE_KEY,
	PROFILE_ONBOARDING_STARTED_STORAGE_KEY,
	PROFILE_STORAGE_KEY,
	type ProfileStorage,
	ProfileStore,
} from "../src/profile/store";

const FLOW_ID = "11111111-1111-4111-8111-111111111111";
const LOCAL_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_FLOW_ID = "33333333-3333-4333-8333-333333333333";
const EVENT_ID = "44444444-4444-4444-8444-444444444444";
const OCCURRED_AT = "2026-09-27T10:00:00.000Z";
const genres = ["genre:ambient", "genre:house", "genre:jazz"];

function storage(initial: Record<string, string> = {}, fail?: "get" | "set" | "remove" | "keys") {
	const values = new Map(Object.entries(initial));
	const reject = (operation: string) => async (): Promise<never> => Promise.reject(new Error(operation));
	return {
		values,
		getItem: fail === "get" ? reject("get") : async (key: string) => values.get(key) ?? null,
		setItem:
			fail === "set" ? reject("set") : async (key: string, value: string) => void values.set(key, value),
		removeItem: fail === "remove" ? reject("remove") : async (key: string) => void values.delete(key),
		getAllKeys: fail === "keys" ? reject("keys") : async () => [...values.keys()],
	} satisfies ProfileStorage & { values: Map<string, string> };
}

describe("music profile store", () => {
	it("requires three choices unless the catalog only contains one or two genres", () => {
		expect(MINIMUM_GENRES).toBe(3);
		expect(selectionIsComplete(genres.slice(0, 2), genres)).toBe(false);
		expect(selectionIsComplete(genres, genres)).toBe(true);
		expect(selectionIsComplete(["genre:ambient"], ["genre:ambient"])).toBe(true);
		expect(selectionIsComplete(["genre:ambient"], ["genre:ambient", "genre:house"])).toBe(false);
		expect(selectionIsComplete(["genre:ambient", "genre:house"], ["genre:ambient", "genre:house"])).toBe(
			true,
		);
		expect(selectionIsComplete([], [])).toBe(false);
	});

	it("persists only the versioned local profile and increments revision once when genres change", async () => {
		const memory = storage();
		const store = new ProfileStore(memory, () => LOCAL_ID);

		const first = await store.commit({ genreIds: genres, availableGenreIds: genres, flowId: FLOW_ID });
		expect(first).toEqual(
			expect.objectContaining({
				kind: "saved",
				profile: expect.objectContaining({ local_id: LOCAL_ID, revision: 1, genre_ids: genres }),
			}),
		);
		const same = await store.commit({ genreIds: genres, availableGenreIds: genres, flowId: OTHER_FLOW_ID });
		expect(isUuid(OTHER_FLOW_ID)).toBe(true);
		expect(same).toEqual(
			expect.objectContaining({ kind: "saved", profile: expect.objectContaining({ revision: 1 }) }),
		);
		const changed = await store.commit({
			genreIds: ["genre:ambient", "genre:house", "genre:techno"],
			availableGenreIds: ["genre:ambient", "genre:house", "genre:techno"],
			flowId: OTHER_FLOW_ID,
		});
		expect(changed).toEqual(
			expect.objectContaining({ kind: "saved", profile: expect.objectContaining({ revision: 2 }) }),
		);
		expect(await store.read()).toEqual(expect.objectContaining({ kind: "profile" }));
		expect(memory.values.get(PROFILE_STORAGE_KEY)).not.toContain("email");
		expect(memory.values.get(PROFILE_STORAGE_KEY)).not.toContain("name");
	});

	it("resumes the persisted draft rather than creating a second flow", async () => {
		const memory = storage();
		const store = new ProfileStore(memory, () => FLOW_ID);

		const first = await store.beginDraft(["genre:ambient"]);
		expect(first).toEqual(expect.objectContaining({ flow_id: FLOW_ID, genre_ids: ["genre:ambient"] }));
		const resumed = await store.beginDraft(["genre:house"]);
		expect(resumed).toEqual(first);
		if (first === undefined) throw new Error("The draft should have been persisted.");
		await store.saveDraft({ ...first, genre_ids: ["genre:ambient", "genre:house"], started_recorded: true });
		expect(await store.readDraft()).toEqual(
			expect.objectContaining({ genre_ids: ["genre:ambient", "genre:house"], started_recorded: true }),
		);
	});

	it("signals corrupt and future profile versions instead of silently accepting them", async () => {
		const corrupt = new ProfileStore(storage({ [PROFILE_STORAGE_KEY]: "not-json" }), () => LOCAL_ID);
		expect(await corrupt.read()).toEqual({ kind: "corrupt" });
		const future = new ProfileStore(
			storage({
				[PROFILE_STORAGE_KEY]: JSON.stringify({
					version: 2,
					local_id: LOCAL_ID,
					genre_ids: genres,
					revision: 1,
					onboarding_completed: true,
					flow_id: FLOW_ID,
				}),
			}),
			() => LOCAL_ID,
		);
		expect(await future.read()).toEqual({ kind: "corrupt" });
		expect(
			parseProfile({
				version: 1,
				local_id: LOCAL_ID,
				genre_ids: [...genres, genres[0]],
				revision: 1,
				onboarding_completed: true,
				flow_id: FLOW_ID,
			}),
		).toBeUndefined();
	});

	it("does not claim a successful write or clear when storage fails", async () => {
		expect(
			await new ProfileStore(storage({}, "set"), () => LOCAL_ID).commit({
				genreIds: genres,
				availableGenreIds: genres,
				flowId: FLOW_ID,
			}),
		).toEqual({ kind: "unavailable" });
		expect(await new ProfileStore(storage({}, "keys"), () => LOCAL_ID).clear()).toEqual({
			kind: "unavailable",
		});
		const pending = storage({
			[PROFILE_ONBOARDING_COMPLETION_STORAGE_KEY]: JSON.stringify({
				version: 1,
				flow_id: FLOW_ID,
				event_id: EVENT_ID,
				genres_count: 3,
				occurred_at: OCCURRED_AT,
			}),
		});
		const removeItem = pending.removeItem;
		pending.removeItem = async (key) => {
			if (key === PROFILE_ONBOARDING_COMPLETION_STORAGE_KEY) throw new Error("ack write failed");
			return removeItem(key);
		};
		const completionStore = new ProfileStore(pending, () => LOCAL_ID);
		expect(await completionStore.acknowledgeOnboardingCompletion(EVENT_ID)).toBe(false);
		expect(await completionStore.readOnboardingCompletion()).toEqual(
			expect.objectContaining({ event_id: EVENT_ID }),
		);
	});

	it("keeps a stable completion id but updates its count when a failed profile write is retried", async () => {
		const memory = storage();
		const savedSetItem = memory.setItem;
		let failProfileWrite = true;
		memory.setItem = async (key, value) => {
			if (key === PROFILE_STORAGE_KEY && failProfileWrite) throw new Error("profile write failed");
			return savedSetItem(key, value);
		};
		const ids = [LOCAL_ID, "44444444-4444-4444-8444-444444444444", LOCAL_ID];
		let nextId = 0;
		let occurredAt = OCCURRED_AT;
		const store = new ProfileStore(
			memory,
			() => ids[nextId++] ?? LOCAL_ID,
			() => occurredAt,
		);

		expect(
			await store.commit({
				genreIds: genres,
				availableGenreIds: genres,
				flowId: FLOW_ID,
				trackOnboardingCompletion: true,
			}),
		).toEqual({ kind: "unavailable" });
		const eventId = (await store.readOnboardingCompletion())?.event_id;
		failProfileWrite = false;
		occurredAt = "2026-09-27T10:01:00.000Z";
		const saved = await store.commit({
			genreIds: [...genres, "genre:techno"],
			availableGenreIds: [...genres, "genre:techno"],
			flowId: FLOW_ID,
			trackOnboardingCompletion: true,
		});
		expect(saved).toEqual(expect.objectContaining({ kind: "saved" }));
		const restarted = new ProfileStore(
			memory,
			() => LOCAL_ID,
			() => occurredAt,
		);
		const pending = await restarted.readOnboardingCompletion();
		expect(pending).toEqual({
			version: 1,
			flow_id: FLOW_ID,
			event_id: eventId,
			genres_count: 4,
			occurred_at: "2026-09-27T10:01:00.000Z",
		});
		expect(await restarted.acknowledgeOnboardingCompletion("55555555-5555-4555-8555-555555555555")).toBe(
			false,
		);
		expect(await restarted.readOnboardingCompletion()).toEqual(pending);
		expect(await restarted.acknowledgeOnboardingCompletion(pending?.event_id ?? "")).toBe(true);
		expect(await restarted.readOnboardingCompletion()).toBeUndefined();
	});

	it("keeps onboarding start pending until its accepted dispatch and reuses its event after restart", async () => {
		const memory = storage();
		const ids = [FLOW_ID, EVENT_ID];
		let nextId = 0;
		const first = new ProfileStore(
			memory,
			() => ids[nextId++] ?? LOCAL_ID,
			() => OCCURRED_AT,
		);
		const draft = await first.beginDraft();
		if (draft === undefined) throw new Error("The draft should have been persisted.");
		const pending = await first.prepareOnboardingStarted(draft.flow_id);
		expect(pending).toEqual({ version: 1, flow_id: FLOW_ID, event_id: EVENT_ID, occurred_at: OCCURRED_AT });
		expect(await first.readDraft()).toEqual(expect.objectContaining({ started_recorded: false }));

		const restarted = new ProfileStore(
			memory,
			() => LOCAL_ID,
			() => "2026-09-27T10:01:00.000Z",
		);
		expect(await restarted.prepareOnboardingStarted(FLOW_ID)).toEqual(pending);
		expect(await restarted.acknowledgeOnboardingStarted(EVENT_ID)).toBe(true);
		expect(await restarted.readOnboardingStarted()).toBeUndefined();
		expect(await restarted.readDraft()).toEqual(expect.objectContaining({ started_recorded: true }));
	});

	it("purges both analytics outboxes without relying on a successful read", async () => {
		const memory = storage(
			{
				[PROFILE_ONBOARDING_STARTED_STORAGE_KEY]: "started",
				[PROFILE_ONBOARDING_COMPLETION_STORAGE_KEY]: "completion",
			},
			"get",
		);
		const store = new ProfileStore(memory, () => LOCAL_ID);

		expect(await store.discardOnboardingOutboxes()).toBe(true);
		expect(memory.values.has(PROFILE_ONBOARDING_STARTED_STORAGE_KEY)).toBe(false);
		expect(memory.values.has(PROFILE_ONBOARDING_COMPLETION_STORAGE_KEY)).toBe(false);
	});

	it("blocks replay until a failed outbox purge is durably completed", async () => {
		const memory = storage({
			[PROFILE_ONBOARDING_STARTED_STORAGE_KEY]: "started",
			[PROFILE_ONBOARDING_COMPLETION_STORAGE_KEY]: "completion",
		});
		const removeItem = memory.removeItem;
		let failPurge = true;
		memory.removeItem = async (key) => {
			if (failPurge && key === PROFILE_ONBOARDING_STARTED_STORAGE_KEY) throw new Error("storage unavailable");
			return removeItem(key);
		};
		const store = new ProfileStore(
			memory,
			() => FLOW_ID,
			() => OCCURRED_AT,
		);

		expect(await store.discardOnboardingOutboxes()).toBe(false);
		expect(memory.values.get(PROFILE_ONBOARDING_PURGE_STORAGE_KEY)).toBe("pending");
		expect(await store.onboardingOutboxPurgePending()).toBe(true);
		expect(await store.prepareOnboardingStarted(FLOW_ID)).toBeUndefined();

		failPurge = false;
		expect(await store.discardOnboardingOutboxes()).toBe(true);
		expect(await store.onboardingOutboxPurgePending()).toBe(false);
		expect(memory.values.has(PROFILE_ONBOARDING_STARTED_STORAGE_KEY)).toBe(false);
		expect(memory.values.has(PROFILE_ONBOARDING_COMPLETION_STORAGE_KEY)).toBe(false);
	});

	it("serializes acknowledgement before writing a newer completion event", async () => {
		const memory = storage();
		const ids = [LOCAL_ID, "44444444-4444-4444-8444-444444444444", "55555555-5555-4555-8555-555555555555"];
		let nextId = 0;
		const first = new ProfileStore(memory, () => ids[nextId++] ?? LOCAL_ID);
		await first.commit({
			genreIds: genres,
			availableGenreIds: genres,
			flowId: FLOW_ID,
			trackOnboardingCompletion: true,
		});
		const eventId = (await first.readOnboardingCompletion())?.event_id ?? "";
		const second = new ProfileStore(memory, () => ids[nextId++] ?? LOCAL_ID);
		await Promise.all([
			first.acknowledgeOnboardingCompletion(eventId),
			second.commit({
				genreIds: [...genres, "genre:techno"],
				availableGenreIds: [...genres, "genre:techno"],
				flowId: OTHER_FLOW_ID,
				trackOnboardingCompletion: true,
			}),
		]);
		expect(await second.readOnboardingCompletion()).toEqual(
			expect.objectContaining({ flow_id: OTHER_FLOW_ID, event_id: "55555555-5555-4555-8555-555555555555" }),
		);
	});

	it("clears only the music profile, draft and recommendation keys", async () => {
		const memory = storage({
			[PROFILE_STORAGE_KEY]: "profile",
			[PROFILE_DRAFT_STORAGE_KEY]: "draft",
			"track1.recommendation.v1": "today",
			"track1.recommendation.history.v1": "history",
			[PROFILE_ONBOARDING_COMPLETION_STORAGE_KEY]: "completion",
			[PROFILE_ONBOARDING_STARTED_STORAGE_KEY]: "started",
			"track1.analytics-consent.v1": "granted",
			"track1.push-subscription.v1": "push",
		});

		expect(await new ProfileStore(memory, () => LOCAL_ID).clear()).toEqual({ kind: "cleared" });
		expect(memory.values.has(PROFILE_STORAGE_KEY)).toBe(false);
		expect(memory.values.has(PROFILE_DRAFT_STORAGE_KEY)).toBe(false);
		expect(memory.values.has("track1.recommendation.v1")).toBe(false);
		expect(memory.values.has(PROFILE_ONBOARDING_COMPLETION_STORAGE_KEY)).toBe(false);
		expect(memory.values.has(PROFILE_ONBOARDING_STARTED_STORAGE_KEY)).toBe(false);
		expect(memory.values.get("track1.analytics-consent.v1")).toBe("granted");
		expect(memory.values.get("track1.push-subscription.v1")).toBe("push");
	});
});
