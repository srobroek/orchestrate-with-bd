import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHeader } from "../src/index";
import { missingRoles, requiredRoles, rolesStop } from "../src/roles";

function agentsDir(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "orc-agents-"));
	for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
	return dir;
}

describe("requiredRoles", () => {
	test("collects role aliases from agent frontmatter, grouped by alias, ignoring non-alias models and body text", () => {
		const dir = agentsDir({
			"a.md": '---\nname: a\nmodel: "@plan"\n---\nmodel: "@not-frontmatter"\n',
			"b.md": "---\nname: b\nmodel: @plan:high\n---\n",
			"c.md": '---\nname: c\nmodel: "anthropic/claude-x"\n---\n',
			"d.md": "---\nname: d\n---\n",
			"e.txt": '---\nmodel: "@ignored"\n---\n',
		});
		expect([...requiredRoles(dir)]).toEqual([["@plan", ["a", "b"]]]);
	});

	test("the shipped agents name only OMP built-in role aliases, so a fresh install needs no modelRoles entry", () => {
		const builtIn = new Set(["@default", "@smol", "@slow", "@vision", "@plan", "@commit", "@tiny", "@task", "@advisor"]);
		const roles = requiredRoles();
		expect(roles.size).toBeGreaterThan(0);
		for (const alias of roles.keys()) expect(builtIn.has(alias), alias).toBe(true);
		expect(roles.get("@slow")).toEqual(["orc-implementer-max", "orc-reviewer"]);
		expect(roles.get("@task")).toEqual(["orc-implementer", "orc-shepherd"]);
	});
});

describe("missingRoles", () => {
	const roles = new Map([
		["@plan", ["orc-lead"]],
		["@reviewer", ["orc-reviewer"]],
	]);
	test("keeps only the aliases the resolver cannot turn into a model", () => {
		const models = { resolve: (spec: string) => (spec === "@plan" ? { id: "x" } : undefined) };
		expect([...missingRoles(models, roles)]).toEqual([["@reviewer", ["orc-reviewer"]]]);
		expect(missingRoles({ resolve: () => ({ id: "x" }) }, roles).size).toBe(0);
	});
});

describe("rolesStop in the run header", () => {
	test("an unresolvable alias replaces the dispatch contract with a STOP naming the alias, its agents, and the config key", async () => {
		const root = mkdtempSync(join(tmpdir(), "orc-root-"));
		const roles = new Map([["@plan", ["orc-lead"]], ["@reviewer", ["orc-reviewer"]]]);
		const missing = missingRoles({ resolve: (spec: string) => (spec === "@plan" ? { id: "x" } : undefined) }, roles);
		const stopped = await runHeader(root, "omp/x", rolesStop(missing));
		expect(stopped).toContain("@reviewer (orc-reviewer)");
		expect(stopped).toContain("modelRoles.reviewer");
		expect(stopped).not.toContain("Read `skill://orchestrate-with-bd`");
		expect(stopped).not.toContain("Work in waves");

		const resolved = await runHeader(root, "omp/x");
		expect(resolved).not.toContain("STOP.");
		expect(resolved).toContain("Read `skill://orchestrate-with-bd`");
	});
});

describe("implementer tool exposure", () => {
	test("every tier exposes its ledger, editing, inspection, and helper tools", () => {
		const required = ["read", "grep", "glob", "bash", "edit", "write", "ast_grep", "task", "orc_claim", "orc_finish"];
		for (const agent of ["orc-implementer.md", "orc-implementer-deep.md", "orc-implementer-max.md"]) {
			const frontmatter = readFileSync(join(import.meta.dir, "..", "agents", agent), "utf8").split("---", 3)[1] ?? "";
			const declared = frontmatter.match(/^tools:\s*(.+)$/m)?.[1] ?? "";
			const tools = new Set(declared.split(",").map((tool) => tool.trim()).filter(Boolean));
			for (const tool of required) expect(tools.has(tool), `${agent}: ${tool}`).toBe(true);
		}
	});
});
