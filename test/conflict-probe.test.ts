import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { zod } from "@oh-my-pi/pi-coding-agent";
import { describe, expect, test } from "bun:test";
import { type Exec, type ExecResult, spawnExec } from "../src/tools/bot-review-probe";
import {
	type ConflictProbeDetails,
	diffNamesArgv,
	ghChecksArgv,
	intersectPaths,
	mergeBaseArgv,
	mergeTreeArgv,
	parseMergeTreeOutput,
	type ProbeMode,
	registerConflictProbe,
	revParseArgv,
} from "../src/tools/conflict-probe";

describe("parseMergeTreeOutput", () => {
	test("a lone tree oid is a clean merge", () => {
		expect(parseMergeTreeOutput("4b825dc642cb6eb9a060e54bf8d69288fbee4904\n")).toEqual({ clean: true, paths: [] });
	});

	test("reads the conflicting paths between the oid and the blank line", () => {
		const out = [
			"9f2b1c4d0e6a7b8c9d0e1f2a3b4c5d6e7f8091a2",
			"src/index.ts",
			"README.md",
			"",
			"Auto-merging src/index.ts",
			"CONFLICT (content): Merge conflict in src/index.ts",
		].join("\n");
		expect(parseMergeTreeOutput(out)).toEqual({ clean: false, paths: ["README.md", "src/index.ts"] });
	});

	test("de-duplicates repeated paths", () => {
		const out = ["9f2b1c4d0e6a7b8c9d0e1f2a3b4c5d6e7f8091a2", "a.ts", "a.ts", ""].join("\n");
		expect(parseMergeTreeOutput(out).paths).toEqual(["a.ts"]);
	});

	test("accepts a sha-256 tree oid", () => {
		const oid = "a".repeat(64);
		expect(parseMergeTreeOutput(`${oid}\nsrc/a.ts\n`)).toEqual({ clean: false, paths: ["src/a.ts"] });
	});

	test("output that does not start with an oid is neither clean nor conflicting", () => {
		// The whole point of this branch: an unclassifiable merge-tree result must
		// never read as clean, or the Shepherd would merge on a non-answer.
		expect(parseMergeTreeOutput("fatal: not a git repository\n")).toEqual({ clean: false, paths: [] });
		expect(parseMergeTreeOutput("")).toEqual({ clean: false, paths: [] });
	});
});

describe("intersectPaths", () => {
	test("returns the sorted shared paths", () => {
		expect(intersectPaths(["src/b.ts", "src/a.ts", "docs/x.md"], ["src/a.ts", "src/b.ts", "other.ts"])).toEqual([
			"src/a.ts",
			"src/b.ts",
		]);
	});

	test("disjoint and empty inputs yield no overlap", () => {
		expect(intersectPaths(["a"], ["b"])).toEqual([]);
		expect(intersectPaths([], ["a"])).toEqual([]);
		expect(intersectPaths(["a"], [])).toEqual([]);
		expect(intersectPaths([], [])).toEqual([]);
	});

	test("a path repeated on either side appears once", () => {
		expect(intersectPaths(["a", "a"], ["a"])).toEqual(["a"]);
	});
});

describe("argument vectors", () => {
	test("conflicts mode pins refs to commits, then predicts the merge", () => {
		expect(revParseArgv("main")).toEqual(["git", "rev-parse", "--verify", "main^{commit}"]);
		expect(mergeTreeArgv("abc123", "def456")).toEqual([
			"git",
			"merge-tree",
			"--write-tree",
			"--name-only",
			"abc123",
			"def456",
		]);
	});

	test("pairwise mode diffs each branch against its own merge base", () => {
		expect(mergeBaseArgv("main", "feature")).toEqual(["git", "merge-base", "main", "feature"]);
		expect(diffNamesArgv("abc123", "feature")).toEqual(["git", "diff", "--name-only", "abc123", "feature"]);
	});

	test("ci mode asks gh for the PR's checks", () => {
		expect(ghChecksArgv("42")).toEqual(["gh", "pr", "checks", "42"]);
	});
});

