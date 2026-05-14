/**
 * Stream a YouTube videoId as audio (m4a) to the browser.
 *
 * First request for a videoId: fetch bestaudio bytes from the local yt-dlp
 * bridge (http://127.0.0.1:YTDLP_BRIDGE_PORT/download/:videoId) and write
 * them to {streamCacheDir}/{videoId}.m4a (~2-5s for a 3-min track). The
 * bridge runs on Henry's laptop and is reached through an SSH reverse
 * tunnel — yt-dlp executes on a residential IP, sidestepping YouTube's
 * "Sign in to confirm you're not a bot" anti-bot wall that blocks the
 * droplet's datacenter IP.
 *
 * Subsequent requests: serve the cached file with HTTP Range support so the
 * <audio> element can seek.
 *
 * Cache eviction: LRU by mtime, total size capped at MAX_STREAM_CACHE_BYTES.
 */
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, rename, stat, unlink } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";

const MAX_STREAM_CACHE_BYTES = Number.parseInt(
	process.env.STREAM_CACHE_MAX_BYTES ?? `${5 * 1024 * 1024 * 1024}`,
	10,
);
const BRIDGE_URL = process.env.YTDLP_BRIDGE_URL ?? "http://127.0.0.1:18889";
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

const inflight = new Map<string, Promise<string>>();

export function isValidVideoId(s: string): boolean {
	return VIDEO_ID_RE.test(s);
}

function fileFor(streamCacheDir: string, videoId: string): string {
	return join(streamCacheDir, `${videoId}.m4a`);
}

async function downloadAudio(streamCacheDir: string, videoId: string): Promise<string> {
	await mkdir(streamCacheDir, { recursive: true });
	const finalPath = fileFor(streamCacheDir, videoId);
	const tmpPath = `${finalPath}.${process.pid}.${Date.now()}.tmp`;
	const bridge = `${BRIDGE_URL}/download/${encodeURIComponent(videoId)}`;
	const res = await fetch(bridge);
	if (!res.ok || !res.body) {
		const detail = await res.text().catch(() => "");
		throw new Error(`bridge ${res.status}: ${detail.slice(0, 500)}`);
	}
	// Stream the response body into the tmp file, then atomic-rename.
	await pipeline(res.body as unknown as NodeJS.ReadableStream, createWriteStream(tmpPath));
	await rename(tmpPath, finalPath);
	void evict(streamCacheDir);
	return finalPath;
}

async function ensureCached(streamCacheDir: string, videoId: string): Promise<string> {
	const path = fileFor(streamCacheDir, videoId);
	try {
		await stat(path);
		return path;
	} catch {
		// not cached
	}
	const existing = inflight.get(videoId);
	if (existing) return existing;
	const p = downloadAudio(streamCacheDir, videoId).finally(() => inflight.delete(videoId));
	inflight.set(videoId, p);
	return p;
}

async function evict(streamCacheDir: string): Promise<void> {
	try {
		const entries = await readdir(streamCacheDir);
		const files: { path: string; size: number; mtime: number }[] = [];
		let total = 0;
		for (const name of entries) {
			if (!name.endsWith(".m4a")) continue;
			const p = join(streamCacheDir, name);
			const s = await stat(p).catch(() => null);
			if (!s) continue;
			files.push({ path: p, size: s.size, mtime: s.mtimeMs });
			total += s.size;
		}
		if (total <= MAX_STREAM_CACHE_BYTES) return;
		files.sort((a, b) => a.mtime - b.mtime); // oldest first
		for (const f of files) {
			if (total <= MAX_STREAM_CACHE_BYTES) break;
			await unlink(f.path).catch(() => {});
			total -= f.size;
		}
	} catch {
		// best-effort
	}
}

export async function handleStream(
	req: IncomingMessage,
	res: ServerResponse,
	params: { videoId: string; streamCacheDir: string },
): Promise<void> {
	const { videoId, streamCacheDir } = params;
	if (!isValidVideoId(videoId)) {
		res.statusCode = 400;
		res.setHeader("Content-Type", "application/json");
		res.end(JSON.stringify({ error: "invalid videoId" }));
		return;
	}
	let filePath: string;
	try {
		filePath = await ensureCached(streamCacheDir, videoId);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		res.statusCode = 502;
		res.setHeader("Content-Type", "application/json");
		res.end(JSON.stringify({ error: "yt-dlp failed", detail: msg }));
		return;
	}
	const st = await stat(filePath);
	const total = st.size;
	const range = req.headers.range;
	res.setHeader("Content-Type", "audio/mp4");
	res.setHeader("Accept-Ranges", "bytes");
	res.setHeader("Cache-Control", "public, max-age=86400");
	// Touch mtime to keep the file warm in LRU.
	void stat(filePath).catch(() => {});
	if (range) {
		const m = /^bytes=(\d+)-(\d*)$/.exec(range);
		if (!m) {
			res.statusCode = 416;
			res.setHeader("Content-Range", `bytes */${total}`);
			res.end();
			return;
		}
		const start = Number.parseInt(m[1] ?? "0", 10);
		const end = m[2] ? Math.min(Number.parseInt(m[2], 10), total - 1) : total - 1;
		if (start >= total || end < start) {
			res.statusCode = 416;
			res.setHeader("Content-Range", `bytes */${total}`);
			res.end();
			return;
		}
		res.statusCode = 206;
		res.setHeader("Content-Range", `bytes ${start}-${end}/${total}`);
		res.setHeader("Content-Length", `${end - start + 1}`);
		createReadStream(filePath, { start, end }).pipe(res);
		return;
	}
	res.statusCode = 200;
	res.setHeader("Content-Length", `${total}`);
	createReadStream(filePath).pipe(res);
}
