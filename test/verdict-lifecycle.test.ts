import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { BdBead } from "../src/bd";
import { edgesOf } from "../src/bd";
import { readyWave } from "../src/dag";
import { applyDecision, applyVerdict, type Decision, type Verdict } from "../src/verdict";

/**
 * A stateful `bd` double with the semantics the ledger relies on: `ready` lists open,
 * unassigned beads whose non-parent dependencies are all closed; `reopen`, `close`,
 * `update` (status, assignee, claim, metadata), `create`, `dep add`, `comment`, `show`.
 * Drives both `applyVerdict` (as its runner) and `readyWave` (through `Bun.spawn`).
 */
class FakeStore {
	beads = new Map<string, BdBead>();
	comments: string[][] = [];
	private created = 0;

	add(bead: BdBead): BdBead {
		this.beads.set(bead.id, { status: "open", dependencies: [], ...bead });
		return this.beads.get(bead.id) as BdBead;
	}

	under(epic: string): BdBead[] {
		return [...this.beads.values()].filter(bead => edgesOf(bead).some(edge => edge.type === "parent-child" && edge.id === epic));
	}

	private ready(args: readonly string[]): BdBead[] {
		const parent = args[args.indexOf("--parent") + 1] as string;
		const type = args.includes("--type") ? args[args.indexOf("--type") + 1] : undefined;
		return this.under(parent).filter(bead => {
			if (bead.status !== "open" || bead.assignee) return false;
			if (type !== undefined && bead.issue_type !== type) return false;
			return edgesOf(bead).every(edge => edge.type === "parent-child" || this.beads.get(edge.id)?.status === "closed");
		});
	}

	run = async (args: readonly string[]): Promise<unknown> => {
		const [verb, id] = args;
		const bead = () => {
			const found = this.beads.get(id as string);
			if (found === undefined) throw new Error(`no bead ${id}`);
			return found;
		};
		switch (verb) {
			case "ready":
				return this.ready(args);
			case "show":
				return bead();
			case "comment":
				this.comments.push([id as string, args[2] as string]);
				return undefined;
			case "close":
				bead().status = "closed";
				return bead();
			case "reopen":
				bead().status = "open";
				return bead();
			case "dep": {
				// `bd dep add <bead> <depends-on>`
				const target = this.beads.get(args[2] as string);
				if (target === undefined) throw new Error(`no bead ${args[2]}`);
				(target.dependencies as Array<{ id: string; dependency_type: string }>).push({ id: args[3] as string, dependency_type: "blocks" });
				return undefined;
			}
			case "update": {
				const target = bead();
				for (let i = 2; i < args.length; i++) {
					if (args[i] === "--status") target.status = args[++i];
					else if (args[i] === "--assignee") target.assignee = args[++i] || undefined;
					else if (args[i] === "--claim") {
						target.assignee = "worker";
						target.status = "in_progress";
					} else if (args[i] === "--set-metadata") {
						const [key, ...rest] = (args[++i] as string).split("=");
						target.metadata = { ...target.metadata, [key as string]: rest.join("=") };
					}
				}
				return target;
			}
			case "list":
				return [...this.beads.values()];
			case "create": {
				const created: BdBead = {
					id: `new-${++this.created}`,
					issue_type: args[args.indexOf("--type") + 1],
					title: args[args.indexOf("--title") + 1],
					metadata: JSON.parse(args[args.indexOf("--metadata") + 1] as string),
					dependencies: args.includes("--parent") ? [{ id: args[args.indexOf("--parent") + 1], dependency_type: "parent-child" }] : [],
				};
				return this.add(created);
			}
			default:
				throw new Error(`fake bd: unhandled ${args.join(" ")}`);
		}
	};

	/** Route `Bun.spawn(["bd", ...])` calls from `readyWave` into this store. */
	spawn() {
		return spyOn(Bun, "spawn").mockImplementation(((cmd: string[]) => {
			const args = cmd.slice(1).filter(arg => arg !== "--json" && arg !== "--limit" && arg !== "0");
			const payload = this.run(args);
			const stream = new ReadableStream<Uint8Array>({
				start: controller => {
					payload.then(value => {
						controller.enqueue(new TextEncoder().encode(JSON.stringify(value ?? null)));
						controller.close();
					});
				},
			});
			return {
				stdout: stream,
				stderr: new Response("").body,
				exited: Promise.resolve(0),
				kill: () => undefined,
			};
		}) as unknown as typeof Bun.spawn);
	}

	async wave(epic: string): Promise<string[]> {
		return (await readyWave(epic, this.under(epic), "/tmp")).map(bead => bead.id);
	}

