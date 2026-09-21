import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { zod } from "@oh-my-pi/pi-coding-agent";
import { describe, expect, setSystemTime, test } from "bun:test";
import type { Exec, ExecResult } from "../src/tools/bot-review-probe";
import {
 registerBotReviewRequest,
 requestBotReview,
 type ReviewRequestDetails,
 reviewRequestMarker,
} from "../src/tools/bot-review-request";
import { detectProviderAvailability, detectReviewRequests, reviewProvider } from "../src/tools/bot-review-providers";

const REPO = "acme/widgets";
const PR = "42";
const HEAD = "a".repeat(40);
const HEAD64 = "c".repeat(64);
const OTHER_HEAD = "b".repeat(40);
const VIEW = `gh pr view ${PR} --repo ${REPO} --json headRefOid`;
const ACTOR = "gh api user";
const COMMENTS = `gh api --paginate --slurp repos/${REPO}/issues/${PR}/comments?per_page=100`;
const REVIEWERS = `gh api repos/${REPO}/pulls/${PR}/requested_reviewers`;
const REVIEWS = `gh api --paginate --slurp repos/${REPO}/pulls/${PR}/reviews?per_page=100`;

function ok(value: unknown): ExecResult {
 return { code: 0, stdout: JSON.stringify(value), stderr: "" };
}

function transcript(answers: Record<string, ExecResult | null>): { exec: Exec; calls: string[] } {
 const calls: string[] = [];
 return {
  calls,
  exec: async (argv) => {
   const key = argv.join(" ");
   calls.push(key);
   return answers[key] ?? null;
  },
 };
}

describe("provider registry", () => {
 test("resolves provider aliases without guessing unsupported names", () => {
  expect(reviewProvider("chatgpt-codex-connector")?.id).toBe("codex");
  expect(reviewProvider("coderabbitai")?.id).toBe("coderabbit");
  expect(reviewProvider("unknown")).toBeUndefined();
 });

 test("reports only evidence-backed availability", () => {
  const providers = detectProviderAvailability({
   checks: [{ name: "CodeRabbit", detailsUrl: "" }],
   reviews: [{ login: "chatgpt-codex-connector[bot]" }],
   comments: [],
   notices: [],
  });
  expect(providers.find(row => row.provider === "codex")).toEqual({ provider: "codex", status: "observed", evidence: "review" });
  expect(providers.find(row => row.provider === "coderabbit")).toEqual({ provider: "coderabbit", status: "observed", evidence: "check" });
  expect(providers.find(row => row.provider === "gemini")).toEqual({ provider: "gemini", status: "unknown" });
 });
});

