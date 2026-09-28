import type { Catalog } from "../src/api/contracts";
import type { Profile } from "../src/profile/model";
import { DailyRecommendationStore, recommendDaily } from "../src/recommendation/daily";

const LOCAL_ID = "11111111-1111-4111-8111-111111111111";
const FLOW_ID = "22222222-2222-4222-8222-222222222222";
const RECOMMENDATION_ID = "33333333-3333-4333-8333-333333333333";
const revision = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function profile(revisionNumber = 1): Profile {
	return {
		version: 1,
		local_id: LOCAL_ID,
		genre_ids: ["genre:ambient"],
		revision: revisionNumber,
		onboarding_completed: true,
		flow_id: FLOW_ID,
	};
}

function catalog(count = 3): Catalog {
	const nodes = [
		{ identity: "genre:ambient", name: "Ambient", teaser: null, type: "genre" as const },
		...Array.from({ length: count }, (_, index) => ({
			identity: `artist:artist-${index}`,
			name: `Artist ${index}`,
			teaser: `Teaser ${index}`,
			type: "artist" as const,
		})),
	];
	return {
		version: "v1",
		revision,
		taxonomy: { mode: "degraded", available: true },
		nodes,
		edges: nodes.slice(1).map((node) => ({ source: node.identity, target: "genre:ambient", type: "genres" })),
	};
}

function memory(values = new Map<string, string>()) {
	return {
		values,
		getItem: async (key: string) => values.get(key) ?? null,
		setItem: async (key: string, value: string) => void values.set(key, value),
		removeItem: async (key: string) => void values.delete(key),
	};
}

describe("recommendDaily", () => {
	it("persists a same-day selection and reasons before returning it despite a refreshed catalog", async () => {
		const storage = memory();
		const store = new DailyRecommendationStore(storage, () => RECOMMENDATION_ID);
		const first = await recommendDaily({
			store,
			profile: profile(),
			catalog: catalog(),
			localDate: "2026-09-27",
		});
		const second = await recommendDaily({
			store: new DailyRecommendationStore(storage, () => "44444444-4444-4444-8444-444444444444"),
			profile: profile(),
			catalog: {
				...catalog(),
				revision: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			},
			localDate: "2026-09-27",
		});

		expect(first).toEqual({ kind: "recommendation", recommendation: expect.any(Object) });
		expect(second).toEqual(first);
	});

	it("changes dates, reuses a visited local date after a timezone return, and recalculates on taste revision", async () => {
		const storage = memory();
		const store = new DailyRecommendationStore(storage, () => RECOMMENDATION_ID);
		const first = await recommendDaily({
			store,
			profile: profile(),
			catalog: catalog(),
			localDate: "2026-09-27",
		});
		const tomorrow = await recommendDaily({
			store,
			profile: profile(),
			catalog: catalog(),
			localDate: "2026-09-28",
		});
		const returned = await recommendDaily({
			store,
			profile: profile(),
			catalog: catalog(),
			localDate: "2026-09-27",
		});
		const revised = await recommendDaily({
			store,
			profile: profile(2),
			catalog: catalog(),
			localDate: "2026-09-27",
		});

		expect(tomorrow).not.toEqual(first);
		expect(returned).toEqual(first);
		expect(revised).toEqual({
			kind: "recommendation",
			recommendation: expect.objectContaining({ profile_revision: 2 }),
		});
	});

	it("excludes the forty latest candidates when an unseen one exists, then starts a new cycle", async () => {
		const storage = memory();
		const store = new DailyRecommendationStore(storage, () => RECOMMENDATION_ID);
		const source = catalog(41);
		const selected = new Set<string>();
		for (let day = 1; day <= 41; day += 1) {
			const result = await recommendDaily({
				store,
				profile: profile(),
				catalog: source,
				localDate: `2026-10-${String(day).padStart(2, "0")}`,
			});
			if (result.kind === "recommendation") selected.add(result.recommendation.node_id);
		}
		expect(selected.size).toBe(41);
	});

	it("hashes within the unseen candidates instead of filtering after the modulo", async () => {
		const store = new DailyRecommendationStore(memory(), () => RECOMMENDATION_ID);
		await store.save([
			{
				recommendation_id: RECOMMENDATION_ID,
				local_date: "2026-11-02",
				profile_revision: 1,
				node_id: "artist:artist-3",
				node_type: "artist",
				name: "Artist 3",
				teaser: null,
				reasons: ["Lié à Ambient"],
				view_event_id: "44444444-4444-4444-8444-444444444444",
				view_recorded: true,
			},
		]);
		const result = await recommendDaily({
			store,
			profile: profile(),
			catalog: catalog(4),
			localDate: "2026-11-03",
		});

		expect(result).toEqual({
			kind: "recommendation",
			recommendation: expect.objectContaining({ node_id: "artist:artist-1" }),
		});
	});

	it("returns public empty states and never claims a stable selection when storage fails", async () => {
		const unavailable = new DailyRecommendationStore({
			getItem: async () => null,
			setItem: async () => Promise.reject(new Error("disk full")),
			removeItem: async () => undefined,
		});
		await expect(
			recommendDaily({ store: unavailable, profile: profile(), catalog: catalog(), localDate: "2026-09-27" }),
		).resolves.toEqual({ kind: "unavailable" });
		await expect(
			recommendDaily({
				store: new DailyRecommendationStore(memory()),
				catalog: catalog(),
				localDate: "2026-09-27",
			}),
		).resolves.toEqual({ kind: "missing_profile" });
		await expect(
			recommendDaily({
				store: new DailyRecommendationStore(memory()),
				profile: profile(),
				catalog: undefined,
				localDate: "2026-09-27",
			}),
		).resolves.toEqual({ kind: "empty_catalog" });
	});
});
