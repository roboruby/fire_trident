import type { Directive, Id, Intent, IntentField } from "@fire_trident/core";
import { errorMessage, errorStatus } from "./rpc.ts";

/**
 * How an in-platform agent changes course (pure helpers; the loop acts in loop.ts). The colony pushes
 * directives (AgentDO.direct): human guidance, or a revision or withdrawal of an intent the agent
 * holds. The agent keeps them in its journal and acts at its next step: a withdrawal stops the job, a
 * revision restarts it from the new revision, guidance goes into every later prompt for that intent
 * and work already produced is redone with it.
 */

/** A directive as the agent keeps it. */
export interface HeldDirective {
  directive: Directive;
  /** The intent as amended (revision notices). */
  intent?: Intent;
  receivedAt: number;
  /** When the loop acted on it, and what it did. */
  appliedAt?: number;
  outcome?: string;
}

/** Guidance a job follows: what the human said, who, when. */
export type Guidance = { id: Id; message: string; by: string; at: number };

/** Directives a journal keeps at most (applied ones go first), and how long an unapplied one waits. */
export const MAX_HELD = 50;
export const PENDING_TTL_MS = 60 * 60_000;
/** Guidance a job carries into its prompts at most (the latest). */
export const MAX_GUIDANCE = 5;

/** Steps whose in-flight work a directive about the job makes moot (the step is halted). */
const INTERRUPT_STEPS: ReadonlySet<string> = new Set(["produce", "commit", "push", "propose"]);

/** Keep a newly received directive (a repeat of the same id is ignored); prunes old entries. */
export function holdDirective(list: HeldDirective[], d: Directive, intent: Intent | undefined, now: number): HeldDirective[] {
  if (list.some((h) => h.directive.id === d.id)) return list;
  const next: HeldDirective[] = [...list, { directive: d, ...(intent ? { intent } : {}), receivedAt: now }];
  const live = next.filter((h) => h.appliedAt !== undefined || now - h.receivedAt <= PENDING_TTL_MS);
  while (live.length > MAX_HELD) {
    const i = live.findIndex((h) => h.appliedAt !== undefined);
    live.splice(i >= 0 ? i : 0, 1);
  }
  return live;
}

/** Record that a directive was acted on. */
export function markApplied(list: HeldDirective[], id: Id, now: number, outcome: string): HeldDirective[] {
  return list.map((h) => (h.directive.id === id && h.appliedAt === undefined ? { ...h, appliedAt: now, outcome } : h));
}

/** Is this directive about the job (its intent, or no intent in particular)? */
export function aboutJob(d: Directive, job: { intentId: Id }): boolean {
  return d.intentId === undefined || d.intentId === job.intentId;
}

/**
 * The directive a job must act on first, if any: a withdrawal of its intent, then a revision newer
 * than the one it works from, then guidance about it, oldest first.
 */
export function nextDirection(list: HeldDirective[], job: { intentId: Id; intent: Pick<Intent, "revision"> }): HeldDirective | null {
  const pending = list.filter((h) => h.appliedAt === undefined);
  const mine = (kind: Directive["kind"]) => pending.filter((h) => h.directive.kind === kind && h.directive.intentId === job.intentId);
  const withdrawal = mine("withdrawal")[0];
  if (withdrawal) return withdrawal;
  const working = job.intent.revision ?? 1;
  const revision = mine("revision").find((h) => (h.directive.revision ?? 0) > working);
  if (revision) return revision;
  return pending.find((h) => h.directive.kind === "guidance" && aboutJob(h.directive, job)) ?? null;
}

/** Should a directive halt the step in flight? Withdrawals and revisions of the job's intent always do; guidance does while the job produces or proposes. */
export function interrupts(d: Directive, job: { intentId: Id; step: string } | null): boolean {
  if (!job || !aboutJob(d, job)) return false;
  if (d.kind === "withdrawal" || d.kind === "revision") return d.intentId === job.intentId;
  return INTERRUPT_STEPS.has(job.step);
}

