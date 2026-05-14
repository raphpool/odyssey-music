/**
 * Stream a YouTube videoId as audio (m4a) to the browser.
 *
 * First request for a videoId: spawn yt-dlp to download bestaudio to
 * {streamCacheDir}/{videoId}.m4a (~3-8s for a 3-min track).
 * Subsequent requests: serve the cached file with HTTP Range support so
 * the <audio> element can seek.
 *
 * Cache eviction: LRU by mtime, total size capped at MAX_STREAM_CACHE_BYTES.
 */
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, readdir, rename, stat, unlink } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";

const MAX_STREAM_CACHE_BYTES = Number.parseInt(
	process.env.STREAM_CACHE_MAX_BYTES ?? `${5 * 1024 * 1024 * 1024}`,
	10,
);
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
	const url = `https://www.youtube.com/watch?v=${videoId}`;
	// -f bestaudio[ext=m4a]/bestaudio: prefer m4a (browsers love it); fallback bestaudio.
	// --no-playlist: never expand to a playlist.
	// --no-progress / --quiet: keep logs clean.
	// -o: explicit output path.
	const args = [
		"-f",
		"bestaudio[ext=m4a]/bestaudio",
		"--no-playlist",
		"--no-progress",
		"--quiet",
		"-o",
		tmpPath,
		url,
	];
	await new Promise<void>((resolve, reject) => {
		const child = spawn("yt-dlp", args, { stdio: ["ignore", "ignore", "pipe"] });
		const errChunks: Buffer[] = [];
		child.stderr.on("data", (c: Buffer) => errChunks.push(c));
		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) resolve();
			else
				reject(
					new Error(`yt-dlp exited ${code}: ${Buffer.concat(errChunks).toString("utf8").slice(0, 500)}`),
				);
		});
	});
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
