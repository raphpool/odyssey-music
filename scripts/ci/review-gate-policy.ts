export type Tier = 1 | 2 | 3;
export type ReviewState = "missing" | "pending" | "success" | "failure" | "error" | "stale";
export type GateVerdict = "pass" | "wait" | "block";

// Conclusions of a GitHub check-run (plus `missing` for "no conclusion yet"). The `review` check-run of
// ai-review.yml is not a commit status, so it can end in states that a ReviewState does not model.
export type CheckConclusion =
	| ReviewState
	| "neutral"
	| "cancelled"
	| "timed_out"
	| "skipped"
	| "action_required";

export interface OrdinaryReview {
	claude: CheckConclusion;
	codex: ReviewState;
	claudeBlocking: boolean;
}

export interface GateInput {
	risk: Tier;
	ordinary: OrdinaryReview;
	deep: ReviewState;
	// Conclusion of the `deep-review` job of ai-review.yml (absent = `missing`, so an old review-gate.yml that does
	// not forward it behaves as before).
	deepClaude?: CheckConclusion;
	// True when the PR edits a file of the gate itself (`gateIntegrityPath`).
	touchesGate: boolean;
}

// TRA-498 (2026-10-14): the integrity gate (audit, ratchet, committed ceilings) is only worth anything if a
// tier/1 PR cannot weaken it, so its three files escalate like the workflow that runs it. TRA-521 (2026-10-15):
// scripts/ci/review-reuse.ts decides whether the AI review verdict is reused (TRA-510), so it escalates the same
// way (prefix match, like review-gate-policy). TRA-522 (2026-10-15): ai-review.yml checks out the PR merge ref and
// its prompt reads the root REVIEW.md, so a tier/1 PR editing it would be reviewed under its own calibration
// rules; it escalates too, anchored at the root (docs/REVIEW.md does not). TRA-553 (2026-10-15): the pattern is
// case-insensitive (flag `i`) because the self-hosted runners are on macOS, whose default APFS volume ignores
// case: `review.md` checks out over `REVIEW.md` and would otherwise dodge the escalation. TRA-556 (2026-10-24):
// the `tier-guard` job of .github/workflows/ci.yml no longer holds a copy: it reads this literal, as text, from the
// default branch and turns it into a `grep -Eqi` pattern (`\/` written `/`, flag `i` written `-i`). So the literal
// must stay one `export const sensitivePath = /…/i;` declaration with the pattern on a single line, in ASCII, no
// `/`, `[` or backslash inside a character class, no escape except one that quotes a punctuation character (`\.`,
// `\/`), no `(?` group, no lazy quantifier, and the flag `i` alone: the job fails closed on anything else, because
// JS and `grep -E` read those differently (test/ci-integrity-job.test.ts runs the job's own steps on it).
export const sensitivePath =
	/(^|\/)(auth|payment[s]?|migrations|infra|deploy)\/|^\.github\/|^scripts\/(deploy-|ci\/review-gate-policy|ci\/review-reuse|ci\/threshold-ratchet\.ts$|audit-cache\.ts$)|^data\/integrity-thresholds\.json$|^\.codex\/scripts\/publish-review-status\.sh$|^REVIEW\.md$|\.sql$|secrets/i;

// TRA-704 (2026-11-16): a `pull_request` workflow runs the PR's own version, so a PR could empty the `deep-review`
// job of ai-review.yml and then be passed by it. A PR that edits any file of the gate therefore cannot be
// validated by `deepClaude`: it still needs the `codex-deep-review` status. Written like sensitivePath (one line,
// ASCII, flag `i` alone, no `(?`, no lazy quantifier) so it can be translated to an ERE later; no ci.yml check
// consumes it yet. Do not loosen it.
export const gateIntegrityPath =
	/^\.github\/(workflows\/(ai-review|review-gate)\.yml|review-gate-authors\.txt)$|^scripts\/ci\/(review-gate-policy|review-reuse)|^REVIEW\.md$|^\.codex\/scripts\/publish-review-status\.sh$/i;

// TRA-841 (2026-11-26): a data PR is tier/3 only so that Raphael approves its content, which the deep review cannot
// do. On TRA-812 (#738, 30 project nodes that only gained `l10n.fr`) it hit its 60-turn limit twice without a verdict
// and `review-gate` blocked the PR; the risks it looks for (diff scope, equality outside `l10n`, Zod validation,
// audit-cache, integrity) are already checked mechanically. Such a PR is therefore tier 2. Everything else keeps its
// tier: a path outside `cache/nodes/` (the gate itself included, via `sensitivePath`) or any change that is not an
// added `l10n` block (a deletion, a merge, a rewrite) stays tier/3, because losing data is a real risk there.
const cacheNodePath = /^cache\/nodes\/[^\0]+\.json$/;

