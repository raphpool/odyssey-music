import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
	EDGE_FIELDS_BY_TYPE,
	NODE_TYPES,
	OPTIONAL_TEXT_FIELDS,
	SINGULAR_EDGES_BY_TYPE,
} from "../src/node-spec.js";

// TRA-395 (plan track1-ios-figma, D9 and D15): the iOS node page is a client-side projection of the Figma Data
// contract, so `NodePageSpec` repeats parts of `src/node-spec.ts`. `npm run check` does not compile Swift, which
// makes this file the only thing that notices when one side moves and the other does not. It reads the constants
// between the parity markers as text and compares them with the TypeScript objects, list by list and in order.
const SWIFT_SPEC = "ios/Track1Core/Sources/Track1Core/Features/Node/NodePageSpec.swift";
// TRA-436: the header picks the node fields behind the subtitle and the facts block. Those names are not between
// the parity markers, so they are read from the code that uses them.
const SWIFT_HEADER = "ios/Track1Core/Sources/Track1Core/Features/Node/NodePageHeader.swift";
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
	optionalTextFields: FieldsByType;
}

const same = (actual: unknown, expected: unknown) => JSON.stringify(actual) === JSON.stringify(expected);

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

// --- Header fields (TRA-436) ---

/** The node fields `NodePageHeader` reads, per node type. */
interface HeaderFields {
	/** `facts["..."]` reads of the subtitle: optional text fields. */
	subtitleText: FieldsByType;
	/** `node.edges["..."]` reads of the subtitle: edge fields. */
	subtitleEdges: FieldsByType;
	/** The `field` of every `NodePageSpec.factFields` entry: optional text fields. */
	facts: FieldsByType;
}

/** Drops `//` comments (doc comments too) and keeps string literals, so a `//` inside a string survives. */
const withoutComments = (source: string) =>
	source.replace(/"(?:[^"\\\n]|\\.)*"|\/\/[^\n]*/g, (match) => (match.startsWith("//") ? "" : match));

/**
 * Index of the quote that closes the string literal opened at `open`. One-line literals are read, interpolations
 * included (`"\(a) \(b)"`, as the label subtitle uses). A raw string or a multi-line string would hide brackets
 * and quotes from this scan, so they stop it with a message instead of letting it drift.
 */
function closingQuote(source: string, open: number): number {
	if (source[open - 1] === "#" || source.startsWith('""', open + 1)) {
		throw new Error("raw and multi-line string literals are not supported here");
	}
	for (let i = open + 1; i < source.length; i++) {
		if (source[i] === "\\") {
			i = source[i + 1] === "(" ? closingParen(source, i + 1) : i + 1;
		} else if (source[i] === '"') return i;
		else if (source[i] === "\n") break;
	}
	throw new Error("unterminated string literal");
}

/** Index of the `)` that closes the interpolation opened at `open`; quotes inside it are skipped whole. */
function closingParen(source: string, open: number): number {
	let depth = 0;
	for (let i = open; i < source.length; i++) {
		if (source[i] === '"') i = closingQuote(source, i);
		else if (source[i] === "(") depth++;
		else if (source[i] === ")" && --depth === 0) return i;
	}
	throw new Error("unterminated string interpolation");
}

/** The text between the bracket at `open` and its partner, brackets inside string literals ignored. */
function balanced(source: string, open: number): string {
	const opener = source[open] ?? "";
	const closer = ({ "{": "}", "[": "]", "(": ")" } as Record<string, string>)[opener];
	if (closer === undefined) throw new Error(`no bracket at offset ${open}`);
	let depth = 0;
	for (let i = open; i < source.length; i++) {
		const char = source[i];
		if (char === '"') i = closingQuote(source, i);
		else if (char === opener) depth++;
		else if (char === closer && --depth === 0) return source.slice(open + 1, i);
	}
	throw new Error(`"${opener}" at offset ${open} is never closed`);
}

