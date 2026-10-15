import type {
	ArtistNode,
	EdgeRef,
	GenreNode,
	LabelNode,
	NodeType,
	ProjectNode,
	Slug,
	TrackNode,
} from "../../src/types.js";

const ARTICLE = "A real long article about this node, well past the eighty character floor. ".repeat(2);
const base = {
	editorial_article: ARTICLE,
	citations: [{ url: "https://example.com/source" }],
	materialized_at: "2026-10-15T00:00:00.000Z",
};

export function edge(type: NodeType, slug: string, name: string, extra: Partial<EdgeRef> = {}): EdgeRef {
	return { slug: `${type}:${slug}` as Slug, type, name, ...extra };
}

export function projectNode(slug: string, name: string, extra: Partial<ProjectNode> = {}): ProjectNode {
	return {
		...base,
		type: "project",
		slug: `project:${slug}`,
		name,
		editorial_pitch: "A short pitch.",
		artists: [],
		genres: [],
		tracklist: [],
		producers: [],
		personnel: [],
		related_projects: [],
		...extra,
	};
}

export function trackNode(slug: string, name: string, extra: Partial<TrackNode> = {}): TrackNode {
	return {
		...base,
		type: "track",
		slug: `track:${slug}`,
		name,
		editorial_teaser: "A short teaser.",
		artists: [],
		genres: [],
		producers: [],
		personnel: [],
		samples: [],
		sampled_by: [],
		remixed_by: [],
		...extra,
	};
}

export function artistNode(slug: string, name: string, extra: Partial<ArtistNode> = {}): ArtistNode {
	return {
		...base,
		type: "artist",
		slug: `artist:${slug}`,
		name,
		editorial_bio: "A short bio.",
		genres: [],
		labels: [],
		discography: [],
		notable_tracks: [],
		influences: [],
		influenced: [],
		collaborators: [],
		aliases: [],
		members: [],
		similar_artists: [],
		...extra,
	};
}

export function labelNode(slug: string, name: string, extra: Partial<LabelNode> = {}): LabelNode {
	return {
		...base,
		type: "label",
		slug: `label:${slug}`,
		name,
		editorial_description: "A short description.",
		genres: [],
		roster: [],
		notable_releases: [],
		...extra,
	};
}

export function genreNode(slug: string, name: string, extra: Partial<GenreNode> = {}): GenreNode {
	return {
		...base,
		type: "genre",
		slug: `genre:${slug}`,
		name,
		editorial_definition: "A short definition.",
		parent_genres: [],
		subgenres: [],
		related_genres: [],
		key_artists: [],
		key_labels: [],
		landmark_projects: [],
		landmark_tracks: [],
		...extra,
	};
}

export function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export function redirectResponse(location: string | null, status = 307): Response {
	return new Response(null, { status, headers: location ? { location } : {} });
}

export type Responder = (url: URL) => Response | Promise<Response>;

export type RoutedFetch = typeof fetch & { calls: string[] };

/**
 * Routes a stubbed fetch by URL substring, first match wins; unmatched requests answer 404 and are
 * recorded in `calls` so a test can assert what was (not) requested.
 */
export function routedFetch(routes: Array<[string, Responder]>): RoutedFetch {
	const calls: string[] = [];
	const impl = async (input: Parameters<typeof fetch>[0]): Promise<Response> => {
		const raw = input instanceof Request ? input.url : input.toString();
		calls.push(raw);
		const url = new URL(raw);
		for (const [needle, responder] of routes) {
			if (raw.includes(needle)) return responder(url);
		}
		return new Response("not found", { status: 404 });
	};
	return Object.assign(impl, { calls }) as unknown as RoutedFetch;
}
