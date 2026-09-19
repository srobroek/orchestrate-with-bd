import { describe, expect, test } from "bun:test";
import type { BdBead } from "../src/bd";
import { parentOf } from "../src/bd";
import {
	applyDecision,
	applyVerdict,
	holdOf,
	nextTier,
	reviewTargets,
	ROUND_CAP,
} from "../src/verdict";

/** A recorded `bd` runner: every call is captured; `create` returns a fresh id; `list` returns the known beads. */
function recorder(shows: Record<string, BdBead>) {
	const calls: string[][] = [];
	let created = 0;
	const bd = async (args: readonly string[]) => {
		calls.push([...args]);
		if (args[0] === "create")
			return { id: `new-${++created}`, title: args[args.indexOf("--title") + 1] };
		if (args[0] === "list") return Object.values(shows);
		return undefined;
	};
	const show = async (id: string) => {
		const bead = shows[id];
		if (bead === undefined) throw new Error(`no bead ${id}`);
		return bead;
	};
	return { calls, bd, show };
}

const review: BdBead = {
	id: "e.9",
	title: "Review the wave",
	issue_type: "task",
	metadata: { role: "reviewer" },
	dependencies: [
		{ id: "e", dependency_type: "parent-child" },
		{ id: "e.1", dependency_type: "blocks" },
		{ id: "e.2", dependency_type: "blocks" },
		{ id: "e.3", dependency_type: "blocks" },
	],
};
const tasks: Record<string, BdBead> = {
	"e.1": {
		id: "e.1",
		title: "Add subtract",
		issue_type: "task",
		metadata: { role: "implementer", tier: "basic" },
		dependencies: [{ id: "e", dependency_type: "parent-child" }],
	},
	"e.2": {
		id: "e.2",
		title: "Add divide",
		issue_type: "task",
		metadata: { role: "implementer", tier: "max" },
		dependencies: [{ id: "e", dependency_type: "parent-child" }],
	},
	"e.3": {
		id: "e.3",
		title: "Round two",
		issue_type: "task",
		metadata: { role: "implementer", tier: "deep", fix_round: ROUND_CAP },
		dependencies: [{ id: "e", dependency_type: "parent-child" }],
	},
	"e.9": review,
};

describe("verdict helpers", () => {
	test("tiers order basic -> deep -> max and max has no successor", () => {
		expect(nextTier("basic")).toBe("deep");
		expect(nextTier("deep")).toBe("max");
		expect(nextTier("max")).toBeNull();
	});
	test("targets are the review's blocking dependencies", () => {
		expect(reviewTargets(review)).toEqual(["e.1", "e.2", "e.3"]);
		expect(parentOf(review)).toBe("e");
	});
});

