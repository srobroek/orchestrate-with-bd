/**
 * D18: agent PRs do not pay for a human PR's CI.
 *
 * Every branch an agent creates begins `omp/`, so one head-branch filter covers all of them.
 * A run's expensive PR-only jobs are excluded from those branches by extending the conditions
 * that already say "only on a pull request" with `&& !startsWith(github.head_ref, 'omp/')`.
 * `orc_bind` runs this at run start and adds the exclusion itself rather than refusing or
 * asking: an unscoped repository would otherwise burn a full CI matrix on every wave.
 *
 * The edit is textual and line-local by design. A YAML round-trip would reflow every workflow
 * in the repository, turning a one-line scoping change into an unreviewable diff, and the
 * expression being changed is a string either way. Only conditions this module can rewrite
 * without ambiguity are touched; anything else is reported for a human, never guessed at.
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

export interface CiScopeReport {
	/** Whether every PR-only condition in the repository now excludes `omp/**` head branches. */
	scoped: boolean;
	/** Workflow files this call rewrote, relative to the repository root. */
	changed: string[];
	/** `<file>:<line>` of PR-only conditions that were already scoped. */
	already: string[];
	/**
	 * `<file>:<line> <why>` for a PR-only condition this module refused to rewrite — a folded
	 * or block scalar, where appending to one line would change what the expression means.
	 * Reported, not guessed at, so the lead scopes it by hand.
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
		// Appending to the key line would produce `if: >- && …`, so the whole condition is left
		// alone and reported. The indicator can carry a chomping or indentation modifier.
		const block = /^(\s*)(?:-\s+)?if:[ \t]*[|>][+-]?\d*[+-]?[ \t]*$/u.exec(line);
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
		const wrapped = /^\$\{\{(?<body>[\s\S]*)\}\}$/u.exec(value.trim());
		if (wrapped !== null) {
			const body = (wrapped.groups?.body ?? "").trim();
			if (body.length === 0) continue;
			lines[index] = `${match[1] ?? ""}${match[2] ?? ""}if: \${{ ${body} && ${OMP_EXCLUSION} }}`;
		} else if (value.includes("${{")) {
			// A condition interleaving literal text with one or more `${{ }}` spans has no single
			// expression to extend.
			unhandled.push({ line: index + 1, why: "condition mixes literal text with an expression span" });
			continue;
		} else {
			lines[index] = `${match[1] ?? ""}${match[2] ?? ""}if: ${value.trimEnd()} && ${OMP_EXCLUSION}`;
		}
		changed.push(index + 1);
	}
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
