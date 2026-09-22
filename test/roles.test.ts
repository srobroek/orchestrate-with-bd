import { describe, expect, spyOn, test } from "bun:test";
import { scratchDir } from "./scratch";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runHeader } from "../src/index";
import { activeAgent, missingRoles, requiredRoles, rolesStop } from "../src/roles";

function agentsDir(files: Record<string, string>): string {
	const dir = scratchDir("orc-agents-");
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
		expect(roles.get("@task")).toEqual(["orc-implementer", "orc-merger", "orc-shepherd"]);
	});
});

describe("activeAgent", () => {
	test("maps each claim-pool role marker to its exact dispatched agent identity", () => {
		expect(activeAgent(["prefix\nORC-ROLE: implementer (basic tier)\nsuffix"])).toBe("orc-implementer");
		expect(activeAgent(["ORC-ROLE: implementer (deep tier)"])).toBe("orc-implementer-deep");
		expect(activeAgent(["ORC-ROLE: implementer (max tier)"])).toBe("orc-implementer-max");
		expect(activeAgent(["ORC-ROLE: merger"])).toBe("orc-merger");
		expect(activeAgent(["ORC-ROLE: reviewer"])).toBe("orc-reviewer");
		expect(activeAgent(["no orchestration role here"])).toBeUndefined();
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
async function isolatedRunHeader(root: string, stop?: string): Promise<string> {
	const spawn = spyOn(Bun, "spawn").mockImplementation(((argv: string[]) => ({
		stdout: new Response(argv[0] === "gh" ? "Logged in to github.com account test" : "[]").body,
		stderr: new Response("").body,
		exited: Promise.resolve(0),
		kill: () => undefined,
	})) as unknown as typeof Bun.spawn);
	try {
		return await runHeader(root, "omp/x", stop, async () => root);
	} finally {
		spawn.mockRestore();
	}
}

describe("rolesStop in the run header", () => {
	test("an unresolvable alias replaces the dispatch contract with a STOP naming the alias, its agents, and the config key", async () => {
		const root = scratchDir("orc-root-");
		const roles = new Map([["@plan", ["orc-lead"]], ["@reviewer", ["orc-reviewer"]]]);
		const missing = missingRoles({ resolve: (spec: string) => (spec === "@plan" ? { id: "x" } : undefined) }, roles);
		const stopped = await isolatedRunHeader(root, rolesStop(missing));
		expect(stopped).toContain("@reviewer (orc-reviewer)");
		expect(stopped).toContain("modelRoles.reviewer");
		expect(stopped).not.toContain("Read `skill://orchestrate-with-bd`");
		expect(stopped).not.toContain("Work in waves");

		const resolved = await isolatedRunHeader(root);
		expect(resolved).not.toContain("STOP.");
		expect(resolved).toContain("Read `skill://orchestrate-with-bd`");
	});

	test("the wave contract separates per-result refill from whole-wave integration", async () => {
		const root = scratchDir("orc-contract-");
		const header = await isolatedRunHeader(root);
		const wave = header.split("\n").find(line => line.startsWith("- Work in waves.")) ?? "";
		expect(wave).not.toBe("");
		// Refill is per result: a lead that waits for the slowest sibling leaves the freed slots idle
		// while a bead the first finisher unblocked sits in `ready`.
		expect(wave).toContain("on every settled child result");
		expect(wave).toContain("orc_status.newly_ready");
		// Landing is the whole call. Stating that rule as a ban on re-reading status is what made the
		// same bullet say both things, so the ban must not come back.
		expect(wave).toContain("has landed only when the whole `task` call has returned");
		expect(wave).not.toContain("never on the first result");
	});

	test("the run header schedules guarded accepted heads through terminal merger receipts", async () => {
		const root = scratchDir("orc-merger-contract-");
		const header = await isolatedRunHeader(root);
		expect(header).toContain("create exactly one merge bead for that accepted head");
		expect(header).toContain("pool:orc-merger");
		expect(header).toContain("--match-head-commit REVIEWED_HEAD");
		expect(header).toContain("head can change after preflight");
		expect(header).toContain("dispatch the resulting `orc-merger` wave item");
		expect(header).toContain("Consume that receipt before advancing");
		expect(header).toContain("Never schedule a replacement until the old bead is closed");
		expect(header).toContain("resolve every conflict there");
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

describe("queued role claim prompts", () => {
	test("every normal queued role supplies its exact agent identity to orc_claim", () => {
		const queued = ["orc-implementer", "orc-implementer-deep", "orc-implementer-max", "orc-reviewer", "orc-researcher", "orc-shepherd", "orc-merger"];
		for (const agent of queued) {
			const body = readFileSync(join(import.meta.dir, "..", "agents", `${agent}.md`), "utf8");
			expect(body, agent).toMatch(new RegExp(`orc_claim \\{ bead: <[^>]+>, agent: "${agent}" \\}`));
		}
	});
});

describe("merger delivery boundary", () => {
	test("requires an atomic expected-head guard across preflight and mutation", () => {
		const body = readFileSync(join(import.meta.dir, "..", "agents", "orc-merger.md"), "utf8");
		const frontmatter = body.split("---", 3)[1] ?? "";
		const declared = frontmatter.match(/^tools:\s*(.+)$/m)?.[1] ?? "";
		expect(declared.split(",").map(tool => tool.trim())).toEqual(["read", "bash", "orc_claim", "orc_finish"]);
		expect(body).toContain("--match-head-commit HEAD_SHA");
		expect(body).toContain("The head can change after preflight");
		expect(body).toContain("Only the forge's atomic expected-head guard protects the mutation");
		expect(body).toContain("Never replace `--match-head-commit` with another read");
		expect(body).toContain("Never invoke `bd`");
		expect(body).toContain("The lead owns integration policy, the integration worktree, and conflict decisions.");
	});

	test("lead terminally closes and reclaims an attempt before replacement", () => {
		const lead = readFileSync(join(import.meta.dir, "..", "agents", "orc-lead.md"), "utf8");
		expect(lead).toContain("create exactly one merge bead for that accepted head");
		for (const field of ["role", "target", "base", "head_sha", "receipt"]) expect(lead).toContain(`"${field}"`);
		expect(lead).toContain("gh pr merge PR_URL MERGE_METHOD --match-head-commit REVIEWED_HEAD");
		expect(lead).toContain("terminally closed, not blocked");
		expect(lead).toContain("old merge bead is closed");
		expect(lead).toContain("worktree registration, path, and branch are gone");
		expect(lead).toContain("Consume every merger receipt before continuing");
	});

	test("landing conflicts close with not-landed cleanup evidence", () => {
		const landing = readFileSync(join(import.meta.dir, "..", "skills", "orchestrate-with-bd", "references", "landing.md"), "utf8");
		expect(landing).toContain("finishes `done` with `NOT-LANDED` evidence and cleanup");
		expect(landing).not.toContain("The merger blocks with");
	});

	test("shepherd is review-only and never schedules landing", () => {
		const shepherd = readFileSync(join(import.meta.dir, "..", "agents", "orc-shepherd.md"), "utf8");
		expect(shepherd).toContain("are review-only");
		expect(shepherd).toContain("never create or claim a merge bead, dispatch a merger, merge, push, or edit product code");
		expect(shepherd).toContain("The lead alone turns a clean round into a merge bead");
	});
});

describe("planning escalation contract", () => {
	test("tier upgrades describe a clean successor worktree and pull request", () => {
		const planning = readFileSync(join(import.meta.dir, "..", "skills", "orchestrate-with-bd", "references", "planning.md"), "utf8");
		expect(planning).toContain("creating a clean `Fix:` successor bead in the deeper tier's queue");
		expect(planning).toContain("starts with no worktree or pull request");
		expect(planning).toContain("creates its own branch from the predecessor's branch, and opens its own pull request");
		expect(planning).not.toContain("One bead keeps its branch, its pull request and its findings; a successor bead would discard them");
	});
});
