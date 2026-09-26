import { LINKABLE_TYPES, type ResolveLinksInput, type StreamingLinks } from "../streaming-links.js";
import type { Slug } from "../types.js";
import type { MobileNodeReader } from "./nodes.js";
import { safePublicHttpsUrl } from "./nodes.js";

interface ImageResolution {
	slug: Slug;
	image_url: string | null;
	source: string;
}

interface ImageService {
	resolveDisplayImage(slug: Slug): Promise<ImageResolution>;
}

export interface MobileImageResponse {
	slug: Slug;
	image_url: string | null;
	source: string;
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
	image(slug: string): Promise<MobileImageResponse | null>;
	links(slug: string): Promise<MobileLinksResponse | null>;
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

export function createMobileMedia(dependencies: MobileMediaDependencies): MobileMedia {
	return {
		async image(slug: string): Promise<MobileImageResponse | null> {
			const node = await dependencies.nodes.read(slug);
			if (!node) return null;
			try {
				const image = await dependencies.imageService.resolveDisplayImage(node.node.id as Slug);
				return { ...image, image_url: safePublicHttpsUrl(image.image_url) };
			} catch {
				throw new MobileProviderUnavailableError();
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
