import type { Certification, Id, Intent, Landing, Proposal, Sha } from "@fire_trident/core";
import { intentLifecycle, type IntentLifecycle, type LifecycleAgent, type LifecycleCertified, type LifecycleChange, type LifecycleFacts, type LifecycleIntent } from "@fire_trident/core";
import { TEST_FILE } from "../certify/compile.ts";
import { nothingToRun, placeLanding } from "../certify/landingtests.ts";
import { withheldFromAuthors } from "../api/logic.ts";
import { noteDecisions, type DecisionRow } from "./direction.ts";
import type { SqlRunner } from "./inline.ts";

/**
 * An intent's lifecycle strip (GET /api/colonies/:id/intents/:iid/lifecycle; core/lifecycle.ts draws it), read from what
 * the colony already records: the intent (who declared it, its status, an agent's report, the closure ledger's latest
 * record), its proposals (newest LIFECYCLE_READ, through the proposals_by_intent index the take path and the stuck
 * detector also create), their decide-arc decisions, their agents, the landings that took them, and whether a green
 * certification includes each landing: the first green result at or after its commit, placed on trunk's chain by the
 * trunk writer's landing log (one commitOrder call for all of them), as a landing's test row places it
 * (certify/landingtests.ts). Read only, apart from that index. A trunk writer that cannot place the commits leaves
 * certification "not known", with the reason; nothing here fails the read.
 *
 * The answer is public, like the intent's own read: a security return's failing checks are withheld first, as the
 * proposal route withholds them (api/logic.ts withheldFromAuthors), and only the checks that name what confirmed a change
 * (the gate check and the layers it reads) go into the facts.
 */

/** Proposals of one intent read at most, newest first. */
export const LIFECYCLE_READ = 50;

/** The trunk writer's read the certified step needs (TrunkDO.commitOrder). */
export interface LifecycleTrunk {
  commitOrder(shas: Sha[]): Promise<Record<Sha, number>>;
}

/** What the colony gives the read. */
export interface LifecycleHost {
  sql: SqlRunner;
  colonyId: Id;
  /** The intent as the colony serves it, and its row's last update (when it was withdrawn, for a withdrawn one). */
  intent: Intent;
  updatedAt: number;
  trunk: () => LifecycleTrunk;
  /** Why certification does not run in the colony, as a clause, or null when it does (certify/landingtests.ts certificationOff). */
  off: () => string | null;
}

type ProposalRow = { id: string; agent_id: string; status: string; created_at: number; updated_at: number; data: string };
type AgentRow = { id: string; kind: string; name: string; model: string | null; intent_id: string | null; workspace: string | null };
type LandingRow = { id: string; trunk_sha: string; at: number; data: string };

/** Colonies whose proposals_by_intent index this isolate has made sure of. */
const indexed = new WeakSet<object>();

