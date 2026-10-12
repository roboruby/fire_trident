import type { AgentKind, ColonyEvent, DecisionKind, DecisionLayer, FunnelStage, Id, IntentField, IntentStatus, Millis, Path, ProposalStatus } from "@fire_trident/core";
import { isRedirect } from "./direction.ts";

/**
 * A reconstructed replay: the live events of a run that happened before the colony recorded them,
 * rebuilt from what it stores (rules, intents with their times, agents, proposals and their decide
 * outcomes, decisions, landings with their files, revisions and directives). Pure: ColonyDO reads the
 * rows, this orders them into ColonyEvents.
 *
 * What is exact: when rules, intents, agents, proposals, decisions, outcomes, landings, amendments,
 * withdrawals and directives happened, and the violations count and funnel they imply. What is
 * estimated: when an agent claimed an intent (just after its previous job settled, before it proposed),
 * and when a reaped agent died (its last sign of life). Field marks are not part of the record; the
 * replay derives them from intents, claims and landings.
 */

export interface ReconRule {
  id: Id;
  createdAt: Millis;
  retractedAt: Millis | null;
  retractedBy: string | null;
  retractReason: string | null;
}

export interface ReconIntent {
  id: Id;
  title: string;
  footprint: Path[];
  status: IntentStatus;
  ruleId: Id | null;
  /** Violations its file had when the rule created it (0 for intents a person declared). */
  violations: number;
  createdAt: Millis;
  updatedAt: Millis;
  withdrawnReason: string | null;
}

export interface ReconAgent {
  id: Id;
  kind: AgentKind;
  state: string;
  createdAt: Millis;
  lastSeen: Millis;
  stoppedAt: Millis | null;
}

export interface ReconProposal {
  id: Id;
  intentId: Id;
  agentId: Id;
  status: ProposalStatus;
  createdAt: Millis;
  updatedAt: Millis;
  reason: string | null;
  landingId: Id | null;
  /** Paths of its write set. */
  paths: Path[];
}

export interface ReconDecision {
  id: Id;
  kind: DecisionKind;
  subject: Id;
  layer: DecisionLayer;
  p: number;
  action: string;
  at: Millis;
}

/** What the decide arc concluded for a proposal (decide_outcomes), and the human decision if any. */
export interface ReconOutcome {
  proposalId: Id;
  layer: string;
  action: string;
  at: Millis;
  human: string | null;
  humanAt: Millis | null;
}

export interface ReconLanding {
  id: Id;
  /** When the colony recorded it (the live event's time). */
  at: Millis;
  trunkSha: string;
  proposalIds: Id[];
  intentIds: Id[];
  paths: Path[];
}

export interface ReconRevision {
  intentId: Id;
  revision: number;
  at: Millis;
  by: string;
  reason: string;
  changed: IntentField[];
  /** The title after the amendment, when it changed. */
  title: string | null;
}

export interface ReconDirective {
  id: Id;
  agentId: Id;
  intentId: Id | null;
  message: string;
  by: string;
  at: Millis;
  via: "push" | "inbox" | null;
}

/** Everything a reconstruction reads. Vaccine intents and proposals are left out by the caller. */
export interface ReconInput {
  rules: ReconRule[];
  intents: ReconIntent[];
  agents: ReconAgent[];
  proposals: ReconProposal[];
  decisions: ReconDecision[];
  outcomes: ReconOutcome[];
  landings: ReconLanding[];
  revisions: ReconRevision[];
  /** Human guidance only: revision and withdrawal notices are implied by the amended and withdrawn events. */
  directives: ReconDirective[];
  /** Who withdrew each withdrawn intent, from its withdrawal notice. */
  withdrawnBy: Record<Id, string>;
}

/** How long after its previous job settled an agent is shown claiming the next one. */
const CLAIM_LAG_MS = 300;