/** Collect what `registerConflictProbe` registers, without an OMP session. */
function registered(exec?: Exec): {
	execute: (
		id: string,
		params: { mode: ProbeMode; base?: string; branch?: string; branchB?: string; pr?: string },
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: ExtensionContext,
	) => Promise<{ isError?: boolean; content: { text: string }[]; details?: ConflictProbeDetails }>;
} {
	const tools: unknown[] = [];
	const pi = { zod, registerTool: (tool: unknown) => tools.push(tool) } as unknown as ExtensionAPI;
	registerConflictProbe(pi, exec);
	expect(tools).toHaveLength(1);
	return tools[0] as ReturnType<typeof registered>;
}

describe("registerConflictProbe", () => {
	test("missing mode arguments fail as a result, never as a throw", async () => {
		const tool = registered();
		const ctx = { cwd: "/tmp" } as unknown as ExtensionContext;

		const cases: { mode: ProbeMode; base?: string; branch?: string }[] = [
			{ mode: "conflicts", base: "main" },
			{ mode: "pairwise", base: "main", branch: "a" },
			{ mode: "ci" },
		];
		for (const params of cases) {
			const result = await tool.execute("id", params, undefined, undefined, ctx);
			expect(result.isError).toBe(true);
			expect(result.details?.error).toBe("missing arguments");
			expect(result.details?.mode).toBe(params.mode);
		}
	});
});

const OID = "9f2b1c4d0e6a7b8c9d0e1f2a3b4c5d6e7f8091a2";

/** Answer `git`/`gh` from a transcript keyed by joined argv; anything unscripted fails loudly. */
function transcript(answers: Record<string, ExecResult>): { exec: Exec; calls: string[] } {
	const calls: string[] = [];
	const exec: Exec = async (argv) => {
		const key = argv.join(" ");
		calls.push(key);
		return answers[key] ?? { code: 1, stdout: "", stderr: `unexpected argv: ${key}` };
	};
	return { exec, calls };
}

function out(stdout: string, code = 0, stderr = ""): ExecResult {
	return { code, stdout, stderr };
}

