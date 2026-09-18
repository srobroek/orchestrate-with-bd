/**
 * D18: agent PRs do not pay for a human PR's CI.
 *
 * Every branch an agent creates begins `omp/`, so one head-branch filter covers all of them.
 * A run's expensive PR-only jobs are excluded from those branches by extending the conditions
 * that already say "only on a pull request" with `&& !startsWith(github.head_ref, 'omp/')`.
 * A job that runs on every pull request instead gains a whole-job condition, and a job that
 * already carries an unrelated condition of its own keeps it: the guard is conjoined to that
 * condition, so the author's narrowing survives and only the agent-branch exclusion is added.
 * `orc_bind` runs this at run start and adds the exclusion itself rather than refusing or
 * asking: an unscoped repository would otherwise burn a full CI matrix on every wave.
 *
 * The edit is textual and line-local by design. A YAML round-trip would reflow every workflow
 * in the repository, turning a one-line scoping change into an unreviewable diff, and the
 * expression being changed is a string either way. A block scalar therefore keeps its own line
 * structure and gains one line, which is sound because a newline inside a GitHub expression is
 * whitespace. Only conditions this module can rewrite without ambiguity are touched; anything
 * else is reported for a human, never guessed at, and leaves the repository reported unscoped.
 */

import { type Dirent, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isInside } from "./worktree";

/** The guard appended to a PR-only condition. `head_ref` is set only for a pull request. */
export const OMP_EXCLUSION = "!startsWith(github.head_ref, 'omp/')";