describe("comment review requests", () => {
 test("posts an allowlisted Codex command with a per-head dedupe marker", async () => {
  const marker = reviewRequestMarker("codex", "review", HEAD);
  const post = `gh api repos/${REPO}/issues/${PR}/comments --method POST -f body=@codex review\n\n${marker}`;
  const { exec, calls } = transcript({
   [VIEW]: ok({ headRefOid: HEAD }),
   [ACTOR]: ok({ login: "orchestrator" }),
   [COMMENTS]: ok([[]]),
   [post]: ok({ html_url: "https://github.com/acme/widgets/pull/42#issuecomment-1" }),
  });
  const result = await requestBotReview(REPO, PR, "codex", HEAD, undefined, { exec });
  expect(result).toMatchObject({ state: "requested", provider: "codex", mode: "review", head: HEAD });
  expect(calls).toEqual([VIEW, ACTOR, COMMENTS, post]);
 });

 test("does not trust a marker posted by another GitHub actor", async () => {
  const marker = reviewRequestMarker("codex", "review", HEAD);
  const post = `gh api repos/${REPO}/issues/${PR}/comments --method POST -f body=@codex review\n\n${marker}`;
  const { exec, calls } = transcript({
   [VIEW]: ok({ headRefOid: HEAD }),
   [ACTOR]: ok({ login: "orchestrator" }),
   [COMMENTS]: ok([[{ user: { login: "outsider" }, body: marker }]]),
   [post]: ok({ html_url: "https://github.com/acme/widgets/pull/42#issuecomment-1", created_at: "2026-09-10T12:00:00Z" }),
  });
  const result = await requestBotReview(REPO, PR, "codex", HEAD, undefined, { exec });
  expect(result).toMatchObject({ state: "requested", provider: "codex", mode: "review", head: HEAD, requestedAt: "2026-09-10T12:00:00Z" });
  expect(calls).toContain(post);
 });

 test("deduplicates the same provider, mode and head from the authenticated actor", async () => {
  const marker = reviewRequestMarker("coderabbit", "full", HEAD);
  const { exec, calls } = transcript({
   [VIEW]: ok({ headRefOid: HEAD }),
   [ACTOR]: ok({ login: "orchestrator" }),
   [COMMENTS]: ok([[{ user: { login: "Orchestrator" }, body: `@coderabbitai full review\n${marker}`, html_url: "prior", created_at: "2026-09-10T11:55:00Z" }]]),
  });
  const result = await requestBotReview(REPO, PR, "coderabbit", HEAD, "full", { exec });
  expect(result).toMatchObject({ state: "already_requested", evidence: "prior", requestedAt: "2026-09-10T11:55:00Z" });
  expect(calls).toEqual([VIEW, ACTOR, COMMENTS]);
 });

 test("refuses a changed head before reading or posting comments", async () => {
  const { exec, calls } = transcript({ [VIEW]: ok({ headRefOid: OTHER_HEAD }) });
  const result = await requestBotReview(REPO, PR, "gemini", HEAD, undefined, { exec });
  expect(result).toMatchObject({ state: "head_mismatch", head: OTHER_HEAD });
  expect(calls).toEqual([VIEW]);
 });

 test("refuses an unsupported mode before reading GitHub", async () => {
  const { exec, calls } = transcript({});
  const invalidMode = await requestBotReview(REPO, PR, "codex", HEAD, "full", { exec });
  expect(invalidMode.state).toBe("unsupported");
  expect(calls).toEqual([]);
 });

 test("keeps Qodo observe-only without reading GitHub", async () => {
  const { exec, calls } = transcript({});
  const qodo = await requestBotReview(REPO, PR, "qodo", HEAD, undefined, { exec });
  expect(qodo).toMatchObject({ state: "unsupported", provider: "qodo" });
  expect(calls).toEqual([]);
 });

 test.each([
  ["gemini", "/gemini review"],
  ["greptile", "@greptileai"],
 ] as const)("posts the verified %s command", async (provider, command) => {
  const marker = reviewRequestMarker(provider, "review", HEAD);
  const post = `gh api repos/${REPO}/issues/${PR}/comments --method POST -f body=${command}\n\n${marker}`;
  const { exec, calls } = transcript({
   [VIEW]: ok({ headRefOid: HEAD }),
   [ACTOR]: ok({ login: "orchestrator" }),
   [COMMENTS]: ok([[]]),
   [post]: ok({ html_url: "u" }),
  });
  expect((await requestBotReview(REPO, PR, provider, HEAD, undefined, { exec })).state).toBe("requested");
  expect(calls).toContain(post);
 });
 test("does not report a silent comment POST as requested", async () => {
  const marker = reviewRequestMarker("gemini", "review", HEAD);
  const post = `gh api repos/${REPO}/issues/${PR}/comments --method POST -f body=/gemini review\n\n${marker}`;
  const { exec, calls } = transcript({
   [VIEW]: ok({ headRefOid: HEAD }),
   [ACTOR]: ok({ login: "orchestrator" }),
   [COMMENTS]: ok([[]]),
   [post]: { code: 0, stdout: "", stderr: "" },
  });
  const result = await requestBotReview(REPO, PR, "gemini", HEAD, undefined, { exec });
  expect(result).toMatchObject({ state: "unknown", provider: "gemini", mode: "review", head: HEAD });
  expect(result.evidence).toBeUndefined();
  expect(result.error).toContain("empty output");
  expect(calls).toEqual([VIEW, ACTOR, COMMENTS, post]);
 });

 test("accepts a 64-character SHA-256 PR head", async () => {
  const marker = reviewRequestMarker("codex", "review", HEAD64);
  const post = `gh api repos/${REPO}/issues/${PR}/comments --method POST -f body=@codex review\n\n${marker}`;
  const { exec, calls } = transcript({
   [VIEW]: ok({ headRefOid: HEAD64 }),
   [ACTOR]: ok({ login: "orchestrator" }),
   [COMMENTS]: ok([[]]),
   [post]: ok({ html_url: "u" }),
  });
  expect((await requestBotReview(REPO, PR, "codex", HEAD64, undefined, { exec })).state).toBe("requested");
  expect(calls).toContain(post);
 });
});
describe("Copilot review requests", () => {
 test("requests Copilot and records exact-head marker evidence", async () => {
  const post = `gh api repos/${REPO}/pulls/${PR}/requested_reviewers --method POST -f reviewers[]=copilot-pull-request-reviewer[bot]`;
  const marker = reviewRequestMarker("copilot", "review", HEAD);
  const markerPost = `gh api repos/${REPO}/issues/${PR}/comments --method POST -f body=Requested Copilot code review for ${HEAD.slice(0, 12)}.\n\n${marker}`;
  const { exec, calls } = transcript({
   [VIEW]: ok({ headRefOid: HEAD }),
   [REVIEWERS]: ok({ users: [] }),
   [REVIEWS]: ok([[]]),
   [post]: ok({ users: [{ login: "copilot-pull-request-reviewer[bot]" }] }),
   [ACTOR]: ok({ login: "orchestrator" }),
   [COMMENTS]: ok([[]]),
   [markerPost]: ok({ html_url: "marker-url", created_at: "2026-09-10T12:05:00Z" }),
  });
  const result = await requestBotReview(REPO, PR, "copilot", HEAD, undefined, { exec });
  expect(result).toMatchObject({ state: "requested", provider: "copilot", evidence: "marker-url", requestedAt: "2026-09-10T12:05:00Z" });
  expect(calls).toEqual([VIEW, REVIEWERS, REVIEWS, post, ACTOR, COMMENTS, markerPost]);
  expect(detectReviewRequests({
   checks: [],
   reviews: [],
   comments: [],
   notices: [{ login: "orchestrator", body: marker, at: "2026-09-10T12:05:00Z", url: "marker-url" }],
   requestActor: "orchestrator",
  })).toEqual([{ provider: "copilot", mode: "review", head: HEAD, requestedAt: "2026-09-10T12:05:00Z", url: "marker-url" }]);
 });

 test("does not request Copilot again while its review request is pending", async () => {
  const marker = reviewRequestMarker("copilot", "review", HEAD);
  const { exec, calls } = transcript({
   [VIEW]: ok({ headRefOid: HEAD }),
   [REVIEWERS]: ok({ users: [{ login: "copilot-pull-request-reviewer[bot]" }] }),
   [ACTOR]: ok({ login: "orchestrator" }),
   [COMMENTS]: ok([[{ user: { login: "orchestrator" }, body: marker, html_url: "prior", created_at: "2026-09-10T12:00:00Z" }]]),
  });
  const result = await requestBotReview(REPO, PR, "copilot", HEAD, undefined, { exec });
  expect(result).toMatchObject({ state: "already_requested", evidence: "prior", requestedAt: "2026-09-10T12:00:00Z" });
  expect(calls).toEqual([VIEW, REVIEWERS, ACTOR, COMMENTS]);
 });

 test("records a marker when Copilot already reviewed the exact head", async () => {
  const marker = reviewRequestMarker("copilot", "review", HEAD);
  const markerPost = `gh api repos/${REPO}/issues/${PR}/comments --method POST -f body=Requested Copilot code review for ${HEAD.slice(0, 12)}.\n\n${marker}`;
  const { exec, calls } = transcript({
   [VIEW]: ok({ headRefOid: HEAD }),
   [REVIEWERS]: ok({ users: [] }),
   [REVIEWS]: ok([[{ user: { login: "copilot-pull-request-reviewer[bot]" }, commit_id: HEAD }]]),
   [ACTOR]: ok({ login: "orchestrator" }),
   [COMMENTS]: ok([[]]),
   [markerPost]: ok({ html_url: "marker-url", created_at: "2026-09-10T12:05:00Z" }),
  });
  expect((await requestBotReview(REPO, PR, "copilot", HEAD, undefined, { exec })).state).toBe("already_requested");
  expect(calls).toEqual([VIEW, REVIEWERS, REVIEWS, ACTOR, COMMENTS, markerPost]);
 });

 test("treats a rejected reviewer identity as unavailable", async () => {
  const post = `gh api repos/${REPO}/pulls/${PR}/requested_reviewers --method POST -f reviewers[]=copilot-pull-request-reviewer[bot]`;
  const { exec } = transcript({
   [VIEW]: ok({ headRefOid: HEAD }),
   [REVIEWERS]: ok({ users: [] }),
   [REVIEWS]: ok([[]]),
   [post]: { code: 1, stdout: "", stderr: "HTTP 422: Reviews may only be requested from collaborators" },
  });
  expect((await requestBotReview(REPO, PR, "copilot", HEAD, undefined, { exec })).state).toBe("unavailable");
 });
 test("does not report a silent reviewer POST as requested", async () => {
  const post = `gh api repos/${REPO}/pulls/${PR}/requested_reviewers --method POST -f reviewers[]=copilot-pull-request-reviewer[bot]`;
  const marker = reviewRequestMarker("copilot", "review", HEAD);
  const markerPost = `gh api repos/${REPO}/issues/${PR}/comments --method POST -f body=Requested Copilot code review for ${HEAD.slice(0, 12)}.\n\n${marker}`;
  const { exec, calls } = transcript({
   [VIEW]: ok({ headRefOid: HEAD }),
   [REVIEWERS]: ok({ users: [] }),
   [REVIEWS]: ok([[]]),
   [post]: { code: 0, stdout: "", stderr: "" },
   [ACTOR]: ok({ login: "orchestrator" }),
   [COMMENTS]: ok([[]]),
   [markerPost]: ok({ html_url: "marker-url" }),
  });
  const result = await requestBotReview(REPO, PR, "copilot", HEAD, undefined, { exec });
  expect(result).toMatchObject({ state: "unknown", provider: "copilot", mode: "review", head: HEAD });
  expect(result.evidence).toBeUndefined();
  expect(result.error).toContain("empty output");
  expect(calls).toEqual([VIEW, REVIEWERS, REVIEWS, post]);
 });

 test("seven gh calls that each nearly exhaust their bound still complete the request", async () => {
  // Every call answers just inside the per-call bound, so only the operation deadline can
  // refuse one. With the deadline sized for six reads the reviewer POST was sent and the
  // marker POST refused, and the tool reported `unknown` for a request it had made. The
  // clock is moved instead of waited on, and the exec honours the deadline exactly as
  // `spawnExec` does: a call whose remaining budget is under its duration never answers.
  const post = `gh api repos/${REPO}/pulls/${PR}/requested_reviewers --method POST -f reviewers[]=copilot-pull-request-reviewer[bot]`;
  const marker = reviewRequestMarker("copilot", "review", HEAD);
  const markerPost = `gh api repos/${REPO}/issues/${PR}/comments --method POST -f body=Requested Copilot code review for ${HEAD.slice(0, 12)}.\n\n${marker}`;
  const answers: Record<string, ExecResult> = {
   [VIEW]: ok({ headRefOid: HEAD }),
   [REVIEWERS]: ok({ users: [] }),
   [REVIEWS]: ok([[]]),
   [post]: ok({ users: [{ login: "copilot-pull-request-reviewer[bot]" }] }),
   [ACTOR]: ok({ login: "orchestrator" }),
   [COMMENTS]: ok([[]]),
   [markerPost]: ok({ html_url: "marker-url", created_at: "2026-09-10T12:05:00Z" }),
  };
  const TIMEOUT_MS = 100;
  const CALL_MS = 95;
  const calls: string[] = [];
  const exec: Exec = async (argv, opts) => {
   calls.push(argv.join(" "));
   const budget = Math.min(opts.timeoutMs ?? Infinity, (opts.deadline ?? Infinity) - Date.now());
   if (budget < CALL_MS) return null;
   setSystemTime(new Date(Date.now() + CALL_MS));
   return answers[argv.join(" ")] ?? null;
  };
  setSystemTime(new Date("2026-09-10T12:00:00Z"));
  try {
   const result = await requestBotReview(REPO, PR, "copilot", HEAD, undefined, { exec, timeoutMs: TIMEOUT_MS });
   expect(calls).toEqual([VIEW, REVIEWERS, REVIEWS, post, ACTOR, COMMENTS, markerPost]);
   expect(result).toMatchObject({ state: "requested", evidence: "marker-url" });
  } finally {
   setSystemTime();
  }
 });
});

