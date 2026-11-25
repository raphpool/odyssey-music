import type { PipelineDeps } from "../pipeline.js";
import { createGeminiGenerateJson } from "./gemini-generate.js";
import { createNodeTranslator } from "./translate-node.js";

// The translation step of the pipeline (TRA-809): the same translator as the batch tool, behind the
// PipelineDeps.translate signature. A refusal is a null, never a throw, and the log line carries only the
// reason and the issue codes: the translated text never reaches a log.

export function makePipelineTranslator(deps: {
	apiKey: string;
	logger?: (line: string) => void;
}): NonNullable<PipelineDeps["translate"]> {
	const translator = createNodeTranslator({ generate: createGeminiGenerateJson(deps.apiKey) });
	const log = deps.logger ?? (() => {});
	return async (node) => {
		const outcome = await translator(node, "fr");
		// The cost does not enter the pipeline metrics (plan, TRA-809): the log is where it is traced.
		const { inputTokens, outputTokens, costUsd } = outcome.usage;
		const usage = `attempts=${outcome.attempts} tokens=${inputTokens}/${outputTokens} cost=$${costUsd.toFixed(5)}`;
		if (outcome.ok) {
			log(`[translate] done for ${node.slug}: ${usage}`);
			return outcome.translation;
		}
		const codes = outcome.issues.map((issue) => issue.code).join(",") || "-";
		log(`[translate] refused for ${node.slug}: reason=${outcome.reason} codes=${codes} ${usage}`);
		return null;
	};
}