	verdict(reviewId: string, verdict: Verdict, targets?: string[]) {
		return applyVerdict({ review: this.beads.get(reviewId) as BdBead, verdict, reason: `${verdict} reason`, findings: `${verdict} findings`, criteria: verdict === "change" ? [1] : undefined, cause: verdict === "escalate" ? "contract" : undefined, targets, bd: this.run, show: async id => this.beads.get(id) as BdBead });
	}

	decide(taskId: string, action: Decision) {
		return applyDecision({ task: this.beads.get(taskId) as BdBead, action, reason: `${action} reason`, bd: this.run });
	}

	/** The review bead is taken by a reviewer again. */
	claimReview(id: string) {
		const review = this.beads.get(id) as BdBead;
		review.assignee = "reviewer";
		review.status = "in_progress";
	}

	/** An implementer takes the bead and finishes it. */
	work(id: string) {
		const bead = this.beads.get(id) as BdBead;
		bead.assignee = "impl";
		bead.status = "closed";
	}
}

function reviewedWave(store: FakeStore) {
	store.add({ id: "e", issue_type: "epic" });
	const t1 = store.add({ id: "e.1", issue_type: "task", title: "Add subtract", metadata: { role: "implementer", tier: "basic" }, dependencies: [{ id: "e", dependency_type: "parent-child" }] });
	const t2 = store.add({ id: "e.2", issue_type: "task", title: "Add divide", metadata: { role: "implementer", tier: "max" }, dependencies: [{ id: "e", dependency_type: "parent-child" }] });
	const review = store.add({
		id: "e.9",
		issue_type: "task",
		title: "Review the wave",
		metadata: { role: "reviewer" },
		dependencies: [
			{ id: "e", dependency_type: "parent-child" },
			{ id: "e.1", dependency_type: "blocks" },
			{ id: "e.2", dependency_type: "blocks" },
		],
	});
	store.work(t1.id);
	store.work(t2.id);
	// The reviewer claimed the review bead.
	review.assignee = "reviewer";
	review.status = "in_progress";
	return store;
}

