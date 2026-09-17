import { describe, expect, it } from "vitest";
import { isSameEntityName } from "../src/entity-name.js";

// TRA-XXX: real homonym collisions observed in the 2026-09-17 --genre-seeds crawl (168
// targets), where researchTarget searched by name alone and canonicalizeDraft let the
// LLM-authored name silently replace the requested one under the requested slug.
describe("isSameEntityName", () => {
	describe("refuses real homonym collisions", () => {
		it.each([
			["Tracy Onne", "Tracy Lawrence"], // artist:tracy-onne -> wrote the US country singer
			["Towdee Mac", "Mac Davis"], // artist:towdee-mac -> wrote the wrong Mac
			["Nazira", "Naaz"], // artist:nazira -> unrelated artist
			["Afrobeats", "Afrobeat"], // genre:afrobeats (Q25099840) -> wrote Fela's Afrobeat
			["Breaks", "Breakbeat"], // distinct, related genres — not interchangeable
		])("requested %j vs drafted %j", (requested, drafted) => {
			expect(isSameEntityName(requested, drafted)).toBe(false);
		});
	});

	describe("accepts benign stylization drift", () => {
		it.each([
			["Tyree", "Tyree Cooper"], // requested alias is a strict prefix of the full name
			["House music", "House"],
			["Hip Hop", "Hip-Hop"],
			["The Beatles", "Beatles"],
			["Beyoncé", "Beyonce"],
			["Guns N' Roses", "Guns N Roses"],
			["R&B", "R and B"],
		])("requested %j vs drafted %j", (requested, drafted) => {
			expect(isSameEntityName(requested, drafted)).toBe(true);
		});
	});

	it("is symmetric for both the exact-match and subset cases", () => {
		expect(isSameEntityName("Tyree Cooper", "Tyree")).toBe(true);
		expect(isSameEntityName("Tracy Lawrence", "Tracy Onne")).toBe(false);
	});
});
