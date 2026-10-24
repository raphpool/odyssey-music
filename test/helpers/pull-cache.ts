import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach } from "vitest";
import { auditNodes, type RawNode, thresholdsFromReport } from "../../scripts/audit-cache.js";

// Shared by the TRA-493 tests (pull-cache-validate, pull-cache-script): a valid artist node, a cache
// directory holding some, and the ceilings of a given set of nodes.

const dirs: string[] = [];

/** A fresh temp dir, removed after the test. */
export function tmp(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}

export function removeTmpDirsAfterEach(): void {
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});
}

/** A node that passes nodePayloadSchema: no edge, one citation, `body` as its slug body. */
export function artist(body: string, overrides: RawNode = {}): RawNode {
	return {
		slug: `artist:${body}`,
		type: "artist",
		name: body.replace(/-/g, " "),
		editorial_article:
			"A fixture article that is long enough to clear the eighty character floor of the node schema.",
		citations: [{ url: "https://example.org/source" }],
		materialized_at: "2026-10-01T00:00:00.000Z",
		editorial_bio: "A fixture biography.",
		genres: [],
		labels: [],
		discography: [],
		notable_tracks: [],
		influences: [],
		influenced: [],
		collaborators: [],
		aliases: [],
		members: [],
		...overrides,
	};
}

/** Writes `<root>/nodes/<type>/<body>.json` for each node, with `text` standing for the bytes when given. */
export function writeNodes(root: string, nodes: RawNode[], rawText: Record<string, string> = {}): void {
	for (const node of nodes) {
		const slug = node.slug as string;
		const [type, body] = [slug.slice(0, slug.indexOf(":")), slug.slice(slug.indexOf(":") + 1)];
		const path = join(root, "nodes", type, `${body}.json`);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, rawText[slug] ?? `${JSON.stringify(node, null, 2)}\n`);
	}
}

/** Ceilings equal to what the audit measures on exactly these nodes. */
export function thresholdsOf(nodes: RawNode[]): string {
	const map = new Map(nodes.map((n) => [n.slug as string, n]));
	return JSON.stringify(thresholdsFromReport(auditNodes(map)));
}

export function writeJson(path: string, value: unknown): string {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
	return path;
}
