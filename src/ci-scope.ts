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
 * expression being changed is a string either way. Block scalar folding, chomping, and explicit
 * indentation are not line-local semantics, so those values are reported byte-identically rather
 * than decoded or rewritten. Only conditions this module can rewrite without ambiguity are touched;
 * Anything else is reported for a human, never guessed at, and leaves the repository reported unscoped.
 */

import { type Dirent, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isInside } from "./worktree";

/** The guard appended to a PR-only condition. `head_ref` is set only for a pull request. */
export const OMP_EXCLUSION = "!startsWith(github.head_ref, 'omp/')";

/** Matches a condition that runs *because* the event is a pull request. `!=` is not it. */
const PULL_REQUEST_CONDITION = /github\s*\.\s*event_name\s*==\s*['"]pull_request['"]/u;
/**
 * The head-ref prefix predicate this module writes, however it is spaced or quoted. It is the
 * only shape that covers *every* `omp/**` branch, so it is the only one this reader credits.
 */
const HEAD_REF_PREFIX = String.raw`startsWith\s*\(\s*github\s*\.\s*head_ref\s*,\s*['"]omp/['"]\s*\)`;
/**
 * A mention of that predicate anywhere in a condition. Only a mention: whether the condition
 * really keeps `omp/**` head branches out is decided by `excludesOmpHead`, which reads the
 * logic around it. Text alone cannot say. `github.event_name == 'pull_request' && (failure() ||
 * !startsWith(github.head_ref, 'omp/'))` names the exclusion and still runs its whole matrix on
 * every agent pull request that fails, and `github.head_ref != 'omp/special'` mentions `omp/`
 * while excluding exactly one branch.
 */
const MENTIONS_HEAD_REF_PREFIX = new RegExp(HEAD_REF_PREFIX, "u");
/** Why a condition that names the exclusion is still reported rather than counted as scoped. */
const PARTIAL_EXCLUSION = "the omp/** exclusion does not cover every path through this condition";
/** `<indent>if: <value>`, the only shape whose value is a complete expression on one line. */
const IF_LINE = /^(\s*)(-\s+)?if:[ \t]+(\S.*)$/u;
/** Any `if:` key, one-line or block, at any indentation. */
const ANY_IF_LINE = /^\s*(?:-\s+)?if:(?:[ \t]|$)/u;
/** An `if:` whose value begins with a folded or literal block scalar indicator. */
const BLOCK_IF_LINE = /^(\s*)(?:-\s+)?if:[ \t]*[|>].*$/u;
/** A `${{ … }}` span, when it covers a whole condition value. */
const WRAPPED_EXPRESSION = /^\$\{\{(?<body>[\s\S]*)\}\}$/u;
/** A block-mapping key line with nothing after the colon: `  <name>:`. */
const BLOCK_KEY = /^(\s+)([A-Za-z_][\w.-]*):[ \t]*$/u;
/** A YAML alias reference: the value it stands for is the anchor's, not the text here. */
const YAML_ALIAS = /(?:^|[\s,[{])\*[A-Za-z0-9_][\w.-]*/u;
/** A YAML merge key, which folds another mapping's keys into this one. */
const MERGE_KEY = /^\s*(?:-\s+)?<<\s*:/u;
/** A comment-only line carries no mapping structure at any indentation. */
function isCommentOnly(line: string): boolean {
	return line.trimStart().startsWith("#");
}

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

type InlineScalarStyle = "plain" | "single" | "double";

interface InlineConditionScalar {
	value: string;
	style: InlineScalarStyle;
}

/** YAML's non-string plain scalar spellings, which this string-only editor must not rewrite. */
const NON_STRING_PLAIN_SCALAR = /^(?:~|null|true|false|[-+]?(?:(?:0b[01_]+|0o[0-7_]+|0x[\da-f_]+|\d[\d_]*)|(?:\d[\d_]*\.\d*|\.\d[\d_]*)(?:e[-+]?\d[\d_]*)?|\d[\d_]*e[-+]?\d[\d_]*|\.inf|\.nan))$/iu;

/** Decode a complete single-quoted YAML scalar. Quotes inside it must be doubled. */
function singleQuotedScalar(source: string): string | null {
	let value = "";
	for (let index = 1; index < source.length - 1; index += 1) {
		const char = source.charAt(index);
		if (char === "'") {
			if (source.charAt(index + 1) !== "'" || index + 1 === source.length - 1) return null;
			value += "'";
			index += 1;
			continue;
		}
		const code = source.charCodeAt(index);
		if (code < 0x20 && code !== 0x09) return null;
		if (code >= 0xd800 && code <= 0xdbff) {
			const low = source.charCodeAt(index + 1);
			if (low < 0xdc00 || low > 0xdfff || index + 1 === source.length - 1) return null;
			value += char + source.charAt(index + 1);
			index += 1;
		} else {
			if (code >= 0xdc00 && code <= 0xdfff) return null;
			value += char;
		}
	}
	return value;
}
/** YAML's one-character double-quoted escapes. */
const YAML_DOUBLE_ESCAPES: Readonly<Record<string, string>> = {
	"0": "\0",
	a: "\x07",
	b: "\b",
	t: "\t",
	n: "\n",
	v: "\v",
	f: "\f",
	r: "\r",
	e: "\x1b",
	" ": " ",
	'"': '"',
	"/": "/",
	"\\": "\\",
	N: "\u0085",
	_: "\u00a0",
	L: "\u2028",
	P: "\u2029",
};


/** Decode one YAML double-quoted escape. Returns the value and its last consumed index. */
function doubleQuotedEscape(source: string, slash: number): { value: string; end: number } | null {
	const escaped = source.charAt(slash + 1);
	const simple = YAML_DOUBLE_ESCAPES[escaped];
	if (simple !== undefined) return { value: simple, end: slash + 1 };
	const digits = escaped === "x" ? 2 : escaped === "u" ? 4 : escaped === "U" ? 8 : 0;
	if (digits === 0) return null;
	const hex = source.slice(slash + 2, slash + 2 + digits);
	if (hex.length !== digits || !/^[\da-f]+$/iu.test(hex)) return null;
	const codePoint = Number.parseInt(hex, 16);
	if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return null;
	return { value: String.fromCodePoint(codePoint), end: slash + 1 + digits };
}

/** Decode a complete double-quoted YAML scalar without relying on Bun's optional YAML API. */
function doubleQuotedScalar(source: string): string | null {
	let value = "";
	for (let index = 1; index < source.length - 1; index += 1) {
		const char = source.charAt(index);
		if (char === '"') return null;
		if (char === "\\") {
			const escape = doubleQuotedEscape(source, index);
			if (escape === null || escape.end >= source.length - 1) return null;
			value += escape.value;
			index = escape.end;
			continue;
		}
		const code = source.charCodeAt(index);
		if (code < 0x20 && code !== 0x09) return null;
		if (code >= 0xd800 && code <= 0xdbff) {
			const low = source.charCodeAt(index + 1);
			if (low < 0xdc00 || low > 0xdfff || index + 1 === source.length - 1) return null;
			value += char + source.charAt(index + 1);
			index += 1;
		} else {
			if (code >= 0xdc00 && code <= 0xdfff) return null;
			value += char;
		}
	}
	return value;
}

/**
 * Decode one complete inline YAML string scalar without accepting comments, collections, tags,
 * implicit non-string values, or malformed escapes. This intentionally implements only the
 * scalar forms the line-local editor can reproduce; every other YAML shape fails closed.
 */
function inlineConditionScalar(raw: string): InlineConditionScalar | { why: string } {
	const source = raw.trimEnd();
	if (source.length === 0) return { why: "`if:` with no expression to extend" };
	const first = source[0];
	const style: InlineScalarStyle = first === "'" ? "single" : first === '"' ? "double" : "plain";
	if (style === "plain") {
		if (/(?:^|[ \t])#/u.test(source)) return { why: "trailing comment after the condition" };
		if (/^(?:[-?:](?:[ \t]|$)|[,\[\]{}#&*!|>'"%@`])/u.test(source) || /:(?:[ \t]|$)/u.test(source) || NON_STRING_PLAIN_SCALAR.test(source)) {
			return { why: "unsupported YAML condition scalar" };
		}
		return { value: source, style };
	}
	if (source.length < 2 || source.at(-1) !== first) {
		return { why: /[ \t]#/u.test(source) ? "trailing comment after the condition" : "unsupported YAML condition scalar" };
	}
	const value = style === "single" ? singleQuotedScalar(source) : doubleQuotedScalar(source);
	return value === null ? { why: "unsupported YAML condition scalar" } : { value, style };
}

/** Encode `value` in the same scalar style, proving the result decodes to exactly that string. */
function renderConditionScalar(value: string, style: InlineScalarStyle): string | null {
	const rendered = style === "single" ? `'${value.replaceAll("'", "''")}'` : style === "double" ? JSON.stringify(value) : value;
	const reparsed = inlineConditionScalar(rendered);
	return "value" in reparsed && reparsed.value === value && reparsed.style === style ? rendered : null;
}

/** A parsed scalar and the sole GitHub expression it contains, when both shapes are supported. */
function inlineCondition(value: string): { scalar: InlineConditionScalar; expression: string; wrapped: boolean } | { why: string } {
	const scalar = inlineConditionScalar(value);
	if ("why" in scalar) return scalar;
	const sole = soleExpression(scalar.value);
	if (sole === null) return { why: "condition mixes literal text with an expression span" };
	return { scalar, ...sole };
}

/**
 * A condition's truth on the run this module cares about, where an atom it does not model
 * leaves the answer open.
 */
type Truth = true | false | "maybe";

/** The atoms whose value is fixed on a pull request whose head branch is `omp/**`. */
const ATOM_HEAD_REF_PREFIX = new RegExp(String.raw`^${HEAD_REF_PREFIX}$`, "u");
const ATOM_HEAD_REF_PREFIX_FALSE = new RegExp(String.raw`^${HEAD_REF_PREFIX}\s*==\s*false$`, "u");
const ATOM_PULL_REQUEST = /^github\s*\.\s*event_name\s*==\s*['"]pull_request['"]$/u;
const ATOM_NOT_PULL_REQUEST = /^github\s*\.\s*event_name\s*!=\s*['"]pull_request['"]$/u;

/**
 * `expression`'s value on a pull request whose head branch is `omp/**`: the head-ref prefix
 * predicate holds, the pull-request event test holds and its negation does not, and every other
 * atom is open. `null` when the text is not a shape this reader parses — a group used as the
 * operand of anything but `&&`, `||` and `!`, unbalanced delimiters, text after the expression.
 *
 * Three-valued, so a definite answer holds for every value the open atoms could take. An
 * expression that repeats an atom can come out open where a solver would call it definite; that
 * costs a report, never a wrong credit.
 */
function evaluateOnOmpHead(expression: string): Truth | null {
	let at = 0;

	function skipSpace(): void {
		while (at < expression.length && /\s/u.test(expression.charAt(at))) at += 1;
	}

	/** The `&&` or `||` at the cursor, or `null` for anything else, the end included. */
	function nextOperator(): "&&" | "||" | null {
		const char = expression.charAt(at);
		if (char !== expression.charAt(at + 1)) return null;
		if (char === "&") return "&&";
		if (char === "|") return "||";
		return null;
	}

	/**
	 * The atom at the cursor: everything up to a top-level operator or the `)` of an enclosing
	 * group. A function call's own parentheses and anything inside quotes belong to the atom.
	 */
	function atom(): Truth | null {
		const start = at;
		let depth = 0;
		let quote: string | null = null;
		while (at < expression.length) {
			const char = expression.charAt(at);
			if (quote !== null) {
				// A doubled quote escapes itself, which closing and reopening handles for free.
				if (char === quote) quote = null;
			} else if (char === "'" || char === '"') quote = char;
			else if (char === "(") depth += 1;
			else if (char === ")") {
				if (depth === 0) break;
				depth -= 1;
			} else if (depth === 0 && nextOperator() !== null) break;
			at += 1;
		}
		if (quote !== null || depth !== 0) return null;
		const text = expression.slice(start, at).trim();
		if (text.length === 0) return null;
		if (ATOM_HEAD_REF_PREFIX.test(text)) return true;
		if (ATOM_HEAD_REF_PREFIX_FALSE.test(text)) return false;
		if (ATOM_PULL_REQUEST.test(text)) return true;
		if (ATOM_NOT_PULL_REQUEST.test(text)) return false;
		return "maybe";
	}

	function unary(): Truth | null {
		skipSpace();
		if (expression.charAt(at) === "!") {
			at += 1;
			const inner = unary();
			return inner === null || inner === "maybe" ? inner : !inner;
		}
		if (expression.charAt(at) !== "(") return atom();
		at += 1;
		const inner = disjunction();
		if (inner === null) return null;
		skipSpace();
		if (expression.charAt(at) !== ")") return null;
		at += 1;
		skipSpace();
		// A group that is the operand of something else — `(a || b) == false` — is a shape this
		// reader does not model, and guessing at one is exactly what would fail open.
		if (at < expression.length && nextOperator() === null && expression.charAt(at) !== ")") return null;
		return inner;
	}

	function conjunction(): Truth | null {
		let value = unary();
		if (value === null) return null;
		for (;;) {
			skipSpace();
			if (nextOperator() !== "&&") return value;
			at += 2;
			const right = unary();
			if (right === null) return null;
			if (value === false || right === false) value = false;
			else if (value === "maybe" || right === "maybe") value = "maybe";
			else value = true;
		}
	}

	function disjunction(): Truth | null {
		let value = conjunction();
		if (value === null) return null;
		for (;;) {
			skipSpace();
			if (nextOperator() !== "||") return value;
			at += 2;
			const right = conjunction();
			if (right === null) return null;
			if (value === true || right === true) value = true;
			else if (value === "maybe" || right === "maybe") value = "maybe";
			else value = false;
		}
	}

	const value = disjunction();
	if (value === null) return null;
	skipSpace();
	return at === expression.length ? value : null;
}

/**
 * Whether a condition's whole value can never be true on a pull request whose head branch is
 * `omp/**` — the invariant this module exists to establish. False whenever the text does not
 * settle it, so a condition this reader cannot follow is reported rather than counted as scoped.
 */
function excludesOmpHead(value: string): boolean {
	const condition = value.includes("\n") ? soleExpression(value) : inlineCondition(value);
	if (condition !== null && "expression" in condition && evaluateOnOmpHead(condition.expression) === false) return true;
	// A leading `!` is a reserved YAML indicator, but GitHub accepts this established condition
	// shape. Credit an existing exclusion without trying to emit another invalid plain scalar.
	const plain = value[0] !== "'" && value[0] !== '"' ? soleExpression(value) : null;
	return plain !== null && evaluateOnOmpHead(plain.expression) === false;
}

/** Whether a supported inline scalar or a block body contains a pull-request expression. */
function hasPullRequestCondition(value: string): boolean {
	if (value.includes("\n")) return PULL_REQUEST_CONDITION.test(value);
	const scalar = inlineConditionScalar(value);
	return "value" in scalar && PULL_REQUEST_CONDITION.test(scalar.value);
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
			if (candidate.trim().length > 0 && !isCommentOnly(candidate) && candidate.search(/\S/u) === 0) {
				end = scan;
				break;
			}
		}
		return { value: match[1] ?? "", start: index + 1, end };
	}
	return null;
}

/** What a workflow's `on:` block says about the `pull_request` event, and whether it could be read. */
export interface PullRequestTrigger {
	/** True only when the `on:` block literally names `pull_request`. */
	triggers: boolean;
	/** Set when the block cannot be read literally at all; the caller reports it and writes nothing. */
	unreadable?: { line: number; why: string };
}

/**
 * Whether this workflow runs on the `pull_request` event. A workflow that does not is out of
 * scope: adding a head-branch condition to its jobs would only disable work agent branches
 * never trigger. `pull_request_target` deliberately does not count — its `github.event_name` is
 * not `pull_request`, so this module's guard would evaluate true there and scope nothing, and
 * claiming otherwise would report a workflow as scoped when it is not.
 *
 * The read is textual, so a YAML alias (`on: [*pr]`) or a merge key hides the real event list
 * behind an anchor defined elsewhere in the file. The absence of the literal `pull_request`
 * proves nothing there, and treating it as "no pull request trigger" would skip the job pass
 * and still report the repository scoped — the same fail-open this module exists to avoid. Such
 * a block is reported instead, which holds `scoped` false until a human reads it.
 */
export function pullRequestTrigger(lines: readonly string[]): PullRequestTrigger {
	const on = topLevelKey(lines, "on");
	if (on === null) return { triggers: false };
	const body = lines.slice(on.start, on.end);
	if (/pull_request(?!_)/u.test(on.value) || body.some(line => /pull_request(?!_)/u.test(line))) return { triggers: true };
	const aliased = [on.value, ...body].some(line => YAML_ALIAS.test(line) || MERGE_KEY.test(line));
	if (!aliased) return { triggers: false };
	return {
		triggers: false,
		unreadable: { line: on.start, why: "the `on:` block resolves a YAML alias, so whether this workflow triggers on pull_request cannot be read from its text" },
	};
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
			if (candidate.trim().length > 0 && !isCommentOnly(candidate) && candidate.search(/\S/u) <= jobIndent) {
				end = scan;
				break;
			}
		}
		const body = lines.slice(index + 1, end).filter(candidate => candidate.trim().length > 0 && !isCommentOnly(candidate));

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
	/** The condition's value; block bodies are retained only to keep their full source range. */
	value: string;
	/** Whether the value begins with an unsupported block scalar indicator. */
	block: boolean;
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
		if (!BLOCK_IF_LINE.test(line)) return { key: index, end: index + 1, lead, value: IF_LINE.exec(line)?.[3] ?? "", block: false };
		// A block scalar's body is every following more-indented line; blank lines belong to it
		// but never end it, so the range stops at the last line carrying content.
		let end = index + 1;
		for (let scan = index + 1; scan < job.end; scan += 1) {
			const candidate = lines[scan] ?? "";
			if (isCommentOnly(candidate)) continue;
			if (candidate.trim().length === 0) continue;

			if (candidate.search(/\S/u) <= job.childIndent) break;
			end = scan + 1;
		}
		const body = lines.slice(index + 1, end);
		return { key: index, end, lead, value: body.join("\n"), block: true };
	}
	return null;
}

/**
 * The lines replacing a job-level condition that has nothing to do with pull requests, or why
 * it was left alone.
 *
 * The existing inline condition is preserved and the whole-job guard is conjoined to it, so a job
 * its author already narrowed keeps that narrowing and merely stops running on agent branches.
 * Block scalars are outside this line-local editor's supported semantics and fail closed.
 */
function scopeJobCondition(condition: JobCondition): string[] | { why: string } {
	if (condition.block) return { why: "folded or block scalar condition" };
	const parsed = inlineCondition(condition.value);
	if ("why" in parsed) return parsed;
	if (parsed.expression.length === 0) return { why: "`if:` with no expression to extend" };
	if (!inspectExpression(parsed.expression).balanced) return { why: "unbalanced quotes or parentheses in the condition" };
	const joined = `${operand(parsed.expression)} && ${operand(OMP_JOB_CONDITION)}`;
	const scalarValue = parsed.wrapped ? `\${{ ${joined} }}` : joined;
	const rendered = renderConditionScalar(scalarValue, parsed.scalar.style);
	if (rendered === null) return { why: "unsupported YAML condition scalar" };
	return [`${condition.lead}if: ${rendered}`];
}

/** A replacement of the half-open zero-based line range `[start, end)` with `lines`. */
interface Edit {
	start: number;
	end: number;
	lines: string[];
}

/** Whether a job's step text contains a supported pull-request-only `if:` condition. */
function hasStepPullRequestCondition(lines: readonly string[]): boolean {
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		const match = IF_LINE.exec(line);
		if (match === null) continue;
		if (!BLOCK_IF_LINE.test(line)) {
			const scalar = inlineConditionScalar(match[3] ?? "");
			if ("value" in scalar && PULL_REQUEST_CONDITION.test(scalar.value)) return true;
			continue;
		}
		const indent = line.search(/\S/u);
		let end = index + 1;
		for (; end < lines.length; end += 1) {
			const candidate = lines[end] ?? "";
			if (candidate.trim().length === 0 || isCommentOnly(candidate)) continue;
			if (candidate.search(/\S/u) <= indent) break;
		}
		if (hasPullRequestCondition(lines.slice(index + 1, end).join("\n"))) return true;
		index = end - 1;
	}
	return false;
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
		// Folding, chomping, and explicit indentation affect the scalar as a whole. This line-local
		// editor cannot prove those semantics, including for malformed indicator mutations, so the
		// complete condition stays byte-identical and cannot be credited as already scoped.
		if (BLOCK_IF_LINE.test(line)) {
			unhandled.push({ line: index + 1, why: "folded or block scalar condition" });
			continue;
		}
		const match = IF_LINE.exec(line);
		if (match === null) continue;
		const value = match[3] ?? "";
		const parsed = inlineCondition(value);
		if ("why" in parsed) {
			if (PULL_REQUEST_CONDITION.test(value) || /^["']/u.test(value)) unhandled.push({ line: index + 1, why: parsed.why });
			continue;
		}
		if (!PULL_REQUEST_CONDITION.test(parsed.scalar.value)) continue;
		if (MENTIONS_HEAD_REF_PREFIX.test(parsed.scalar.value)) {
			if (excludesOmpHead(value)) {
				already.push(index + 1);
				continue;
			}
			// A mention the condition's logic does not carry through every path is not scoping:
			// the job still runs whole on agent pull requests whenever the other operand holds.
			// Extending such a condition would rewrite a differentiation its author meant, so it
			// is reported, and the repository stays unscoped until a human settles it.
			unhandled.push({ line: index + 1, why: PARTIAL_EXCLUSION });
			continue;
		}
		if (parsed.expression.length === 0) continue;
		if (!inspectExpression(parsed.expression).balanced) {
			unhandled.push({ line: index + 1, why: "unbalanced quotes or parentheses in the condition" });
			continue;
		}
		const joined = `${operand(parsed.expression)} && ${operand(OMP_EXCLUSION)}`;
		const scalarValue = parsed.wrapped ? `\${{ ${joined} }}` : joined;
		const rendered = renderConditionScalar(scalarValue, parsed.scalar.style);
		if (rendered === null) {
			unhandled.push({ line: index + 1, why: "unsupported YAML condition scalar" });
			continue;
		}
		lines[index] = `${match[1] ?? ""}${match[2] ?? ""}if: ${rendered}`;
		changed.push(index + 1);
	}
	// Extending step conditions cannot reach a job that has no PR-only condition of its own: it
	// runs whole on every pull request, which is exactly the `py`-shaped job this scoping exists
	// for. Such a job gets the guard as its own condition, conjoined to whatever unrelated
	// condition it already carries. A job whose steps already carry a PR-only condition was
	// deliberately differentiated by its author and the pass above scoped those steps, so its
	// unconditional cheap steps keep running on agent PRs.
	const edits: Edit[] = [];
	const trigger = pullRequestTrigger(lines);
	if (trigger.unreadable !== undefined) unhandled.push(trigger.unreadable);
	if (trigger.triggers) {
		const listing = jobBlocks(lines);
		// A job this reader cannot place a condition in is not a job that needs none: it runs its
		// whole matrix on every agent pull request just like the analysable jobs below, and the
		// report is the only thing that keeps `scoped` false until a human scopes it by hand.
		unhandled.push(...listing.opaque);
		for (const job of listing.blocks) {
			const own = jobCondition(lines, job);
			if (unhandled.some(entry => entry.why === "folded or block scalar condition" && entry.line > job.start && entry.line <= job.end)) continue;
			if (own !== null) {
				if (MENTIONS_HEAD_REF_PREFIX.test(own.value)) {
					if (excludesOmpHead(own.value)) {
						if (!already.includes(own.key + 1)) already.push(own.key + 1);
						continue;
					}
					// A one-line job condition is also a line the pass above read, which reported it
					// already; the `already` dedupe above is the same case.
					if (!unhandled.some(entry => entry.line === own.key + 1)) unhandled.push({ line: own.key + 1, why: PARTIAL_EXCLUSION });
					continue;
				}
				// A PR-only job condition is a one-line extension the pass above owns.
				if (hasPullRequestCondition(own.value)) continue;
			}
			const steps = [...lines.slice(job.start, own?.key ?? job.end), ...lines.slice(own?.end ?? job.end, job.end)];
			// A step that really excludes `omp/**`, or that carries a PR-only condition, is the
			// author's own differentiation and the pass above scoped it. A step that merely names
			// the exclusion without covering every path is not, so this job still needs a guard.
			if (hasStepPullRequestCondition(steps) || steps.some(line => excludesOmpHead(IF_LINE.exec(line)?.[3] ?? ""))) continue;
			if (own === null) {
				edits.push({ start: job.key + 1, end: job.key + 1, lines: [`${" ".repeat(job.childIndent)}if: ${OMP_JOB_CONDITION}`] });
				continue;
			}
			const scoped = scopeJobCondition(own);
			if (Array.isArray(scoped)) edits.push({ start: own.key, end: own.end, lines: scoped });
			else if (!unhandled.some(entry => entry.line === own.key + 1)) unhandled.push({ line: own.key + 1, why: scoped.why });
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
			`CI: ${report.pending.join(", ")} still run their whole pull-request matrix on omp/** head branches. Nothing was written: ${report.root} is the canonical checkout, whose working tree is never mutated. Create your integration worktree, then call orc_bind again with worktree: "<that path>" and commit the edit as the run's first change`,
		);
	}
	if (report.unhandled.length > 0) parts.push(`CI: scope these by hand, they were left untouched: ${report.unhandled.join("; ")}`);
	if (parts.length > 0) return parts.join("\n");
	return report.already.length === 0 ? "CI: no pull-request-only conditions to scope" : `CI: already scoped away from omp/** (${report.already.length} condition(s))`;
}