function ensureIndex(sql: SqlRunner): void {
  if (indexed.has(sql)) return;
  try {
    sql.exec("CREATE INDEX IF NOT EXISTS proposals_by_intent ON proposals(intent_id, created_at)");
    indexed.add(sql);
  } catch (err) {
    // The read still works without it, only slower.
    console.warn(`lifecycle: proposals_by_intent not created: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function parse<T>(text: string | null | undefined): T | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** The checks that say what confirmed a change: the platform's gate check, and the layers and proof an older note's words come from. */
const CONFIRMING = /^(gate$|reflex: |llm: |deterministic)/;

/** The intent as the strip reads it. */
function intentFacts(i: Intent, updatedAt: number): LifecycleIntent {
  const report = i.escalation && !i.escalation.resolved ? i.escalation : undefined;
  return {
    id: i.id,
    title: i.title,
    source: i.source,
    createdBy: i.createdBy,
    createdAt: i.createdAt,
    status: i.status,
    ...(i.withdrawnReason ? { withdrawnReason: i.withdrawnReason } : {}),
    ...(i.status === "withdrawn" ? { withdrawnAt: updatedAt } : {}),
    ...(report ? { report: { kind: report.kind, by: report.by, at: report.at } } : {}),
    ...(i.closure ? { closure: { cause: i.closure.cause, at: i.closure.at, ...(i.closure.agentId ? { agentId: i.closure.agentId } : {}), ...(typeof i.closure.gapMs === "number" ? { gapMs: i.closure.gapMs } : {}) } } : {}),
  };
}

/** One proposal as the strip reads it (its security return's failing checks withheld). */
function changeFacts(row: ProposalRow, decisions: unknown[] | undefined): LifecycleChange | null {
  const stored = parse<Proposal>(row.data);
  if (!stored || typeof stored !== "object") return null;
  const p = withheldFromAuthors({ ...stored, status: row.status as Proposal["status"] });
  const moved = Array.isArray(p.movedBy) ? p.movedBy.find((m) => m && typeof m.landingId === "string" && m.landingId !== "") : undefined;
  const checks = (p.evidence?.checks ?? []).filter((c) => c && typeof c.name === "string" && CONFIRMING.test(c.name));
  return {
    id: row.id,
    agentId: row.agent_id,
    status: row.status,
    createdAt: row.created_at,
    settledAt: row.updated_at,
    ...(typeof p.reason === "string" && p.reason ? { reason: p.reason } : {}),
    ...(moved ? { beatenBy: { landingId: moved.landingId, ...(moved.trunkSha ? { trunkSha: moved.trunkSha } : {}), ...(moved.title ? { title: moved.title } : {}) } } : {}),
    ...(p.supersededBy ? { supersededBy: p.supersededBy } : {}),
    ...(p.landingId ? { landingId: p.landingId } : {}),
    evidence: { checks },
    ...(decisions ? { decisions } : {}),
    ...(typeof p.approvedAt === "number" ? { approvedAt: p.approvedAt } : {}),
    ...(Array.isArray(p.mergeHold) && p.mergeHold.length > 0 ? { held: true } : {}),
  };
}

/** Whether a green certification includes each landing (see the module comment), by landing id. */
async function certifiedOf(host: LifecycleHost, landings: ReadonlyArray<{ id: Id; trunkSha: Sha; parentSha: Sha; paths: string[] }>): Promise<Map<Id, LifecycleCertified>> {
  const out = new Map<Id, LifecycleCertified>();
  if (landings.length === 0) return out;
  let results: Array<{ sha: Sha; status: string; startedAt: number; finishedAt: number }> = [];
  try {
    results = (host.sql.exec("SELECT trunk_sha, status, started_at, finished_at FROM certifications WHERE status IN ('green', 'red', 'skipped')").toArray() as Array<{ trunk_sha: string; status: string; started_at: number; finished_at: number | null }>).map(
      (r) => ({ sha: r.trunk_sha, status: r.status, startedAt: r.started_at, finishedAt: r.finished_at ?? 0 }),
    );
  } catch {
    // No certification table yet: nothing was certified.
  }
  const off = host.off();
  if (results.length === 0) {
    for (const l of landings) out.set(l.id, { status: "pending", reason: off ?? "no certification has run on a commit that includes it yet" });
    return out;
  }
  let order: Record<Sha, number>;
  try {
    order = await host.trunk().commitOrder([...new Set([...results.map((r) => r.sha), ...landings.flatMap((l) => [l.trunkSha, l.parentSha])].filter((s) => typeof s === "string" && s !== ""))]);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    for (const l of landings) out.set(l.id, { status: "unknown", reason: `the trunk writer could not place its commit just now (${why.replace(/[.\s]+$/, "")}); ask again in a moment` });
    return out;
  }
  const certification = (sha: Sha | undefined): Certification | null => {
    if (!sha) return null;
    try {
      const row = host.sql.exec("SELECT data FROM certifications WHERE trunk_sha = ?", sha).toArray()[0] as { data?: string } | undefined;
      return parse<Certification>(row?.data);
    } catch {
      return null;
    }
  };
  for (const l of landings) {
    const seq = order[l.trunkSha];
    if (typeof seq !== "number") {
      out.set(l.id, { status: "unknown", reason: "the trunk writer's log does not place its commit" });
      continue;
    }
    const placed = results.flatMap((r) => (typeof order[r.sha] === "number" ? [{ ...r, seq: order[r.sha]! }] : []));
    const at = placeLanding(placed, seq, order[l.parentSha] ?? seq - 1);
    if (at.certified) {
      out.set(l.id, { status: "certified", sha: at.certified.sha, ...(at.certified.finishedAt > 0 ? { at: at.certified.finishedAt } : {}) });
      continue;
    }
    // A run with nothing to run, at or after it, or the newest before it when it brought no test file (no run follows one).
    const skipped = certification(at.skipped?.sha) ?? (at.before && !at.red && !l.paths.some((p) => TEST_FILE.test(p)) ? certification(at.before.sha) : null);
    if (!at.red && nothingToRun(skipped)) {
      out.set(l.id, { status: "no-tests", ...(skipped?.detail ? { reason: skipped.detail } : {}) });
      continue;
    }
    out.set(l.id, { status: "pending", reason: at.red ? `trunk is red at ${at.red.sha.slice(0, 7)}` : (off ?? "no certification has run on a commit that includes it yet") });
  }
  return out;
}

/** The intent's lifecycle (see the module comment). */
export async function readLifecycle(host: LifecycleHost): Promise<IntentLifecycle> {
  const { sql, intent } = host;
  ensureIndex(sql);
  const rows = sql
    .exec("SELECT id, agent_id, status, created_at, updated_at, data FROM proposals WHERE intent_id = ? ORDER BY created_at DESC LIMIT ?", intent.id, LIFECYCLE_READ)
    .toArray() as ProposalRow[];
  const ids = rows.map((r) => r.id);
  const decisions =
    ids.length > 0
      ? noteDecisions(sql.exec("SELECT id, kind, subject, layer, answers, p, action, at FROM decisions WHERE subject IN (SELECT value FROM json_each(?)) ORDER BY at", JSON.stringify(ids)).toArray() as DecisionRow[])
      : {};
  const changes = rows.map((r) => changeFacts(r, decisions[r.id])).filter((c): c is LifecycleChange => c !== null);

  // The agents: of each change, the holder, and whoever a report or a closure names.
  const holderId = (intent.status === "claimed" || intent.status === "proposed") && intent.assignedTo ? intent.assignedTo : undefined;
  const agentIds = [...new Set([...changes.map((c) => c.agentId), holderId, intent.escalation?.by, intent.closure?.agentId].filter((x): x is string => typeof x === "string" && x !== ""))];
  const agents: Record<Id, LifecycleAgent> = {};
  if (agentIds.length > 0) {
    for (const a of sql.exec("SELECT id, kind, name, model, intent_id, workspace FROM agents WHERE id IN (SELECT value FROM json_each(?))", JSON.stringify(agentIds)).toArray() as AgentRow[]) {
      // When it took the intent: its workspace lease, while it still holds it.
      const lease = a.intent_id === intent.id ? parse<{ leasedAt?: unknown }>(a.workspace) : null;
      const claimedAt = typeof lease?.leasedAt === "number" && Number.isFinite(lease.leasedAt) ? lease.leasedAt : undefined;
      Object.defineProperty(agents, a.id, {
        value: { id: a.id, name: a.name, kind: a.kind, ...(a.model ? { model: a.model } : {}), ...(claimedAt ? { claimedAt } : {}) },
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }

  // The landings of the landed changes, while the colony keeps them (its newest 1,000), and their certification.
  const landingIds = [...new Set(changes.flatMap((c) => (c.status === "landed" && c.landingId ? [c.landingId] : [])))];
  const landings = new Map<Id, { id: Id; trunkSha: Sha; parentSha: Sha; at: number; paths: string[] }>();
  if (landingIds.length > 0) {
    for (const l of sql.exec("SELECT id, trunk_sha, at, data FROM landings WHERE id IN (SELECT value FROM json_each(?))", JSON.stringify(landingIds)).toArray() as LandingRow[]) {
      const data = parse<Partial<Landing>>(l.data);
      const paths = Array.isArray(data?.paths) ? data.paths.filter((x): x is string => typeof x === "string") : [];
      landings.set(l.id, { id: l.id, trunkSha: l.trunk_sha, parentSha: typeof data?.parentSha === "string" ? data.parentSha : "", at: l.at, paths });
    }
  }
  const certified = await certifiedOf(host, [...landings.values()].filter((l) => l.trunkSha !== ""));

  const facts: Array<Omit<LifecycleFacts, "intent">> = changes.map((change) => {
    const landing = change.landingId ? landings.get(change.landingId) : undefined;
    const cert = landing ? certified.get(landing.id) : undefined;
    return { change, ...(landing ? { landing: { id: landing.id, trunkSha: landing.trunkSha, at: landing.at } } : {}), ...(cert ? { certified: cert } : {}) };
  });
  const holder = holderId ? (Object.hasOwn(agents, holderId) ? agents[holderId] : { id: holderId }) : undefined;
  return intentLifecycle({ colonyId: host.colonyId, intent: intentFacts(intent, host.updatedAt), changes: facts, ...(holder ? { holder } : {}), agents });
}