/** Guidance a new job on this intent starts with: guidance about it (or about no intent, still pending), the latest MAX_GUIDANCE. */
export function guidanceFor(list: HeldDirective[], intentId: Id): Guidance[] {
  return list
    .filter((h) => h.directive.kind === "guidance" && (h.directive.intentId === intentId || (h.directive.intentId === undefined && h.appliedAt === undefined)))
    .map((h) => ({ id: h.directive.id, message: h.directive.message, by: h.directive.by, at: h.directive.at }))
    .slice(-MAX_GUIDANCE);
}

/** Add guidance to a job's list (deduplicated, the latest MAX_GUIDANCE). */
export function withGuidance(current: Guidance[] | undefined, d: Directive): Guidance[] {
  const list = (current ?? []).filter((g) => g.id !== d.id);
  list.push({ id: d.id, message: d.message, by: d.by, at: d.at });
  return list.slice(-MAX_GUIDANCE);
}

/** A colony refusal that means the direction changed: the intent was revised or withdrawn under the job. */
export function directionError(e: unknown): { kind: "revision" | "withdrawal"; reason: string } | null {
  if (errorStatus(e) !== 409) return null;
  const msg = errorMessage(e, 600);
  if (msg.startsWith("intent revised: ")) return { kind: "revision", reason: msg };
  if (msg.startsWith("intent withdrawn: ")) return { kind: "withdrawal", reason: msg };
  return null;
}

/** "why changed", "title and footprint changed". */
export function changedText(changed: readonly IntentField[] | undefined): string {
  const c = changed ?? [];
  if (c.length === 0) return "changed";
  return `${c.length === 1 ? c[0] : `${c.slice(0, -1).join(", ")} and ${c[c.length - 1]}`} changed`;
}

function quote(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return `"${t.length > max ? `${t.slice(0, max - 1)}…` : t}"`;
}

function files(paths: readonly string[], max = 2): string {
  if (paths.length === 0) return "no files";
  const head = paths.slice(0, max).join(", ");
  return paths.length > max ? `${head} +${paths.length - max}` : head;
}

/** What a job relays at a step: a one-line "what I am doing now". */
export function stepNote(job: {
  step: string;
  intent: Pick<Intent, "title" | "footprint" | "revision">;
  reads?: Array<{ path: string }>;
  depsMissing?: string[];
  writeSet?: Array<{ path: string }>;
  proposalId?: Id;
  lastStatus?: string;
  directives?: Guidance[];
  lease?: { repo: { name: string } };
}): string {
  const title = quote(job.intent.title, 60);
  const rev = (job.intent.revision ?? 1) > 1 ? ` r${job.intent.revision}` : "";
  const following = (job.directives ?? []).length > 0 ? `, following ${(job.directives ?? []).length} directive${(job.directives ?? []).length === 1 ? "" : "s"}` : "";
  switch (job.step) {
    case "deps":
      return `waiting for ${(job.depsMissing ?? []).length || "the"} file(s) ${title} builds on to land`;
    case "fetch":
      return `fetching trunk for ${title}${rev}`;
    case "read":
      return `reading ${files(job.intent.footprint ?? [])} for ${title}${rev}`;
    case "produce":
      return `writing ${files((job.reads ?? []).map((r) => r.path))} for ${title}${rev}${following}`;
    case "commit":
      return `committing ${title}${rev}`;
    case "push":
      return `pushing ${title}${rev} to ${job.lease?.repo.name ?? "its workspace"}`;
    case "propose":
      return `proposing ${files((job.writeSet ?? []).map((w) => w.path))} for ${title}${rev}${following}`;
    case "await":
      return `waiting on ${job.proposalId ?? "its proposal"} (${job.lastStatus ?? "in review"}) for ${title}${rev}`;
    default:
      return `${job.step} ${title}${rev}`;
  }
}

/** A short line for a directive the agent acted on. */
export function directiveNote(d: Directive, title: string, what: string): string {
  switch (d.kind) {
    case "withdrawal":
      return `stopped ${quote(title, 60)}: withdrawn (${d.message.replace(/\s+/g, " ").slice(0, 100)})`;
    case "revision":
      return `intent revised to r${d.revision ?? "?"} (${changedText(d.changed)}): restarting ${quote(title, 60)}`;
    default:
      return `directive from ${d.by} ${quote(d.message, 80)}: ${what}`;
  }
}
