// Hosts we accept for a node's `image_url` (TRA-455). An image URL comes from third-party data
// (Wikidata, Cover Art Archive, iTunes), so the schema refuses anything off this list before it
// reaches disk or an <img src>. Existing photo_url / cover_url values are NOT checked against it.
const EXACT_HOSTS: ReadonlySet<string> = new Set([
	"upload.wikimedia.org",
	"commons.wikimedia.org",
	"coverartarchive.org",
	"archive.org",
]);

// Accepted for any strict subdomain, never the bare domain. Cover Art Archive redirects to
// ia*.us.archive.org, hence archive.org subdomains.
const SUBDOMAIN_SUFFIXES: readonly string[] = [".archive.org", ".mzstatic.com"];

export const IMAGE_HOST_ALLOWLIST: readonly string[] = [
	...EXACT_HOSTS,
	...SUBDOMAIN_SUFFIXES.map((suffix) => `*${suffix}`),
];

export function isAllowedImageUrl(url: string): boolean {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}
	if (parsed.protocol !== "https:") return false;
	if (parsed.username !== "" || parsed.password !== "") return false;
	const host = parsed.hostname.toLowerCase();
	if (EXACT_HOSTS.has(host)) return true;
	return SUBDOMAIN_SUFFIXES.some((suffix) => host.length > suffix.length && host.endsWith(suffix));
}
