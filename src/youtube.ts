/**
 * Resolve a track to a YouTube videoId via Tavily search, with sidecar cache.
 *
 * The result lives in {cacheDir}/youtube/{trackSlug}.json (not part of the NodePayload
 * schema -- keeps schema validation untouched and lets us re-resolve later if needed).
 *
 * Picker is title-scored, not "first parseable id". Tavily will happily return
 * an unrelated video that merely mentions one token of the query; the previous
 * implementation cached that forever. The scorer requires the result title to
 * contain the track tokens and the artist tokens, and applies bonuses for
 * "official", "audio", and YouTube Topic channels. Cached sidecars are also
 * re-validated on read against the current artist/track names so a poisoned
 * entry self-heals on the next request instead of sticking forever.
 */
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { nameMatchScore } from "./text-match.js";
import { tavilySearch } from "./tools/tavily.js";

// Re-exported: the tokenizer moved to text-match.ts when the streaming-link
// resolver needed the same entity-matching gate. Callers (and tests) that know
// it as part of the YouTube module keep working.
export { normalizeTokens } from "./text-match.js";

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

/**
 * Score a candidate against expected track/artist. Returns null when the title
 * fails a hard requirement (no track-token overlap, or artist-known and zero
 * artist-token overlap). Higher score = better match. Used both to pick the
 * best candidate and to validate a cached sidecar before serving it.
 *
 * The shared entity gate lives in text-match.ts; what stays here is the
 * YouTube-specific ranking — official uploads and Topic channels up, covers,
 * karaoke and reactions down.
 */
export function scoreCandidate(
	candidateTitle: string,
	trackName: string,
	artistName: string | undefined,
): number | null {
	const base = nameMatchScore(candidateTitle, trackName, artistName);
	if (base === null) return null;

	let score = base;
	const t = candidateTitle.toLowerCase();
	if (/\bofficial\b/.test(t)) score += 15;
	if (/\bofficial audio\b|\baudio officiel\b/.test(t)) score += 10;
	if (/- topic\b/.test(t)) score += 12; // YouTube auto-Topic channels
	if (/\blyrics?\b|\blyric video\b/.test(t)) score -= 5;
	if (/\blive\b|\bconcert\b/.test(t)) score -= 8;
	if (/\bcover\b|\binstrumental\b|\bkaraoke\b/.test(t)) score -= 25;
	if (/\breaction\b/.test(t)) score -= 40;
	return score;
}

export async function readSidecar(cacheDir: string, trackSlug: string): Promise<YouTubeResolution | null> {
	try {
		const text = await readFile(sidecarPath(cacheDir, trackSlug), "utf8");
		return JSON.parse(text) as YouTubeResolution;
	} catch {
		return null;
	}
}

/**
 * Read sidecar and validate it still matches the current artist/track. A
 * poisoned cache entry (wrong videoId for the track) is deleted and treated
 * as a miss, so the next resolve attempt re-runs the picker. This is the
 * self-heal path -- without it, one bad Tavily result sticks forever.
 */
export async function readValidatedSidecar(
	cacheDir: string,
	trackSlug: string,
	trackName: string,
	artistName: string | undefined,
): Promise<YouTubeResolution | null> {
	const cached = await readSidecar(cacheDir, trackSlug);
	if (!cached) return null;
	const score = scoreCandidate(cached.title, trackName, artistName);
	if (score === null) {
		await unlink(sidecarPath(cacheDir, trackSlug)).catch(() => {});
		return null;
	}
	return cached;
}

async function writeSidecar(cacheDir: string, trackSlug: string, data: YouTubeResolution): Promise<void> {
	const file = sidecarPath(cacheDir, trackSlug);
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

export async function invalidateSidecar(cacheDir: string, trackSlug: string): Promise<void> {
	await unlink(sidecarPath(cacheDir, trackSlug)).catch(() => {});
}

export interface ResolveInput {
	trackSlug: string;
	trackName: string;
	artistName?: string;
	cacheDir: string;
	tavilyApiKey: string;
	/** Bypass and overwrite an existing sidecar. */
	force?: boolean;
}

export async function resolveYouTube(input: ResolveInput): Promise<YouTubeResolution> {
	if (!input.force) {
		const cached = await readValidatedSidecar(
			input.cacheDir,
			input.trackSlug,
			input.trackName,
			input.artistName,
		);
		if (cached) return cached;
	}

	const query = input.artistName
		? `${input.artistName} ${input.trackName} site:youtube.com`
		: `${input.trackName} site:youtube.com`;

	const results = await tavilySearch(input.tavilyApiKey, query, { max_results: 10, search_depth: "basic" });

	let best: { videoId: string; url: string; title: string; score: number } | null = null;
	for (const r of results) {
		const id = parseVideoId(r.url);
		if (!id) continue;
		const score = scoreCandidate(r.title, input.trackName, input.artistName);
		if (score === null) continue;
		if (!best || score > best.score) {
			best = { videoId: id, url: `https://www.youtube.com/watch?v=${id}`, title: r.title, score };
		}
	}
	if (!best) {
		throw new Error(
			`No confident YouTube match for "${query}" (${results.length} results; all rejected by title scorer)`,
		);
	}
	const resolution: YouTubeResolution = {
		videoId: best.videoId,
		url: best.url,
		title: best.title,
		resolvedAt: new Date().toISOString(),
	};
	await writeSidecar(input.cacheDir, input.trackSlug, resolution);
	return resolution;
}
