import type { Intent, Proposal } from "@fire_trident/core";
import { colonyPath, type ApiRequest } from "./api.ts";
import type { Colors } from "./format.ts";
import { reviewOf, visible } from "./review.ts";

/**
 * Escalation batching in `ft review` (worker decide/batch.ts, FT_ESCALATION_BATCH). Past a colony's hourly budget for
 * the escalations the alert budget cannot send back, the queue marks the batchable changes that escalated for the same
 * reason with one `batch`; `ft review` shows each batch as one block, as the web review page shows one card: its count,
 * each change listed, and how to approve or reject them all (`--approve-batch <id>`, `--reject-batch <id> --reason`).
 * Their own entries follow with --diff (open each). Each change still waits for a person: an answer for a batch is the
 * person's decision on each change it lists. Mirrors packages/web/src/batch.ts; everything is read defensively.
 */

/** A batch as each of its waiting changes carries it (`batch` on a review queue item). */
export interface ReviewBatch {
  /** Short id a person types: bat_1a2b3c4d ("" from a server that sends none). */
  id: string;
  key: string;
  rule: string;
  /** Completes "12 changes ...": "hit the danger pattern capability (network)". */
  label: string;
  /** The hourly budget that was spent. */
  budget: number;
  ids: string[];
}

/** The batch a queue item carries, checked field by field; null when it carries none, and for an audit item (never batched). */
export function batchOf(item: Proposal): ReviewBatch | null {
  const v = (item as Proposal & { batch?: unknown }).batch;
  if (!v || typeof v !== "object" || Array.isArray(v) || "audit" in item) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.key !== "string" || o.key === "" || typeof o.label !== "string" || o.label === "") return null;
  const ids = Array.isArray(o.ids) ? o.ids.filter((x): x is string => typeof x === "string" && x !== "") : [];
  const budget = typeof o.budget === "number" && Number.isFinite(o.budget) && o.budget > 0 ? Math.floor(o.budget) : 0;
  return { id: typeof o.id === "string" ? o.id : "", key: o.key, rule: typeof o.rule === "string" ? o.rule : "", label: o.label, budget, ids };
}

/** One batch block: the batch and its changes still in the queue, in queue order. */
export interface BatchGroup {
  batch: ReviewBatch;
  members: Proposal[];
}

/** The batches of a queue, in the order of each one's first change: a batch with fewer than two changes left is none. */
export function groupBatches(items: readonly Proposal[]): BatchGroup[] {
  const groups = new Map<string, BatchGroup>();
  for (const p of items) {
    const b = batchOf(p);
    if (!b) continue;
    const g = groups.get(b.key) ?? { batch: b, members: [] };
    g.members.push(p);
    groups.set(b.key, g);
  }
  return [...groups.values()].filter((g) => g.members.length >= 2);
}

/** The ids of every change shown in a batch block. */
export function batchMembers(groups: readonly BatchGroup[]): Set<string> {
  return new Set(groups.flatMap((g) => g.members.map((m) => m.id)));
}

/** What a person types for a batch: its id, or its key from a server that sends no id. */
export function batchRef(b: ReviewBatch): string {
  return b.id || b.key;
}

/** A batch named by its id or its key, among the queue's batches; null when none is. */
export function findBatch(groups: readonly BatchGroup[], ref: string): BatchGroup | null {
  return groups.find((g) => g.batch.id === ref || g.batch.key === ref) ?? null;
}

/** Quote a ref for a shell when it holds more than letters, digits, _ and -. */
function shellRef(ref: string): string {
  return /^[\w-]+$/.test(ref) ? ref : `'${ref.replace(/'/g, "'\\''")}'`;
}

/** The line a change shows in a batch block: its first danger pattern, else its reason. */
function memberLine(p: Proposal): string {
  const danger = reviewOf(p)?.danger.find((d) => d.label !== "")?.label;
  const text = danger ?? (typeof p.reason === "string" ? p.reason.replace(/^escalated by \w+: /, "") : "");
  const one = visible(text.replace(/\s+/g, " ").trim());
  return one.length > 140 ? `${one.slice(0, 139)}…` : one;
}

/** One batch as `ft review` shows it: what its changes share, each change, and how to decide them all. */
export function batchLines(g: BatchGroup, intents: ReadonlyMap<string, Intent>, c: Colors, colony: string, when: (at: number) => string): string[] {
  const n = g.members.length;
  const ref = shellRef(batchRef(g.batch));
  const budget = g.batch.budget > 0 ? `its budget of ${g.batch.budget}` : "its budget";
  const out = [
    `${c.yellow(`Batch ${batchRef(g.batch)}`)}  ${c.bold(`${n} changes ${g.batch.label}`)}`,
    c.dim(`  Past ${budget} an hour for escalations the alert budget cannot send back, this colony puts changes that escalate for the same reason in one batch. A person still decides each change.`),
  ];
  for (const p of g.members) {
    const title = intents.get(p.intentId)?.title ?? p.declared?.summary ?? p.intentId;
    out.push(`  ${c.magenta(p.id)}  ${visible(title.replace(/\s+/g, " ").trim()).slice(0, 60)}  ${c.dim(`${p.agentId} · ${when(p.createdAt)}`)}`);
    const line = memberLine(p);
    if (line) out.push(`    ${c.dim(line)}`);
  }
  out.push(c.dim(`  Decide all ${n}: ft review ${colony} --approve-batch ${ref}, or --reject-batch ${ref} --reason <text>. Open each: ft review ${colony} --diff`));
  return out;
}