/** The stage of the funnel that settled a proposal with this outcome. */
export function settledStage(o: { layer: string; action: string; human: string | null }): FunnelStage {
  if (o.human || o.action === "escalate" || o.layer === "human") return "human";
  if (o.layer === "deterministic") return "proof";
  return o.layer === "reflex" || o.layer === "llm" ? o.layer : "human";
}

type Placeholder = { kind: "violations"; ruleId: Id; delta: number; retract?: boolean } | { kind: "funnel"; stage: FunnelStage };

/** Rebuild a run's live events, oldest first. */
export function reconstruct(input: ReconInput): ColonyEvent[] {
  const out: Array<{ at: number; n: number; e: ColonyEvent | null; ph?: Placeholder }> = [];
  let n = 0;
  const push = (e: ColonyEvent): void => {
    out.push({ at: e.at, n: n++, e });
  };
  const hold = (at: number, ph: Placeholder): void => {
    out.push({ at, n: n++, e: null, ph });
  };
  const fin = (x: number, fallback: number): number => (typeof x === "number" && Number.isFinite(x) ? x : fallback);

  const intents = new Map(input.intents.map((i) => [i.id, i]));
  const agents = new Map(input.agents.map((a) => [a.id, a]));
  const outcomes = new Map(input.outcomes.map((o) => [o.proposalId, o]));
  const landingsById = new Map(input.landings.map((l) => [l.id, l]));
  const landingOf = new Map<Id, ReconLanding>();
  for (const l of input.landings) for (const pid of l.proposalIds) landingOf.set(pid, l);
  const decisionsOf = new Map<Id, ReconDecision[]>();
  for (const d of input.decisions) {
    const list = decisionsOf.get(d.subject);
    if (list) list.push(d);
    else decisionsOf.set(d.subject, [d]);
  }
  const proposalById = new Map(input.proposals.map((p) => [p.id, p]));

  // Rules: their intents appear, then the count of violations they found.
  const ruleIntents = new Map<Id, ReconIntent[]>();
  for (const i of input.intents) {
    if (!i.ruleId) continue;
    const list = ruleIntents.get(i.ruleId);
    if (list) list.push(i);
    else ruleIntents.set(i.ruleId, [i]);
  }
  for (const i of input.intents) push({ t: "intent", at: i.createdAt, intentId: i.id, status: "open", title: i.title, footprint: i.footprint });
  for (const r of input.rules) {
    const list = ruleIntents.get(r.id) ?? [];
    const found = list.reduce((s, i) => s + Math.max(0, fin(i.violations, 0)), 0);
    const at = list.reduce((m, i) => Math.max(m, i.createdAt), r.createdAt);
    hold(at, { kind: "violations", ruleId: r.id, delta: found });
  }

  // Agents join.
  for (const a of input.agents) push({ t: "agent", at: a.createdAt, agentId: a.id, kind: a.kind, state: "idle" });

  // Each agent's jobs in order: claim (estimated), propose, the decide arc, the outcome.
  const lastFree = new Map<Id, number>();
  const synthLandings = new Map<Id, ReconLanding>();
  const byAgent = new Map<Id, ReconProposal[]>();
  for (const p of input.proposals) {
    const list = byAgent.get(p.agentId);
    if (list) list.push(p);
    else byAgent.set(p.agentId, [p]);
  }
  for (const [agentId, list] of byAgent) {
    list.sort((a, b) => a.createdAt - b.createdAt);
    const agent = agents.get(agentId);
    const kind: AgentKind = agent?.kind ?? "internal";
    let free = agent?.createdAt ?? 0;
    for (const p of list) {
      const intent = intents.get(p.intentId);
      if (!intent) continue;
      const fp = intent.footprint;
      const lo = Math.max(free, intent.createdAt);
      const claimAt = Math.max(Math.min(lo + CLAIM_LAG_MS, p.createdAt - 50), Math.min(lo, p.createdAt - 1));
      push({ t: "intent", at: claimAt, intentId: intent.id, status: "claimed", title: intent.title, footprint: fp });
      push({ t: "agent", at: claimAt, agentId, kind, state: "working", intentId: intent.id, paths: fp });
      const o = outcomes.get(p.id);
      push({ t: "proposal", at: p.createdAt, proposalId: p.id, intentId: p.intentId, agentId, status: o ? "checking" : "ready" });
      push({ t: "intent", at: p.createdAt, intentId: intent.id, status: "proposed", title: intent.title, footprint: fp });
      push({ t: "agent", at: p.createdAt, agentId, kind, state: "proposing", intentId: intent.id });
      for (const d of decisionsOf.get(p.id) ?? []) {
        push({ t: "decision", at: d.at, decisionId: d.id, kind: d.kind, layer: d.layer, p: d.p, action: d.action, subject: d.subject });
      }
      let settled = p.updatedAt;
      if (o) {
        const stage = settledStage(o);
        const at = o.layer === "human" ? (o.humanAt ?? o.at) : o.at;
        hold(at, { kind: "funnel", stage });
        if (o.action === "escalate") push({ t: "proposal", at: o.at, proposalId: p.id, intentId: p.intentId, agentId, status: "escalated" });
        else if (o.action === "land") push({ t: "proposal", at: o.at, proposalId: p.id, intentId: p.intentId, agentId, status: "ready" });
        if (o.human === "approve" && o.humanAt) push({ t: "proposal", at: o.humanAt, proposalId: p.id, intentId: p.intentId, agentId, status: "ready" });
      }
      if (p.status === "landed") {
        let l = landingOf.get(p.id) ?? (p.landingId ? landingsById.get(p.landingId) : undefined);
        if (!l) {
          // The landing log keeps the latest 1,000; an older landing is rebuilt from its proposal.
          const id = p.landingId ?? `lnd_${p.id}`;
          l = synthLandings.get(id);
          if (!l) {
            l = { id, at: p.updatedAt, trunkSha: "", proposalIds: [], intentIds: [], paths: [] };
            synthLandings.set(id, l);
          }
          l.proposalIds.push(p.id);
          l.intentIds.push(p.intentId);
          l.paths.push(...p.paths.filter((x) => !l!.paths.includes(x)));
        }
        settled = l.at;
        push({ t: "proposal", at: l.at, proposalId: p.id, intentId: p.intentId, agentId, status: "landed" });
        push({ t: "agent", at: l.at, agentId, kind, state: "idle" });
      } else if (p.status === "returned" || p.status === "rejected") {
        const reason = p.reason ?? undefined;
        push({ t: "proposal", at: p.updatedAt, proposalId: p.id, intentId: p.intentId, agentId, status: p.status, ...(reason ? { reason } : {}) });
        if (!isRedirect(reason)) push({ t: "intent", at: p.updatedAt, intentId: intent.id, status: "open", title: intent.title, footprint: fp });
        push({ t: "agent", at: p.updatedAt, agentId, kind, state: "idle" });
      } else if (p.status === "escalated" && o && o.action !== "escalate") {
        push({ t: "proposal", at: p.updatedAt, proposalId: p.id, intentId: p.intentId, agentId, status: "escalated" });
      }
      free = Math.max(free, settled);
    }
    lastFree.set(agentId, free);
  }

  // Landings: the commit, then its intents land (and their violations are fixed).
  const landedIntents = new Set<Id>();
  const landings = [...input.landings, ...synthLandings.values()].sort((a, b) => a.at - b.at);
  for (const l of landings) {
    push({ t: "landing", at: l.at, landingId: l.id, trunkSha: l.trunkSha, proposalIds: l.proposalIds, paths: l.paths });
    const ids = new Set(l.intentIds);
    for (const pid of l.proposalIds) {
      const p = proposalById.get(pid);
      if (p) ids.add(p.intentId);
    }
    for (const iid of ids) landIntent(iid, l.at);
  }
  function landIntent(iid: Id, at: number): void {
    const i = intents.get(iid);
    if (!i || i.status !== "landed" || landedIntents.has(iid)) return;
    landedIntents.add(iid);
    push({ t: "intent", at, intentId: i.id, status: "landed", title: i.title, footprint: i.footprint });
    if (i.ruleId && i.violations > 0) hold(at, { kind: "violations", ruleId: i.ruleId, delta: -i.violations });
  }
  // Landed intents whose landing is no longer in the log.
  for (const i of input.intents) if (i.status === "landed") landIntent(i.id, i.updatedAt);

  // Changing direction.
  for (const r of input.revisions) {
    const title = r.title ?? intents.get(r.intentId)?.title ?? r.intentId;
    push({ t: "amended", at: r.at, intentId: r.intentId, revision: r.revision, changed: r.changed, reason: r.reason, by: r.by, title, returned: 0 });
  }
  for (const i of input.intents) {
    if (i.status !== "withdrawn") continue;
    push({ t: "intent", at: i.updatedAt, intentId: i.id, status: "withdrawn", title: i.title, footprint: i.footprint });
    push({ t: "withdrawn", at: i.updatedAt, intentId: i.id, reason: i.withdrawnReason ?? "withdrawn", by: input.withdrawnBy[i.id] ?? "unknown", title: i.title, returned: 0, ...(i.ruleId ? { ruleId: i.ruleId } : {}) });
  }
  for (const r of input.rules) {
    if (r.retractedAt === null) continue;
    const withdrawn = (ruleIntents.get(r.id) ?? []).filter((i) => i.status === "withdrawn").length;
    push({ t: "retracted", at: r.retractedAt, ruleId: r.id, reason: r.retractReason ?? "retracted", by: r.retractedBy ?? "unknown", withdrawn });
    hold(r.retractedAt, { kind: "violations", ruleId: r.id, delta: 0, retract: true });
  }
  for (const d of input.directives) {
    push({ t: "directive", at: d.at, directiveId: d.id, agentId: d.agentId, ...(d.intentId ? { intentId: d.intentId } : {}), message: d.message, by: d.by, ...(d.via ? { via: d.via } : {}) });
  }

  // Agents leave: when they were stopped, or (reaped) after their last sign of life.
  for (const a of input.agents) {
    if (a.stoppedAt === null && a.state !== "dead") continue;
    const at = Math.max(a.stoppedAt ?? a.lastSeen, lastFree.get(a.id) ?? 0, a.createdAt);
    push({ t: "agent", at, agentId: a.id, kind: a.kind, state: "dead" });
  }

  out.sort((a, b) => a.at - b.at || a.n - b.n);

  // Totals: violations per rule as they rise and fall, and the funnel as proposals settle.
  const open = new Map<Id, number>();
  const retracted = new Set<Id>();
  const funnel: Record<FunnelStage, number> = { proof: 0, reflex: 0, llm: 0, human: 0 };
  const events: ColonyEvent[] = [];
  for (const x of out) {
    if (x.e) {
      events.push(x.e);
      continue;
    }
    const ph = x.ph;
    if (!ph) continue;
    if (ph.kind === "funnel") {
      funnel[ph.stage]++;
      events.push({ t: "metric", at: x.at, name: `funnel.${ph.stage}`, value: funnel[ph.stage] });
      continue;
    }
    if (retracted.has(ph.ruleId)) continue;
    if (ph.retract) {
      retracted.add(ph.ruleId);
      open.set(ph.ruleId, 0);
    } else {
      open.set(ph.ruleId, Math.max(0, (open.get(ph.ruleId) ?? 0) + ph.delta));
    }
    let total = 0;
    const byRule: Record<Id, number> = {};
    for (const [id, v] of open) {
      byRule[id] = v;
      total += v;
    }
    events.push({ t: "violations", at: x.at, total, byRule });
  }
  return events;
}