export interface FileChange {
	path: string;
	// First letter of `git diff --name-status`: only `M` can qualify; added, deleted, copied or type-changed files cannot.
	status: string;
	// File content on the merge base and on the head; null when the file does not exist on that side.
	base: string | null;
	head: string | null;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

// Structural JSON equality: the key order of an object does not matter, the order of an array does.
const sameJson = (a: unknown, b: unknown): boolean => {
	if (a === b) return true;
	if (Array.isArray(a) || Array.isArray(b)) {
		return (
			Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => sameJson(v, b[i]))
		);
	}
	if (!isPlainObject(a) || !isPlainObject(b)) return false;
	const keys = Object.keys(a);
	return (
		keys.length === Object.keys(b).length && keys.every((k) => Object.hasOwn(b, k) && sameJson(a[k], b[k]))
	);
};

// The one locale and the keys of a translation block that src/schemas.ts declares (`nodeTranslationSchema`), held here
// because the gate runs this file alone. A block of another shape is not recognised, so it keeps the deep review: the
// worst a schema change does is turn the shortcut off. Keep in step with src/schemas.ts.
const l10nLocales: ReadonlySet<string> = new Set(["fr"]);
const l10nBlockKeys: ReadonlySet<string> = new Set([
	"teaser",
	"article",
	"facts",
	"source_sha256",
	"model",
	"translated_at",
]);

const isTranslationBlock = (block: unknown): boolean => {
	if (!isPlainObject(block)) return false;
	return Object.entries(block).every(([key, value]) =>
		key === "facts"
			? isPlainObject(value) && Object.values(value).every((fact) => typeof fact === "string")
			: l10nBlockKeys.has(key) && typeof value === "string",
	);
};

const withoutL10n = (node: Record<string, unknown>): Record<string, unknown> => {
	const { l10n: _l10n, ...rest } = node;
	return rest;
};

const parseJson = (text: string | null): unknown => {
	if (text === null) return undefined;
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return undefined;
	}
};

// True when the file differs from its base only by `l10n` blocks (locales) that the base did not have: parsed JSON
// compared, no text read. Every doubt is false (fail closed): unreadable or non-object JSON, a locale of the base
// changed or removed, no locale added, or an added block that is not a plain translation block of the declared locale.
const addsOnlyL10n = (change: FileChange): boolean => {
	if (change.status !== "M" || !cacheNodePath.test(change.path)) return false;
	const base = parseJson(change.base);
	const head = parseJson(change.head);
	if (!isPlainObject(base) || !isPlainObject(head)) return false;
	if (!sameJson(withoutL10n(base), withoutL10n(head))) return false;
	const baseL10n = Object.hasOwn(base, "l10n") ? base.l10n : {};
	const headL10n = head.l10n;
	if (!isPlainObject(baseL10n) || !isPlainObject(headL10n)) return false;
	const keptLocales = Object.keys(baseL10n).every(
		(locale) => Object.hasOwn(headL10n, locale) && sameJson(baseL10n[locale], headL10n[locale]),
	);
	if (!keptLocales) return false;
	const added = Object.keys(headL10n).filter((locale) => !Object.hasOwn(baseL10n, locale));
	return (
		added.length > 0 &&
		added.every((locale) => l10nLocales.has(locale) && isTranslationBlock(headL10n[locale]))
	);
};

export const isL10nOnlyAddition = (changes: readonly FileChange[]): boolean =>
	changes.length > 0 && changes.every(addsOnlyL10n);

export interface RiskOptions {
	// Result of `isL10nOnlyAddition` for the whole diff, computed by the caller from the default branch's copy of this file.
	l10nOnly?: boolean;
}

export const classifyRisk = (
	paths: readonly string[],
	labels: readonly string[],
	options: RiskOptions = {},
): Tier => {
	if (paths.some((path) => sensitivePath.test(path))) return 3;
	if (labels.includes("tier/3")) {
		// Defense in depth: even a true flag only counts when every path of the diff is a cache node file.
		const l10nOnly =
			options.l10nOnly === true && paths.length > 0 && paths.every((path) => cacheNodePath.test(path));
		return l10nOnly ? 2 : 3;
	}
	if (labels.includes("tier/2")) return 2;
	return 1;
};