/** Matches a condition that runs *because* the event is a pull request. `!=` is not it. */
const PULL_REQUEST_CONDITION = /github\s*\.\s*event_name\s*==\s*['"]pull_request['"]/u;
/** Any exclusion already naming `omp/` against the head ref, however spelled. */
const ALREADY_SCOPED = /head_ref[\s\S]*?['"]omp\//u;
/** `<indent>if: <value>`, the only shape whose value is a complete expression on one line. */
const IF_LINE = /^(\s*)(-\s+)?if:[ \t]+(\S.*)$/u;
/** Any `if:` key, one-line or block, at any indentation. */
const ANY_IF_LINE = /^\s*(?:-\s+)?if:(?:[ \t]|$)/u;
/** An `if:` whose expression is a folded or literal block scalar on the following lines. */
const BLOCK_IF_LINE = /^(\s*)(?:-\s+)?if:[ \t]*[|>][+-]?\d*[+-]?[ \t]*$/u;
/** A `${{ … }}` span, when it covers a whole condition value. */
const WRAPPED_EXPRESSION = /^\$\{\{(?<body>[\s\S]*)\}\}$/u;
/** A block-mapping key line with nothing after the colon: `  <name>:`. */
const BLOCK_KEY = /^(\s+)([A-Za-z_][\w.-]*):[ \t]*$/u;
/**
 * The whole-job condition for a job that carries no PR-only condition anywhere. Such a job
 * runs in full on every pull request, so extending step conditions never reaches it — it needs
 * a condition of its own, not an extension. The `!=` half keeps push and schedule runs intact.
 */
export const OMP_JOB_CONDITION = `github.event_name != 'pull_request' || ${OMP_EXCLUSION}`;

export interface CiScopeReport {
	/** Whether every PR-only condition in the repository now excludes `omp/**` head branches. */
	scoped: boolean;
	/** The checkout this pass read, and wrote when it wrote: the caller's own worktree. */
	root: string;
	/** Workflow files this call rewrote, relative to `root`. */
	changed: string[];
	/**
	 * Workflow files that need the exclusion and were deliberately *not* written, because this
	 * pass ran in the canonical checkout, whose working tree is never mutated. The lead applies
	 * them in its integration worktree, where a commit can carry them.
	 */
	pending: string[];
	/** `<file>:<line>` of PR-only conditions that were already scoped. */
	already: string[];
	/**
	 * `<file>:<line> <why>` for a condition or job this module refused to rewrite, because no
	 * unambiguous rewrite exists — a value interleaving literal text with expression spans, an
	 * expression whose quotes or parentheses do not balance, a trailing comment, a job whose
	 * body is an inline mapping with no line of its own to carry a condition. Reported, not
	 * guessed at, so the lead scopes it by hand, and `scoped` stays false while any remains.
	 */
	unhandled: string[];
}

export interface WorkflowScope {
	/** The rewritten text; identical to the input when `changed` is empty. */
	text: string;
	/** Line numbers this pass extended. Empty means the file must not be rewritten. */
	changed: number[];
	/** Line numbers that already excluded `omp/**`. */
	already: number[];
	/** Conditions left alone because rewriting them would change what they mean. */
	unhandled: { line: number; why: string }[];
}

/**
 * `||` at the top level of `expression`, outside quotes and parentheses, and whether its quotes
 * and parentheses balance at all.
 *
 * `&&` binds tighter than `||` in a GitHub expression, so appending `&& guard` to `a || b`
 * guards only `b`: an expression with a top-level `||` has to be parenthesized before another
 * `&&` is conjoined to it. An expression whose quotes or parentheses do not balance cannot be
 * reasoned about at all, and a condition is never rewritten on a guess.
 */
function inspectExpression(expression: string): { or: boolean; balanced: boolean } {
	let depth = 0;
	let quote: string | null = null;
	let or = false;
	for (let index = 0; index < expression.length; index += 1) {
		const char = expression[index];
		if (quote !== null) {
			// A doubled quote escapes itself, which closing and reopening handles for free.
			if (char === quote) quote = null;
			continue;
		}
		if (char === "'" || char === '"') quote = char;
		else if (char === "(") depth += 1;
		else if (char === ")") {
			depth -= 1;
			if (depth < 0) return { or, balanced: false };
		} else if (char === "|" && expression[index + 1] === "|" && depth === 0) or = true;
	}
	return { or, balanced: depth === 0 && quote === null };
}

/** `expression`, parenthesized only where a conjoined `&&` would otherwise bind too tightly. */
function operand(expression: string): string {
	return inspectExpression(expression).or ? `(${expression})` : expression;
}

/**
 * The single expression a condition's value contains — the value itself when it is bare, or the
 * inside of a `${{ … }}` span covering the whole value — or `null` when the value interleaves
 * literal text with one or more spans and so has no single expression to extend.
 */
function soleExpression(value: string): { expression: string; wrapped: boolean } | null {
	const trimmed = value.trim();
	const wrapped = WRAPPED_EXPRESSION.exec(trimmed);
	const expression = wrapped === null ? trimmed : (wrapped.groups?.body ?? "").trim();
	// A second span inside what looked like one: `${{ a }} && ${{ b }}` matched greedily above.
	if (expression.includes("${{") || expression.includes("}}")) return null;
	return { expression, wrapped: wrapped !== null };
}

/** The inline value and half-open child line range of a column-0 key, or `null` when absent. */
function topLevelKey(lines: readonly string[], key: string): { value: string; start: number; end: number } | null {
	const opener = new RegExp(`^["']?${key}["']?:[ \\t]*(.*)$`, "u");
	for (const [index, line] of lines.entries()) {
		const match = opener.exec(line);
		if (match === null) continue;
		let end = lines.length;
		for (let scan = index + 1; scan < lines.length; scan += 1) {
			const candidate = lines[scan] ?? "";
			if (candidate.trim().length > 0 && candidate.search(/\S/u) === 0) {
				end = scan;
				break;
			}
		}
		return { value: match[1] ?? "", start: index + 1, end };
	}
	return null;
}

/**
 * Whether this workflow runs on the `pull_request` event. A workflow that does not is out of
 * scope: adding a head-branch condition to its jobs would only disable work agent branches
 * never trigger. `pull_request_target` deliberately does not count — its `github.event_name` is
 * not `pull_request`, so this module's guard would evaluate true there and scope nothing, and
 * claiming otherwise would report a workflow as scoped when it is not.
 */
export function triggersPullRequest(lines: readonly string[]): boolean {
	const on = topLevelKey(lines, "on");
	if (on === null) return false;
	if (/pull_request(?!_)/u.test(on.value)) return true;
	return lines.slice(on.start, on.end).some(line => /pull_request(?!_)/u.test(line));
}

/** One job of a workflow: its key line, the indentation of its own keys, and its body range. */
interface JobBlock {
	name: string;
	key: number;
	childIndent: number;
	start: number;
	end: number;
}

/**
 * Every top-level job, split into the block mappings this reader can analyse and the entries it
 * cannot read at all. An inline mapping — `build: { runs-on: …, steps: […] }`, or every job on
 * the `jobs:` line itself — keeps its whole body where no line of its own exists, so no `if:`
 * can be inserted into it and no step of it can be extended.
 *
 * Such an entry is *reported*, never dropped: it runs its whole matrix on every agent pull
 * request exactly like an analysable job, and a pass that discarded it would report a clean
 * repository while that job still bills every agent PR.
 */
export interface JobListing {
	blocks: JobBlock[];
	/** Job entries no rewrite can reach, each at the one-based line that carries it. */
	opaque: { line: number; why: string }[];
}

export function jobBlocks(lines: readonly string[]): JobListing {
	const jobs = topLevelKey(lines, "jobs");
	if (jobs === null) return { blocks: [], opaque: [] };
	// `topLevelKey`'s `start` is the zero-based first child line, which is the one-based number
	// of the key line itself. A comment after `jobs:` is not a value and leaves the block alone.
	const inline = jobs.value.trim();
	if (inline.length > 0 && !inline.startsWith("#")) {
		return { blocks: [], opaque: [{ line: jobs.start, why: "every job is written inline on the `jobs:` line, so no job has a line of its own to carry a condition" }] };
	}
	const blocks: JobBlock[] = [];
	const opaque: { line: number; why: string }[] = [];
	let jobIndent: number | null = null;
	for (let index = jobs.start; index < jobs.end; index += 1) {
		const line = lines[index] ?? "";
		if (line.trim().length === 0 || line.trimStart().startsWith("#")) continue;
		const indent = line.search(/\S/u);
		jobIndent ??= indent;
		if (indent !== jobIndent) continue;
		const key = BLOCK_KEY.exec(line);
		if (key === null) {
			// A job entry at job indentation that is not a bare block key: an inline mapping, an
			// anchor, a quoted name. What it is does not matter, only that this reader cannot place
			// a condition in it, which is exactly what has to reach the report.
			opaque.push({ line: index + 1, why: "job is not a block mapping (an inline mapping, an anchor or a quoted key), so no condition can be inserted into it" });
			continue;
		}
		let end = jobs.end;
		for (let scan = index + 1; scan < jobs.end; scan += 1) {
			const candidate = lines[scan] ?? "";
			if (candidate.trim().length > 0 && candidate.search(/\S/u) <= jobIndent) {
				end = scan;
				break;
			}
		}
		const body = lines.slice(index + 1, end).filter(candidate => candidate.trim().length > 0);
		const childIndent = body.length === 0 ? jobIndent + 2 : Math.min(...body.map(candidate => candidate.search(/\S/u)));
		blocks.push({ name: key[2] ?? "", key: index, childIndent, start: index + 1, end });
	}
	return { blocks, opaque };
}

/** A job's own `if:`: where it is, what it says, and whether it is a block scalar. */
interface JobCondition {
	/** Zero-based index of the `if:` key line. */
	key: number;
	/** Zero-based exclusive end of every line the condition occupies, key line included. */
	end: number;
	/** Everything on the key line before `if:`, so a rewrite keeps the exact indentation. */
	lead: string;
	/** The condition's expression; a block scalar's body lines joined by newlines. */
	value: string;
	/** A block scalar's body range and base indentation; `null` for a one-line condition. */
	block: { start: number; end: number; indent: number } | null;
}

/**
 * The job's own `if:`, at the indentation of the job's own keys, or `null` when it has none.
 * A key with no usable value still returns a condition: reporting it is right, and treating it
 * as absent would insert a second `if:` into the same mapping.
 */
function jobCondition(lines: readonly string[], job: JobBlock): JobCondition | null {
	for (let index = job.start; index < job.end; index += 1) {
		const line = lines[index] ?? "";
		if (line.search(/\S/u) !== job.childIndent || !ANY_IF_LINE.test(line)) continue;
		const lead = line.slice(0, line.indexOf("if:"));
		if (!BLOCK_IF_LINE.test(line)) return { key: index, end: index + 1, lead, value: IF_LINE.exec(line)?.[3] ?? "", block: null };
		// A block scalar's body is every following more-indented line; blank lines belong to it
		// but never end it, so the range stops at the last line carrying content.
		let end = index + 1;
		for (let scan = index + 1; scan < job.end; scan += 1) {
			const candidate = lines[scan] ?? "";
			if (candidate.trim().length === 0) continue;
			if (candidate.search(/\S/u) <= job.childIndent) break;
			end = scan + 1;
		}
		const body = lines.slice(index + 1, end);
		const filled = body.filter(candidate => candidate.trim().length > 0);
		const indent = filled.length === 0 ? job.childIndent + 2 : Math.min(...filled.map(candidate => candidate.search(/\S/u)));
		return { key: index, end, lead, value: body.join("\n"), block: { start: index + 1, end, indent } };
	}
	return null;
}

/**
 * The lines replacing a job-level condition that has nothing to do with pull requests, or why
 * it was left alone.
 *
 * The existing condition is preserved and the whole-job guard is conjoined to it, so a job its
 * author already narrowed keeps that narrowing and merely stops running on agent branches. A
 * block scalar keeps every line it had and gains one more inside the same scalar; only the
 * span's own delimiters and, where precedence demands it, a pair of parentheses move.
 */
function scopeJobCondition(lines: readonly string[], condition: JobCondition): string[] | { why: string } {
	const empty = { why: "`if:` with no expression to extend" };
	if (condition.block === null) {
		const value = condition.value.trimEnd();
		if (value.length === 0) return empty;
		// A `#` after whitespace ends a plain scalar, so the expression is not the whole value.
		if (/\s#/u.test(value)) return { why: "trailing comment after the condition" };
		const sole = soleExpression(value);
		if (sole === null) return { why: "condition mixes literal text with an expression span" };
		if (sole.expression.length === 0) return empty;
		if (!inspectExpression(sole.expression).balanced) return { why: "unbalanced quotes or parentheses in the condition" };
		const joined = `${operand(sole.expression)} && ${operand(OMP_JOB_CONDITION)}`;
		return [`${condition.lead}if: ${sole.wrapped ? `\${{ ${joined} }}` : joined}`];
	}
	const body = lines.slice(condition.block.start, condition.block.end);
	if (body.every(line => line.trim().length === 0)) return empty;
	const sole = soleExpression(condition.value);
	if (sole === null) return { why: "condition mixes literal text with an expression span" };
	if (sole.expression.length === 0) return empty;
	const shape = inspectExpression(sole.expression);
	if (!shape.balanced) return { why: "unbalanced quotes or parentheses in the condition" };
	// `soleExpression` proved the span covers the whole value, so its `${{` opens the first line
	// carrying content and its `}}` closes the last: the guard's own line carries the `}}` on.
	const first = body.findIndex(line => line.trim().length > 0);
	const last = body.length - 1;
	const rewritten = [...body];
	const head = rewritten[first] ?? "";
	if (sole.wrapped) {
		rewritten[first] = head.replace(/\$\{\{[ \t]*/u, () => (shape.or ? "${{ (" : "${{ "));
		rewritten[last] = `${(rewritten[last] ?? "").replace(/[ \t]*\}\}[ \t]*$/u, "")}${shape.or ? ")" : ""}`;
	} else if (shape.or) {
		const column = head.search(/\S/u);
		rewritten[first] = `${head.slice(0, column)}(${head.slice(column)}`;
		rewritten[last] = `${(rewritten[last] ?? "").trimEnd()})`;
	}
	const guard = `${" ".repeat(condition.block.indent + 2)}&& ${operand(OMP_JOB_CONDITION)}${sole.wrapped ? " }}" : ""}`;
	return [lines[condition.key] ?? "", ...rewritten, guard];
}

/** A replacement of the half-open zero-based line range `[start, end)` with `lines`. */
interface Edit {
	start: number;
	end: number;
	lines: string[];
}

/**
 * Analyse and rewrite one workflow's text. The analysis is always returned, including the
 * conditions this module refuses to touch: they are what makes a repository only partly
 * scoped, and dropping them when no line changed would report a clean pass over a file that
 * still runs its whole matrix on agent branches. An empty `changed` means do not write.
 */
export function scopeWorkflowText(text: string): WorkflowScope {
	const lines = text.split("\n");
	const changed: number[] = [];
	const already: number[] = [];
	const unhandled: { line: number; why: string }[] = [];
	for (const [index, line] of lines.entries()) {
		// A folded or block `if:` keeps its expression on the following, more-indented lines.
		// Appending to the key line would produce `if: >- && …`, so a step's whole condition is
		// left alone and reported; a job's own condition is rewritten in the pass below, which
		// can see the whole block. The indicator can carry a chomping or indentation modifier.
		const block = BLOCK_IF_LINE.exec(line);
		if (block !== null) {
			const indent = (block[1] ?? "").length;
			let scoped = false;
			for (const following of lines.slice(index + 1)) {
				if (following.trim().length > 0 && following.search(/\S/u) <= indent) break;
				if (PULL_REQUEST_CONDITION.test(following)) scoped = true;
			}
			if (scoped) unhandled.push({ line: index + 1, why: "folded or block scalar condition" });
			continue;
		}
		const match = IF_LINE.exec(line);
		if (match === null) continue;
		const value = match[3] ?? "";
		if (!PULL_REQUEST_CONDITION.test(value)) continue;
		if (ALREADY_SCOPED.test(value)) {
			already.push(index + 1);
			continue;
		}
		const comment = value.search(/\s#/u);
		if (comment !== -1) {
			unhandled.push({ line: index + 1, why: "trailing comment after the condition" });
			continue;
		}
		// A condition interleaving literal text with one or more `${{ }}` spans has no single
		// expression to extend, and one whose delimiters do not balance cannot be read at all.
		const sole = soleExpression(value);
		if (sole === null) {
			unhandled.push({ line: index + 1, why: "condition mixes literal text with an expression span" });
			continue;
		}
		if (sole.expression.length === 0) continue;
		if (!inspectExpression(sole.expression).balanced) {
			unhandled.push({ line: index + 1, why: "unbalanced quotes or parentheses in the condition" });
			continue;
		}
		const joined = `${operand(sole.expression)} && ${operand(OMP_EXCLUSION)}`;
		lines[index] = `${match[1] ?? ""}${match[2] ?? ""}if: ${sole.wrapped ? `\${{ ${joined} }}` : joined}`;
		changed.push(index + 1);
	}
	// Extending step conditions cannot reach a job that has no PR-only condition of its own: it
	// runs whole on every pull request, which is exactly the `py`-shaped job this scoping exists
	// for. Such a job gets the guard as its own condition, conjoined to whatever unrelated
	// condition it already carries. A job whose steps already carry a PR-only condition was
	// deliberately differentiated by its author and the pass above scoped those steps, so its
	// unconditional cheap steps keep running on agent PRs.
	const edits: Edit[] = [];
	if (triggersPullRequest(lines)) {
		const listing = jobBlocks(lines);
		// A job this reader cannot place a condition in is not a job that needs none: it runs its
		// whole matrix on every agent pull request just like the analysable jobs below, and the
		// report is the only thing that keeps `scoped` false until a human scopes it by hand.
		unhandled.push(...listing.opaque);
		for (const job of listing.blocks) {
			const own = jobCondition(lines, job);
			if (own !== null) {
				if (ALREADY_SCOPED.test(own.value)) {
					if (!already.includes(own.key + 1)) already.push(own.key + 1);
					continue;
				}
				// A PR-only job condition is a one-line extension the pass above owns, or a block
				// scalar it already reported; either way it is not this pass's to rewrite.
				if (PULL_REQUEST_CONDITION.test(own.value)) continue;
			}
			const steps = [...lines.slice(job.start, own?.key ?? job.end), ...lines.slice(own?.end ?? job.end, job.end)];
			if (steps.some(line => PULL_REQUEST_CONDITION.test(line) || ALREADY_SCOPED.test(line))) continue;
			if (own === null) {
				edits.push({ start: job.key + 1, end: job.key + 1, lines: [`${" ".repeat(job.childIndent)}if: ${OMP_JOB_CONDITION}`] });
				continue;
			}
			const scoped = scopeJobCondition(lines, own);
			if (Array.isArray(scoped)) edits.push({ start: own.key, end: own.end, lines: scoped });
			else unhandled.push({ line: own.key + 1, why: scoped.why });
		}
	}
	// Applied last to first so an earlier edit never shifts a later one's anchor, and every line
	// number already reported moves with the text, so the report keeps naming the condition it
	// means rather than whatever an insertion above it pushed into that position.
	for (const edit of edits.sort((left, right) => right.start - left.start)) {
		lines.splice(edit.start, edit.end - edit.start, ...edit.lines);
		const delta = edit.lines.length - (edit.end - edit.start);
		if (delta !== 0) {
			for (const [position, line] of changed.entries()) if (line > edit.end) changed[position] = line + delta;
			for (const [position, line] of already.entries()) if (line > edit.end) already[position] = line + delta;
			for (const entry of unhandled) if (entry.line > edit.end) entry.line += delta;
		}
		changed.push(edit.start + 1);
	}
	changed.sort((left, right) => left - right);
	return { text: changed.length === 0 ? text : lines.join("\n"), changed, already, unhandled };
}

/** What `<root>/.github/workflows` holds, and what it would not give up. */
export interface WorkflowListing {
	/** Regular `*.yml`/`*.yaml` files, sorted. */
	files: string[];
	/**
	 * Entries that match the name but are not regular files — a symlink, a directory. They are
	 * never read and never written: `writeFileSync` follows a symlink, so a link out of the
	 * checkout would make this pass rewrite a file outside the tree it was handed.
	 */
	skipped: string[];
	/**
	 * Why the directory could not be enumerated at all. Absent when it simply does not exist:
	 * a repository with no workflows has nothing to scope, which is a clean pass, while a
	 * directory this process may not read is a pass that saw nothing and must not claim one.
	 */
	unreadable?: string;
}

/** Workflow files under `<root>/.github/workflows`; see `WorkflowListing` for what it withholds. */
export function workflowFiles(root: string): WorkflowListing {
	const dir = path.join(root, ".github", "workflows");
	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch (error) {
		const code = error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
		if (code === "ENOENT" || code === "ENOTDIR") return { files: [], skipped: [] };
		return { files: [], skipped: [], unreadable: error instanceof Error ? error.message : String(error) };
	}
	const listing: WorkflowListing = { files: [], skipped: [] };
	for (const entry of entries) {
		if (!/\.ya?ml$/u.test(entry.name)) continue;
		if (entry.isFile()) listing.files.push(path.join(dir, entry.name));
		else listing.skipped.push(entry.name);
	}
	listing.files.sort();
	listing.skipped.sort();
	return listing;
}

/**
 * Scope every PR-only condition in `root`'s workflows to exclude `omp/**` head branches.
 * Idempotent: a second call finds every condition already scoped and changes nothing.
 *
 * `mode` is not a convenience. `root` is whichever checkout the caller works in, and the
 * canonical checkout's working tree is never mutated (`references/landing.md`): a lead that
 * binds before creating its integration worktree passes `"report"`, and the files that need the
 * edit come back as `pending` for it to apply where its commit can carry them. `"apply"`
 * rewrites in place. `scoped` is false whenever the repository still runs a PR-only condition
 * on `omp/**` branches — because this module would not rewrite it, because nothing was
 * written, or because the pass could not see what it was asked to scope. An unreadable
 * workflow directory, an entry that is not a regular file, and a file whose real path leaves
 * `root` are all reported and all hold `scoped` false: a pass that read nothing is not a
 * repository that needs nothing.
 */
export function scopeCi(root: string, mode: "apply" | "report"): CiScopeReport {
	const report: CiScopeReport = { scoped: true, root, changed: [], pending: [], already: [], unhandled: [] };
	const listing = workflowFiles(root);
	if (listing.unreadable !== undefined) {
		report.unhandled.push(`.github/workflows could not be read: ${listing.unreadable}`);
		report.scoped = false;
	}
	for (const name of listing.skipped) report.unhandled.push(`.github/workflows/${name} is not a regular file; a symlinked workflow is never rewritten`);
	if (listing.skipped.length > 0) report.scoped = false;
	for (const file of listing.files) {
		const relative = path.relative(root, file);
		// The entry is a regular file, but `.github` or `.github/workflows` may itself be a link
		// out of the checkout. The real path decides, so `mode: "apply"` cannot be talked into
		// writing a file this caller was never given.
		if (!isInside(file, root)) {
			report.unhandled.push(`${relative} resolves outside ${root}; nothing was read or written`);
			report.scoped = false;
			continue;
		}
		let text: string;
		try {
			text = readFileSync(file, "utf8");
		} catch {
			report.unhandled.push(`${relative} unreadable`);
			report.scoped = false;
			continue;
		}
		const result = scopeWorkflowText(text);
		for (const line of result.already) report.already.push(`${relative}:${line}`);
		for (const entry of result.unhandled) report.unhandled.push(`${relative}:${entry.line} ${entry.why}`);
		if (result.changed.length === 0) continue;
		if (mode === "report") {
			report.pending.push(relative);
			continue;
		}
		try {
			writeFileSync(file, result.text);
		} catch (error) {
			report.unhandled.push(`${relative} not writable: ${error instanceof Error ? error.message : String(error)}`);
			report.scoped = false;
			continue;
		}
		report.changed.push(relative);
	}
	if (report.unhandled.length > 0 || report.pending.length > 0) report.scoped = false;
	return report;
}

/** One line for the bind result: what was scoped, what is pending, and what a human must scope. */
export function ciScopeMessage(report: CiScopeReport): string {
	const parts: string[] = [];
	if (report.changed.length > 0) parts.push(`CI: scoped ${report.changed.join(", ")} away from omp/** head branches in ${report.root} — commit this as the run's first change`);
	if (report.pending.length > 0) {
		parts.push(
			`CI: ${report.pending.join(", ")} still run their whole pull-request matrix on omp/** head branches. Nothing was written: ${report.root} is the canonical checkout, whose working tree is never mutated. Create your integration worktree, then call orc_bind again from it and commit the edit as the run's first change`,
		);
	}
	if (report.unhandled.length > 0) parts.push(`CI: scope these by hand, they were left untouched: ${report.unhandled.join("; ")}`);
	if (parts.length > 0) return parts.join("\n");
	return report.already.length === 0 ? "CI: no pull-request-only conditions to scope" : `CI: already scoped away from omp/** (${report.already.length} condition(s))`;
}
