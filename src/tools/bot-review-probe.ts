/**
 * `orc_bot_review_probe` — classify a PR's review-bot round at one exact head SHA.
 *
 * Originally a Python script in the orchestrate skill; the fetch split keeps each read
 * injectable while moving repeated PR and check reads to GitHub's REST API.
 *
 * Review bots (CodeRabbit, Copilot review, Greptile, ...) post findings outside every
 * status check the merge decision already reads, and each signals actionability its own
 * way. That per-bot knowledge stays in one adapter table, so adding a bot is a table
 * entry rather than a parser change.
 *
 * The vocabulary is the landing contract's:
 *   0  absent      no configured bot on this PR; merge decision unchanged
 *   0  clean       the bot's latest round at this head reports nothing actionable
 *   10 pending     check still running, no review at this head yet, or the bot skipped
 *                  the round (draft PR, auto-review disabled) and must be asked
 *   11 stale       the bot reviewed an older head only
 *   12 actionable
 *   13 declined    the bot refused the round (quota/rate limit); re-trigger, do not wait
 *   2  unknown     malformed or unreadable evidence -- never treated as clean
 *
 * Nothing here throws. The script raised `ValueError`/`RuntimeError` and let `main` map
 * the raise onto exit 2; this port returns that code directly, so a caller cannot forget
 * the `try` that turns unreadable evidence into a refusal. An unanswered probe must never
 * read as a satisfied one.
 */

import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { detectProviderAvailability, detectReviewRequests, type ProviderAvailability, type ReviewRequestObservation } from "./bot-review-providers";

export const EXIT_UNKNOWN = 2;
export const EXIT_WAITING = 10;
export const EXIT_STALE = 11;
export const EXIT_ACTIONABLE = 12;
export const EXIT_DECLINED = 13;

export const DEFAULT_BOTS = "coderabbitai,chatgpt-codex-connector,copilot-pull-request-reviewer,greptile-apps";
/**
 * A bot slug is matched against check names and details URLs by alphanumeric containment
 * in either direction ("CodeRabbit" vs "coderabbitai"). The floor keeps a short slug from
 * matching unrelated checks.
 */
export const MIN_SLUG_MATCH = 4;

// A decline notice is matched LOOSELY ON PURPOSE, in two independent halves: an indicator
// that the bot refused, and -- separately -- any duration figure anywhere in the body. A
// downstream script once matched the bot's exact sentence ("next review available in: N
// minutes"); the bot reworded it to "your next included review will be available in N
// minutes", the match returned empty, the caller read that as "no limit notice" and
// reported the quota window as reopened while it was exhausted, burning four re-triggers.
// Tightening either half into one sentence pattern reintroduces that bug: word order,
// "included", "will be", bold markers, and minutes-vs-hours all vary.
//
// The looseness has a cost the callers below pay for: CodeRabbit's finding prose quotes
// the code under review, so a real round on a PR that touches rate-limit or quota code
// matches too. The indicator is therefore consulted only on bodies that carry no verdict
// of their own -- see {@link classifyBotReviews} and {@link declines}.
//
// None of these patterns carries `g`: a global regexp keeps `lastIndex` between calls, so
// the same body would match or not depending on what was tested before it.
const DECLINE_INDICATORS = /limit\s+(?:is\s+)?(?:currently\s+)?reached|fair\s+usage|rate[-\s]?limit|quota|usage\s+limit/i;
const WAIT_FIGURE = /(\d+)\s*\**\s*(minute|hour)s?/i;
// "Review skipped": the bot did not review because the PR is a draft or auto-review is
// off, and says so. Not a refusal -- a request (or marking the PR ready) is what unblocks
// it -- so it must never read as `declined`, whose contract is "re-trigger, do not wait".
const SKIP_INDICATOR = /review\s+skipped/i;
// CodeRabbit's auto-generated walkthrough is a PR summary posted as an issue comment. Its
// prose paraphrases the diff, so on a PR touching rate-limit code it matches the decline
// indicator while saying nothing about the round.
const WALKTHROUGH_MARKER = /<!--[^>]*summarize by coderabbit\.ai[^>]*-->/i;

/** True when this body is the bot saying it refused the round. */
export function indicatesDecline(body: string): boolean {
 return DECLINE_INDICATORS.test(body ?? "");
}

/** Per-bot knowledge: how this bot says "here is what you must fix". */
interface Adapter {
 slug: string;
 /** The actionable-finding count for a review body, or `null` when it carries no verdict this adapter recognises. */
 count: (body: string) => number | null;
 note: string;
 /**
  * True when this body is the bot refusing the round. Defaults to the cross-bot
  * indicator set; override only to ADD wording, never to narrow it to one sentence.
  */
 declined: (body: string) => boolean;
}