interface RegisteredTool {
 name: string;
 approval?: string;
 execute: (
  id: string,
  params: { pr: string; repo?: string; provider: string; mode?: string; expected_head: string; cwd?: string },
  signal: AbortSignal | undefined,
  onUpdate: undefined,
  ctx: ExtensionContext,
 ) => Promise<AgentToolResult<ReviewRequestDetails>>;
}

function registered(exec: Exec): RegisteredTool {
 const tools: unknown[] = [];
 const pi = { zod, registerTool: (tool: unknown) => tools.push(tool) } as unknown as ExtensionAPI;
 registerBotReviewRequest(pi, exec);
 expect(tools).toHaveLength(1);
 return tools[0] as RegisteredTool;
}

const CTX = { cwd: "/tmp" } as unknown as ExtensionContext;

describe("registerBotReviewRequest", () => {
 test("registers a separate exec-approved mutation tool", () => {
  const tool = registered(transcript({}).exec);
  expect(tool.name).toBe("orc_bot_review_request");
  expect(tool.approval).toBe("exec");
 });

 test("returns head mismatches as errors without mutating GitHub", async () => {
  const { exec, calls } = transcript({ [VIEW]: ok({ headRefOid: OTHER_HEAD }) });
  const result = await registered(exec).execute(
   "id",
   { pr: PR, repo: REPO, provider: "codex", expected_head: HEAD },
   undefined,
   undefined,
   CTX,
  );
  expect(result.isError).toBe(true);
  expect(result.details?.state).toBe("head_mismatch");
  expect(calls).toEqual([VIEW]);
 });
});