describe("verdicts from subprocess transcripts", () => {
	const ctx = { cwd: "/tmp" } as unknown as ExtensionContext;
	const BASE_SHA = "a".repeat(40);
	const TOPIC_SHA = "b".repeat(40);
	const resolved = {
		[revParseArgv("main").join(" ")]: out(`${BASE_SHA}\n`),
		[revParseArgv("topic").join(" ")]: out(`${TOPIC_SHA}\n`),
	};

	test("merge-tree exit 0 is clean", async () => {
		const { exec } = transcript({ ...resolved, [mergeTreeArgv(BASE_SHA, TOPIC_SHA).join(" ")]: out(`${OID}\n`) });
		const result = await registered(exec).execute("id", { mode: "conflicts", base: "main", branch: "topic" }, undefined, undefined, ctx);
		expect(result.isError).toBeFalsy();
		expect(result.details).toEqual({ mode: "conflicts", clean: true, paths: [] });
	});

	test("merge-tree exit 1 with conflicting paths is a conflict naming them", async () => {
		const { exec, calls } = transcript({
			...resolved,
			[mergeTreeArgv(BASE_SHA, TOPIC_SHA).join(" ")]: out(
				`${OID}\nsrc/index.ts\nREADME.md\n\nCONFLICT (content): Merge conflict in src/index.ts\n`,
				1,
			),
		});
		const result = await registered(exec).execute("id", { mode: "conflicts", base: "main", branch: "topic" }, undefined, undefined, ctx);
		expect(result.isError).toBeFalsy();
		expect(result.details).toEqual({ mode: "conflicts", clean: false, paths: ["README.md", "src/index.ts"] });
		// Refs are pinned to commits before merge-tree sees them.
		expect(calls).toEqual([revParseArgv("main").join(" "), revParseArgv("topic").join(" "), mergeTreeArgv(BASE_SHA, TOPIC_SHA).join(" ")]);
	});

	test("merge-tree exit 1 with an oid but no paths is not clean and not a conflict", async () => {
		// The mutation this guards: `code === 0 || paths.length === 0` reading as clean.
		const { exec } = transcript({ ...resolved, [mergeTreeArgv(BASE_SHA, TOPIC_SHA).join(" ")]: out(`${OID}\n`, 1) });
		const result = await registered(exec).execute("id", { mode: "conflicts", base: "main", branch: "topic" }, undefined, undefined, ctx);
		expect(result.isError).toBe(true);
		expect(result.details?.clean).toBeUndefined();
		expect(result.details?.error).toBe("unclassified");
	});

	test("an unclassifiable merge-tree carries git's reason", async () => {
		const { exec } = transcript({
			...resolved,
			[mergeTreeArgv(BASE_SHA, TOPIC_SHA).join(" ")]: out("", 128, "fatal: refusing to merge unrelated histories\n"),
		});
		const result = await registered(exec).execute("id", { mode: "conflicts", base: "main", branch: "topic" }, undefined, undefined, ctx);
		expect(result.isError).toBe(true);
		expect(result.details).toEqual({ mode: "conflicts", error: "unclassified", stderr: "fatal: refusing to merge unrelated histories" });
		expect(result.content[0]?.text).toContain("refusing to merge unrelated histories");
	});

	test("a bad ref carries git's reason and never reaches merge-tree", async () => {
		const { exec, calls } = transcript({
			[revParseArgv("main").join(" ")]: out(`${BASE_SHA}\n`),
			[revParseArgv("nope").join(" ")]: out("", 128, "fatal: Needed a single revision\n"),
		});
		const result = await registered(exec).execute("id", { mode: "conflicts", base: "main", branch: "nope" }, undefined, undefined, ctx);
		expect(result.details).toEqual({ mode: "conflicts", error: "bad ref", stderr: "fatal: Needed a single revision" });
		expect(calls).toHaveLength(2);
	});

	test("pairwise reports the overlap of what each branch changed since its own merge base", async () => {
		const { exec } = transcript({
			[mergeBaseArgv("main", "one").join(" ")]: out("1111\n"),
			[diffNamesArgv("1111", "one").join(" ")]: out("src/a.ts\nsrc/b.ts\ndocs/x.md\n"),
			[mergeBaseArgv("main", "two").join(" ")]: out("2222\n"),
			[diffNamesArgv("2222", "two").join(" ")]: out("src/b.ts\nother.ts\nsrc/a.ts\n"),
		});
		const result = await registered(exec).execute("id", { mode: "pairwise", base: "main", branch: "one", branchB: "two" }, undefined, undefined, ctx);
		expect(result.isError).toBeFalsy();
		expect(result.details).toEqual({ mode: "pairwise", clean: false, overlap: ["src/a.ts", "src/b.ts"] });
	});

	test("pairwise with no shared paths is disjoint", async () => {
		const { exec } = transcript({
			[mergeBaseArgv("main", "one").join(" ")]: out("1111\n"),
			[diffNamesArgv("1111", "one").join(" ")]: out("src/a.ts\n"),
			[mergeBaseArgv("main", "two").join(" ")]: out("1111\n"),
			[diffNamesArgv("1111", "two").join(" ")]: out("src/b.ts\n"),
		});
		const result = await registered(exec).execute("id", { mode: "pairwise", base: "main", branch: "one", branchB: "two" }, undefined, undefined, ctx);
		expect(result.details).toEqual({ mode: "pairwise", clean: true, overlap: [] });
	});

	test("ci unsupported exit is an error with an exact prefix", async () => {
		const { exec } = transcript({ [ghChecksArgv("7").join(" ")]: out("build\tpending\t0\thttps://ci/1\n", 8) });
		const result = await registered(exec).execute("id", { mode: "ci", pr: "7" }, undefined, undefined, ctx);
		expect(result.isError).toBe(true);
		expect(result.details).toEqual({ mode: "ci", exitCode: 8, error: "unsupported exit" });
		expect(result.content[0]?.text).toBe("conflict-probe: unsupported gh pr checks exit 8");
	});

	test("ci exit 1 with a check table is failing checks: an answer, not an error", async () => {
		const { exec } = transcript({ [ghChecksArgv("7").join(" ")]: out("build\tfail\t1m2s\thttps://ci/1\n", 1) });
		const result = await registered(exec).execute("id", { mode: "ci", pr: "7" }, undefined, undefined, ctx);
		expect(result.isError).toBeFalsy();
		expect(result.details).toEqual({ mode: "ci", exitCode: 1 });
	});

	test("ci exit 0 is passing checks", async () => {
		const { exec } = transcript({ [ghChecksArgv("7").join(" ")]: out("build\tpass\t1m2s\thttps://ci/1\n") });
		const result = await registered(exec).execute("id", { mode: "ci", pr: "7" }, undefined, undefined, ctx);
		expect(result.details).toEqual({ mode: "ci", exitCode: 0 });
	});

	test("ci supported statuses require parseable stdout", async () => {
		for (const code of [0, 1]) {
			const { exec } = transcript({ [ghChecksArgv("7").join(" ")]: out("", code) });
			const result = await registered(exec).execute("id", { mode: "ci", pr: "7" }, undefined, undefined, ctx);
			expect(result.isError).toBe(true);
			expect(result.details?.error).toBe("unreadable CI evidence");
		}
	});

	test.each([2, 4])("ci exit %p is an authenticated/tool failure", async (code) => {
		const { exec } = transcript({ [ghChecksArgv("7").join(" ")]: out("", code) });
		const result = await registered(exec).execute("id", { mode: "ci", pr: "7" }, undefined, undefined, ctx);
		expect(result.isError).toBe(true);
		expect(result.details?.error).toBe("gh failed");
		expect(result.details?.exitCode).toBe(code);
	});

	test("ci exit 1 without stdout is unreadable, not a verdict", async () => {
		const { exec } = transcript({ [ghChecksArgv("7").join(" ")]: out("", 1, "no pull requests found\n") });
		const result = await registered(exec).execute("id", { mode: "ci", pr: "7" }, undefined, undefined, ctx);
		expect(result.isError).toBe(true);
		expect(result.details?.error).toBe("unreadable CI evidence");
	});

});

