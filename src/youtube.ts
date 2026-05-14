/**
 * Resolve a track to a YouTube videoId via Tavily search, with sidecar cache.
 *
 * The result lives in {cacheDir}/youtube/{trackSlug}.json (not part of the NodePayload
 * schema — keeps schema validation untouched and lets us re-resolve later if needed).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tavilySearch } from "./tools/tavily.js";

export interface YouTubeResolution {
	videoId: string;
	url: string;
	title: string;
	resolvedAt: string;
}

const VIDEO_ID_RE = /(?:v=|youtu\.be\/|\/embed\/|\/shorts\/)([A-Za-z0-9_-]{11})/;

export function parseVideoId(url: string): string | null {
	const m = VIDEO_ID_RE.exec(url);
	return m && m[1] ? m[1] : null;
}

export function sidecarPath(cacheDir: string, trackSlug: string): string {
	const safe = trackSlug.replace(/^track:/, "").replace(/[^a-z0-9_-]/gi, "_");
	return join(cacheDir, "youtube", `${safe}.json`);
}

export async function readSidecar(cacheDir: string, trackSlug: string): Promise<YouTubeResolution | null> {
	try {
		const text = await readFile(sidecarPath(cacheDir, trackSlug), "utf8");
		return JSON.parse(text) as YouTubeResolution;
	} catch {
		return null;
	}
}

async function writeSidecar(cacheDir: string, trackSlug: string, data: YouTubeResolution): Promise<void> {
	const file = sidecarPath(cacheDir, trackSlug);
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

export interface ResolveInput {
	trackSlug: string;
	trackName: string;
	artistName?: string;
	cacheDir: string;
	tavilyApiKey: string;
}

export async function resolveYouTube(input: ResolveInput): Promise<YouTubeResolution> {
	const cached = await readSidecar(input.cacheDir, input.trackSlug);
	if (cached) return cached;

	const query = input.artistName
		? `${input.artistName} ${input.trackName} site:youtube.com`
		: `${input.trackName} site:youtube.com`;

	const results = await tavilySearch(input.tavilyApiKey, query, { max_results: 8, search_depth: "basic" });
	let picked: { videoId: string; url: string; title: string } | null = null;
	for (const r of results) {
		const id = parseVideoId(r.url);
		if (!id) continue;
		picked = { videoId: id, url: `https://www.youtube.com/watch?v=${id}`, title: r.title };
		break;
	}
	if (!picked) {
		throw new Error(`No YouTube result for "${query}"`);
	}
	const resolution: YouTubeResolution = {
		videoId: picked.videoId,
		url: picked.url,
		title: picked.title,
		resolvedAt: new Date().toISOString(),
	};
	await writeSidecar(input.cacheDir, input.trackSlug, resolution);
	return resolution;
}
