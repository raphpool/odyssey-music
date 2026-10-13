import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { EDGE_FIELDS_BY_TYPE, NODE_TYPES, SINGULAR_EDGES_BY_TYPE } from "../src/node-spec.js";

// TRA-395 (plan track1-ios-figma, D9 and D15): the iOS node page is a client-side projection of the Figma Data
// contract, so `NodePageSpec` repeats parts of `src/node-spec.ts`. `npm run check` does not compile Swift, which
// makes this file the only thing that notices when one side moves and the other does not. It reads the constants
// between the parity markers as text and compares them with the TypeScript objects, list by list and in order.
const SWIFT_SPEC = "ios/Track1Core/Sources/Track1Core/Features/Node/NodePageSpec.swift";
// The web front owns the carousel choice, and the Data contract (rule 4) copies it.
const WEB_FRONT = "web/index.html";

const BEGIN_MARKER = "// BEGIN node-spec-parity";
const END_MARKER = "// END node-spec-parity";

const PARITY_CONSTANTS = [
	"sectionOrder",
	"singleFields",
	"carouselField",
	"trackListField",
	"chipLimit",
	"rule9Deviations",
];

// Data contract rule 9 hides these fields. The article and the citations are the one validated exception
// (D15, 2026-10-11): they are shown anyway, and `rule9Deviations` is the only place that may say so.
const RULE_9_FIELDS = ["mbid", "qid", "materialized_at", "image_source"];
const VALIDATED_RULE_9_DEVIATIONS = ["editorial_article", "citations"];

// Data contract rule 3: "max 8 then an Overflow chip '+N more'".
const CHIP_LIMIT = 8;

type FieldsByType = Record<string, readonly string[]>;

interface Reference {
	edgeFields: FieldsByType;
	singularFields: FieldsByType;
	carouselFields: Record<string, string>;
}

const quoted = (text: string) => [...text.matchAll(/"([^"]*)"/g)].map((match) => match[1] ?? "");

/** `[ .artist: ["a", "b"], .label: [] ]` as `{ artist: ["a", "b"], label: [] }`, in literal order. */
const fieldsByType = (literal: string): FieldsByType =>
	Object.fromEntries(
		[...literal.matchAll(/\.(\w+):\s*\[([^\]]*)\]/g)].map((m) => [m[1], quoted(m[2] ?? "")]),
	);

/** `[ .artist: "discography" ]` as `{ artist: "discography" }`. */
const stringByType = (literal: string): Record<string, string> =>
	Object.fromEntries([...literal.matchAll(/\.(\w+):\s*"([^"]*)"/g)].map((m) => [m[1], m[2] ?? ""]));

/** The constants between the markers: `static let name [: Type] = literal`, comments dropped. */
function parityBlock(swiftSource: string): { constants: Map<string, string>; literals: string[] } {
	const begins = swiftSource.split(BEGIN_MARKER).length - 1;
	const ends = swiftSource.split(END_MARKER).length - 1;
	if (begins !== 1 || ends !== 1) {
		throw new Error(`expected one "${BEGIN_MARKER}" and one "${END_MARKER}", found ${begins} and ${ends}`);
	}
	const start = swiftSource.indexOf(BEGIN_MARKER) + BEGIN_MARKER.length;
	const end = swiftSource.indexOf(END_MARKER);
	if (end < start) throw new Error("the END marker comes before the BEGIN marker");

	const code = swiftSource.slice(start, end).replace(/\/\/[^\n]*/g, "");
	const constants = new Map<string, string>();
	for (const declaration of code.split(/(?:\b(?:public|internal)\s+)?\bstatic let\s+/).slice(1)) {
		const [name = "", ...rest] = declaration.split("=");
		constants.set(name.replace(/:.*$/s, "").trim(), rest.join("=").trim());
	}
	return { constants, literals: quoted(code) };
}

/** Reads `PROJECT_CAROUSEL_EDGE` from the web front: `{ artist: "discography", ... }`. */
function webCarouselEdges(webSource: string): Record<string, string> {
	const body = /const PROJECT_CAROUSEL_EDGE = \{([^}]*)\}/.exec(webSource)?.[1];
	if (body === undefined) throw new Error("PROJECT_CAROUSEL_EDGE not found in web/index.html");
	return Object.fromEntries([...body.matchAll(/(\w+):\s*"(\w+)"/g)].map((match) => [match[1], match[2]]));
}

