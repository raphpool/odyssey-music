import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import { proposeGenreSeedsFromMusicBrainz } from "../src/genre-seed-proposals.js";
import { GenreTaxonomySchema } from "../src/genre-taxonomy.js";
import type { Slug } from "../src/types.js";

const sourceSlugSchema = z
	.string()
	.regex(/^genre:[a-z0-9]+(?:-[a-z0-9]+)*(?:--[a-z0-9]+(?:-[a-z0-9]+)*)?$/)
	.transform((value): Slug => value as Slug);
const proofSchema = z.object({ url: z.string().url(), verified: z.boolean() }).strict();
const targetSchema = z
	.object({
		type: z.enum(["artist", "project", "track"]),
		name: z.string().trim().min(1),
		slug: z.string().min(1),
		mbid: z.string().uuid().optional(),
		proofs: z.array(proofSchema).default([]),
		homonym: z.boolean().optional(),
	})
	.strict();
const anchorSchema = z
	.object({
		slug: z.string().min(1),
		name: z.string().trim().min(1),
		qid: z.string().optional(),
		justification: z.string().optional(),
		proofs: z.array(proofSchema).default([]),
		homonym: z.boolean().optional(),
	})
	.strict();
const inputSchema = z
	.object({
		taxonomy: GenreTaxonomySchema,
		coverage: z.object({
			entries: z.record(
				z.object({
					resolvedSources: z.array(sourceSlugSchema),
					missingSources: z.array(sourceSlugSchema),
					quarantinedSources: z.array(sourceSlugSchema),
					neighbourCount: z.number().int().nonnegative(),
					deficit: z.number().int().nonnegative(),
					publishable: z.boolean(),
				}),
			),
			families: z.record(z.object({ entries: z.number(), publishable: z.number(), deficit: z.number() })),
		}),
		candidates: z.record(z.object({ targets: z.array(targetSchema), anchors: z.array(anchorSchema) })),
		trustedHosts: z.array(z.string().min(1)).default(["musicbrainz.org"]),
	})
	.strict();

interface CliOutput {
	stdout: { write(value: string): unknown };
	stderr: { write(value: string): unknown };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export async function main(
	args = process.argv.slice(2),
	output: CliOutput = { stdout: process.stdout, stderr: process.stderr },
): Promise<number> {
	if (args.length !== 1 || !args[0]) {
		output.stderr.write("usage: propose-genre-seeds.ts <proposal-input.json>\n");
		return 2;
	}
	let raw: unknown;
	try {
		raw = JSON.parse(await readFile(args[0], "utf8")) as unknown;
	} catch (error) {
		output.stderr.write(`error: ${errorMessage(error)}\n`);
		return 1;
	}
	const parsed = inputSchema.safeParse(raw);
	if (!parsed.success) {
		output.stderr.write(`invalid proposal input: ${parsed.error.issues[0]?.message ?? "unknown error"}\n`);
		return 2;
	}
	try {
		const input = parsed.data;
		const report = await proposeGenreSeedsFromMusicBrainz(input.taxonomy, input.coverage, input.candidates, {
			trustedHosts: input.trustedHosts,
		});
		output.stdout.write(`${JSON.stringify(report)}\n`);
		return 0;
	} catch (error) {
		output.stderr.write(`error: ${errorMessage(error)}\n`);
		return 1;
	}
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fileURLToPath(new URL(process.argv[1], "file:"))) {
	void main().then((status) => {
		process.exitCode = status;
	});
}
