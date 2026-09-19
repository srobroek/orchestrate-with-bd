export type ReviewProviderId = "codex" | "coderabbit" | "copilot" | "gemini" | "qodo" | "greptile";
export type ReviewMode = "review" | "incremental" | "full";

export interface ReviewProvider {
 id: ReviewProviderId;
 aliases: readonly string[];
 logins: readonly string[];
 checks: readonly string[];
 request:
  | { kind: "comment"; commands: Partial<Record<ReviewMode, string>>; defaultMode: ReviewMode }
  | { kind: "reviewer"; login: string; defaultMode: "review" }
  | { kind: "unsupported"; reason: string };
}

export interface ProviderEvidence {
 checks: unknown;
 reviews: readonly { login: string }[];
 comments: readonly { login: string }[];
 notices: readonly { login: string; body?: string; at?: string; url?: string }[];
 requestActor?: string | null;
}

export interface ProviderAvailability {
 provider: ReviewProviderId;
 status: "observed" | "unknown";
 evidence?: string;
}

export interface ReviewRequestObservation {
 provider: ReviewProviderId;
 mode: ReviewMode;
 head: string;
 requestedAt?: string;
 url?: string;
}

export const REVIEW_PROVIDERS: readonly ReviewProvider[] = [
 {
  id: "codex",
  aliases: ["codex", "chatgpt-codex-connector"],
  logins: ["chatgpt-codex-connector"],
  checks: ["codex", "chatgptcodexconnector"],
  request: { kind: "comment", commands: { review: "@codex review" }, defaultMode: "review" },
 },
 {
  id: "coderabbit",
  aliases: ["coderabbit", "coderabbitai"],
  logins: ["coderabbitai"],
  checks: ["coderabbit", "coderabbitai"],
  request: {
   kind: "comment",
   commands: { incremental: "@coderabbitai review", full: "@coderabbitai full review" },
   defaultMode: "incremental",
  },
 },
 {
  id: "copilot",
  aliases: ["copilot", "copilot-pull-request-reviewer"],
  logins: ["copilot-pull-request-reviewer"],
  checks: ["copilotpullrequestreviewer", "copilotcodereview"],
  request: { kind: "reviewer", login: "copilot-pull-request-reviewer[bot]", defaultMode: "review" },
 },
 {
  id: "gemini",
  aliases: ["gemini", "gemini-code-assist"],
  logins: ["gemini-code-assist"],
  checks: ["geminicodeassist", "gemini"],
  request: { kind: "comment", commands: { review: "/gemini review" }, defaultMode: "review" },
 },
 {
  id: "qodo",
  aliases: ["qodo", "qodo-merge", "qodo-merge-pro"],
  logins: ["qodo-merge", "qodo-merge-pro"],
  checks: ["qodomerge", "qodo"],
  request: { kind: "unsupported", reason: "Qodo's current Code Review documentation does not publish a stable manual trigger; observe it only." },
 },
 {
  id: "greptile",
  aliases: ["greptile", "greptile-apps"],
  logins: ["greptile-apps"],
  checks: ["greptile", "greptileapps"],
  request: { kind: "comment", commands: { review: "@greptileai" }, defaultMode: "review" },
 },
] as const;

function normalize(value: string): string {
 return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function login(value: string): string {
 return value.toLowerCase().replace(/\[bot\]$/, "");
}

export function reviewProvider(value: string): ReviewProvider | undefined {
 const wanted = normalize(value);
 return REVIEW_PROVIDERS.find(provider =>
  provider.id === wanted || provider.aliases.some(alias => normalize(alias) === wanted),
 );
}

function observedLogin(provider: ReviewProvider, value: string): boolean {
 const actual = login(value);
 return provider.logins.some(candidate => login(candidate) === actual);
}

function checkText(value: unknown): string {
 if (typeof value !== "object" || value === null || Array.isArray(value)) return "";
 const row = value as Record<string, unknown>;
 return `${typeof row.name === "string" ? row.name : ""} ${typeof row.detailsUrl === "string" ? row.detailsUrl : ""}`;
}

export function detectProviderAvailability(evidence: ProviderEvidence): ProviderAvailability[] {
 const checks = Array.isArray(evidence.checks) ? evidence.checks : [];
 return REVIEW_PROVIDERS.map(provider => {
  const review = evidence.reviews.find(row => observedLogin(provider, row.login));
  if (review) return { provider: provider.id, status: "observed", evidence: "review" };
  const comment = evidence.comments.find(row => observedLogin(provider, row.login));
  if (comment) return { provider: provider.id, status: "observed", evidence: "review_comment" };
  const notice = evidence.notices.find(row => observedLogin(provider, row.login));
  if (notice) return { provider: provider.id, status: "observed", evidence: "issue_comment" };
  const check = checks.find(row => {
   const text = normalize(checkText(row));
   return provider.checks.some(candidate => text.includes(normalize(candidate)));
  });
  if (check) return { provider: provider.id, status: "observed", evidence: "check" };
  return { provider: provider.id, status: "unknown" };
 });
}

const REQUEST_MARKER = /<!--\s*omp-orchestrate:review-request\s+provider=([a-z-]+)\s+mode=([a-z-]+)\s+head=([0-9a-f]{40,64})\s*-->/gi;

export function detectReviewRequests(evidence: ProviderEvidence): ReviewRequestObservation[] {
 const requests = new Map<string, ReviewRequestObservation>();
 const trustedActor = (evidence.requestActor ?? "").toLowerCase();
 if (trustedActor === "") return [];
 for (const notice of evidence.notices) {
  if (notice.login.toLowerCase() !== trustedActor) continue;
  for (const match of (notice.body ?? "").matchAll(REQUEST_MARKER)) {
   const provider = reviewProvider(match[1] ?? "");
   const mode = match[2] as ReviewMode | undefined;
   const head = match[3];
   if (!provider || !mode || !head || !["review", "incremental", "full"].includes(mode)) continue;
   const request = {
    provider: provider.id,
    mode,
    head: head.toLowerCase(),
    requestedAt: notice.at,
    url: notice.url,
   };
   requests.set(`${request.provider}:${request.mode}:${request.head}`, request);
  }
 }
 return [...requests.values()];
}
