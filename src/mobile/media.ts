import { logger } from "../logger.js";
import type { DisplayImage } from "../services/image-service.js";
import { LINKABLE_TYPES, type ResolveLinksInput, type StreamingLinks } from "../streaming-links.js";
import type { Slug } from "../types.js";
import type { MobileNodeReader } from "./nodes.js";
import { safePublicHttpsUrl } from "./nodes.js";

const log = logger.child({ module: "mobile-media" });

/** What a client is asked to wait before asking again when the image is still being resolved. */
export const MOBILE_RETRY_AFTER_SECONDS = 5;

interface ImageService {
	resolveDisplayImage(slug: Slug): Promise<DisplayImage>;
	warmSlug(slug: Slug): Promise<void>;
}

export interface MobileImageResponse {
	slug: Slug;
	image_url: string | null;
	source: string;
	state: "found" | "pending" | "none";
	retry_after_seconds?: number;
}

export interface MobileLinksResponse {
	slug: Slug;
	spotify: string | null;
	apple: string | null;
	sources: StreamingLinks["sources"];
	resolvedAt: string;
}

export class MobileProviderUnavailableError extends Error {
	constructor() {
		super("mobile provider is temporarily unavailable");
		this.name = "MobileProviderUnavailableError";
	}
}

export interface MobileMedia {
	/** Never null: a slug without a node is answered by the image service (`no-context`), not by a 404. */
	image(slug: string): Promise<MobileImageResponse>;
	links(slug: string): Promise<MobileLinksResponse | null>;
	/** Starts resolving the images of a page the client is about to ask for. Never throws. */
	warm(slug: string): Promise<void>;
}

export interface MobileMediaDependencies {
	nodes: MobileNodeReader;
	imageService: ImageService;
	resolveLinks(input: ResolveLinksInput): Promise<StreamingLinks>;
	cacheDir: string;
}

const STREAMING_HOSTS = {
	spotify: "open.spotify.com",
	apple: "music.apple.com",
} as const;

function toMobileImage(image: DisplayImage): MobileImageResponse {
	if (image.state === "pending") {
		return {
			slug: image.slug,
			image_url: null,
			source: image.source,
			state: "pending",
			retry_after_seconds: image.retry_after_seconds ?? MOBILE_RETRY_AFTER_SECONDS,
		};
	}
	if (image.state === "found") {
		// The URL comes from a sidecar derived from third-party sources: it is checked on every way out.
		const imageUrl = safePublicHttpsUrl(image.image_url);
		return imageUrl
			? { slug: image.slug, image_url: imageUrl, source: image.source, state: "found" }
			: { slug: image.slug, image_url: null, source: "unsafe-url", state: "none" };
	}
	return { slug: image.slug, image_url: null, source: image.source, state: "none" };
}

export function createMobileMedia(dependencies: MobileMediaDependencies): MobileMedia {
	return {
		async image(slug: string): Promise<MobileImageResponse> {
			const node = await dependencies.nodes.read(slug);
			// 2026-10-16 (TRA-584): a dangling work slug answered 404, which the iOS store cached as
			// unavailable for the session. A slug without a node now goes to the service, which answers
			// from its queue and sidecars (pending / none), so the client can ask again.
			const key = (node ? node.node.id : slug) as Slug;
			try {
				return toMobileImage(await dependencies.imageService.resolveDisplayImage(key));
			} catch (error) {
				log.warn("image resolution failed", {
					slug,
					error: error instanceof Error ? error.message : String(error),
				});
				throw new MobileProviderUnavailableError();
			}
		},
		async warm(slug: string): Promise<void> {
			try {
				await dependencies.imageService.warmSlug(slug as Slug);
			} catch (error) {
				// Best effort: warming must never cost the page it was triggered by.
				log.warn("warm failed", { slug, error: error instanceof Error ? error.message : String(error) });
			}
		},
		async links(slug: string): Promise<MobileLinksResponse | null> {
			const node = await dependencies.nodes.read(slug);
			if (!node) return null;
			if (!LINKABLE_TYPES.has(node.node.type)) {
				return {
					slug: node.node.id as Slug,
					spotify: null,
					apple: null,
					sources: {},
					resolvedAt: new Date().toISOString(),
				};
			}
			const artists = node.node.edges.artists;
			const firstArtist = Array.isArray(artists) ? artists[0]?.name : undefined;
			try {
				const resolved = await dependencies.resolveLinks({
					slug: node.node.id,
					type: node.node.type,
					name: node.node.name,
					...(firstArtist ? { artistName: firstArtist } : {}),
					cacheDir: dependencies.cacheDir,
				});
				const spotify = safePublicHttpsUrl(resolved.spotify, STREAMING_HOSTS.spotify);
				const apple = safePublicHttpsUrl(resolved.apple, STREAMING_HOSTS.apple);
				return {
					slug: node.node.id as Slug,
					spotify,
					apple,
					sources: {
						...(spotify && resolved.sources.spotify ? { spotify: resolved.sources.spotify } : {}),
						...(apple && resolved.sources.apple ? { apple: resolved.sources.apple } : {}),
					},
					resolvedAt: resolved.resolvedAt,
				};
			} catch {
				throw new MobileProviderUnavailableError();
			}
		},
	};
}
