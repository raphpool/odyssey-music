import { type BuildGraphOptions, buildGraphFromCache, DEFAULT_TAXONOMY_PATH } from "../graph.js";

export function createGraphService(
	cacheDir: string,
	// `taxonomyPath` override is test-only (mirrors buildGraphFromCache's own param): production
	// always resolves DEFAULT_TAXONOMY_PATH, the same constant scripts/build-graph-json.ts uses,
	// so the two exports can't silently point at different taxonomy files (TRA-134 review).
	options: Pick<BuildGraphOptions, "taxonomyPath"> = {},
) {
	return {
		getGraph() {
			return buildGraphFromCache(cacheDir, {
				quarantineOrphanGenres: true,
				scrubQuarantinedRefs: true,
				// "degrade": a live cache can lag the repo's committed cache/ (deploy excludes
				// it), so a taxonomy that references a not-yet-deployed genre must never 500 the
				// whole explorer -- log it and serve the graph without picker v2 instead.
				taxonomy: "degrade",
				taxonomyPath: options.taxonomyPath ?? DEFAULT_TAXONOMY_PATH,
			});
		},
	};
}