describe("bounded conflict evidence", () => {
	const ctx = { cwd: "/tmp" } as unknown as ExtensionContext;
	const cases: { mode: ProbeMode; base?: string; branch?: string; branchB?: string; pr?: string }[] = [
		{ mode: "conflicts", base: "main", branch: "topic" },
		{ mode: "pairwise", base: "main", branch: "one", branchB: "two" },
		{ mode: "ci", pr: "7" },
	];

	test("pre-aborted probes never invoke their executor", async () => {
		const controller = new AbortController();
		controller.abort();
		let calls = 0;
		const tool = registered(async () => {
			calls++;
			return { code: 0, stdout: "", stderr: "" };
		});
		for (const params of cases) {
			const result = await tool.execute("id", params, controller.signal, undefined, ctx);
			expect(result.isError).toBe(true);
			expect(result.details?.clean).toBeUndefined();
			expect(result.details?.exitCode).toBeUndefined();
		}
		expect(calls).toBe(0);
	});

	test("aborted reads cannot authorize a verdict or start later subprocesses", async () => {
		for (const params of cases) {
			const controller = new AbortController();
			let calls = 0;
			const tool = registered(async () => {
				calls++;
				controller.abort();
				return { code: 0, stdout: "a".repeat(40), stderr: "" };
			});
			const result = await tool.execute("id", params, controller.signal, undefined, ctx);
			expect(result.isError).toBe(true);
			expect(result.details?.clean).toBeUndefined();
			expect(result.details?.exitCode).toBeUndefined();
			expect(calls).toBe(1);
		}
	});

	test("overflow of real subprocess output is an error, never clean or CI success", async () => {
		for (const params of cases) {
			let calls = 0;
			const exec: Exec = (_argv, opts) => {
				calls++;
				return spawnExec([
					process.execPath,
					"-e",
					'process.stdout.write("a".repeat(5 * 1024 * 1024)); process.stderr.write("b".repeat(5 * 1024 * 1024))',
				], opts);
			};
			const result = await registered(exec).execute("id", params, undefined, undefined, ctx);
			expect(result.isError).toBe(true);
			expect(result.details?.clean).toBeUndefined();
			expect(result.details?.exitCode).toBeUndefined();
			expect(calls).toBe(1);
		}
	});
});
