/**
 * Model-role preflight. Every shipped agent names its model as an OMP role alias
 * (`@plan`, `@reviewer`, ...). A built-in role resolves through OMP's priority chain; a
 * custom role exists only when the user's `modelRoles` defines it, and an undefined one
 * resolves to nothing, so OMP quietly runs that agent on the caller's model. The plugin
 * refuses to orchestrate until every alias its agents name resolves to a callable model.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const AGENTS_DIR = join(import.meta.dir, "..", "agents");

const MODEL_LINE = /^model:\s*["']?(@[^"'\s:]+)/mu;

const ACTIVE_AGENTS: Readonly<Record<string, string>> = Object.freeze({
	"lead (epic)": "orc-lead",
	"implementer (basic tier)": "orc-implementer",
	"implementer (deep tier)": "orc-implementer-deep",
	"implementer (max tier)": "orc-implementer-max",
	planner: "orc-planner",
	merger: "orc-merger",
	reviewer: "orc-reviewer",
	researcher: "orc-researcher",
	shepherd: "orc-shepherd",
});

/** The shipped agent named by the active system prompt's `ORC-ROLE` marker. */
export function activeAgent(systemPrompt: readonly string[]): string | undefined {
	for (const section of systemPrompt) {
		const marker = /^ORC-ROLE:\s*(.+?)\s*$/mu.exec(section)?.[1];
		if (marker !== undefined) return ACTIVE_AGENTS[marker];
	}
	return undefined;
}

/** Role alias -> the shipped agents whose `model:` names it, from the agent frontmatter. */
export function requiredRoles(dir: string = AGENTS_DIR): Map<string, string[]> {
	const roles = new Map<string, string[]>();
	for (const file of readdirSync(dir).filter(name => name.endsWith(".md")).sort()) {
		const text = readFileSync(join(dir, file), "utf8");
		if (!text.startsWith("---")) continue;
		const end = text.indexOf("\n---", 3);
		const alias = MODEL_LINE.exec(end === -1 ? text : text.slice(0, end))?.[1];
		if (alias === undefined) continue;
		const agents = roles.get(alias) ?? [];
		agents.push(file.slice(0, -3));
		roles.set(alias, agents);
	}
	return roles;
}

const SHIPPED_ROLES = requiredRoles();

/** The subset of `roles` whose alias OMP cannot resolve to a model for this session. */
export function missingRoles(
	models: { resolve(spec: string): unknown },
	roles: Map<string, string[]> = SHIPPED_ROLES,
): Map<string, string[]> {
	const missing = new Map<string, string[]>();
	for (const [alias, agents] of roles) {
		if (models.resolve(alias) === undefined) missing.set(alias, agents);
	}
	return missing;
}

function describe(missing: Map<string, string[]>): string {
	return [...missing].map(([alias, agents]) => `${alias} (${agents.join(", ")})`).join("; ");
}

/** Header text for a session whose agents name an unresolvable alias. */
export function rolesStop(missing: Map<string, string[]>): string {
	const keys = [...missing.keys()].map(alias => `modelRoles.${alias.slice(1)}`).join(", ");
	return `STOP. These model role aliases do not resolve to a model on this machine, so the agents that name them would silently run on the wrong model: ${describe(missing)}. Reply to the human with exactly this and end the turn: set ${keys} to a provider/model this machine can call in the OMP config (~/.omp/agent/config.yml, or the chezmoi source that renders it), then start a new session. Do not dispatch an agent; task and the ledger tools are refused in this session.`;
}

function modelName(model: unknown): string | undefined {
	if (model === null || typeof model !== "object") return undefined;
	const record = model as Record<string, unknown>;
	return typeof record.provider === "string" && typeof record.id === "string" ? `${record.provider}/${record.id}` : undefined;
}

/** STOP text when a shipped active agent is unresolved or is running on a different model. */
export function activeRoleStop(
	models: { resolve(spec: string): unknown; current(): unknown },
	systemPrompt: readonly string[],
	roles: Map<string, string[]> = SHIPPED_ROLES,
): string | undefined {
	const agent = activeAgent(systemPrompt);
	if (agent === undefined) return undefined;
	const entry = [...roles].find(([, agents]) => agents.includes(agent));
	if (entry === undefined) {
		return `STOP. The active agent ${agent} has no shipped model-role declaration. Start a new session after repairing its frontmatter; task and the ledger tools are refused in this session.`;
	}
	const [alias] = entry;
	const resolved = models.resolve(alias);
	if (resolved === undefined) return rolesStop(new Map([[alias, [agent]]]));
	const current = models.current();
	const expected = modelName(resolved);
	const actual = modelName(current);
	if (current === resolved || (expected !== undefined && expected === actual)) return undefined;
	return `STOP. The active agent ${agent} declares ${alias}, which resolves to ${expected ?? "an unknown model"}, but this session is running ${actual ?? "an unknown model"}. Start a new session after repairing role routing; task and the ledger tools are refused in this session.`;
}