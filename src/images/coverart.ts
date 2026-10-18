/**
 * Cover Art Archive front cover of a MusicBrainz release group (TRA-465).
 *
 * `GET https://coverartarchive.org/release-group/<mbid>/front-500` answers 307 to an archive.org
 * file when a front cover exists and 404 otherwise. We never follow the redirect: the URL we hand
 * back (and store in `image_url`) is the canonical coverartarchive.org one, because the browser and
 * the iOS `NodeImageLoader` follow and validate the redirect themselves, and an archive.org
 * `ia8xxxxx.us.archive.org/…` target is a per-item mirror that can move.
 */
import { musicBrainzConfig } from "../config.js";
import { isAllowedImageUrl } from "./hosts.js";

const CAA_BASE = "https://coverartarchive.org";
const REQUEST_TIMEOUT_MS = 5000;
const MBID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Canonical front-500 URL for a release group, or null when it has no front cover (404), the
 * input is not a UUID, the redirect target is off the image allowlist, or the request fails.
 *
 * `onOutage` is called when the null means "could not tell" and not "no cover": a status other than 200,
 * 3xx and 404 (429, 5xx), a timeout or a network error. The archive.org side throttles and fails at times
 * (2026-10-18, TRA-612 follow-up): a caller that records verdicts must not keep such a null for a week.
 */
export async function coverArtUrl(
	releaseGroupMbid: string,
	fetchImpl: typeof fetch = fetch,
	onOutage?: () => void,
): Promise<string | null> {
	// The MBID lands in a URL path: refuse anything that is not a plain UUID.
	if (!MBID_PATTERN.test(releaseGroupMbid)) return null;
	const canonical = `${CAA_BASE}/release-group/${releaseGroupMbid.toLowerCase()}/front-500`;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	try {
		const r = await fetchImpl(canonical, {
			headers: { "User-Agent": musicBrainzConfig.userAgent },
			redirect: "manual",
			signal: controller.signal,
		});
		// We only need the status (and the redirect target); don't download the image body.
		void r.body?.cancel().catch(() => undefined);
		if (r.status >= 300 && r.status < 400) {
			// Third-party redirect: it must stay on an allowed image host, else the cover is unusable.
			const location = r.headers.get("location");
			if (!location) return null;
			let target: string;
			try {
				target = new URL(location, canonical).href;
			} catch {
				return null;
			}
			if (!isAllowedImageUrl(target)) return null;
		} else if (r.status !== 200) {
			if (r.status !== 404) onOutage?.();
			return null;
		}
		return isAllowedImageUrl(canonical) ? canonical : null;
	} catch {
		onOutage?.();
		return null;
	} finally {
		clearTimeout(timer);
	}
}