// CodeRabbit posts one summary review per round whose body carries "Actionable comments
// posted: N". Every fix suggestion hangs under that summary, so N is the actionability
// signal and a long nitpick-only body with N=0 merges.
const ADAPTERS: Record<string, Adapter> = {
 coderabbitai: {
  slug: "coderabbitai",
  count: (body) => {
   const digits = /actionable comments posted:\s*(?<n>\d+)/i.exec(body ?? "")?.groups?.n;
   if (digits === undefined) return null;
   const parsed = Number.parseInt(digits, 10);
   // CLAMP, for the reason `reopenInstant` clamps: the figure is the bot's own prose,
   // so it is data this tool does not control. `parseInt` on enough digits returns
   // Infinity, which rendered as `actionable=Infinity` and JSON-serialised to `null`
   // -- a field typed `number` reaching the caller as null. Returning `null` instead
   // would be worse than either: it reads as "no verdict at head yet" and waits
   // forever on a round that already answered. Any figure past a real round means
   // the same thing operationally, and every value here is only ever tested `> 0`.
   return Number.isSafeInteger(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
  },
  note: 'CodeRabbit summary line "Actionable comments posted: N"',
  declined: indicatesDecline,
 },
};

// A bot with no adapter still gets classified from its exact-head review and inline
// comments. CHANGES_REQUESTED is actionable everywhere; a COMMENTED review with inline
// comments is actionable, and one with none is clean. The head match prevents resolved
// comments from an older revision from keeping the new round open.
const GENERIC_NOTE = "no adapter: exact-head review state and inline comments";

function adapterFor(slug: string): Adapter {
 // `Object.hasOwn`, not a plain index: the slug is caller data (`--bots`,
 // `$PR_REVIEW_BOTS`), and a slug naming an `Object.prototype` member -- "constructor",
 // "toString" -- resolved through the prototype chain to a truthy non-Adapter, whose
 // missing `.declined`/`.count` threw a TypeError out of a function documented never to
 // throw.
 const exact = Object.hasOwn(ADAPTERS, slug) ? ADAPTERS[slug] : undefined;
 if (exact) return exact;
 for (const known of Object.keys(ADAPTERS)) {
  // PARITY: a variant slug ("coderabbit") reuses the table entry unchanged, so the
  // adapter keeps the canonical slug rather than the configured spelling.
  if (related(normalize(slug), normalize(known))) return ADAPTERS[known] as Adapter;
 }
 return { slug, count: () => null, note: GENERIC_NOTE, declined: indicatesDecline };
}

/** How this slug's actionability is read — the script's `bots` subcommand, one slug at a time. */
export function adapterNote(slug: string): string {
 return adapterFor(slug).note;
}

/** Python's truthiness for a decoded JSON value: `null`, `false`, `0`, `""`, `[]`, `{}`. */
function truthy(value: unknown): boolean {
 if (value === undefined || value === null || value === false || value === "") return false;
 if (typeof value === "number") return value !== 0;
 if (Array.isArray(value)) return value.length > 0;
 if (typeof value === "object") return Object.keys(value).length > 0;
 return true;
}

/**
 * `str(value or "")` on a decoded JSON value.
 *
 * PARITY: Python's `str()` spells booleans "True"/"False" and lists with repr quoting.
 * Only malformed evidence reaches those branches, and every consumer of this is a
 * containment or equality test that fails on either spelling.
 */
function str(value: unknown): string {
 if (!truthy(value)) return "";
 if (typeof value === "string") return value;
 return typeof value === "object" ? JSON.stringify(value) : String(value);
}

/** A JSON object, which is what Python's `isinstance(x, dict)` accepts — arrays excluded. */
function isObject(value: unknown): value is Record<string, unknown> {
 return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `(row.get(outer) or {}).get(inner) or ""`. */
function nested(row: Record<string, unknown>, outer: string, inner: string): string {
 const value = row[outer];
 return isObject(value) ? str(value[inner]) : "";
}

/** Python's `<` on two strings, for `sort(key=...)` and `max(...)` parity. */
function compare(left: string, right: string): number {
 if (left < right) return -1;
 return left > right ? 1 : 0;
}

function normalize(value: string): string {
 return (value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function related(left: string, right: string): boolean {
 if (left.length < MIN_SLUG_MATCH || right.length < MIN_SLUG_MATCH) return false;
 return left.includes(right) || right.includes(left);
}

/**
 * The bot slugs to probe for: the caller's list, else `$PR_REVIEW_BOTS`, else the default.
 *
 * PARITY: only an *absent* value falls back. An explicit empty string configures zero
 * bots, exactly as `--bots ''` did, and every PR then reads `absent`.
 */
export function configuredSlugs(raw?: string, env: Record<string, string | undefined> = process.env): string[] {
 const source = raw ?? env.PR_REVIEW_BOTS ?? DEFAULT_BOTS;
 const slugs: string[] = [];
 for (const part of source.split(",")) {
  const slug = part.trim();
  if (slug !== "") slugs.push(slug.toLowerCase());
 }
 return slugs;
}

function isBotCheck(check: Record<string, unknown>, slugs: string[]): boolean {
 const name = normalize(str(check.name));
 const url = normalize(str(check.detailsUrl));
 return slugs.some((slug) => related(name, normalize(slug)) || related(url, normalize(slug)));
}

/** The configured slug this review author is, or `null`. */
function loginSlug(login: string, slugs: string[]): string | null {
 const actual = (login ?? "").toLowerCase();
 for (const slug of slugs) {
  if (actual === slug || actual === `${slug}[bot]`) return slug;
 }
 return null;
}

// The Checks API reports `status: completed`; the older commit-status API reports
// `state: SUCCESS|FAILURE|PENDING|ERROR` and has no `status` at all. Only "completed"
// counted as finished, so a status-API bot reporting SUCCESS read as "still running" and
// the probe returned EXIT_WAITING forever -- a bot that had already answered kept the
// merge waiting indefinitely.
const STATUS_API_TERMINAL: Record<string, true> = { success: true, failure: true, error: true };

/**
 * The check's state, normalized to the Checks API vocabulary.
 *
 * A commit-status `state` is mapped onto `completed` when it is terminal, so the one
 * caller comparing against "completed" treats both APIs alike. `pending` stays itself,
 * because it means the same thing in both.
 */
function checkState(check: Record<string, unknown>): string {
 const status = str(check.status).toLowerCase();
 if (status !== "") return status;
 const state = str(check.state).toLowerCase();
 // `=== true`, for the same prototype-chain reason as `adapterFor`: a check whose state
 // is the literal "constructor" read as `completed`, grading a round the bot had not
 // answered yet.
 return STATUS_API_TERMINAL[state] === true ? "completed" : state;
}

/** Minutes until the bot says it will review again, from any wording. */
export function waitMinutes(body: string): number | null {
 const match = WAIT_FIGURE.exec(body ?? "");
 if (!match) return null;
 const value = Number.parseInt(match[1] as string, 10);
 return (match[2] as string).toLowerCase() === "hour" ? value * 60 : value;
}

// `datetime.fromisoformat`, hand-rolled. `new Date("2026-07-30T11:00:00")` reads a
// timestamp with no offset as LOCAL time, so the quota window would move with the
// machine's zone; Python read it as naive and stamped it UTC.
const ISO_INSTANT =
 /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?(?:(Z|z)|([+-])(\d{2}):?(\d{2}))?$/;

function parseInstant(at: string): Date | null {
 const match = ISO_INSTANT.exec(at ?? "");
 if (!match) return null;
 const year = Number(match[1]);
 const month = Number(match[2]);
 const day = Number(match[3]);
 const hour = Number(match[4]);
 const minute = Number(match[5]);
 const second = match[6] === undefined ? 0 : Number(match[6]);
 const fraction = match[7] === undefined ? 0 : Math.floor(Number(`0.${match[7]}`) * 1000);
 if (month < 1 || month > 12 || day < 1 || day > 31) return null;
 if (hour > 23 || minute > 59 || second > 59) return null;

 const stamp = Date.UTC(year, month - 1, day, hour, minute, second, fraction);
 const probe = new Date(stamp);
 // Date.UTC rolls February 30th into March; `fromisoformat` refused it, and a refusal
 // is the honest answer for a timestamp nothing can place.
 if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
  return null;
 }
 if (match[9] === undefined) return probe;

 const offsetHours = Number(match[10]);
 const offsetMinutes = Number(match[11]);
 if (offsetHours > 23 || offsetMinutes > 59) return null;
 const offset = (offsetHours * 60 + offsetMinutes) * 60_000;
 return new Date(match[9] === "-" ? stamp + offset : stamp - offset);
}

/** `datetime.isoformat()` for a UTC instant: a `+00:00` offset, microseconds only when non-zero. */
function isoUtc(at: Date): string {
 const pad = (value: number, width = 2): string => String(value).padStart(width, "0");
 const ms = at.getUTCMilliseconds();
 const fraction = ms === 0 ? "" : `.${pad(ms, 3)}000`;
 return (
  `${pad(at.getUTCFullYear(), 4)}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}` +
  `T${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}:${pad(at.getUTCSeconds())}${fraction}+00:00`
 );
}

/**
 * Absolute reopen time, or `null` when the notice has no usable timestamp.
 *
 * The bot's figure is relative to when it POSTED the notice, so it decays; a stored figure
 * alone cannot say whether the window is open.
 */
export function reopenInstant(at: string, minutes: number): Date | null {
 const posted = parseInstant(at);
 if (posted === null) return null;
 // CLAMP: the figure comes from the bot's own prose, so it is data this tool does not
 // control. Python's `timedelta` raised OverflowError past its range and `main` caught
 // only ValueError, so "retry in 999999999999999999999999 minutes" exited 1 with a
 // traceback instead of the documented exit 2. A week is far past any real backoff, and
 // anything beyond it means the same thing operationally.
 const bounded = Math.max(0, Math.min(minutes, 7 * 24 * 60));
 return new Date(posted.getTime() + bounded * 60_000);
}

/** The word the landing contract uses for this round. */
export type BotReviewState = "absent" | "clean" | "pending" | "stale" | "actionable" | "declined" | "unknown";

/** Everything the probe read, in the shape {@link renderBotReview} prints. */
export interface BotReviewFindings {
 head: string;
 /** The configured slugs, comma-joined. */
 bots: string;
 /** `name/state` per matched bot check, comma-joined, or `"none"`. */
 check: string;
 actionable: number;
 changesRequested: number;
 /** URL of the review round that decided this verdict, or `"none"`. */
 summary: string;
 /** When the bot says it will review again: an instant, `"UNKNOWN"`, `"<n>m"`, or `"none"`. */
 wait: string;
 detail: string;
 /** `path:line url` per bot comment at this head, sorted. */
 files: string[];
}

export interface BotReviewVerdict {
 code: number;
 verdict: BotReviewState;
 findings: BotReviewFindings;
}

export interface ClassifyOptions {
 /**
  * The exact head SHA a round must match. A blank one is refused as unread evidence:
  * it is the frame of reference every comparison below needs.
  */
 head: string;
 slugs: string[];
 /** Injected so decline-window arithmetic stays deterministic in tests. */
 now?: Date;
}

interface Decline {
 wait: string;
 detail: string;
}

/** `null` = no refusal notice; `"malformed"` = a notice that is not an object. */
type DeclineOutcome = Decline | null | "malformed";

/**
 * The bot's newest refusal notice, or `null`.
 *
 * Advisory only: the caller must consult this AFTER evidence of a real review, because a
 * refusal notice stays in the comment history forever and would otherwise mask the genuine
 * review that landed after it.
 */
function declines(notices: unknown[], slugs: string[], now: Date): DeclineOutcome {
 const found: [string, string][] = [];
 for (const notice of notices) {
  if (!isObject(notice)) return "malformed";
  const slug = loginSlug(str(notice.login), slugs);
  const body = str(notice.body);
  // The walkthrough summarises the diff; whatever it says about limits is the PR's code.
  if (slug === null || WALKTHROUGH_MARKER.test(body) || !adapterFor(slug).declined(body)) continue;
  found.push([str(notice.at), body]);
 }
 const newest = found[0];
 if (newest === undefined) return null;
 // PARITY: `max()` on `(at, body)` tuples breaks a timestamp tie on the body, and keeps
 // the first of two identical pairs.
 let best = newest;
 for (const candidate of found) {
  const byTime = compare(candidate[0], best[0]);
  if (byTime > 0 || (byTime === 0 && compare(candidate[1], best[1]) > 0)) best = candidate;
 }

 const [at, body] = best;
 const minutes = waitMinutes(body);
 if (minutes === null) {
  return { wait: "UNKNOWN", detail: "bot declined the round; re-check before re-trigger" };
 }
 const reopen = reopenInstant(at, minutes);
 if (reopen === null) {
  return {
   wait: `${minutes}m`,
   detail: `bot declined the round for ${minutes}m from an unreadable timestamp; re-check before re-trigger`,
  };
 }
 const stamp = isoUtc(reopen);
 if (reopen.getTime() <= now.getTime()) {
  return { wait: stamp, detail: `bot declined the round; window reopened at ${stamp}, re-trigger` };
 }
 return { wait: stamp, detail: `bot declined the round; retry after ${stamp}` };
}

/** `payload.get(key) or []`, or `null` when the value is truthy but not an array. */
function arrayField(value: unknown): unknown[] | null {
 if (!truthy(value)) return [];
 return Array.isArray(value) ? value : null;
}

function verdictOf(
 findings: BotReviewFindings,
 verdict: BotReviewState,
 code: number,
 detail: string,
): BotReviewVerdict {
 return { code, verdict, findings: { ...findings, detail } };
}

/**
 * Pure classification of one fetched payload against one head SHA.
 *
 * PARITY: the script raised `ValueError` on evidence it could not read and `main` printed
 * it and returned exit 2. Here that path returns exit 2 with `verdict: "unknown"` — the
 * same observable answer, minus the chance of an uncaught raise reading as a crash rather
 * than as unread evidence.
 */
export function classifyBotReviews(payload: unknown, opts: ClassifyOptions): BotReviewVerdict {
 const { slugs, head } = opts;
 const now = opts.now ?? new Date();
 const findings: BotReviewFindings = {
  head,
  bots: slugs.join(","),
  check: "none",
  actionable: 0,
  changesRequested: 0,
  summary: "none",
  wait: "none",
  detail: "",
  files: [],
 };
 const unknown = (detail: string): BotReviewVerdict => verdictOf(findings, "unknown", EXIT_UNKNOWN, detail);

 // A blank head is unread evidence, not a PR with nothing on it.
 // {@link fetchBotReviewEvidence} already refuses a head-less `gh pr view`, but the
 // comparison lives HERE, and with head="" a review carrying no `commit_id` compared
 // equal to it and returned `clean`, exit 0 -- an approval synthesised out of a round
 // that named no commit at all. Every other verdict at a blank head is equally
 // unfounded, so this refuses before reading the payload rather than per-branch.
 if ((head ?? "").trim() === "") return unknown("no head SHA to classify a round against");

 if (!isObject(payload)) return unknown("payload must be a JSON object");
 const checks = arrayField(payload.checks);
 const reviews = arrayField(payload.reviews);
 const comments = arrayField(payload.comments);
 const notices = arrayField(payload.notices);
 if (checks === null || reviews === null || comments === null || notices === null) {
  return unknown("checks, reviews, comments, and notices must be arrays");
 }

 if (slugs.length > 1) {
  const rounds = [...new Set(slugs)].map((slug) =>
   classifyBotReviews(payload, { ...opts, slugs: [slug], now }),
  );
  const priority: BotReviewState[] = ["unknown", "actionable", "declined", "stale", "pending", "clean", "absent"];
  const decisive = priority.map((state) => rounds.find((round) => round.verdict === state)).find(Boolean);
  if (!decisive) return unknown("no configured bot verdicts");
  return {
   code: decisive.code,
   verdict: decisive.verdict,
   findings: {
    ...decisive.findings,
    bots: findings.bots,
    check: [...new Set(rounds.map((round) => round.findings.check).filter((check) => check !== "none"))].join(",") || "none",
    actionable: rounds.reduce((total, round) => total + round.findings.actionable, 0),
    changesRequested: rounds.reduce((total, round) => total + round.findings.changesRequested, 0),
    files: [...new Set(rounds.flatMap((round) => round.findings.files))].sort(compare),
    detail: `${decisive.findings.bots}: ${decisive.findings.detail}`,
   },
  };
 }

 const botChecks: Record<string, unknown>[] = [];
 for (const check of checks) {
  if (isObject(check) && isBotCheck(check, slugs)) botChecks.push(check);
 }

 const botReviews: [string, Record<string, unknown>][] = [];
 const refusals: unknown[] = [...notices];
 for (const review of reviews) {
  if (!isObject(review)) return unknown("each review must be an object");
  const slug = loginSlug(str(review.login), slugs);
  if (slug === null) continue;
  // A refusal is not a review round. Left in `botReviews` it would read as
  // `pending`/`stale` -- "keep waiting" -- exactly the ambiguity that cost the
  // wasted re-triggers. But a body the adapter reads a count from, or one GitHub gave a
  // decisive state, IS the round: CodeRabbit's findings quote the code under review, so
  // an actionable round on a PR touching rate-limit code matches the indicator too, and
  // dropping it left an older round -- or nothing -- to decide the verdict.
  const adapter = adapterFor(slug);
  const body = str(review.body);
  if (adapter.count(body) === null && str(review.state) === "COMMENTED" && adapter.declined(body)) refusals.push(review);
  else botReviews.push([slug, review]);
 }
 const skipped = notices.some(
  (entry) => isObject(entry) && loginSlug(str(entry.login), slugs) !== null && SKIP_INDICATOR.test(str(entry.body)),
 );

 findings.check =
  botChecks.map((check) => `${str(check.name) || "?"}/${checkState(check) || "?"}`).join(",") || "none";

 const decline = declines(refusals, slugs, now);
 if (decline === "malformed") return unknown("each notice must be an object");

 // A skip notice is the bot on this PR, so the PR is not `absent` -- exit 0 would clear
 // the gate on a round nobody ran.
 if (botChecks.length === 0 && botReviews.length === 0 && decline === null && !skipped) {
  return verdictOf(findings, "absent", 0, "no configured review bot on this PR");
 }

 // A PR check rollup always describes the current head, so a running bot check needs no
 // head comparison of its own.
 if (botChecks.some((check) => checkState(check) !== "completed")) {
  return verdictOf(findings, "pending", EXIT_WAITING, "bot check still running");
 }

 const atHead = botReviews.filter(([, review]) => str(review.commit) === head);
 atHead.sort((left, right) => compare(str(left[1].at), str(right[1].at)));

 // A REAL REVIEW ALWAYS BEATS A NOTICE. The decline notice is only consulted where there
 // is no review to read at all: with a review at this head the count decides, and with a
 // review at an older head only the answer is `stale`. A refusal notice from an earlier
 // commit must never mask either.
 const newest = atHead[atHead.length - 1];
 if (newest === undefined) {
  if (botReviews.length === 0) {
   if (decline !== null) {
    return {
     code: EXIT_DECLINED,
     verdict: "declined",
     findings: { ...findings, wait: decline.wait, detail: decline.detail },
    };
   }
   if (skipped) return verdictOf(findings, "pending", EXIT_WAITING, "review skipped by bot policy; request or wait");
   return verdictOf(findings, "pending", EXIT_WAITING, "bot check complete, no review posted yet");
  }
  return verdictOf(findings, "stale", EXIT_STALE, "bot reviewed an older head only");
 }

 // A re-review at the same head supersedes the earlier one, so read the LATEST round.
 // Taking the maximum would let a resolved round block the PR forever, and reusing an
 // older clean count when the latest round has none would treat an unrecognised review
 // as approval.
 const latest = {
  actionable: adapterFor(newest[0]).count(str(newest[1].body)),
  changesRequested: str(newest[1].state) === "CHANGES_REQUESTED",
  url: str(newest[1].url),
 };
 const changes = latest.changesRequested ? 1 : 0;
 findings.changesRequested = changes;
 findings.summary = latest.url || "none";
 findings.files = [];
 // GitHub re-anchors a thread's `commit` to the newest commit it still applies to, so
 // "at head" already excludes outdated threads; `outdated` itself is carried for the
 // reader and decides nothing here.
 const resolvedAtHead: string[] = [];
 for (const entry of comments) {
  if (!isObject(entry) || loginSlug(str(entry.login), slugs) === null || str(entry.commit) !== head) continue;
  if (entry.resolved === true) {
   resolvedAtHead.push(str(entry.threadId) || "?");
   continue;
  }
  const line = truthy(entry.line) ? str(entry.line) : "0";
  findings.files.push(`thread=${str(entry.threadId) || "?"} ${str(entry.path) || "?"}:${line} ${str(entry.url)}`.trim());
 }
 findings.files.sort(compare);
 resolvedAtHead.sort(compare);

 if (latest.actionable === null) {
  if (changes) {
   return verdictOf(findings, "actionable", EXIT_ACTIONABLE, "changes requested without a summary count");
  }
  findings.actionable = findings.files.length;
  if (findings.actionable > 0) {
   return verdictOf(findings, "actionable", EXIT_ACTIONABLE, `${findings.actionable} inline comment(s)`);
  }
  const knownAdapter = Object.keys(ADAPTERS).some((known) => related(normalize(newest[0]), normalize(known)));
  if (knownAdapter) return verdictOf(findings, "pending", EXIT_WAITING, "no actionable-comment summary at head yet");
  return verdictOf(findings, "clean", 0, "completed review with no unresolved inline comments");
 }

 findings.actionable = latest.actionable;
 if (changes) {
  return verdictOf(findings, "actionable", EXIT_ACTIONABLE, `${latest.actionable} actionable comment(s)`);
 }
 if (latest.actionable > 0) {
  // The summary count is the bot's verdict when it posted. Threads are its findings'
  // live state: once every one at this head is resolved -- the rejection-only round,
  // where nothing is pushed and the count never changes -- the round is answered. With
  // threads still open the count is a floor under them, never a ceiling. A count with
  // no threads at all has no evidence to downgrade on and stands.
  if (findings.files.length === 0 && resolvedAtHead.length > 0) {
   findings.actionable = 0;
   return verdictOf(
    findings,
    "clean",
    0,
    `${latest.actionable} actionable comment(s), every thread at head resolved: ${resolvedAtHead.join(", ")}`,
   );
  }
  findings.actionable = Math.max(latest.actionable, findings.files.length);
  return verdictOf(findings, "actionable", EXIT_ACTIONABLE, `${findings.actionable} actionable comment(s)`);
 }
 // A zero count with open threads is CodeRabbit's nitpick-only round: those threads are
 // listed below the verdict, and the round merges.
 return verdictOf(findings, "clean", 0, "0 actionable comments");
}

/** The one-line `BOT_REVIEW` record, plus one `COMMENT` line per bot comment at head. */
export function renderBotReview(result: BotReviewVerdict): string {
 const f = result.findings;
 const lines = [
  `BOT_REVIEW ${result.verdict} bots=${f.bots} head=${f.head} check=${f.check} ` +
  `actionable=${f.actionable} changes_requested=${f.changesRequested} ` +
  `summary=${f.summary} wait=${f.wait} detail="${f.detail}"`,
 ];
 for (const entry of f.files) lines.push(`COMMENT ${entry}`);
 return lines.join("\n");
}

/** A finished subprocess. `null` from an {@link Exec} means it never ran, or never answered. */
export interface ExecResult {
 code: number;
 stdout: string;
 stderr: string;
}

export interface ExecOptions {
 cwd?: string;
 timeoutMs?: number;
 signal?: AbortSignal;
 deadline?: number;
}

/**
 * The subprocess seam: one argv, never a throw.
 *
 * Exported so tests answer `gh` from a transcript instead of a network, and so a caller
 * that already has a `gh` runner can pass it instead of paying for a second spawn path.
 */
export type Exec = (argv: string[], opts: ExecOptions) => Promise<ExecResult | null>;

/**
 * Per-call bound on a `gh` read. None of the reads had a timeout, so a wedged `gh` -- an
 * auth prompt, a hung proxy -- hung the shepherd indefinitely rather than failing.
 *
 * FIVE SECONDS, not thirty. Five reads run per probe, so the bound has to leave the whole
 * probe inside a caller's patience; a paginated GitHub read that has not answered in five
 * seconds is not about to. Overridable for a genuinely slow link.
 *
 * PARITY: the script's `int(os.environ[...])` raised at import on a junk value. A tool
 * cannot take the session down over a stray env var, so unreadable falls back to five.
 */
export function ghTimeoutMs(env: Record<string, string | undefined> = process.env): number {
 const seconds = Number.parseInt(env.PR_SHEPHERD_GH_TIMEOUT ?? "", 10);
 return (Number.isFinite(seconds) && seconds > 0 ? seconds : 5) * 1000;
}

/** The default {@link Exec}: capture `gh`, and resolve `null` for every failure to answer. */
export const spawnExec: Exec = async (argv, opts) => {
 const [bin, ...args] = argv;
 if (bin === undefined || opts.signal?.aborted) return null;
 const timeout = Math.min(opts.timeoutMs ?? ghTimeoutMs(), (opts.deadline ?? Infinity) - Date.now());
 if (timeout <= 0) return null;
 try {
  const proc = Bun.spawn([bin, ...args], { cwd: opts.cwd, stdout: "pipe", stderr: "pipe" });
  let failed = false;
  let bytes = 0;
  const readers = [proc.stdout.getReader(), proc.stderr.getReader()];
  let stop!: () => void;
  const stopped = new Promise<null>((resolve) => {
   stop = () => {
    failed = true;
    proc.kill("SIGKILL");
    for (const reader of readers) void reader.cancel().catch(() => { });
    resolve(null);
   };
  });
  const capture = async (reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> => {
   const decoder = new TextDecoder();
   let text = "";
   while (!failed) {
    const chunk = await reader.read();
    if (chunk.done) break;
    bytes += chunk.value.byteLength;
    if (bytes > 8 * 1024 * 1024) {
     stop();
     break;
    }
    text += decoder.decode(chunk.value, { stream: true });
   }
   return text + decoder.decode();
  };
  const timer = setTimeout(stop, timeout);
  opts.signal?.addEventListener("abort", stop, { once: true });
  try {
   if (opts.signal?.aborted) stop();
   const answer = Promise.all([capture(readers[0]!), capture(readers[1]!), proc.exited]).then(
    ([stdout, stderr, code]) => failed ? null : { code, stdout, stderr },
   );
   return await Promise.race([answer, stopped]);
  } finally {
   clearTimeout(timer);
   opts.signal?.removeEventListener("abort", stop);
  }
 } catch {
  return null;
 }
};

/** Read the PR head from REST; repeated bot rounds must not spend GraphQL points. */
export function prViewArgv(repo: string, pr: string): string[] {
 return ["gh", "api", `repos/${repo}/pulls/${pr}`];
}

/** One REST read, paginated because a single bot round can exceed a page. */
export function ghApiArgv(path: string): string[] {
 return ["gh", "api", "--paginate", "--slurp", path];
}

const REVIEW_THREADS_QUERY = `query($owner:String!,$name:String!,$number:Int!,$endCursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$endCursor){nodes{id isResolved isOutdated comments(first:100){nodes{author{login} path line originalLine url body commit{oid}}}} pageInfo{hasNextPage endCursor}}}}}`;

/** Keep GraphQL for review-thread `id`, `isResolved`, and `isOutdated`: REST PR comments omit all three. */
export function ghReviewThreadsArgv(repo: string, pr: string): string[] | null {
 const parts = repo.split("/");
 if (parts.length !== 2 || parts[0] === "" || parts[1] === "" || !/^\d+$/.test(pr)) return null;
 return [
  "gh", "api", "graphql", "--paginate", "--slurp",
  "-f", `query=${REVIEW_THREADS_QUERY}`,
  "-F", `owner=${parts[0]}`,
  "-F", `name=${parts[1]}`,
  "-F", `number=${pr}`,
 ];
}

type Read<T> = { ok: true; value: T } | { ok: false; error: string };

async function ghJson(argv: string[], exec: Exec, opts: ExecOptions): Promise<Read<unknown>> {
 const label = argv.slice(1).join(" ");
 if (opts.signal?.aborted) return { ok: false, error: "bot review read aborted" };
 if (opts.deadline !== undefined && Date.now() >= opts.deadline) {
  return { ok: false, error: "bot review operation deadline exceeded" };
 }
 const result = await exec(argv, opts);
 if (opts.signal?.aborted) return { ok: false, error: "bot review read aborted" };
 if (opts.deadline !== undefined && Date.now() >= opts.deadline) {
  return { ok: false, error: "bot review operation deadline exceeded" };
 }
 // PARITY: the script told a timeout apart from a spawn failure by exception type. The
 // seam reports both as "no answer", which is the same operational fact.
 if (result === null) {
  const seconds = (opts.timeoutMs ?? ghTimeoutMs()) / 1000;
  return { ok: false, error: `gh ${label} did not answer: unavailable, aborted, output limit exceeded, or exceeded ${seconds}s` };
 }
 if (result.code !== 0) return { ok: false, error: `gh ${label} failed: ${result.stderr.trim()}` };
 // EMPTY STDOUT IS NOT "no data". `gh` exiting 0 with nothing on stdout turned into
 // `null`, which built a payload with an empty head and all-empty review arrays -- and
 // that classifies as `absent`, exit 0, clearing the merge as though the bot gate had
 // been satisfied. Silence from an upstream read cannot be evidence that a check passed.
 if (result.stdout.trim() === "") {
  return { ok: false, error: `gh ${label} exited 0 with empty output; refusing to read silence as an answer` };
 }
 try {
  return { ok: true, value: JSON.parse(result.stdout) };
 } catch (error) {
  return { ok: false, error: `gh ${label} returned unreadable JSON: ${String(error)}` };
 }
}

/** Read and flatten the REST pages `gh api --paginate --slurp` emits. */
async function ghPaginatedJson(
 path: string,
 exec: Exec,
 opts: ExecOptions,
): Promise<Read<Record<string, unknown>[]>> {
 const read = await ghJson(ghApiArgv(path), exec, opts);
 if (!read.ok) return read;
 if (!Array.isArray(read.value)) return { ok: false, error: "paginated gh response must be an array of pages" };
 const rows: Record<string, unknown>[] = [];
 for (const page of read.value) {
  if (!Array.isArray(page)) return { ok: false, error: "paginated gh response contains a malformed page" };
  for (const row of page) {
   if (!isObject(row)) return { ok: false, error: "paginated gh response contains a malformed page" };
   rows.push(row);
  }
 }
 return { ok: true, value: rows };
}

interface ReviewThreadComment {
 login: string;
 path: string;
 line: unknown;
 commit: string;
 url: string;
 body: string;
 threadId: string;
 resolved: boolean;
 outdated: boolean;
}
/** Read REST pages whose payload is an object such as check-runs or commit status. */
async function ghPaginatedObjects(
 path: string,
 exec: Exec,
 opts: ExecOptions,
): Promise<Read<Record<string, unknown>[]>> {
 const read = await ghJson(ghApiArgv(path), exec, opts);
 if (!read.ok) return read;
 if (!Array.isArray(read.value)) return { ok: false, error: "paginated gh response must be an array of pages" };
 const pages: Record<string, unknown>[] = [];
 for (const page of read.value) {
  if (!isObject(page)) return { ok: false, error: "paginated gh response contains a malformed object page" };
  pages.push(page);
 }
 return { ok: true, value: pages };
}

function rollupFromRest(
 checkRuns: Record<string, unknown>[],
 statuses: Record<string, unknown>[],
): Read<unknown[]> {
 const rollup: Record<string, unknown>[] = [];
 for (const page of checkRuns) {
  const rows = page.check_runs;
  if (!Array.isArray(rows)) return { ok: false, error: "REST check-runs response was malformed" };
  for (const row of rows) {
   if (!isObject(row)) return { ok: false, error: "REST check-runs response was malformed" };
   rollup.push({ name: str(row.name), status: str(row.status), detailsUrl: str(row.details_url) });
  }
 }
 for (const page of statuses) {
  const rows = page.statuses;
  if (!Array.isArray(rows)) return { ok: false, error: "REST commit-status response was malformed" };
  for (const row of rows) {
   if (!isObject(row)) return { ok: false, error: "REST commit-status response was malformed" };
   rollup.push({ name: str(row.context), state: str(row.state), detailsUrl: str(row.target_url) });
  }
 }
 return { ok: true, value: rollup };
}

/** Read and flatten review-thread pages while preserving each thread's resolution state. */
async function ghReviewThreads(
 repo: string,
 pr: string,
 exec: Exec,
 opts: ExecOptions,
): Promise<Read<ReviewThreadComment[]>> {
 const argv = ghReviewThreadsArgv(repo, pr);
 if (argv === null) return { ok: false, error: `invalid GitHub PR identity: ${repo}#${pr}` };
 const read = await ghJson(argv, exec, opts);
 if (!read.ok) return read;
 if (!Array.isArray(read.value)) return { ok: false, error: "paginated GraphQL response must be an array of pages" };
 const comments: ReviewThreadComment[] = [];
 for (const page of read.value) {
  if (!isObject(page) || !isObject(page.data) || !isObject(page.data.repository) ||
      !isObject(page.data.repository.pullRequest) || !isObject(page.data.repository.pullRequest.reviewThreads)) {
   return { ok: false, error: "paginated GraphQL response contains a malformed reviewThreads page" };
  }
  const nodes = page.data.repository.pullRequest.reviewThreads.nodes;
  if (!Array.isArray(nodes)) return { ok: false, error: "reviewThreads nodes must be an array" };
  for (const thread of nodes) {
   if (!isObject(thread) || !isObject(thread.comments) || !Array.isArray(thread.comments.nodes)) {
    return { ok: false, error: "reviewThreads page contains a malformed thread" };
   }
   for (const entry of thread.comments.nodes) {
    if (!isObject(entry)) return { ok: false, error: "review thread contains a malformed comment" };
    comments.push({
     login: nested(entry, "author", "login"),
     path: str(entry.path),
     line: truthy(entry.line) ? entry.line : truthy(entry.originalLine) ? entry.originalLine : 0,
     commit: nested(entry, "commit", "oid"),
     url: str(entry.url),
     body: str(entry.body),
     threadId: str(thread.id),
     resolved: thread.isResolved === true,
     outdated: thread.isOutdated === true,
    });
   }
  }
 }
 return { ok: true, value: comments };
}

/** What the seven REST/GraphQL reads produce, and the only input classify takes. */
export interface BotReviewPayload {
 head: string;
 /** The normalized REST check-runs and commit-status rollup. */
 checks: unknown;
 reviews: { login: string; state: string; body: string; commit: string; url: string; at: string }[];
 comments: ReviewThreadComment[];
 notices: { login: string; body: string; at: string; url: string }[];
 requestActor: string | null;
}

export type FetchOutcome = { ok: true; payload: BotReviewPayload } | { ok: false; error: string };
/** Seven reads, no classification; repeated rounds stay off the GraphQL budget. */
export async function fetchBotReviewEvidence(
 repo: string,
 pr: string,
 opts: { exec?: Exec; cwd?: string; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<FetchOutcome> {
 const exec = opts.exec ?? spawnExec;
 const timeoutMs = opts.timeoutMs ?? ghTimeoutMs();
 const run: ExecOptions = { cwd: opts.cwd, timeoutMs, signal: opts.signal, deadline: Date.now() + 4 * timeoutMs };

 const view = await ghJson(prViewArgv(repo, pr), exec, run);
 if (!view.ok) return { ok: false, error: view.error };
 const head = isObject(view.value) && isObject(view.value.head) ? str(view.value.head.sha) : "";
 if (head === "") {
  return {
   ok: false,
   error:
    `gh api repos/${repo}/pulls/${pr} returned no head.sha; refusing to treat an unanswered read as ` +
    "an absent review",
  };
 }

 const [checkRuns, statuses, reviews, comments, notices, actor] = await Promise.all([
  ghPaginatedObjects(`repos/${repo}/commits/${head}/check-runs?per_page=100`, exec, run),
  ghPaginatedObjects(`repos/${repo}/commits/${head}/status?per_page=100`, exec, run),
  ghPaginatedJson(`repos/${repo}/pulls/${pr}/reviews`, exec, run),
  ghReviewThreads(repo, pr, exec, run),
  ghPaginatedJson(`repos/${repo}/issues/${pr}/comments`, exec, run),
  ghJson(["gh", "api", "user"], exec, run),
 ]);
 if (!checkRuns.ok) return { ok: false, error: checkRuns.error };
 if (!statuses.ok) return { ok: false, error: statuses.error };
 if (!reviews.ok) return { ok: false, error: reviews.error };
 if (!comments.ok) return { ok: false, error: comments.error };
 if (!notices.ok) return { ok: false, error: notices.error };
 const requestActor = actor.ok && isObject(actor.value) && typeof actor.value.login === "string" ? actor.value.login : null;
 const rollup = rollupFromRest(checkRuns.value, statuses.value);
 if (!rollup.ok) return { ok: false, error: rollup.error };

 return {
  ok: true,
  payload: {
   head,
   checks: rollup.value,
   requestActor,
   reviews: reviews.value.map((r) => ({
    login: nested(r, "user", "login"),
    state: str(r.state),
    body: str(r.body),
    commit: str(r.commit_id),
    url: str(r.html_url),
    at: str(r.submitted_at),
   })),
   comments: comments.value,
   notices: notices.value.map((n) => ({
    login: nested(n, "user", "login"),
    body: str(n.body),
    at: str(n.created_at),
    url: str(n.html_url),
   })),
  },
 };
}


/** An `owner/repo` plus PR number, however the caller spelled the reference. */
export interface PrRef {
 repo: string;
 number: string;
}

const PR_URL = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/;
const PR_QUALIFIED = /^([^/\s]+)\/([^/\s]+)[#/](\d+)$/;
const PR_NUMBER = /^#?(\d+)$/;

/**
 * Split a PR reference into the repo and number the reads need.
 *
 * The repository cannot be derived — `gh pr view` is always called with an explicit
 * `--repo` — so a bare number is only usable alongside `repo`. Returning `null` there is
 * deliberate: guessing the repository from the session's checkout would silently probe a
 * different PR and report its verdict as this one's.
 */
export function parsePrRef(pr: string, repo?: string): PrRef | null {
 const text = pr.trim();
 const url = PR_URL.exec(text);
 if (url?.[1] && url[2] && url[3]) return { repo: `${url[1]}/${url[2]}`, number: url[3] };
 const qualified = PR_QUALIFIED.exec(text);
 if (qualified?.[1] && qualified[2] && qualified[3]) {
  return { repo: `${qualified[1]}/${qualified[2]}`, number: qualified[3] };
 }
 const bare = PR_NUMBER.exec(text);
 const owner = repo?.trim();
 if (bare?.[1] && owner) return { repo: owner, number: bare[1] };
 return null;
}

/** The caveat every bot-review verdict carries, because two codes are routinely misread. */
const NEVER_CLEAN =
 "unknown (2) and declined (13) are never to be treated as clean: unknown means the evidence could not " +
 "be read, declined means the bot refused the round and must be re-triggered.";

/** What the tool reports alongside its text. `error` is set only on unread evidence. */
export interface BotReviewDetails {
 /** A code from the landing contract's vocabulary. Unread evidence is 2, never `null`. */
 code: number;
 verdict: BotReviewState;
 head?: string;
 actionable?: number;
 changesRequested?: number;
 wait?: string;
 files?: string[];
 error?: string;
 providers?: ProviderAvailability[];
 requests?: ReviewRequestObservation[];
}

function unreadable(text: string, error: string): AgentToolResult<BotReviewDetails> {
 return {
  content: [{ type: "text", text: `verdict: unknown (exit ${EXIT_UNKNOWN}) — ${text}\n${NEVER_CLEAN}` }],
  details: { code: EXIT_UNKNOWN, verdict: "unknown", error },
  isError: true,
 };
}

/** Register `orc_bot_review_probe`. The orchestrator wires this from `src/index.ts`. */
export function registerBotReviewProbe(pi: ExtensionAPI, exec: Exec = spawnExec): void {
 const z = pi.zod;

 // A named const, not an inline `z.object(...)` argument: inlined, the generic no longer
 // infers and `params` degrades to `unknown`.
 const probeParams = z.object({
  pr: z.string().describe("PR reference: a github.com pull URL, `owner/repo#123`, or a number with `repo`"),
  repo: z.string().optional().describe("`owner/repo`, required when `pr` is a bare number"),
  bots: z.string().optional().describe("comma-separated bot slugs; defaults to $PR_REVIEW_BOTS"),
  cwd: z.string().optional().describe("working directory for the gh reads"),
 });

 pi.registerTool({
  name: "orc_bot_review_probe",
  label: "Bot review probe",
  description:
   "Classify a PR's review-bot round (CodeRabbit, Copilot review, ...) at its exact head SHA. Reads the " +
   "PR with `gh` — `pr view` for the head and check rollup, then the reviews, review comments and issue " +
   "comments — and grades the latest round at that head. Verdicts: clean (0), absent (0), pending (10), " +
   `stale (11), actionable (12), declined (13), unknown (2). ${NEVER_CLEAN}`,
  parameters: probeParams,
  approval: "read",
  async execute(
   _id,
   params,
   signal,
   _onUpdate,
   ctx: ExtensionContext,
  ): Promise<AgentToolResult<BotReviewDetails>> {
   try {
    const ref = parsePrRef(String(params.pr ?? ""), params.repo === undefined ? undefined : String(params.repo));
    if (!ref) {
     return unreadable(
      `cannot read a repository from pr=${JSON.stringify(params.pr)}. Pass a github.com pull URL, ` +
      "`owner/repo#123`, or a bare number together with `repo`.",
      "unreadable pr reference",
     );
    }

    const fetched = await fetchBotReviewEvidence(ref.repo, ref.number, {
     exec,
     cwd: params.cwd ?? ctx.cwd,
     signal,
    });
    if (!fetched.ok) {
     return unreadable(`the PR read failed, so no round was classified.\n${fetched.error}`, fetched.error);
    }

    // The head a round must match is the one the reads just returned, never a
    // caller-supplied SHA: classifying against a stale head is how a `stale`
    // round reads as `clean`.
    const slugs = configuredSlugs(params.bots ? params.bots : undefined);
    const result = classifyBotReviews(fetched.payload, { head: fetched.payload.head, slugs });
    const adapters = slugs.map((slug) => `${slug}=${adapterNote(slug)}`).join("; ");
    const providers = detectProviderAvailability(fetched.payload);
    const providerText = providers
     .map(provider => `${provider.provider}=${provider.status}${provider.evidence ? `:${provider.evidence}` : ""}`)
     .join("; ");
    const requests = detectReviewRequests(fetched.payload);
    const requestText = requests.length === 0
     ? "none"
     : requests.map(request => `${request.provider}/${request.mode}@${request.head}${request.requestedAt ? `:${request.requestedAt}` : ""}`).join("; ");
    const text = [
     `verdict: ${result.verdict} (exit ${result.code}) at head ${result.findings.head}`,
     renderBotReview(result),
     adapters === "" ? "" : `adapters: ${adapters}`,
     `providers: ${providerText}`,
     `requests: ${requestText}`,
     NEVER_CLEAN,
    ]
     .filter(Boolean)
     .join("\n");

    return {
     content: [{ type: "text", text }],
     details: {
      code: result.code,
      verdict: result.verdict,
      head: result.findings.head,
      actionable: result.findings.actionable,
      changesRequested: result.findings.changesRequested,
      wait: result.findings.wait,
      files: result.findings.files,
      providers,
      requests,
     },
     // pending, stale, actionable and declined are answers, not failures. Only
     // evidence that could not be read is an error result.
     isError: result.verdict === "unknown",
    };
   } catch (error) {
    // Defence in depth: an unexpected throw would surface as a tool crash, which
    // reads to the model as "the repo is broken" rather than "the probe failed".
    return unreadable(`the probe failed: ${String(error)}`, "probe failed");
   }
  },
 });
}