describe("applyVerdict", () => {
	test("refuses a non-review bead, a change without criteria, and an escalate without cause", async () => {
		const { bd, show } = recorder(tasks);
		await expect(
			applyVerdict({
				review: tasks["e.1"] as BdBead,
				verdict: "approve",
				reason: "x",
				findings: "",
				bd,
				show,
			}),
		).rejects.toThrow("a verdict applies to a review bead");
		await expect(
			applyVerdict({
				review,
				verdict: "change",
				reason: "x",
				findings: "",
				targets: ["e.1"],
				bd,
				show,
			}),
		).rejects.toThrow("change names the criteria");
		await expect(
			applyVerdict({
				review,
				verdict: "escalate",
				reason: "x",
				findings: "",
				targets: ["e.1"],
				bd,
				show,
			}),
		).rejects.toThrow("escalate needs a cause");
	});

	test("approve closes the review bead and nothing else", async () => {
		const { calls, bd, show } = recorder(tasks);
		const out = await applyVerdict({
			review,
			verdict: "approve",
			reason: "criteria met",
			findings: "",
			bd,
			show,
		});
		expect(out.line).toContain("approve");
		expect(calls).toEqual([["close", "e.9", "--reason", "criteria met", "--json"]]);
	});

	test("fix reopens the target for the same tier with the findings and the round; the review returns to the queue; nothing is created", async () => {
		const { calls, bd, show } = recorder(tasks);
		const out = await applyVerdict({
			review,
			verdict: "fix",
			reason: "off by one",
			findings: "1. zero case",
			targets: ["e.1"],
			bd,
			show,
		});
		expect(out.reopened).toEqual(["e.1"]);
		expect(out.held).toEqual([]);
		expect(calls[0]).toEqual(["comment", "e.9", "fix: 1. zero case"]);
		expect(calls[1]).toEqual(["update", "e.9", "--status", "open", "--assignee", "", "--json"]);
		expect(calls[2]).toEqual(["reopen", "e.1", "--reason", "fix requested by e.9: off by one"]);
		expect(calls[3]).toEqual([
			"update",
			"e.1",
			"--assignee",
			"",
			"--set-metadata",
			"fix_from=e.9",
			"--set-metadata",
			"fix_kind=fix",
			"--set-metadata",
			"fix_round=1",
			"--set-metadata",
			"fix_findings=1. zero case",
			"--json",
		]);
		expect(calls.some((call) => call[0] === "close" || call[0] === "create")).toBe(false);
	});

	test("change records the failing criteria and never changes the tier", async () => {
		const { calls, bd, show } = recorder(tasks);
		await applyVerdict({
			review,
			verdict: "change",
			reason: "criterion 2 not met",
			findings: "header missing",
			criteria: [2],
			targets: ["e.1"],
			bd,
			show,
		});
		const update = calls.find((call) => call[0] === "update" && call[1] === "e.1") as string[];
		expect(update).toContain("fix_kind=change");
		expect(update).toContain("fix_criteria=2");
		expect(update.some((arg) => arg.startsWith("tier="))).toBe(false);
		expect(calls.some((call) => call[0] === "create")).toBe(false);
	});

	test("the round cap holds the task as repeated instead of reopening it, suggesting an upgrade below max", async () => {
		const { calls, bd, show } = recorder(tasks);
		const out = await applyVerdict({
			review,
			verdict: "fix",
			reason: "again",
			findings: "same zero case",
			targets: ["e.3"],
			bd,
			show,
		});
		expect(out.reopened).toEqual([]);
		expect(out.held).toEqual([{ bead: "e.3", cause: "repeated" }]);
		expect(calls.some((call) => call[0] === "reopen")).toBe(false);
		const hold = calls.find((call) => call[0] === "update" && call[1] === "e.3") as string[];
		expect(hold).toContain("--status");
		expect(hold[hold.indexOf("--status") + 1]).toBe("blocked");
		expect(hold).toContain("held=repeated");
		expect(hold).toContain("held_suggested=upgrade");
		expect(out.line).toContain("decisions");
	});

	test("escalate holds the target with the cause; an unbounded cause or a max tier suggests a split", async () => {
		const { calls, bd, show } = recorder(tasks);
		const out = await applyVerdict({
			review,
			verdict: "escalate",
			reason: "contract",
			findings: "changes the Item shape",
			cause: "contract",
			targets: ["e.1", "e.2"],
			bd,
			show,
		});
		expect(out.held).toEqual([
			{ bead: "e.1", cause: "contract" },
			{ bead: "e.2", cause: "contract" },
		]);
		expect(calls[0]).toEqual(["comment", "e.9", "escalate (contract): changes the Item shape"]);
		const holdBasic = calls.find((call) => call[0] === "update" && call[1] === "e.1") as string[];
		const holdMax = calls.find((call) => call[0] === "update" && call[1] === "e.2") as string[];
		expect(holdBasic).toContain("held_suggested=upgrade");
		expect(holdMax).toContain("held_suggested=split");
		expect(
			calls.some((call) => call[0] === "create" || call[0] === "reopen" || call[0] === "close"),
		).toBe(false);
	});

	test("a DAG review is approve or change; change creates a planner revision it depends on", async () => {
		const dag: BdBead = {
			id: "e.8",
			title: "Review the DAG",
			issue_type: "task",
			metadata: { role: "dag-reviewer" },
			dependencies: [{ id: "e", dependency_type: "parent-child" }],
		};
		const { calls, bd, show } = recorder(tasks);
		await expect(
			applyVerdict({ review: dag, verdict: "fix", reason: "x", findings: "", bd, show }),
		).rejects.toThrow("approve or change");
		const out = await applyVerdict({
			review: dag,
			verdict: "change",
			reason: "point 5",
			findings: "e.2 is max without justification",
			bd,
			show,
		});
		expect(out.planner).toEqual(["new-1"]);
		const create = calls.find((call) => call[0] === "create") as string[];
		expect(JSON.parse(create[create.indexOf("--metadata") + 1] as string)).toEqual({
			role: "planner",
			review: "e.8",
		});
		expect(calls).toContainEqual(["dep", "add", "e.8", "new-1"]);
	});
});

const held = (id: string, tier: string, extra: Record<string, unknown> = {}): BdBead => ({
	id,
	title: "Add subtract",
	issue_type: "task",
	status: "blocked",
	metadata: {
		role: "implementer",
		tier,
		held: "repeated",
		held_by: "e.9",
		held_suggested: "upgrade",
		held_findings: "same zero case",
		fix_round: 2,
		...extra,
	},
	dependencies: [{ id: "e", dependency_type: "parent-child" }],
});