/** Splits at the commas outside any bracket and string; blank items (a trailing comma) are dropped. */
function topLevelItems(body: string): string[] {
	const items: string[] = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < body.length; i++) {
		const char = body[i] ?? "";
		if (char === '"') i = closingQuote(body, i);
		else if ("[({".includes(char)) depth++;
		else if ("])}".includes(char)) depth--;
		else if (char === "," && depth === 0) {
			items.push(body.slice(start, i));
			start = i + 1;
		}
	}
	items.push(body.slice(start));
	return items.map((item) => item.trim()).filter((item) => item !== "");
}

/** The body of `static let <name>: <type> = [ ... ]` (array or dictionary literal), brackets excluded. */
function swiftLiteralBody(code: string, name: string): string {
	const found = new RegExp(`static let ${name}\\b\\s*:[^=\\n]*=\\s*\\[`).exec(code);
	if (found === null) throw new Error(`"static let ${name}: ... = [...]" not found`);
	return balanced(code, found.index + found[0].length - 1);
}

/** `factFields`: `[ .project: projectFacts, .genre: [("sonic_markers", "SONIC MARKERS")], ... ]`. */
function factFieldsByType(code: string): FieldsByType {
	const result: Record<string, string[]> = {};
	for (const item of topLevelItems(swiftLiteralBody(code, "factFields"))) {
		const entry = /^\.(\w+)\s*:\s*([\s\S]+)$/.exec(item);
		if (entry === null) throw new Error(`factFields entry not understood: ${item}`);
		const [, type = "", value = ""] = entry;
		if (Object.hasOwn(result, type)) throw new Error(`factFields lists .${type} twice`);
		// A value is either an array literal or the name of another `static let` array of the same shape.
		let list: string;
		if (/^\w+$/.test(value)) list = swiftLiteralBody(code, value);
		else if (value.startsWith("[")) list = balanced(value, 0);
		else throw new Error(`factFields.${type} is neither an array literal nor a named array: ${value}`);
		result[type] = topLevelItems(list).map((tuple) => {
			const parts = /^\(\s*(?:field:\s*)?"([^"]*)"\s*,\s*(?:label:\s*)?"([^"]*)"\s*\)$/.exec(tuple);
			if (parts === null) throw new Error(`factFields.${type} entry not understood: ${tuple}`);
			return parts[1] ?? "";
		});
	}
	return result;
}

