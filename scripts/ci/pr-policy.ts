import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export interface DiffFile {
	path: string;
	additions: number;
	deletions: number;
	binary: boolean;
}

export interface PolicyPath {
	path: string;
	provenance: string;
}

export interface PrPolicy {
	writtenLines: number;
	writtenFiles: number;
	generatedLines: number;
	generatedFiles: number;
	binaryFiles: PolicyPath[];
	written: PolicyPath[];
	generated: PolicyPath[];
	requiresScopeReview: boolean;
}

const generatedProvenance = (path: string): string | undefined => {
	if (/(^|\/)package-lock\.json$/.test(path)) return "npm";
	if (path === "web/data.json") return "scripts/build-graph-json.ts";
	if (path === "data/genre-qid-map.json") return "scripts/build-genre-qid-map.ts";
	if (/^cache\/nodes\/.+\.json$/.test(path)) return "pipeline";
	if (/(^|\/)__snapshots__\/|\.snap$/.test(path)) return "test runner";
	return undefined;
};

export const calculatePrPolicy = (files: readonly DiffFile[]): PrPolicy => {
	let writtenLines = 0;
	let generatedLines = 0;
	const written: PolicyPath[] = [];
	const generated: PolicyPath[] = [];
	const binaryFiles: PolicyPath[] = [];

	for (const file of files) {
		const provenance = generatedProvenance(file.path);
		if (file.binary) {
			binaryFiles.push({ path: file.path, provenance: provenance ?? "unknown" });
			continue;
		}

		const lines = file.additions + file.deletions;
		if (provenance !== undefined) {
			generatedLines += lines;
			generated.push({ path: file.path, provenance });
		} else {
			writtenLines += lines;
			written.push({ path: file.path, provenance: "manual" });
		}
	}

	return {
		writtenLines,
		writtenFiles: written.length,
		generatedLines,
		generatedFiles: generated.length,
		binaryFiles,
		written,
		generated,
		requiresScopeReview: writtenLines > 1000 || written.length > 20,
	};
};

export const readDiffFiles = (base: string, head: string, cwd?: string): DiffFile[] => {
	const output = execFileSync("git", ["diff", "--no-renames", "--numstat", "-z", `${base}...${head}`], {
		encoding: "utf8",
		cwd,
	});

	return output
		.split("\0")
		.filter((entry) => entry.length > 0)
		.map((entry) => {
			const [additions, deletions, ...pathParts] = entry.split("\t");
			const path = pathParts.join("\t");
			if (additions === undefined || deletions === undefined || path.length === 0) {
				throw new Error(`Could not parse git numstat entry: ${JSON.stringify(entry)}`);
			}
			const binary = additions === "-" || deletions === "-";
			if (!binary && (!/^\d+$/.test(additions) || !/^\d+$/.test(deletions))) {
				throw new Error(`Could not parse git numstat counts for ${path}`);
			}
			return {
				path,
				additions: binary ? 0 : Number(additions),
				deletions: binary ? 0 : Number(deletions),
				binary,
			};
		});
};

export const formatPolicySummary = (policy: PrPolicy): string => {
	const paths = (label: string, entries: readonly PolicyPath[]): string[] => [
		`### ${label}`,
		...(entries.length === 0
			? ["- None"]
			: entries.map((entry) => `- \`${entry.path}\` — ${entry.provenance}`)),
	];
	return [
		"## Diff policy",
		`- Written: ${policy.writtenLines} lines across ${policy.writtenFiles} files`,
		`- Generated: ${policy.generatedLines} lines across ${policy.generatedFiles} files`,
		`- Binary: ${policy.binaryFiles.length} files`,
		`- Scope review: ${policy.requiresScopeReview ? "required" : "not required"}`,
		"",
		...paths("Written paths", policy.written),
		"",
		...paths("Generated paths", policy.generated),
		"",
		...paths("Binary paths", policy.binaryFiles),
	].join("\n");
};

const main = (): void => {
	const [base, head] = process.argv.slice(2);
	if (base === undefined || head === undefined) {
		throw new Error("Usage: pr-policy.ts <base> <head>");
	}
	const policy = calculatePrPolicy(readDiffFiles(base, head));
	console.log(formatPolicySummary(policy));
	if (policy.requiresScopeReview) {
		console.log("::warning::Scope review required: written diff exceeds 1000 lines or 20 files.");
	}
};

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
	main();
}