// TRA-524 (2026-10-24): a Claude review "is there" only if the job ran to a verdict. `cancelled` and `timed_out`
// (the 25-minute timeout of ai-review.yml) used to count as present, so with `codex-review: success` the gate
// passed although no Claude review had completed. `skipped`, `stale` and `action_required` did not review
// anything either. The allowlist fails closed: a conclusion GitHub adds later waits instead of passing.
// `failure` stays present: the review ran and `claudeBlocking` already carries its blocking findings.
// `neutral` stays present on purpose (TRA-524 decision): ai-review.yml never ends a job that way (a job
// concludes success, failure, cancelled, skipped or timed_out), so it has no effect in practice.
// The same three conclusions are listed in the `select_review` jq program of review-gate.yml, which maps the
// others to `missing` before they get here. The list is deliberately held twice: this copy is the one executed
// from the default branch, so it also protects a PR whose own review-gate.yml still forwards the raw conclusion.
// Keep the two in sync (test/review-gate-workflow.test.ts runs both on every conclusion).
const completedClaudeReview: ReadonlySet<CheckConclusion> = new Set(["success", "failure", "neutral"]);

const ordinaryVerdict = (review: OrdinaryReview): GateVerdict => {
	if (review.codex === "failure" || review.claudeBlocking) return "block";
	if (review.claude === "success") return "pass";
	if (completedClaudeReview.has(review.claude) && review.codex === "success") return "pass";
	return "wait";
};

export const evaluateReviewGate = (input: GateInput): GateVerdict => {
	const ordinary = ordinaryVerdict(input.ordinary);
	if (ordinary !== "pass") return ordinary;
	if (input.deep === "failure") return "block";
	if (input.risk < 3) return "pass";
	if (input.deepClaude === "failure") return "block";
	if (input.deep === "success") return "pass";
	// Strict `=== false`: defensive only (main() always derives touchesGate), so a missing value fails closed.
	return input.deepClaude === "success" && input.touchesGate === false ? "pass" : "wait";
};

type GitRunner = (args: readonly string[]) => string;

// The changes of `base...head` with both sides of every file read from git, as the gate's diff sees them (--no-renames,
// -z). A missing side is null. Only a modified cache node is read: anything else cannot qualify anyway.
const readChanges = (git: GitRunner, base: string, head: string): FileChange[] => {
	const mergeBase = git(["merge-base", base, head]).trim();
	const tokens = git(["diff", "-z", "--name-status", "--no-renames", `${base}...${head}`]).split("\0");
	if (tokens.pop() !== "") throw new Error("Unexpected git diff output");
	const show = (rev: string, path: string): string | null => {
		try {
			return git(["show", `${rev}:${path}`]);
		} catch {
			return null;
		}
	};
	const changes: FileChange[] = [];
	for (let i = 0; i < tokens.length; i += 2) {
		const status = tokens[i]?.[0] ?? "";
		const path = tokens[i + 1] ?? "";
		const readable = status === "M" && cacheNodePath.test(path);
		changes.push({
			path,
			status,
			base: readable ? show(mergeBase, path) : null,
			head: readable ? show(head, path) : null,
		});
	}
	return changes;
};

// `review-gate-policy.ts l10n-only <base> <head>` prints `true` or `false` on stdout; anything that goes wrong prints
// `false` and the reason on stderr, so a broken check shows in the job log instead of looking like a PR that is not
// l10n-only. The built-in is imported at call time, not with an `import` statement: the gate copies this file alone
// from the default branch and runs it with `node --experimental-strip-types` (test/review-gate-workflow.test.ts).
const l10nOnlyCommand = async (base: string | undefined, head: string | undefined): Promise<void> => {
	let result = false;
	try {
		if (base === undefined || head === undefined) throw new Error("Usage: l10n-only <base> <head>");
		const { execFileSync } = await import("node:child_process");
		const git: GitRunner = (args) =>
			execFileSync("git", args, {
				encoding: "utf8",
				maxBuffer: 256 * 1024 * 1024,
				stdio: ["ignore", "pipe", "pipe"],
			});
		result = isL10nOnlyAddition(readChanges(git, base, head));
	} catch (error) {
		console.error(`l10n-only: not applied, ${error instanceof Error ? error.message : String(error)}`);
	}
	console.log(String(result));
};

const main = (): void => {
	const encoded = process.argv[2];
	if (encoded === undefined)
		throw new Error("Usage: review-gate-policy.ts <json-input> | l10n-only <base> <head>");
	if (encoded === "l10n-only") {
		void l10nOnlyCommand(process.argv[3], process.argv[4]);
		return;
	}
	const input = JSON.parse(encoded) as Omit<GateInput, "touchesGate"> & {
		paths: string[];
		labels: string[];
		l10nOnly?: boolean;
	};
	const risk = classifyRisk(input.paths, input.labels, { l10nOnly: input.l10nOnly === true });
	const touchesGate = input.paths.some((path) => gateIntegrityPath.test(path));
	console.log(JSON.stringify({ risk, verdict: evaluateReviewGate({ ...input, risk, touchesGate }) }));
};

if (process.argv[1]?.endsWith("review-gate-policy.ts")) main();