/** The `facts["..."]` and `node.edges["..."]` reads of each `case` of the subtitle switch. */
function subtitleFields(code: string): { text: FieldsByType; edges: FieldsByType } {
	const signature = /func subtitle\([^)]*\)\s*->\s*String\?\s*\{/.exec(code);
	if (signature === null) throw new Error("func subtitle(of:facts:) not found");
	const body = balanced(code, signature.index + signature[0].length - 1);
	const switchHead = /switch node\.type\s*\{/.exec(body);
	if (switchHead === null) throw new Error("`switch node.type` not found in subtitle(of:facts:)");
	const cases = balanced(body, switchHead.index + switchHead[0].length - 1);
	if (/\bdefault\s*:/.test(cases)) throw new Error("`default:` in the subtitle switch hides node types");

	const heads = [...cases.matchAll(/\bcase \.(\w+)\s*:/g)];
	const text: Record<string, string[]> = {};
	const edges: Record<string, string[]> = {};
	heads.forEach((head, index) => {
		const type = head[1] ?? "";
		if (Object.hasOwn(text, type)) throw new Error(`the subtitle switch has two cases for .${type}`);
		const segment = cases.slice(head.index + head[0].length, heads[index + 1]?.index ?? cases.length);
		const factReads = [...segment.matchAll(/\bfacts\["(\w+)"\]/g)].map((m) => m[1] ?? "");
		const edgeReads = [...segment.matchAll(/\bnode\.edges\["(\w+)"\]/g)].map((m) => m[1] ?? "");
		// A read through a variable or a computed key would escape the scans above, so count every read too.
		const reads = (segment.match(/\bfacts\[/g) ?? []).length + (segment.match(/\bedges\[/g) ?? []).length;
		if (reads !== factReads.length + edgeReads.length) {
			throw new Error(`subtitle case .${type} reads a field that is not a string literal`);
		}
		if (reads === 0) throw new Error(`subtitle case .${type} reads no field`);
		text[type] = factReads;
		edges[type] = edgeReads;
	});
	if (!same(Object.keys(text).sort(), [...NODE_TYPES].sort())) {
		throw new Error(`the subtitle switch covers ${Object.keys(text).join(", ")}, not every node type`);
	}
	if ((body.match(/\bfacts\[/g) ?? []).length !== Object.values(text).flat().length) {
		throw new Error("subtitle(of:facts:) reads facts outside its switch");
	}
	return { text, edges };
}

function headerFields(headerSource: string): HeaderFields {
	const code = withoutComments(headerSource);
	const subtitle = subtitleFields(code);
	const facts = factFieldsByType(code);
	if (!same(Object.keys(facts).sort(), [...NODE_TYPES].sort())) {
		throw new Error(`factFields covers ${Object.keys(facts).join(", ")}, not every node type`);
	}
	return { subtitleText: subtitle.text, subtitleEdges: subtitle.edges, facts };
}

/** One sentence per header field that `src/node-spec.ts` does not declare; empty means every field exists. */
function headerProblems(headerSource: string, reference: Reference): string[] {
	let fields: HeaderFields;
	try {
		fields = headerFields(headerSource);
	} catch (error) {
		return [`cannot read the header fields: ${(error as Error).message}`];
	}
	const problems: string[] = [];
	for (const type of NODE_TYPES) {
		const declared = reference.optionalTextFields[type] ?? [];
		for (const [where, names] of [
			["subtitle", fields.subtitleText[type]],
			["facts", fields.facts[type]],
		] as const) {
			for (const name of names ?? []) {
				if (!declared.includes(name)) {
					problems.push(`header ${where} of ${type} reads "${name}", not in OPTIONAL_TEXT_FIELDS.${type}`);
				}
			}
		}
		const edges = reference.edgeFields[type] ?? [];
		for (const name of fields.subtitleEdges[type] ?? []) {
			if (!edges.includes(name)) {
				problems.push(`header subtitle of ${type} reads edge "${name}", not in EDGE_FIELDS_BY_TYPE.${type}`);
			}
		}
		const facts = fields.facts[type] ?? [];
		if (new Set(facts).size !== facts.length) problems.push(`header facts of ${type} list a field twice`);
		// The subtitle already says it: a field in both places would be shown twice (`duration` is the example).
		for (const name of fields.subtitleText[type] ?? []) {
			if (facts.includes(name))
				problems.push(`header of ${type} shows "${name}" in the subtitle and in the facts`);
		}
	}
	return problems;
}

// --- Section labels ---
// Added on TRA-436 at the dispatcher's request (2026-10-13). The iOS labels copy `KIND_LABEL` of the web front,
// and nothing noticed a label changed on one side only: the page would show two names for one section.

interface KindLabels {
	labels: Record<string, string>;
	/** `project` depends on the node type: the label of a track, then the label of anything else. */
	project: string[];
}

/** `KIND_LABEL` of the web front: `{ artists: "artist(s)", ... }`, and the `project` ternary apart. */
function webKindLabels(webSource: string): KindLabels {
	const raw = /const KIND_LABEL = \{([\s\S]*?)\n\s*\};/.exec(webSource)?.[1];
	if (raw === undefined) throw new Error("KIND_LABEL not found in web/index.html");
	const body = withoutComments(raw);
	const project = /\bproject:\s*node\.type === "track" \? "([^"]*)" : "([^"]*)"/.exec(body);
	if (project === null) throw new Error('KIND_LABEL.project is no longer `node.type === "track" ? a : b`');
	const labels = Object.fromEntries(
		[...body.matchAll(/^\s*(\w+):\s*"([^"]*)",?\s*$/gm)].map((m) => [m[1] ?? "", m[2] ?? ""]),
	);
	return { labels, project: [project[1] ?? "", project[2] ?? ""] };
}

/** `kindLabels` of `NodePageSpec`, and the `project` branch of `label(field:type:)`. */
function swiftKindLabels(swiftSource: string): KindLabels {
	const code = withoutComments(swiftSource);
	const labels: Record<string, string> = {};
	for (const item of topLevelItems(swiftLiteralBody(code, "kindLabels"))) {
		const pair = /^"(\w+)"\s*:\s*"([^"]*)"$/.exec(item);
		if (pair === null) throw new Error(`kindLabels entry not understood: ${item}`);
		labels[pair[1] ?? ""] = pair[2] ?? "";
	}
	const project = /field == "project"\s*\{\s*return type == \.track \? "([^"]*)" : "([^"]*)"/.exec(code);
	if (project === null)
		throw new Error("the `project` line of label(field:type:) is no longer `type == .track ? a : b`");
	return { labels, project: [project[1] ?? "", project[2] ?? ""] };
}

/** One sentence per label that differs between iOS and the web front; empty means they match. */
function labelProblems(swiftSource: string, webSource: string): string[] {
	let ios: KindLabels;
	let web: KindLabels;
	try {
		ios = swiftKindLabels(swiftSource);
		web = webKindLabels(webSource);
	} catch (error) {
		return [`cannot read the section labels: ${(error as Error).message}`];
	}
	const problems: string[] = [];
	for (const field of new Set([...Object.keys(ios.labels), ...Object.keys(web.labels)])) {
		const [iosLabel, webLabel] = [ios.labels[field], web.labels[field]];
		if (iosLabel === undefined) problems.push(`label "${field}" is "${webLabel}" on the web, missing on iOS`);
		else if (webLabel === undefined)
			problems.push(`label "${field}" is "${iosLabel}" on iOS, missing on the web`);
		else if (iosLabel !== webLabel)
			problems.push(`label "${field}" is "${iosLabel}" on iOS, "${webLabel}" on the web`);
	}
	if (!same(ios.project, web.project)) {
		problems.push(
			`label "project" is ${JSON.stringify(ios.project)} on iOS, ${JSON.stringify(web.project)} on the web`,
		);
	}
	return problems;
}

describe("NodePageSpec parity with src/node-spec.ts", async () => {
	const swiftSource = await readFile(SWIFT_SPEC, "utf8");
	const headerSource = await readFile(SWIFT_HEADER, "utf8");
	const webSource = await readFile(WEB_FRONT, "utf8");
	const reference: Reference = {
		edgeFields: Object.fromEntries(NODE_TYPES.map((type) => [type, Object.keys(EDGE_FIELDS_BY_TYPE[type])])),
		singularFields: SINGULAR_EDGES_BY_TYPE,
		carouselFields: webCarouselEdges(webSource),
		optionalTextFields: OPTIONAL_TEXT_FIELDS,
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

	// TRA-436: every field behind the header subtitle and the facts block exists in src/node-spec.ts.
	describe("header fields", () => {
		const headerOf = (source: string, against = reference) => headerProblems(source, against).join("\n");
		const replaced = (from: string, to: string) => {
			const changed = headerSource.replace(from, to);
			expect(changed, `"${from}" is no longer in NodePageHeader.swift`).not.toBe(headerSource);
			return changed;
		};

		it("reads the fields the header uses, and OPTIONAL_TEXT_FIELDS declares each of them", () => {
			const fields = headerFields(headerSource);
			// Anchors, so that an empty scan cannot pass: one field per source of the subtitle and of the facts.
			expect(fields.subtitleText.artist).toEqual(["origin", "active_years"]);
			expect(fields.subtitleText.track).toContain("duration");
			expect(fields.subtitleEdges.project).toEqual(["artists"]);
			expect(fields.facts.genre).toEqual(["sonic_markers"]);
			expect(fields.facts.artist).toEqual([]);
			expect(headerProblems(headerSource, reference)).toEqual([]);
		});

		it("rejects a subtitle field that node-spec does not declare for that type", () => {
			expect(headerOf(replaced('facts["era"], facts["origin"]', 'facts["era"], facts["orgin"]'))).toContain(
				'header subtitle of genre reads "orgin", not in OPTIONAL_TEXT_FIELDS.genre',
			);
			// Declared for another type is not enough: `era` belongs to genre, not to artist.
			expect(headerOf(replaced('facts["origin"], facts["active_years"]', 'facts["era"]'))).toContain(
				'header subtitle of artist reads "era"',
			);
		});

		it("rejects a subtitle edge that node-spec does not declare", () => {
			expect(headerOf(replaced('node.edges["project"]', 'node.edges["album"]'))).toContain(
				'header subtitle of track reads edge "album", not in EDGE_FIELDS_BY_TYPE.track',
			);
		});

		it("rejects a fact field that node-spec does not declare, in a literal or in a named list", () => {
			expect(headerOf(replaced('("sonic_markers"', '("sonic_marker"'))).toContain(
				'header facts of genre reads "sonic_marker", not in OPTIONAL_TEXT_FIELDS.genre',
			);
			const renamed = headerOf(replaced('("bpm", "BPM")', '("tempo", "BPM")'));
			expect(renamed).toContain('header facts of project reads "tempo"');
			expect(renamed).toContain('header facts of track reads "tempo"');
			expect(headerOf(replaced(".artist: []", '.artist: [("bpm", "BPM")]'))).toContain(
				'header facts of artist reads "bpm", not in OPTIONAL_TEXT_FIELDS.artist',
			);
			expect(headerOf(replaced('("founders", "FOUNDERS")', '("active_years", "FOUNDERS")'))).toContain(
				"header facts of label list a field twice",
			);
		});

		it("rejects a field shown in the subtitle and again in the facts", () => {
			expect(
				headerOf(replaced('.genre: [("sonic_markers", "SONIC MARKERS")]', '.genre: [("origin", "ORIGIN")]')),
			).toContain('header of genre shows "origin" in the subtitle and in the facts');
		});

		it("stops on a string form its scan does not understand, instead of reading it wrong", () => {
			const interpolated = replaced(
				'facts["year"],\n\t\t\t]\n\t\tcase .track',
				'facts["\\(year)"],\n\t\t\t]\n\t\tcase .track',
			);
			expect(headerOf(interpolated)).toContain("not a string literal");
			expect(headerOf(replaced('"\\(NodePageSpec.foundedLabel) \\($0)"', '#"raw"#'))).toContain(
				"raw and multi-line string literals are not supported",
			);
		});

		it("rejects a field that node-spec renames or drops while the header keeps reading it", () => {
			const renamed = OPTIONAL_TEXT_FIELDS.project.map((field) => (field === "bpm" ? "tempo" : field));
			const optionalTextFields = { ...OPTIONAL_TEXT_FIELDS, project: renamed };
			const problems = headerOf(headerSource, { ...reference, optionalTextFields });
			expect(problems).toContain('header facts of project reads "bpm", not in OPTIONAL_TEXT_FIELDS.project');
			expect(problems).not.toContain("of track");
		});

		it("fails with a clear message on a form it cannot read", () => {
			const unreadable = [
				[
					'facts["origin"], facts["active_years"]',
					'facts[key], facts["active_years"]',
					"not a string literal",
				],
				["switch node.type {", "switch node.kind {", "`switch node.type` not found"],
				["case .genre:", "case .genre, .label:", "not every node type"],
				["\t\tcase .label:", "\t\tdefault:", "`default:`"],
				["static let factFields", "static let facts", '"static let factFields'],
				['("founders", "FOUNDERS")', '("founders")', "not understood"],
				["static let projectFacts", "static let otherFacts", '"static let projectFacts'],
				["func subtitle(", "func strapline(", "func subtitle(of:facts:) not found"],
			] as const;
			for (const [from, to, message] of unreadable) {
				const problems = headerOf(replaced(from, to));
				expect(problems, from).toContain("cannot read the header fields");
				expect(problems, from).toContain(message);
			}
		});
	});

	// TRA-457: the web front repeats the singular edges of node-spec in two places (static load and live
	// materialization). One table that forgets `artist.landmark_project` would drop the edge from the page.
	it("lists the singular edges of node-spec in both SINGLE_EDGES tables of the web front", () => {
		const tables = [...webSource.matchAll(/const SINGLE_EDGES = \{([^}]*)\};/g)];
		expect(tables).toHaveLength(2);
		for (const [, body = ""] of tables) {
			const parsed = Object.fromEntries(
				[...body.matchAll(/(\w+):\s*\[([^\]]*)\]/g)].map((m) => [m[1], quoted(m[2] ?? "")]),
			);
			expect(parsed).toEqual(SINGULAR_EDGES_BY_TYPE);
		}
	});

	// The section labels of NodePageSpec are the web ones (see "Section labels" above).
	describe("section labels", () => {
		const labelsOf = (ios: string, web: string) => labelProblems(ios, web).join("\n");

		it("are the same on iOS and on the web front", () => {
			expect(labelProblems(swiftSource, webSource)).toEqual([]);
			// Anchor, so that an empty scan cannot pass.
			expect(swiftKindLabels(swiftSource).labels.related_projects).toBe("related albums");
			expect(webKindLabels(webSource).labels.related_projects).toBe("related albums");
		});

		it("rejects a label that was changed on one side only", () => {
			const ios = swiftSource.replace('"performers"', '"players"');
			expect(ios).not.toBe(swiftSource);
			expect(labelsOf(ios, webSource)).toContain(
				'label "personnel" is "players" on iOS, "performers" on the web',
			);
			const web = webSource.replace('personnel: "performers"', 'personnel: "crew"');
			expect(web).not.toBe(webSource);
			expect(labelsOf(swiftSource, web)).toContain(
				'label "personnel" is "performers" on iOS, "crew" on the web',
			);
		});

		it("rejects a field that is labelled on one side only", () => {
			const ios = swiftSource.replace('"sampled_by": "sampled by",', "");
			expect(ios).not.toBe(swiftSource);
			expect(labelsOf(ios, webSource)).toContain(
				'label "sampled_by" is "sampled by" on the web, missing on iOS',
			);
			const web = webSource.replace('remix_of: "remix of",', "");
			expect(web).not.toBe(webSource);
			expect(labelsOf(swiftSource, web)).toContain(
				'label "remix_of" is "remix of" on iOS, missing on the web',
			);
		});

		it("rejects a different label for a project edge", () => {
			const ios = swiftSource.replace('? "album / ep" :', '? "album" :');
			expect(ios).not.toBe(swiftSource);
			expect(labelsOf(ios, webSource)).toContain('label "project"');
		});

		it("fails with a clear message on a form it cannot read", () => {
			expect(labelsOf(swiftSource, webSource.replace("const KIND_LABEL", "const KINDS"))).toContain(
				"cannot read the section labels: KIND_LABEL not found",
			);
			expect(
				labelsOf(swiftSource.replace("static let kindLabels", "static let labels"), webSource),
			).toContain('cannot read the section labels: "static let kindLabels');
			expect(
				labelsOf(swiftSource.replace('"tracklist": "tracks"', '"tracklist": tracks'), webSource),
			).toContain("kindLabels entry not understood");
			expect(
				labelsOf(swiftSource, webSource.replace('project: node.type === "track"', "project: isTrack")),
			).toContain("KIND_LABEL.project is no longer");
		});
	});
});
