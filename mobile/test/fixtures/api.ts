export const catalogFixture = {
	version: "v1" as const,
	revision: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
	taxonomy: { mode: "degraded", available: true },
	nodes: [
		{
			identity: "artist:massive-attack",
			type: "artist" as const,
			name: "Massive Attack",
			teaser: "Bristol collective.",
		},
	],
	edges: [],
};

export const nodeFixture = {
	node: {
		id: "artist:massive-attack",
		type: "artist" as const,
		name: "Massive Attack",
		teaser: "Bristol collective.",
		article: "Trip-hop pioneers.",
		citations: [],
		edges: {},
		facts: {},
		materialized_at: "2026-09-26T00:00:00.000Z",
	},
	source: "cache",
};

export const generationFixture = {
	request_id: "11111111-1111-4111-8111-111111111111",
	status: "succeeded",
	created_at: "2026-09-26T00:00:00.000Z",
	updated_at: "2026-09-26T00:01:00.000Z",
	node_id: "artist:massive-attack",
};

export const imageFixture = {
	slug: "artist:massive-attack",
	image_url: null,
	source: "cache",
};

export const linksFixture = {
	slug: "artist:massive-attack",
	spotify: null,
	apple: null,
	sources: {},
	resolvedAt: "2026-09-26T00:00:00.000Z",
};