describe("applyDecision", () => {
	test("refuses a task that is not held", async () => {
		const { bd } = recorder(tasks);
		await expect(
			applyDecision({ task: tasks["e.1"] as BdBead, action: "retry", reason: "x", bd }),
		).rejects.toThrow("not held");
		expect(holdOf(tasks["e.1"] as BdBead)).toBeNull();
	});

	test("retry reopens at the same tier with the rounds reset and the hold cleared", async () => {
		const { calls, bd } = recorder({ ...tasks, "e.1": held("e.1", "basic") });
		const out = await applyDecision({
			task: held("e.1", "basic"),
			action: "retry",
			reason: "findings changed",
			bd,
		});
		expect(out.created).toEqual([]);
		expect(calls[0]).toEqual(["comment", "e.1", "decision retry by the lead: findings changed"]);
		expect(calls[1]?.[0]).toBe("reopen");
		const update = calls[2] as string[];
		expect(update).toContain("fix_round=0");
		expect(update).toContain("held=");
		expect(update).toContain("decided=retry");
		expect(update.some((arg) => arg.startsWith("tier="))).toBe(false);
	});

	test("upgrade creates a fix bead one tier up carrying the decision history, re-points the review, and supersedes the task", async () => {
		const { calls, bd } = recorder({ ...tasks, "e.1": held("e.1", "basic") });
		const out = await applyDecision({
			task: held("e.1", "basic"),
			action: "upgrade",
			reason: "same criterion failed twice",
			bd,
		});
		expect(out.created).toEqual(["new-1"]);
		const create = calls.find((call) => call[0] === "create") as string[];
		expect(JSON.parse(create[create.indexOf("--metadata") + 1] as string)).toEqual({
			role: "implementer",
			tier: "deep",
			escalated_from: "e.1",
			review: "e.9",
			decided: "upgrade",
		});
		expect(calls).toContainEqual(["dep", "add", "e.9", "new-1"]);
		const close = calls.find((call) => call[0] === "close" && call[1] === "e.1") as string[];
		expect(close[3]).toContain("superseded by new-1 at tier deep");
	});

	test("upgrade at max is refused; split creates a planner bead with the history", async () => {
		const { calls, bd } = recorder({ ...tasks, "e.2": held("e.2", "max") });
		await expect(
			applyDecision({ task: held("e.2", "max"), action: "upgrade", reason: "x", bd }),
		).rejects.toThrow("no tier above max");
		const out = await applyDecision({
			task: held("e.2", "max", { decided: "upgrade" }),
			action: "split",
			reason: "too big",
			bd,
		});
		expect(out.created).toEqual(["new-1"]);
		const create = calls.find((call) => call[0] === "create") as string[];
		expect(JSON.parse(create[create.indexOf("--metadata") + 1] as string)).toEqual({
			role: "planner",
			review: "e.9",
			decomposes: "e.2",
			decided: "upgrade,split",
		});
	});

	test("accept is refused on a design, contract, or security hold", async () => {
		const { bd } = recorder(tasks);
		for (const cause of ["design", "contract", "security"]) {
			await expect(applyDecision({ task: held("e.1", "basic", { held: cause }), action: "accept", reason: "x", bd })).rejects.toThrow("never accepted");
		}
	});

	test("accept closes the task, leaves multi-target reviews open, and files a follow-up", async () => {
		const { calls, bd } = recorder({ ...tasks, "e.1": held("e.1", "basic") });
		const out = await applyDecision({
			task: held("e.1", "basic"),
			action: "accept",
			reason: "cosmetic residue",
			bd,
		});
		expect(out.created).toEqual(["new-1"]);
		expect(calls.find((call) => call[0] === "close" && call[1] === "e.1")).toBeDefined();
		expect(calls.find((call) => call[0] === "close" && call[1] === "e.9")).toBeUndefined();
	});

	test("stop is the last resort: refused with no prior upgrade or split, allowed on a successor that carries one", async () => {
		const { calls, bd } = recorder(tasks);
		await expect(
			applyDecision({ task: held("e.1", "basic"), action: "stop", reason: "x", bd }),
		).rejects.toThrow("last resort");
		const out = await applyDecision({
			task: held("new-1", "deep", { decided: "upgrade" }),
			action: "stop",
			reason: "needs the human",
			bd,
		});
		expect(out.line).toContain("stopped for the human");
		const update = calls.find((call) => call[0] === "update" && call[1] === "new-1") as string[];
		expect(update).toContain("held=human");
		expect(update).toContain("decided=upgrade,stop");
	});
});
