import { buildGraphFromCache } from "../graph.js";

export function createGraphService(cacheDir: string) {
	return {
		getGraph() {
			return buildGraphFromCache(cacheDir);
		},
	};
}
