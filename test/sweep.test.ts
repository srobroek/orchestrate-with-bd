/**
 * D-5: the session-start sweep. Every case here drives `sweepStaleWorktrees` with an injected
 * command runner, because what matters is *which* commands it decides to run: it must never
 * run `wt step prune`, never pass a destructive flag, and never touch a worktree whose bead is
 * still open.
 */

import { describe, expect, test } from "bun:test";
import { sweepMessage, sweepStaleWorktrees } from "../src/sweep";
import type { CommandResult, CommandRunner } from "../src/worktree";

const ok = (stdout = ""): CommandResult => ({ code: 0, stdout, stderr: "" });

/** One canonical root plus two linked worktrees, as `git worktree list --porcelain` prints it. */
function listing(entries: readonly { path: string; branch: string }[]): string {
	return entries.map(entry => `worktree ${entry.path}\nHEAD abc\nbranch refs/heads/${entry.branch}\n`).join("\n");
}

interface Options {
	prune?: string;
	statuses?: Record<string, string>;
	survives?: readonly string[];
}

function runner(entries: readonly { path: string; branch: string }[], options: Options = {}): { run: CommandRunner; argv: string[][] } {
	const argv: string[][] = [];
	const removed = new Set<string>();
	const run: CommandRunner = async command => {
		argv.push([...command]);
		const [tool, ...rest] = command;
		const joined = rest.join(" ");
		if (tool === "git" && joined.includes("worktree list")) {
			return ok(listing(entries.filter(entry => !removed.has(entry.branch) || (options.survives ?? []).includes(entry.branch))));
		}
		if (tool === "git" && joined.includes("branch --list")) {
			const branch = command[command.length - 1] ?? "";
			return ok((options.survives ?? []).includes(branch) ? `  ${branch}\n` : "");
		}
		if (tool === "wt" && rest.includes("prune")) return ok(options.prune ?? "[]");
		if (tool === "wt" && rest.includes("remove")) {
			removed.add(command[command.length - 1] ?? "");
			return ok();
		}
		if (tool === "bd") {
			const id = rest[1] ?? "";
			return ok(JSON.stringify([{ id, status: options.statuses?.[id] ?? "open" }]));
		}
		return { code: 1, stdout: "", stderr: `unexpected ${joined}` };
	};
	return { run, argv };
}

describe("stale worktree sweep", () => {
	const entries = [
		{ path: "/repo", branch: "main" },
		{ path: "/wt/agent-a", branch: "omp/agent/a" },
		{ path: "/wt/agent-b", branch: "omp/agent/b" },
		{ path: "/wt/someone-else", branch: "feature/unrelated" },
	];

	test("reclaims only the closed bead's worktree, and never forces", async () => {
		const { run, argv } = runner(entries, { statuses: { a: "closed", b: "in_progress" } });
		const result = await sweepStaleWorktrees("/repo", run);
		expect(result).toMatchObject({ swept: ["omp/agent/a"], retained: [] });
		const removals = argv.filter(command => command[0] === "wt" && command.includes("remove"));
		expect(removals).toEqual([["wt", "-C", "/repo", "remove", "-y", "--foreground", "omp/agent/a"]]);
		// The open bead's tree and the unrelated worktree are never named to `wt` at all.
		expect(argv.some(command => command.join(" ").includes("omp/agent/b remove"))).toBe(false);
		expect(argv.some(command => command.includes("feature/unrelated"))).toBe(false);
		for (const command of removals) {
			expect(command).not.toContain("-f");
			expect(command).not.toContain("--force");
			expect(command).not.toContain("-D");
		}
	});

	test("never runs a real prune: the dry run is a precondition, and it stands down when it names anything", async () => {
		const { run, argv } = runner(entries, { statuses: { a: "closed" }, prune: '[{"branch":"someone/else"}]' });
		const result = await sweepStaleWorktrees("/repo", run);
		expect(result.swept).toEqual([]);
		expect(result.stoodDown).toContain("someone/else");
		expect(argv.some(command => command.includes("remove"))).toBe(false);
		const prunes = argv.filter(command => command.includes("prune"));
		expect(prunes).toEqual([["wt", "-C", "/repo", "step", "prune", "--dry-run", "--format", "json"]]);
		expect(prunes[0]).toContain("--dry-run");
	});

	test("a branch that survives its removal is reported for remediation, not silently swept", async () => {
		const { run } = runner(entries, { statuses: { a: "closed" }, survives: ["omp/agent/a"] });
		const result = await sweepStaleWorktrees("/repo", run);
		expect(result.swept).toEqual([]);
		expect(result.retained[0]).toContain("omp/agent/a");
		expect(sweepMessage(result)).toContain("need you");
	});

	test("nothing to sweep asks git nothing further and says nothing", async () => {
		const { run, argv } = runner([{ path: "/repo", branch: "main" }]);
		const result = await sweepStaleWorktrees("/repo", run);
		expect(result).toEqual({ swept: [], retained: [] });
		expect(argv.some(command => command[0] === "wt")).toBe(false);
		expect(sweepMessage(result)).toBeUndefined();
	});
});
