import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
 type Exec,
 type ExecOptions,
 ghTimeoutMs,
 parsePrRef,
 spawnExec,
} from "./bot-review-probe";
import {
 type ReviewMode,
 type ReviewProvider,
 type ReviewProviderId,
 reviewProvider,
} from "./bot-review-providers";

export type ReviewRequestState =
 | "requested"
 | "already_requested"
 | "unsupported"
 | "unavailable"
 | "unknown"
 | "head_mismatch";

export interface ReviewRequestDetails {
 state: ReviewRequestState;
 provider?: ReviewProviderId;
 mode?: ReviewMode;
 head?: string;
 evidence?: string;
 error?: string;
 requestedAt?: string;
}

export interface ReviewRequestOptions {
 exec?: Exec;
 cwd?: string;
 timeoutMs?: number;
 signal?: AbortSignal;
}

type JsonRead = { ok: true; value: unknown } | { ok: false; error: string; stderr?: string };

function isObject(value: unknown): value is Record<string, unknown> {
 return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function ghJson(argv: string[], exec: Exec, opts: ExecOptions): Promise<JsonRead> {
 if (opts.signal?.aborted) return { ok: false, error: "review request aborted" };
 const result = await exec(argv, opts);
 if (opts.signal?.aborted) return { ok: false, error: "review request aborted" };
 if (result === null) return { ok: false, error: "gh did not answer", stderr: "" };
 if (result.code !== 0) {
  const stderr = result.stderr.trim();
  return { ok: false, error: stderr === "" ? "gh request failed" : stderr, stderr };
 }
 // Keep mutation requests fail-closed like the evidence reader: silence is not proof
 // that GitHub accepted a POST, so it must not be reported as requested.
 if (result.stdout.trim() === "") return { ok: false, error: "gh exited 0 with empty output; refusing to read silence as an answer" };
 try {
  return { ok: true, value: JSON.parse(result.stdout) };
 } catch (error) {
  return { ok: false, error: `gh returned unreadable JSON: ${String(error)}` };
 }
}

export function reviewRequestMarker(provider: ReviewProviderId, mode: ReviewMode, head: string): string {
 return `<!-- omp-orchestrate:review-request provider=${provider} mode=${mode} head=${head} -->`;
}

function result(
 state: ReviewRequestState,
 provider: ReviewProvider,
 mode: ReviewMode,
 head: string,
 evidence?: string,
 error?: string,
 requestedAt?: string,
): ReviewRequestDetails {
 return { state, provider: provider.id, mode, head, evidence, error, requestedAt };
}

function resolveMode(provider: ReviewProvider, requested?: ReviewMode): ReviewMode | undefined {
 if (provider.request.kind === "unsupported") return undefined;
 const mode = requested ?? provider.request.defaultMode;
 if (provider.request.kind === "reviewer") return mode === "review" ? mode : undefined;
 return provider.request.commands[mode] === undefined ? undefined : mode;
}

function flattenPages(value: unknown): Record<string, unknown>[] | null {
 if (!Array.isArray(value)) return null;
 const rows: Record<string, unknown>[] = [];
 for (const page of value) {
  if (!Array.isArray(page)) return null;
  for (const row of page) {
   if (!isObject(row)) return null;
   rows.push(row);
  }
 }
 return rows;
}

function loginOf(row: Record<string, unknown>): string {
 return isObject(row.user) && typeof row.user.login === "string" ? row.user.login : "";
}


type MarkerResult =
 | { ok: true; already: boolean; evidence: string; requestedAt?: string }
 | { ok: false; error: string };

async function ensureRequestMarker(
 provider: ReviewProvider,
 mode: ReviewMode,
 repo: string,
 pr: string,
 head: string,
 visibleBody: string,
 exec: Exec,
 opts: ExecOptions,
): Promise<MarkerResult> {
 const actorRead = await ghJson(["gh", "api", "user"], exec, opts);
 if (!actorRead.ok || !isObject(actorRead.value) || typeof actorRead.value.login !== "string") {
  return { ok: false, error: actorRead.ok ? "GitHub actor response is malformed" : actorRead.error };
 }
 const actor = actorRead.value.login.toLowerCase();
 const marker = reviewRequestMarker(provider.id, mode, head);
 const commentsRead = await ghJson(
  ["gh", "api", "--paginate", "--slurp", `repos/${repo}/issues/${pr}/comments?per_page=100`],
  exec,
  opts,
 );
 if (!commentsRead.ok) return { ok: false, error: commentsRead.error };
 const comments = flattenPages(commentsRead.value);
 if (comments === null) return { ok: false, error: "GitHub issue comments response is malformed" };
 const prior = comments.find(row => loginOf(row).toLowerCase() === actor && typeof row.body === "string" && row.body.includes(marker));
 if (prior) {
  return {
   ok: true,
   already: true,
   evidence: typeof prior.html_url === "string" ? prior.html_url : "matching request comment",
   requestedAt: typeof prior.created_at === "string" ? prior.created_at : undefined,
  };
 }
 const posted = await ghJson(
  ["gh", "api", `repos/${repo}/issues/${pr}/comments`, "--method", "POST", "-f", `body=${visibleBody}\n\n${marker}`],
  exec,
  opts,
 );
 if (!posted.ok) return { ok: false, error: posted.error };
 return {
  ok: true,
  already: false,
  evidence: isObject(posted.value) && typeof posted.value.html_url === "string" ? posted.value.html_url : "request comment posted",
  requestedAt: isObject(posted.value) && typeof posted.value.created_at === "string" ? posted.value.created_at : undefined,
 };
}

async function requestByComment(
 provider: ReviewProvider,
 mode: ReviewMode,
 repo: string,
 pr: string,
 head: string,
 exec: Exec,
 opts: ExecOptions,
): Promise<ReviewRequestDetails> {
 if (provider.request.kind !== "comment") return result("unknown", provider, mode, head, undefined, "invalid provider adapter");
 const command = provider.request.commands[mode];
 if (command === undefined) return result("unsupported", provider, mode, head, undefined, "provider does not support this review mode");
 const marker = await ensureRequestMarker(provider, mode, repo, pr, head, command, exec, opts);
 if (!marker.ok) return result("unknown", provider, mode, head, undefined, marker.error);
 return result(marker.already ? "already_requested" : "requested", provider, mode, head, marker.evidence, undefined, marker.requestedAt);
}


async function requestCopilot(
 provider: ReviewProvider,
 mode: ReviewMode,
 repo: string,
 pr: string,
 head: string,
 exec: Exec,
 opts: ExecOptions,
): Promise<ReviewRequestDetails> {
 if (provider.request.kind !== "reviewer") return result("unknown", provider, mode, head, undefined, "invalid provider adapter");
 const reviewer = provider.request.login.toLowerCase();
 const finalize = async (state: "requested" | "already_requested"): Promise<ReviewRequestDetails> => {
  const marker = await ensureRequestMarker(
   provider,
   mode,
   repo,
   pr,
   head,
   `Requested Copilot code review for ${head.slice(0, 12)}.`,
   exec,
   opts,
  );
  if (!marker.ok) return result("unknown", provider, mode, head, undefined, marker.error);
  return result(state, provider, mode, head, marker.evidence, undefined, marker.requestedAt);
 };

 const requestedRead = await ghJson(["gh", "api", `repos/${repo}/pulls/${pr}/requested_reviewers`], exec, opts);
 if (!requestedRead.ok) return result("unknown", provider, mode, head, undefined, requestedRead.error);
 if (!isObject(requestedRead.value) || !Array.isArray(requestedRead.value.users)) {
  return result("unknown", provider, mode, head, undefined, "GitHub requested-reviewers response is malformed");
 }
 const pending = requestedRead.value.users.some(row => isObject(row) && typeof row.login === "string" && row.login.toLowerCase() === reviewer);
 if (pending) return finalize("already_requested");

 const reviewsRead = await ghJson(
  ["gh", "api", "--paginate", "--slurp", `repos/${repo}/pulls/${pr}/reviews?per_page=100`],
  exec,
  opts,
 );
 if (!reviewsRead.ok) return result("unknown", provider, mode, head, undefined, reviewsRead.error);
 const reviews = flattenPages(reviewsRead.value);
 if (reviews === null) return result("unknown", provider, mode, head, undefined, "GitHub reviews response is malformed");
 const reviewed = reviews.some(row =>
  loginOf(row).toLowerCase() === reviewer && typeof row.commit_id === "string" && row.commit_id === head,
 );
 if (reviewed) return finalize("already_requested");

 const posted = await ghJson(
  ["gh", "api", `repos/${repo}/pulls/${pr}/requested_reviewers`, "--method", "POST", "-f", `reviewers[]=${provider.request.login}`],
  exec,
  opts,
 );
 if (!posted.ok) {
  const text = posted.error.toLowerCase();
  const unavailable = text.includes("422") || text.includes("could not be resolved") || text.includes("not a collaborator");
  const state = unavailable ? "unavailable" : "unknown";
  return result(state, provider, mode, head, undefined, posted.error);
 }
 return finalize("requested");
}

export async function requestBotReview(
 repo: string,
 pr: string,
 providerName: string,
 expectedHead: string,
 requestedMode?: ReviewMode,
 options: ReviewRequestOptions = {},
): Promise<ReviewRequestDetails> {
 const provider = reviewProvider(providerName);
 if (!provider) return { state: "unsupported", error: `unsupported review provider: ${providerName}` };
 if (!/^[0-9a-f]{40,64}$/i.test(expectedHead)) {
  return result("unknown", provider, requestedMode ?? "review", expectedHead, undefined, "expected_head must be a full 40- to 64-character Git object ID");
 }
 const mode = resolveMode(provider, requestedMode);
 if (provider.request.kind === "unsupported") {
  return result("unsupported", provider, requestedMode ?? "review", expectedHead, provider.request.reason);
 }
 if (!mode) return result("unsupported", provider, requestedMode ?? provider.request.defaultMode, expectedHead, undefined, "provider does not support this review mode");

 const exec = options.exec ?? spawnExec;
 const timeoutMs = options.timeoutMs ?? ghTimeoutMs();
 // The deadline bounds the whole request, and it must cover every `gh` call on the path
 // at the per-call bound: the comment path is view, user, comments, POST comment; the
 // reviewer path adds requested_reviewers, reviews and the reviewer POST before those.
 // One read short, seven slow-but-answering calls left the reviewer POST sent and the
 // marker POST refused, and the tool reported `unknown` for a request it had made.
 const reads = provider.request.kind === "reviewer" ? 7 : 4;
 const run: ExecOptions = {
  cwd: options.cwd,
  timeoutMs,
  signal: options.signal,
  deadline: Date.now() + reads * timeoutMs,
 };
 const view = await ghJson(["gh", "pr", "view", pr, "--repo", repo, "--json", "headRefOid"], exec, run);
 if (!view.ok) return result("unknown", provider, mode, expectedHead, undefined, view.error);
 const actualHead = isObject(view.value) && typeof view.value.headRefOid === "string" ? view.value.headRefOid : "";
 if (actualHead === "") return result("unknown", provider, mode, expectedHead, undefined, "PR response has no headRefOid");
 if (actualHead !== expectedHead) {
  return result("head_mismatch", provider, mode, actualHead, `expected ${expectedHead}; no request was sent`);
 }

 if (provider.request.kind === "comment") {
  return requestByComment(provider, mode, repo, pr, actualHead, exec, run);
 }
 return requestCopilot(provider, mode, repo, pr, actualHead, exec, run);
}

function toolResult(details: ReviewRequestDetails): AgentToolResult<ReviewRequestDetails> {
 const suffix = details.error ? ` — ${details.error}` : details.evidence ? ` — ${details.evidence}` : "";
 return {
  content: [{
   type: "text",
   text: `review request: ${details.state}${details.provider ? ` provider=${details.provider}` : ""}${details.mode ? ` mode=${details.mode}` : ""}${details.head ? ` head=${details.head}` : ""}${suffix}`,
  }],
  details,
  isError: details.state === "unknown" || details.state === "head_mismatch",
 };
}

export function registerBotReviewRequest(pi: ExtensionAPI, exec: Exec = spawnExec): void {
 const z = pi.zod;
 const requestParams = z.object({
  pr: z.string().describe("PR reference: a github.com pull URL, `owner/repo#123`, or a number with `repo`"),
  repo: z.string().optional().describe("`owner/repo`, required when `pr` is a bare number"),
  provider: z.enum(["codex", "coderabbit", "copilot", "gemini", "qodo", "greptile"]),
  mode: z.enum(["review", "incremental", "full"]).optional(),
  expected_head: z.string().describe("exact 40- to 64-character PR head object ID; a mismatch refuses the request"),
  cwd: z.string().optional().describe("working directory for gh"),
 });
 pi.registerTool({
  name: "orc_bot_review_request",
  label: "Request bot review",
  description:
   "Request one allowlisted review provider at an exact PR head. Codex, CodeRabbit, Gemini and Greptile use verified provider commands; Copilot uses GitHub requested reviewers. Qodo is observe-only because its current Code Review documentation has no manual trigger. Marker checks are replay-safe; the caller must serialize mutations through the PR-update owner.",
  parameters: requestParams,
  approval: "exec",
  async execute(_id, params, signal, _onUpdate, ctx: ExtensionContext): Promise<AgentToolResult<ReviewRequestDetails>> {
   try {
    const ref = parsePrRef(String(params.pr ?? ""), params.repo === undefined ? undefined : String(params.repo));
    if (!ref) return toolResult({ state: "unknown", error: "unreadable pr reference" });
    const details = await requestBotReview(
     ref.repo,
     ref.number,
     String(params.provider ?? ""),
     String(params.expected_head ?? ""),
     params.mode as ReviewMode | undefined,
     { exec, cwd: params.cwd ?? ctx.cwd, signal },
    );
    return toolResult(details);
   } catch (error) {
    return toolResult({ state: "unknown", error: `review request failed: ${String(error)}` });
   }
  },
 });
}
