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

/** The subset of `roles` whose alias OMP cannot resolve to a model for this session. */
export function missingRoles(
	models: { resolve(spec: string): unknown },
	roles: Map<string, string[]> = requiredRoles(),
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