describe("verdict lifecycle against a stateful store", () => {
	afterEach(() => {
		spyOn(Bun, "spawn").mockRestore();
	});

	test("fix: the task is the next wave, then the review re-enters unassigned, then approve empties the wave", async () => {
		const store = reviewedWave(new FakeStore());
		store.spawn();
		expect(await store.wave("e")).toEqual([]);
		await store.verdict("e.9", "fix", ["e.1"]);
		const review = store.beads.get("e.9") as BdBead;
		expect(review.status).toBe("open");
		expect(review.assignee).toBeUndefined();
		expect(await store.wave("e")).toEqual(["e.1"]);
		expect((store.beads.get("e.1") as BdBead).metadata).toMatchObject({ tier: "basic", fix_from: "e.9", fix_round: "1" });
		store.work("e.1");
		expect(await store.wave("e")).toEqual(["e.9"]);
		review.assignee = "reviewer";
		review.status = "in_progress";
		await store.verdict("e.9", "approve");
		expect(await store.wave("e")).toEqual([]);
	});

	test("the round cap holds the task: no wave until the lead decides; upgrade makes the fix bead the wave and the review re-enters once it closes", async () => {
		const store = reviewedWave(new FakeStore());
		store.spawn();
		await store.verdict("e.9", "fix", ["e.1"]);
		store.work("e.1");
		store.claimReview("e.9");
		await store.verdict("e.9", "change", ["e.1"]);
		store.work("e.1");
		store.claimReview("e.9");
		const out = await store.verdict("e.9", "fix", ["e.1"]);
		expect(out.held).toEqual([{ bead: "e.1", cause: "repeated" }]);
		const task = store.beads.get("e.1") as BdBead;
		expect(task.status).toBe("blocked");
		expect(task.metadata).toMatchObject({ tier: "basic", held: "repeated", held_suggested: "upgrade" });
		// Held: nothing is dispatchable, and the review waits on the blocked task.
		expect(await store.wave("e")).toEqual([]);
		const decision = await store.decide("e.1", "upgrade");
		const fix = decision.created[0] as string;
		expect(await store.wave("e")).toEqual([fix]);
		expect((store.beads.get(fix) as BdBead).metadata).toMatchObject({ tier: "deep", escalated_from: "e.1", decided: "upgrade" });
		expect((store.beads.get("e.1") as BdBead).status).toBe("closed");
		store.work(fix);
		expect(await store.wave("e")).toEqual(["e.9"]);
	});

	test("escalate at max: held with a split suggestion; split makes the planner bead the wave; stop is allowed on the part that carries the history", async () => {
		const store = reviewedWave(new FakeStore());
		store.spawn();
		const out = await store.verdict("e.9", "escalate", ["e.2"]);
		expect(out.held).toEqual([{ bead: "e.2", cause: "contract" }]);
		expect((store.beads.get("e.2") as BdBead).metadata).toMatchObject({ held: "contract", held_suggested: "split" });
		expect(await store.wave("e")).toEqual([]);
		await expect(store.decide("e.2", "stop")).rejects.toThrow("last resort");
		const decision = await store.decide("e.2", "split");
		const decompose = decision.created[0] as string;
		expect(await store.wave("e")).toEqual([decompose]);
		expect((store.beads.get(decompose) as BdBead).metadata).toMatchObject({ role: "planner", decomposes: "e.2", decided: "split" });
		// The planner's part inherits the history, bounces, is held, and may now be stopped.
		const part = store.add({ id: "e.20", issue_type: "task", title: "Part", metadata: { role: "implementer", tier: "max", decided: "split", held: "repeated", held_by: "e.9", held_suggested: "split" }, status: "blocked", dependencies: [{ id: "e", dependency_type: "parent-child" }] });
		const stopped = await store.decide(part.id, "stop");
		expect(stopped.line).toContain("stopped for the human");
		expect((store.beads.get(part.id) as BdBead).metadata).toMatchObject({ held: "human", decided: "split,stop" });
	});

	test("retry reopens the held task at the same tier and it is the next wave again", async () => {
		const store = reviewedWave(new FakeStore());
		store.spawn();
		await store.verdict("e.9", "escalate", ["e.1"]);
		await store.decide("e.1", "retry");
		const task = store.beads.get("e.1") as BdBead;
		expect(task.status).toBe("open");
		expect(task.metadata).toMatchObject({ tier: "basic", fix_round: "0", held: "", decided: "retry" });
		expect(await store.wave("e")).toEqual(["e.1"]);
	});

	test("accept is refused on a contract hold and closes the task and the review on a repeated one; the follow-up bead is the wave", async () => {
		const store = reviewedWave(new FakeStore());
		store.spawn();
		await store.verdict("e.9", "escalate", ["e.1"]);
		await expect(store.decide("e.1", "accept")).rejects.toThrow("never accepted");
		(store.beads.get("e.1") as BdBead).metadata = { ...((store.beads.get("e.1") as BdBead).metadata as Record<string, unknown>), held: "repeated" };
		const decision = await store.decide("e.1", "accept");
		expect((store.beads.get("e.1") as BdBead).status).toBe("closed");
		expect((store.beads.get("e.9") as BdBead).status).toBe("closed");
		expect(await store.wave("e")).toEqual([decision.created[0]]);
	});

	test("DAG review: change yields a planner revision bead, then the review, then the implementation wave", async () => {
		const store = new FakeStore();
		store.spawn();
		store.add({ id: "e", issue_type: "epic" });
		store.add({ id: "e.1", issue_type: "task", title: "Add subtract", metadata: { role: "implementer" }, dependencies: [{ id: "e", dependency_type: "parent-child" }] });
		const dag = store.add({ id: "e.0", issue_type: "task", title: "Review the DAG", metadata: { role: "dag-reviewer" }, dependencies: [{ id: "e", dependency_type: "parent-child" }] });
		// Open and unclaimed: the review itself is the whole wave, not the task.
		expect(await store.wave("e")).toEqual(["e.0"]);
		dag.assignee = "reviewer";
		dag.status = "in_progress";
		// Claimed: nothing else is dispatchable.
		expect(await store.wave("e")).toEqual([]);
		// An unrelated ready planner bead under the epic is not part of the gate.
		store.add({ id: "e.5", issue_type: "task", title: "Plan something else", metadata: { role: "planner" }, dependencies: [{ id: "e", dependency_type: "parent-child" }] });
		expect(await store.wave("e")).toEqual([]);
		await expect(store.verdict("e.0", "fix")).rejects.toThrow("approve or change");
		const out = await store.verdict("e.0", "change");
		const revise = out.planner[0] as string;
		expect(await store.wave("e")).toEqual([revise]);
		store.work(revise);
		expect(await store.wave("e")).toEqual(["e.0"]);
		dag.assignee = "reviewer";
		dag.status = "in_progress";
		await store.verdict("e.0", "approve");
		expect(await store.wave("e")).toEqual(["e.1", "e.5"]);
	});
});
