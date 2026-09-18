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

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

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
	/** Workflow files this call rewrote, relative to the repository root. */
	changed: string[];
	/** `<file>:<line>` of PR-only conditions that were already scoped. */
	already: string[];
	/**
	 * `<file>:<line> <why>` for a condition this module refused to rewrite, because no
	 * unambiguous rewrite exists — a value interleaving literal text with expression spans, an
	 * expression whose quotes or parentheses do not balance, a trailing comment. Reported, not
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

/** Every top-level job written as a block mapping. An inline-mapping job is not analysable. */
export function jobBlocks(lines: readonly string[]): JobBlock[] {
	const jobs = topLevelKey(lines, "jobs");
	if (jobs === null) return [];
	const blocks: JobBlock[] = [];
	let jobIndent: number | null = null;
	for (let index = jobs.start; index < jobs.end; index += 1) {
		const line = lines[index] ?? "";
		if (line.trim().length === 0 || line.trimStart().startsWith("#")) continue;
		const indent = line.search(/\S/u);
		jobIndent ??= indent;
		if (indent !== jobIndent) continue;
		const key = BLOCK_KEY.exec(line);
		if (key === null) continue;
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
	return blocks;
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
		for (const job of jobBlocks(lines)) {
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

/** Workflow files under `<root>/.github/workflows`, sorted; empty when the directory is absent. */
export function workflowFiles(root: string): string[] {
	const dir = path.join(root, ".github", "workflows");
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return [];
	}
	return entries.filter(name => /\.ya?ml$/u.test(name)).sort().map(name => path.join(dir, name));
}

/**
 * Scope every PR-only condition in `root`'s workflows to exclude `omp/**` head branches, in
 * place. Idempotent: a second call finds every condition already scoped and changes nothing.
 * `scoped` is false only when a condition was found that this module would not rewrite.
 */
export function scopeCi(root: string): CiScopeReport {
	const report: CiScopeReport = { scoped: true, changed: [], already: [], unhandled: [] };
	for (const file of workflowFiles(root)) {
		const relative = path.relative(root, file);
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
		try {
			writeFileSync(file, result.text);
		} catch (error) {
			report.unhandled.push(`${relative} not writable: ${error instanceof Error ? error.message : String(error)}`);
			report.scoped = false;
			continue;
		}
		report.changed.push(relative);
	}
	if (report.unhandled.length > 0) report.scoped = false;
	return report;
}

/** One line for the bind result: what was scoped, and what a human still has to scope. */
export function ciScopeMessage(report: CiScopeReport): string {
	if (report.changed.length === 0 && report.unhandled.length === 0) {
		return report.already.length === 0 ? "CI: no pull-request-only conditions to scope" : `CI: already scoped away from omp/** (${report.already.length} condition(s))`;
	}
	const parts: string[] = [];
	if (report.changed.length > 0) parts.push(`CI: scoped ${report.changed.join(", ")} away from omp/** head branches — commit this as the run's first change`);
	if (report.unhandled.length > 0) parts.push(`CI: scope these by hand, they were left untouched: ${report.unhandled.join("; ")}`);
	return parts.join("\n");
}
