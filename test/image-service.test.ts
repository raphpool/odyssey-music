import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeCache } from "../src/cache.js";
import type { GenreRedirects } from "../src/genre-registry.js";
import { createImageService } from "../src/services/image-service.js";
import type { GenreNode, ProjectNode, Slug } from "../src/types.js";

// TRA-39: image-service.resolveDisplayImage must apply the same "live node wins, else follow the
// flattened genre-redirect table" rule node-service.getNode already applies (TRA-30). Before this,
// GET /image/genre:electronic-music served { image_url: null, source: "not-cached" } forever, even
// though genre:electronic (and its landmark covers) exist and GET /node/genre:electronic-music
// already serves the canonical node for the same slug.
function genreNode(overrides: Partial<GenreNode> & { slug: Slug; name: string }): GenreNode {
	return {
		type: "genre",
		editorial_article: "A real long article about this genre, well past the eighty character floor. ".repeat(
			2,
		),
		editorial_definition: "A short definition.",
		citations: [{ url: "https://example.com/genre" }],
		materialized_at: new Date().toISOString(),
		parent_genres: [],
		subgenres: [],
		related_genres: [],
		key_artists: [],
		key_labels: [],
		landmark_projects: [],
		landmark_tracks: [],
		...overrides,
	};
}

function projectNode(overrides: Partial<ProjectNode> & { slug: Slug; name: string }): ProjectNode {
	return {
		type: "project",
		editorial_article:
			"A real long article about this project, well past the eighty character floor. ".repeat(2),
		editorial_pitch: "A short pitch.",
		citations: [{ url: "https://example.com/project" }],
		materialized_at: new Date().toISOString(),
		artists: [],
		genres: [],
		tracklist: [],
		producers: [],
		personnel: [],
		related_projects: [],
		...overrides,
	};
}

describe("resolveDisplayImage genre redirects (TRA-39)", () => {
	let dir: string;
	let cache: NodeCache;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "odyssey-image-service-"));
		cache = new NodeCache(dir);
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("serves the canonical node's image for a slug redirected away from it", async () => {
		await cache.write(
			projectNode({
				slug: "project:landmark",
				name: "Landmark",
				cover_url: "https://img.example.com/a.jpg",
			}),
		);
		await cache.write(
			genreNode({
				slug: "genre:electronic",
				name: "Electronic",
				landmark_projects: [{ type: "project", slug: "project:landmark", name: "Landmark" }],
			}),
		);
		const redirects: GenreRedirects = new Map([["genre:electronic-music", "genre:electronic"]]);
		const imageService = createImageService({ cache, redirects });

		const result = await imageService.resolveDisplayImage("genre:electronic-music" as Slug);

		expect(result).toEqual({
			slug: "genre:electronic-music",
			image_url: "https://img.example.com/a.jpg",
			source: "related:project:landmark",
		});
	});

	it("still reports not-cached for a slug with neither a live node nor a redirect entry", async () => {
		const imageService = createImageService({ cache, redirects: new Map() });

		const result = await imageService.resolveDisplayImage("genre:does-not-exist" as Slug);

		expect(result).toEqual({ slug: "genre:does-not-exist", image_url: null, source: "not-cached" });
	});
});