/** `ft review <colony> --approve-batch|--reject-batch <id>`. */
export interface ReviewBatchCommand {
  name: "review-batch";
  colony: string;
  /** The batch's id (bat_...) or key, as `ft review` shows it. */
  batch: string;
  decision: "approve" | "reject";
  reason: string;
  by?: string;
}

/** The answer for a batch, for the changes the queue listed in it now (POST /review/batches/decide). */
export function batchDecisionRequest(cmd: ReviewBatchCommand, g: BatchGroup, by: string): ApiRequest {
  return {
    method: "POST",
    path: colonyPath(cmd.colony, "/review/batches/decide"),
    body: { key: g.batch.key, ids: g.members.map((m) => m.id), decision: cmd.decision, reason: cmd.reason, by: cmd.by ?? by },
  };
}

/** What an answer for a batch did, as the server sends it. */
export interface BatchAnswer {
  decided: string[];
  skipped: Array<{ id: string; why: string }>;
}

/** An answer as the server sent it, checked field by field. */
export function batchAnswerOf(raw: unknown): BatchAnswer {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const decided = Array.isArray(o.decided) ? o.decided.filter((x): x is string => typeof x === "string") : [];
  const skipped = Array.isArray(o.skipped)
    ? o.skipped
        .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
        .map((x) => ({ id: typeof x.id === "string" ? x.id : "", why: typeof x.why === "string" ? x.why : "" }))
        .filter((x) => x.id !== "")
    : [];
  return { decided, skipped };
}

/** What happened, said back: each change decided, and each left alone with why. */
export function batchAnswerLines(ref: string, decision: "approve" | "reject", a: BatchAnswer, c: Colors): string[] {
  const verb = decision === "approve" ? c.green("Approved") : c.red("Rejected");
  const out =
    a.decided.length === 0
      ? [c.yellow(`Nothing decided in batch ${ref}: none of its changes still waits in it.`)]
      : [`${verb} ${a.decided.length} change${a.decided.length === 1 ? "" : "s"} of batch ${ref}: ${a.decided.join(", ")}`];
  if (a.decided.length > 0) out.push(c.dim(decision === "approve" ? "  Each rejoins its lane and lands on the next cycle." : "  Your reason is now one antibody, from the first of them."));
  for (const s of a.skipped) out.push(c.dim(`  left alone ${s.id}: ${s.why}`));
  return out;
}

/** What running `--approve-batch` or `--reject-batch` needs from `ft`. */
export interface BatchRun {
  by: string;
  json: boolean;
  dryRun: boolean;
  c: Colors;
  send: <T>(req: ApiRequest) => Promise<T>;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  /** Print requests instead of sending them (--dry-run). */
  showDryRun: (requests: ApiRequest[]) => number;
}

/**
 * `ft review <colony> --approve-batch|--reject-batch <id>`: read the queue, find the batch, and send the person's answer
 * for the changes it holds now (the server decides only those still waiting in it). Exit 1 when the queue holds no such
 * batch. With --dry-run, prints the read and the answer it would send.
 */
export async function runReviewBatch(cmd: ReviewBatchCommand, run: BatchRun): Promise<number> {
  const read: ApiRequest = { method: "GET", path: colonyPath(cmd.colony, "/review") };
  if (run.dryRun) {
    const placeholder: BatchGroup = { batch: { id: cmd.batch, key: "<the batch's key from the queue>", rule: "", label: "", budget: 0, ids: [] }, members: [] };
    const answer = batchDecisionRequest(cmd, placeholder, run.by);
    return run.showDryRun([read, { ...answer, body: { ...(answer.body as Record<string, unknown>), ids: "<the batch's changes in the queue>" } }]);
  }
  const queue = await run.send<unknown>(read);
  const items = Array.isArray(queue) ? (queue as Proposal[]) : [];
  const g = findBatch(groupBatches(items), cmd.batch);
  if (!g) {
    run.stderr(`ft: no batch ${cmd.batch} in the review queue of ${cmd.colony}. ft review ${cmd.colony} lists the batches; a batch down to one change is decided on its own.`);
    return 1;
  }
  const res = batchAnswerOf(await run.send<unknown>(batchDecisionRequest(cmd, g, run.by)));
  if (run.json) run.stdout(JSON.stringify(res, null, 2));
  else for (const line of batchAnswerLines(batchRef(g.batch), cmd.decision, res, run.c)) run.stdout(line);
  return 0;
}