/** One sentence per divergence between the Swift constants and the reference; empty means parity. */
function parityProblems(swiftSource: string, reference: Reference): string[] {
	let block: ReturnType<typeof parityBlock>;
	try {
		block = parityBlock(swiftSource);
	} catch (error) {
		return [`cannot read the parity block: ${(error as Error).message}`];
	}
	const { constants, literals } = block;
	const problems: string[] = [];
	const same = (actual: unknown, expected: unknown) => JSON.stringify(actual) === JSON.stringify(expected);

	for (const name of PARITY_CONSTANTS) {
		if (!constants.has(name)) problems.push(`${name} is missing between the markers`);
	}
	for (const name of constants.keys()) {
		if (!PARITY_CONSTANTS.includes(name))
			problems.push(`${name} is not a parity constant: move it below END`);
	}

	for (const [name, expected] of [
		["sectionOrder", reference.edgeFields],
		["singleFields", reference.singularFields],
	] as const) {
		const actual = fieldsByType(constants.get(name) ?? "");
		for (const type of NODE_TYPES) {
			if (!same(actual[type], expected[type])) {
				problems.push(
					`${name}.${type} is ${JSON.stringify(actual[type])}, node-spec has ${JSON.stringify(expected[type])}`,
				);
			}
		}
	}

	const carousel = Object.entries(stringByType(constants.get("carouselField") ?? "")).sort();
	const webCarousel = Object.entries(reference.carouselFields).sort();
	if (!same(carousel, webCarousel)) {
		problems.push(
			`carouselField is ${JSON.stringify(carousel)}, the web front has ${JSON.stringify(webCarousel)}`,
		);
	}

	const trackList = quoted(constants.get("trackListField") ?? "")[0] ?? "";
	if (!reference.edgeFields.project?.includes(trackList)) {
		problems.push(`trackListField "${trackList}" is not a project edge in node-spec`);
	}

	if (Number(constants.get("chipLimit")) !== CHIP_LIMIT) problems.push(`chipLimit must be ${CHIP_LIMIT}`);

	const deviations = quoted(constants.get("rule9Deviations") ?? "");
	if (!same(deviations, VALIDATED_RULE_9_DEVIATIONS)) {
		problems.push(
			`rule9Deviations is ${JSON.stringify(deviations)}, the only validated exception is ${JSON.stringify(VALIDATED_RULE_9_DEVIATIONS)}`,
		);
	}
	for (const field of RULE_9_FIELDS) {
		if (literals.includes(field)) problems.push(`"${field}" is hidden by rule 9: not between the markers`);
	}
	return problems;
}

describe("NodePageSpec parity with src/node-spec.ts", async () => {
	const swiftSource = await readFile(SWIFT_SPEC, "utf8");
	const reference: Reference = {
		edgeFields: Object.fromEntries(NODE_TYPES.map((type) => [type, Object.keys(EDGE_FIELDS_BY_TYPE[type])])),
		singularFields: SINGULAR_EDGES_BY_TYPE,
		carouselFields: webCarouselEdges(await readFile(WEB_FRONT, "utf8")),
	};
	const problemsOf = (source: string, against = reference) => parityProblems(source, against).join("\n");

	it("accepts the committed constants, including the validated rule 9 exception", () => {
		expect(parityProblems(swiftSource, reference)).toEqual([]);
	});

	it("rejects a section field that exists only on the Swift side", () => {
		const changed = swiftSource.replace('"aliases"', '"aliases", "bogus_field"');
		expect(changed).not.toBe(swiftSource);
		expect(problemsOf(changed)).toContain("sectionOrder.artist");
	});

	it("rejects a section field that exists only in node-spec", () => {
		const edgeFields = {
			...reference.edgeFields,
			artist: [...(reference.edgeFields.artist ?? []), "new_edge"],
		};
		expect(problemsOf(swiftSource, { ...reference, edgeFields })).toContain("sectionOrder.artist");
	});

	it("rejects two section fields swapped on the Swift side", () => {
		const changed = swiftSource
			.replace('"influences"', '"@swap"')
			.replace('"influenced"', '"influences"')
			.replace('"@swap"', '"influenced"');
		expect(changed).not.toBe(swiftSource);
		expect(problemsOf(changed)).toContain("sectionOrder.artist");
	});

	it("rejects two section fields swapped in node-spec only", () => {
		const [first = "", second = "", ...rest] = reference.edgeFields.genre ?? [];
		const edgeFields = { ...reference.edgeFields, genre: [second, first, ...rest] };
		expect(problemsOf(swiftSource, { ...reference, edgeFields })).toContain("sectionOrder.genre");
	});

	it("rejects a single field that moves on one side only", () => {
		const singularFields = { ...reference.singularFields, track: ["project", "label"] };
		expect(problemsOf(swiftSource, { ...reference, singularFields })).toContain("singleFields.track");
	});

	it("rejects a carousel that differs from the web front", () => {
		const carouselFields = { ...reference.carouselFields, artist: "notable_tracks" };
		expect(problemsOf(swiftSource, { ...reference, carouselFields })).toContain("carouselField");
	});

	it("rejects a rule 9 deviation other than the article and the citations", () => {
		for (const field of RULE_9_FIELDS) {
			const changed = swiftSource.replace('"citations"', `"${field}"`);
			expect(changed).not.toBe(swiftSource);
			expect(problemsOf(changed), field).toContain("rule9Deviations");
		}
		expect(problemsOf(swiftSource.replace('"citations"', '"citations", "mbid"'))).toContain(
			'"mbid" is hidden',
		);
	});

	it("rejects a rule 9 field anywhere else between the markers", () => {
		expect(problemsOf(swiftSource.replace('"aliases"', '"aliases", "qid"'))).toContain('"qid" is hidden');
	});

	it("rejects a constant outside the parity contract between the markers", () => {
		const changed = swiftSource.replace(END_MARKER, `public static let extra = 1\n\t${END_MARKER}`);
		expect(problemsOf(changed)).toContain("extra is not a parity constant");
	});

	it("rejects a file whose markers are missing or duplicated", () => {
		expect(problemsOf(swiftSource.replace(BEGIN_MARKER, "// begin"))).toContain(
			"cannot read the parity block",
		);
		expect(problemsOf(`${swiftSource}\n${END_MARKER}\n`)).toContain("cannot read the parity block");
	});
});
