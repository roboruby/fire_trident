// A copy of packages/core/src/lifecycle.ts: the published CLI ships without @fire_trident/core (scripts/vendor_cli.rb writes it; test/package.test.ts keeps the two the same).
import type { LandingTests } from "@fire_trident/core";
import { gateOf, personName } from "./answerable.ts";
import { CONFIRM_KINDS, CONFIRM_LABEL, changeConfirmed, type ConfirmKind } from "./decides.ts";
import { shortModel } from "./testdelta.ts";

/**
 * The lifecycle strip of a change, as every surface shows it (the Why tab's landing cards, the review card, the Intents
 * tab, `ft why`, `ft intent show`): one row of steps from the intent to a person's merge, each with its evidence, the step
 * reached marked, and where a change left the path. The steps:
 *
 *   declared   who declared the intent, and what they are (a person, a rule, an agent, certification, FireTrident)
 *   claimed    the agent that took it, its kind and model
 *   proposed   the change (proposal id)
 *   confirmed  what let it land: the confirming layer and the rule with its values (core/decides.ts changeConfirmed)
 *   landed     the landing and its trunk commit
 *   certified  the green certification that includes it, "not certified yet", or "no tests this platform can run"
 *   taken back pushing `certified` to the team's origin as a branch and opening a pull request: FireTrident cannot see
 *              this, so the step is always shown as outside FireTrident, with the command, and never as done
 *   merged     a person merging it in the team's forge: outside FireTrident too
 *
 * Off the path: returned (with the reason and the landing that beat it), escalated (waiting for a person), withdrawn,
 * and reaped (the closure ledger took the intent back from a silent agent). The worker reads the facts from what the
 * colony records (colony/lifecycle.ts, GET /api/colonies/:id/intents/:iid/lifecycle); a landing card builds them from
 * its lineage note (noteLifecycleFacts). Facts are read defensively: what is missing reads as not known. Pure: no I/O.
 */

/** The steps, in order. */
export const LIFECYCLE_STEPS = ["declared", "claimed", "proposed", "confirmed", "landed", "certified", "taken-back", "merged"] as const;

/** One step of the path. */
export type LifecycleStepKey = (typeof LIFECYCLE_STEPS)[number];

/** How each step is named. */
export const LIFECYCLE_LABEL: Record<LifecycleStepKey, string> = {
  declared: "Declared",
  claimed: "Claimed",
  proposed: "Proposed",
  confirmed: "Confirmed",
  landed: "Landed",
  certified: "Certified",
  "taken-back": "Taken back",
  merged: "Merged by a person",
};

/**
 * `done`: the change reached it; `todo`: not yet; `outside`: it happens in the team's forge, which FireTrident cannot
 * see, so it is never done here; `none`: it does not apply (no tests this platform can run).
 */
export type LifecycleStepState = "done" | "todo" | "outside" | "none";

/** What a step's evidence is, for a surface to link: the intent, the agent, the proposal, the landing, its certification, the take-back commands. */
export type LifecycleLinkKind = "intent" | "agent" | "proposal" | "landing" | "certification" | "take-back";

/** A step's evidence: its kind and id (a landing's and a certification's carry the commit too). */
export interface LifecycleLink {
  kind: LifecycleLinkKind;
  id: string;
  sha?: string;
}

/** One step as a surface draws it. */
export interface LifecycleStep {
  key: LifecycleStepKey;
  label: string;
  state: LifecycleStepState;
  /** What the step says: who, which change, which rule, which commit; or what is still to come. */
  text: string;
  /** When it happened (ms), where the colony recorded it. */
  at?: number;
  link?: LifecycleLink;
  /** The take-back step only: the command that does it. */
  command?: string;
}

/** Where a change can leave the path. */
export type LifecycleOffKind = "returned" | "escalated" | "withdrawn" | "reaped";

/** How each way off the path is named. */
export const LIFECYCLE_OFF_LABEL: Record<LifecycleOffKind, string> = { returned: "Returned", escalated: "Escalated", withdrawn: "Withdrawn", reaped: "Reaped" };

/** Where and why a change left the path. */
export interface LifecycleOff {
  kind: LifecycleOffKind;
  /** "Returned", "Rejected", "Escalated", "Withdrawn", "Reaped". */
  label: string;
  /** The last step it reached before it left. */
  after: LifecycleStepKey;
  /** Why, as the colony recorded it (a return's reason, the person it waits for, the withdrawal's reason, the silence). */
  text: string;
  at?: number;
  /** Returned only: the landing that beat it, when trunk moved its files. Its title was written by a person or an agent: data. */
  beatenBy?: { landingId: string; trunkSha?: string; title?: string };
  link?: LifecycleLink;
}

/** One change's strip (or an intent's, before it has a change). */
export interface ChangeLifecycle {
  intentId: string;
  /** Absent for an intent no change was proposed for yet (or the attempt of an agent that proposed none). */
  proposalId?: string;
  steps: LifecycleStep[];
  /** The furthest step reached: the one a surface marks. */
  reached: LifecycleStepKey;
  off?: LifecycleOff;
  /** The strip in one line. */
  text: string;
}

/** An intent's strips: the one it stands on now, and each of its changes, newest first. */
export interface IntentLifecycle {
  colonyId?: string;
  intentId: string;
  title?: string;
  current: ChangeLifecycle;
  changes: ChangeLifecycle[];
  caption: string;
}

/** What every strip says under it. */
export const LIFECYCLE_CAPTION = "FireTrident lands to its own trunk and never merges into your repository; the last two steps happen in your forge.";

/** The take-back command, run in a clone of the colony's `certified` branch (git clone -b certified <site>/git/<colony>.git). */
export const TAKE_BACK_PUSH = "git push <your-origin> certified:refs/heads/firetrident/certified";

/** Changes an intent's answer lists at most (newest first). */
export const LIFECYCLE_CHANGES = 20;

// ---------------------------------------------------------------------------
// Facts

/** The intent as the strip reads it. */
export interface LifecycleIntent {
  id: string;
  title?: string;
  /** IntentSource: human, rule, agent, certify, system, external. */
  source?: string;
  createdBy?: string;
  createdAt?: number;
  /** IntentStatus. */
  status?: string;
  withdrawnReason?: string;
  withdrawnAt?: number;
  /** An agent's report that waits for a person (an unresolved IntentEscalation). */
  report?: { kind: string; by?: string; at?: number };
  /** The closure ledger's latest record (IntentClosure). */
  closure?: { cause: string; at: number; agentId?: string; gapMs?: number };
}

/** A proposal as the strip reads it. */
export interface LifecycleChange {
  id: string;
  agentId?: string;
  /** ProposalStatus. */
  status: string;
  createdAt?: number;
  /** When it last changed status (its return, its landing), where known. */
  settledAt?: number;
  /** Why it went back or waits (Proposal.reason). */
  reason?: string;
  /** The landing that beat it (the first of Proposal.movedBy). */
  beatenBy?: { landingId: string; trunkSha?: string; title?: string };
  supersededBy?: string;
  landingId?: string;
  /** Its checks (the gate check names the rule) and its decide-arc decisions, as a lineage note keeps them. */
  evidence?: { checks?: unknown[] };
  decisions?: unknown[];
  /** When a person approved it (Proposal.approvedAt). */
  approvedAt?: number;
  /** A merge the trunk writer held for a person (Proposal.mergeHold). */
  held?: boolean;
}

/** The agent of a change, as the strip names it. */
export interface LifecycleAgent {
  id: string;
  name?: string;
  /** AgentKind: internal, external, synthetic. */
  kind?: string;
  model?: string;
  /** When it took the intent, where known (its workspace lease). */
  claimedAt?: number;
}

/** The landing of a change. */
export interface LifecycleLanding {
  id: string;
  trunkSha: string;
  at?: number;
}

/** Whether a certification includes the landing: certified (with the commit), pending (why), no tests this platform can run, or not known. */
export interface LifecycleCertified {
  status: "certified" | "pending" | "no-tests" | "unknown";
  sha?: string;
  at?: number;
  /** Why it is pending, has no tests, or is not known, as a clause. */
  reason?: string;
}

/** What one strip is computed from. */
export interface LifecycleFacts {
  intent: LifecycleIntent;
  change?: LifecycleChange;
  agent?: LifecycleAgent;
  landing?: LifecycleLanding;
  certified?: LifecycleCertified;
}

// ---------------------------------------------------------------------------
// Words

type Json = Record<string, unknown>;
const isObj = (x: unknown): x is Json => typeof x === "object" && x !== null && !Array.isArray(x);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const time = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);
const short = (sha: string): string => sha.slice(0, 7);

/** Text on one line, no control characters, at most `max` characters (ending in "…" when cut). */
function clip(v: unknown, max = 160): string {
  if (typeof v !== "string") return "";
  const one = v.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
}

/** A silence as words: "45 s", "1 min 37 s", "2 h 5 min". */
export function silenceWords(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return s % 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s / 60} min`;
  const m = Math.floor(s / 60);
  return m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m / 60} h`;
}

const KIND_WORDS: Record<string, string> = { internal: "in-platform agent", external: "outside agent", synthetic: "bench agent" };

/** Who declared an intent, and what they are: "Lee (a person)", "a rule (approved by Lee)", "trunk certification". */
export function declaredText(i: Pick<LifecycleIntent, "source" | "createdBy">): string {
  const who = personName(i.createdBy);
  const named = who ? clip(who, 60) : "";
  switch (i.source) {
    case "human":
      // "api" and the like say a person gave no name; an absent field says only that the record does not name one.
      return named ? `${named} (a person)` : typeof i.createdBy === "string" && i.createdBy.trim() !== "" ? "a person who gave no name" : "a person";
    case "rule":
      // A rule's intents are declared in the name of the person who approved the rule.
      return named ? `a rule approved by ${named}` : "a rule";
    case "agent":
      return named ? `an agent (${named})` : "an agent";
    case "certify":
      return "trunk certification, to repair failing tests";
    case "system":
      return "FireTrident itself";
    case "external":
      // An imported issue (worker colony/issues.ts): a stranger wrote it; a person brought it in.
      return named ? `a public issue, imported by ${named}` : "a public issue";
    default:
      return named || "not recorded";
  }
}

/** An agent as the claimed step names it: "agt_1 (outside agent, gemma-4-26b-a4b-it)". */
function agentText(a: LifecycleAgent): string {
  const name = clip(a.name, 60) || clip(a.id, 60);
  const kind = a.kind ? (KIND_WORDS[a.kind] ?? clip(a.kind, 20)) : "";
  const model = a.model ? shortModel(clip(a.model, 120)) : "";
  const about = [kind, model].filter(Boolean).join(", ");
  return about ? `${name} (${about})` : name;
}

/** The decisions of a change as changeConfirmed reads them: a person's approval with who gave it. */
function humanApproval(decisions: readonly unknown[]): { by?: string; at?: number } | null {
  for (let i = decisions.length - 1; i >= 0; i--) {
    const d = decisions[i];
    if (isObj(d) && d.layer === "human" && d.action === "approve") return { ...(typeof d.by === "string" ? { by: d.by } : {}), ...(time(d.at) ? { at: time(d.at) } : {}) };
  }
  return null;
}

/** The newest time among a change's decisions (the gate decides right after its last layer). */
function lastDecisionAt(decisions: readonly unknown[]): number | undefined {
  let at: number | undefined;
  for (const d of decisions) {
    const t = isObj(d) ? time(d.at) : undefined;
    if (t !== undefined && (at === undefined || t > at)) at = t;
  }
  return at;
}

/** The confirmed step's words: the layer, then the rule with its values ("earned autonomy: R3: confidence 0.93 ≥ 0.85, ..."). */
function confirmedText(c: LifecycleChange): { text: string; at?: number } {
  const decisions = list(c.decisions);
  const conf = changeConfirmed({ evidence: { checks: list(c.evidence?.checks) }, decisions });
  const approval = humanApproval(decisions);
  if (conf.rung === "person" || (approval === null && typeof c.approvedAt === "number" && conf.rung !== "deterministic")) {
    const at = time(c.approvedAt) ?? approval?.at;
    const text = conf.rung === "person" ? conf.text : "A person approved it.";
    return { text, ...(at ? { at } : {}) };
  }
  const at = lastDecisionAt(decisions);
  const label = (CONFIRM_KINDS as readonly string[]).includes(conf.rung) ? CONFIRM_LABEL[conf.rung as ConfirmKind] : "";
  const text = conf.rung === "unreviewed" || conf.rung === "unknown" || !label ? conf.text : `${label}: ${conf.text}`;
  return { text, ...(at ? { at } : {}) };
}

/** The rule that sent a change somewhere other than its lane ("R5 innate+reflex"), from its gate check, or "". */
function gateRule(c: LifecycleChange): string {
  return changeConfirmed({ evidence: { checks: list(c.evidence?.checks) }, decisions: list(c.decisions) }).ruleName;
}

// ---------------------------------------------------------------------------
// One strip

/** Is a proposal status one still on its way (not landed, not sent back)? */
function inFlight(status: string): boolean {
  return status === "pending" || status === "checking" || status === "ready" || status === "escalated";
}

/**
 * One change's strip (or an intent's attempt before a change): each step's state, words, time and evidence, the step
 * reached, and where it left the path. A landed change never leaves it; a withdrawn intent's change leaves it as
 * withdrawn; a change sent back leaves it as returned (after `confirmed` when the gate had let it through and trunk
 * moved before it landed); one waiting for a person as escalated. Without a change: an agent's report waiting for a
 * person is escalated, and a closure that took the intent back from a silent agent is reaped.
 */
export function changeLifecycle(f: LifecycleFacts): ChangeLifecycle {
  const i = f.intent;
  const c = f.change;
  const landing = f.landing ?? (c?.status === "landed" && c.landingId ? { id: c.landingId, trunkSha: "" } : undefined);
  const landed = !!landing;
  const agentId = c?.agentId ?? f.agent?.id;
  const agent: LifecycleAgent | undefined = agentId ? { ...(f.agent?.id === agentId ? f.agent : {}), id: agentId } : undefined;
  const gate = c ? gateOf(list(c.evidence?.checks)) : null;
  const approved = !!c && (typeof c.approvedAt === "number" || humanApproval(list(c.decisions)) !== null);
  // The gate let it through: it landed, waits in its lane, a person approved it, or the gate said land and then trunk
  // moved (a return from the lane, or a merge held for a person).
  const confirmed = !!c && (landed || c.status === "ready" || approved || (gate?.action === "land" && (c.held === true || (c.status !== "escalated" && c.status !== "pending" && c.status !== "checking"))));

  const steps: LifecycleStep[] = [];
  const step = (key: LifecycleStepKey, state: LifecycleStepState, text: string, extra: Partial<LifecycleStep> = {}): void => {
    const at = time(extra.at);
    steps.push({ key, label: LIFECYCLE_LABEL[key], state, text, ...(at ? { at } : {}), ...(extra.link ? { link: extra.link } : {}), ...(extra.command ? { command: extra.command } : {}) });
  };

  step("declared", "done", declaredText(i), { at: i.createdAt, link: { kind: "intent", id: i.id } });
  // A change was proposed by an agent that held the intent, even when the record does not name it.
  step("claimed", agent || c ? "done" : "todo", agent ? agentText(agent) : c ? "an agent the colony did not name" : "no agent has taken it yet", { ...(agent ? { at: agent.claimedAt, link: { kind: "agent", id: agent.id } } : {}) });
  step("proposed", c ? "done" : "todo", c ? clip(c.id, 80) : "no change proposed yet", { ...(c ? { at: c.createdAt, link: { kind: "proposal", id: c.id } } : {}) });
  if (c && confirmed) {
    const conf = confirmedText(c);
    step("confirmed", "done", conf.text, { at: conf.at, link: { kind: "proposal", id: c.id } });
  } else {
    step("confirmed", "todo", c && inFlight(c.status) && c.status !== "escalated" ? "the gate has not decided yet" : "not confirmed");
  }
  if (landing) {
    step("landed", "done", landing.trunkSha ? `${clip(landing.id, 80)} · ${short(landing.trunkSha)}` : clip(landing.id, 80), { at: landing.at, link: { kind: "landing", id: landing.id, ...(landing.trunkSha ? { sha: landing.trunkSha } : {}) } });
  } else {
    step("landed", "todo", "not landed");
  }
  const cert = f.certified;
  if (!landing) step("certified", "todo", "after it lands");
  else if (cert?.status === "certified" && cert.sha) {
    step("certified", "done", `certified commit ${short(cert.sha)} includes it`, { at: cert.at, link: { kind: "certification", id: landing.id, sha: cert.sha } });
  } else if (cert?.status === "no-tests") {
    step("certified", "none", `no tests this platform can run${cert.reason ? `: ${clip(cert.reason, 120)}` : ""}`, { link: { kind: "certification", id: landing.id } });
  } else if (cert?.status === "unknown") {
    step("certified", "todo", `not known here${cert.reason ? `: ${clip(cert.reason, 160)}` : ""}`, { link: { kind: "certification", id: landing.id } });
  } else {
    step("certified", "todo", `not certified yet${cert?.reason ? `: ${clip(cert.reason, 120)}` : ""}`, { link: { kind: "certification", id: landing.id } });
  }
  step("taken-back", "outside", "outside FireTrident: push certified as a branch and open a pull request", { command: TAKE_BACK_PUSH, link: { kind: "take-back", id: "take-back" } });
  step("merged", "outside", "outside FireTrident: a person merges it in your forge");

  let reached: LifecycleStepKey = "declared";
  for (const s of steps) if (s.state === "done") reached = s.key;
  const off = landed ? undefined : offPath(f, c, agent, reached, confirmed, approved);
  const head = off ? `${off.label} after ${LIFECYCLE_LABEL[off.after].toLowerCase()}: ${off.text}` : `${LIFECYCLE_LABEL[reached]}: ${steps.find((s) => s.key === reached)?.text ?? ""}`;
  const next = !off && landed ? `; next, ${steps.find((s) => s.key === "certified")?.state === "done" ? "outside FireTrident: push certified as a branch and open a pull request" : (steps.find((s) => s.key === "certified")?.text ?? "")}` : "";
  return { intentId: i.id, ...(c ? { proposalId: c.id } : {}), steps, reached, ...(off ? { off } : {}), text: `${head}${next}` };
}

/** Where a change that did not land left the path, if it did (see changeLifecycle). */
function offPath(f: LifecycleFacts, c: LifecycleChange | undefined, agent: LifecycleAgent | undefined, reached: LifecycleStepKey, confirmed: boolean, approved: boolean): LifecycleOff | undefined {
  const i = f.intent;
  if (i.status === "withdrawn") {
    const at = time(i.withdrawnAt);
    return { kind: "withdrawn", label: LIFECYCLE_OFF_LABEL.withdrawn, after: reached, text: clip(i.withdrawnReason, 200) || "a person withdrew the intent", ...(at ? { at } : {}), link: { kind: "intent", id: i.id } };
  }
  if (c) {
    const at = time(c.settledAt);
    const after: LifecycleStepKey = confirmed ? "confirmed" : "proposed";
    if (c.status === "returned" || c.status === "rejected") {
      const beaten = c.beatenBy && typeof c.beatenBy.landingId === "string" && c.beatenBy.landingId !== "" ? c.beatenBy : undefined;
      const text = c.supersededBy ? `another attempt at the intent landed instead (${clip(c.supersededBy, 80)})` : clip(c.reason, 240) || (c.status === "rejected" ? "a person or the review rejected it" : "sent back to its agent");
      return {
        kind: "returned",
        label: c.status === "rejected" ? "Rejected" : LIFECYCLE_OFF_LABEL.returned,
        after,
        text,
        ...(at ? { at } : {}),
        ...(beaten
          ? { beatenBy: { landingId: clip(beaten.landingId, 80), ...(beaten.trunkSha ? { trunkSha: clip(beaten.trunkSha, 40) } : {}), ...(beaten.title ? { title: clip(beaten.title, 120) } : {}) }, link: { kind: "landing" as const, id: clip(beaten.landingId, 80), ...(beaten.trunkSha ? { sha: clip(beaten.trunkSha, 40) } : {}) } }
          : {}),
      };
    }
    if (c.status === "escalated") {
      const rule = gateRule(c);
      const why = approved && c.held
        ? "a person approved it, then trunk moved: the merge waits for a person to approve it again"
        : clip(c.reason, 200)
          ? `waiting for a person: ${clip(c.reason, 200)}`
          : `waiting for a person${rule ? `: ${rule} sent it to one` : ""}`;
      return { kind: "escalated", label: LIFECYCLE_OFF_LABEL.escalated, after, text: why, ...(at ? { at } : {}), link: { kind: "proposal", id: c.id } };
    }
    return undefined;
  }
  if (i.report) {
    const who = agent ? clip(agent.name, 60) || clip(agent.id, 60) : clip(i.report.by, 60) || "its agent";
    const at = time(i.report.at);
    return { kind: "escalated", label: LIFECYCLE_OFF_LABEL.escalated, after: reached, text: `${who} reported it as ${clip(i.report.kind, 40) || "not doable"}: waiting for a person to amend, withdraw or dismiss it`, ...(at ? { at } : {}), link: { kind: "intent", id: i.id } };
  }
  const closure = i.closure;
  if (closure && closure.cause === "reaped_silent" && i.status === "open" && (!agent || !closure.agentId || closure.agentId === agent.id)) {
    const who = agent ? clip(agent.name, 60) || clip(agent.id, 60) : clip(closure.agentId, 60) || "its agent";
    const gap = typeof closure.gapMs === "number" && Number.isFinite(closure.gapMs) ? ` for ${silenceWords(closure.gapMs)}` : "";
    const at = time(closure.at);
    return { kind: "reaped", label: LIFECYCLE_OFF_LABEL.reaped, after: reached, text: `the colony took it back: ${who} was silent${gap}; it is open for the next agent`, ...(at ? { at } : {}), link: { kind: "intent", id: i.id } };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// An intent

/** What intentLifecycle reads: the intent, each of its changes with what the colony knows of it, and the agents. */
export interface IntentLifecycleInput {
  colonyId?: string;
  intent: LifecycleIntent;
  changes: Array<Omit<LifecycleFacts, "intent">>;
  /** The agent that holds the intent now (claimed or proposed), when one does. */
  holder?: LifecycleAgent;
  /** Agents by id, to name the agent of a report or of a closure. */
  agents?: Record<string, LifecycleAgent>;
}

/**
 * An intent's strips: one per change, newest first (at most LIFECYCLE_CHANGES), and the one it stands on now: its
 * landed change, else its change on the way, else, while an agent holds it, that agent's last change (sent back, it
 * redoes it) or its attempt, else the intent as it stands (an agent's report waiting for a person, a closure that took
 * it back from a silent agent, or open).
 */
export function intentLifecycle(input: IntentLifecycleInput): IntentLifecycle {
  const intent = input.intent;
  const agents = input.agents ?? {};
  const facts = [...input.changes]
    .filter((x) => x.change && typeof x.change.id === "string")
    .sort((a, b) => (time(b.change?.createdAt) ?? 0) - (time(a.change?.createdAt) ?? 0));
  const strip = (x: Omit<LifecycleFacts, "intent">): ChangeLifecycle => {
    const id = x.change?.agentId;
    const agent = x.agent ?? (id && Object.hasOwn(agents, id) ? agents[id] : undefined);
    return changeLifecycle({ intent, ...x, ...(agent ? { agent } : {}) });
  };
  const named = (id: string | undefined): LifecycleAgent | undefined => (id ? (Object.hasOwn(agents, id) ? agents[id]! : { id }) : undefined);
  const changes = facts.slice(0, LIFECYCLE_CHANGES).map(strip);

  const pick = facts.find((x) => x.change?.status === "landed") ?? facts.find((x) => inFlight(x.change?.status ?? ""));
  let current: ChangeLifecycle;
  if (pick) current = strip(pick);
  else if (intent.status === "withdrawn" && facts[0]) current = strip(facts[0]);
  else if ((intent.status === "claimed" || intent.status === "proposed") && input.holder) {
    const last = facts[0];
    current = last && last.change?.agentId === input.holder.id ? strip(last) : changeLifecycle({ intent, agent: input.holder });
  } else {
    // Open (or withdrawn with no change): who reported it, or whom the colony took it back from, holds the claimed step.
    const who = intent.report?.by ?? (intent.closure?.cause === "reaped_silent" && intent.status === "open" ? intent.closure.agentId : undefined);
    const agent = named(who);
    current = changeLifecycle({ intent, ...(agent ? { agent } : {}) });
  }
  return {
    ...(input.colonyId ? { colonyId: input.colonyId } : {}),
    intentId: intent.id,
    ...(intent.title ? { title: clip(intent.title, 200) } : {}),
    current,
    changes,
    caption: LIFECYCLE_CAPTION,
  };
}

// ---------------------------------------------------------------------------
// From a landing card

/**
 * The facts of one landed change from its lineage note (the Why tab's cards, `ft why`): the intent as the note records
 * it, the change with its checks and decisions, the agent and its model, the landing; `extra` adds what the note does not
 * carry (when the intent was declared, the agent's name, whether a certification includes the landing).
 */
export function noteLifecycleFacts(landing: { id: string; trunkSha: string; at?: number }, entry: unknown, extra: { createdAt?: number; agentName?: string; certified?: LifecycleCertified | null } = {}): LifecycleFacts {
  const p = isObj(entry) ? entry : {};
  const intent = isObj(p.intent) ? p.intent : {};
  const agentId = typeof p.agentId === "string" ? p.agentId : undefined;
  const at = time(landing.at);
  return {
    intent: {
      id: typeof intent.id === "string" ? intent.id : "?",
      ...(typeof intent.title === "string" ? { title: intent.title } : {}),
      ...(typeof intent.source === "string" ? { source: intent.source } : {}),
      ...(typeof intent.createdBy === "string" ? { createdBy: intent.createdBy } : {}),
      ...(time(extra.createdAt) ? { createdAt: time(extra.createdAt) } : {}),
      status: "landed",
    },
    change: {
      id: typeof p.id === "string" ? p.id : "?",
      ...(agentId ? { agentId } : {}),
      status: "landed",
      landingId: landing.id,
      evidence: { checks: list(isObj(p.evidence) ? p.evidence.checks : undefined) },
      decisions: list(p.decisions),
    },
    ...(agentId
      ? { agent: { id: agentId, ...(extra.agentName ? { name: extra.agentName } : {}), ...(typeof p.agentKind === "string" ? { kind: p.agentKind } : {}), ...(typeof p.model === "string" && p.model ? { model: p.model } : {}) } }
      : {}),
    landing: { id: landing.id, trunkSha: typeof landing.trunkSha === "string" ? landing.trunkSha : "", ...(at ? { at } : {}) },
    ...(extra.certified ? { certified: extra.certified } : {}),
  };
}

/** A landing's own certification from its lineage note: green certifies it at its own commit; anything else says nothing. */
export function noteCertified(certification: unknown, trunkSha: string): LifecycleCertified | null {
  if (!isObj(certification) || certification.status !== "green" || !trunkSha) return null;
  const at = time(certification.finishedAt);
  return { status: "certified", sha: trunkSha, ...(at ? { at } : {}) };
}

/** A landing's test row (GET /landings/:ref/tests) as the certified step reads it. */
export function testsCertified(t: Pick<LandingTests, "status" | "certified" | "reason"> | null | undefined): LifecycleCertified | null {
  if (!t || typeof t !== "object") return null;
  if (t.status === "certified" && t.certified && typeof t.certified.sha === "string") return { status: "certified", sha: t.certified.sha };
  if (t.status === "no-tests") return { status: "no-tests", ...(t.reason ? { reason: t.reason } : {}) };
  if (t.status === "pending") return { status: "pending", ...(t.reason ? { reason: t.reason } : {}) };
  return null;
}

/**
 * Whether the colony's newest green commit includes a landing, from what a page or a status read already holds (the
 * green commit, the recent landings with their times, whether certification found nothing to run): trunk is a line of
 * landings, so a green commit that landed at or after it includes it. `unknown` when the green commit is not among the
 * landings it holds.
 */
export function placeCertified(landing: { trunkSha: string; at?: number }, colony: { greenSha?: string | null; landings?: ReadonlyArray<{ trunkSha: string; at: number }>; noTests?: string | null }): LifecycleCertified {
  const green = typeof colony.greenSha === "string" ? colony.greenSha : "";
  if (green && green === landing.trunkSha) return { status: "certified", sha: green };
  const at = time(landing.at);
  const placed = green ? (colony.landings ?? []).find((l) => l && l.trunkSha === green) : undefined;
  if (placed && at !== undefined && placed.at >= at) return { status: "certified", sha: green };
  if (colony.noTests) return { status: "no-tests", reason: colony.noTests };
  if (placed) return { status: "pending", reason: `the newest certified commit, ${short(green)}, is older` };
  if (!green) return { status: "pending" };
  return { status: "unknown", reason: "the newest certified commit is not among the landings this page holds; its tests say" };
}

// ---------------------------------------------------------------------------
// The server's answer, read defensively

const STEP_KEYS: ReadonlySet<string> = new Set(LIFECYCLE_STEPS);
const STATES: ReadonlySet<string> = new Set(["done", "todo", "outside", "none"]);
const LINKS: ReadonlySet<string> = new Set(["intent", "agent", "proposal", "landing", "certification", "take-back"]);
const OFFS: ReadonlySet<string> = new Set(["returned", "escalated", "withdrawn", "reaped"]);

function linkOf(v: unknown): LifecycleLink | undefined {
  if (!isObj(v) || typeof v.kind !== "string" || !LINKS.has(v.kind) || typeof v.id !== "string" || v.id === "") return undefined;
  return { kind: v.kind as LifecycleLinkKind, id: clip(v.id, 80), ...(typeof v.sha === "string" && /^[0-9a-f]{7,64}$/.test(v.sha) ? { sha: v.sha } : {}) };
}

/** One strip from a server or a recording, or null when it is not one: every step is checked, unknown ones dropped. */
export function changeLifecycleOf(raw: unknown): ChangeLifecycle | null {
  if (!isObj(raw) || typeof raw.intentId !== "string") return null;
  const steps: LifecycleStep[] = [];
  for (const s of list(raw.steps)) {
    if (!isObj(s) || typeof s.key !== "string" || !STEP_KEYS.has(s.key) || typeof s.state !== "string" || !STATES.has(s.state)) continue;
    if (steps.some((x) => x.key === s.key)) continue;
    const at = time(s.at);
    const link = linkOf(s.link);
    steps.push({
      key: s.key as LifecycleStepKey,
      label: clip(s.label, 40) || LIFECYCLE_LABEL[s.key as LifecycleStepKey],
      state: s.state as LifecycleStepState,
      text: clip(s.text, 400),
      ...(at ? { at } : {}),
      ...(link ? { link } : {}),
      ...(typeof s.command === "string" && s.command ? { command: clip(s.command, 200) } : {}),
    });
  }
  if (steps.length === 0) return null;
  steps.sort((a, b) => LIFECYCLE_STEPS.indexOf(a.key) - LIFECYCLE_STEPS.indexOf(b.key));
  const reached = typeof raw.reached === "string" && STEP_KEYS.has(raw.reached) ? (raw.reached as LifecycleStepKey) : "declared";
  let off: LifecycleOff | undefined;
  const o = raw.off;
  if (isObj(o) && typeof o.kind === "string" && OFFS.has(o.kind)) {
    const at = time(o.at);
    const link = linkOf(o.link);
    const b = isObj(o.beatenBy) && typeof o.beatenBy.landingId === "string" && o.beatenBy.landingId ? o.beatenBy : null;
    off = {
      kind: o.kind as LifecycleOffKind,
      label: clip(o.label, 40) || LIFECYCLE_OFF_LABEL[o.kind as LifecycleOffKind],
      after: typeof o.after === "string" && STEP_KEYS.has(o.after) ? (o.after as LifecycleStepKey) : reached,
      text: clip(o.text, 400),
      ...(at ? { at } : {}),
      ...(b ? { beatenBy: { landingId: clip(b.landingId, 80), ...(typeof b.trunkSha === "string" ? { trunkSha: clip(b.trunkSha, 40) } : {}), ...(typeof b.title === "string" ? { title: clip(b.title, 120) } : {}) } } : {}),
      ...(link ? { link } : {}),
    };
  }
  return { intentId: clip(raw.intentId, 80), ...(typeof raw.proposalId === "string" ? { proposalId: clip(raw.proposalId, 80) } : {}), steps, reached, ...(off ? { off } : {}), text: clip(raw.text, 600) };
}

/** An intent's answer (GET /api/colonies/:id/intents/:iid/lifecycle), or null when it is not one (an older server, an error). */
export function intentLifecycleOf(raw: unknown): IntentLifecycle | null {
  if (!isObj(raw) || typeof raw.intentId !== "string") return null;
  const current = changeLifecycleOf(raw.current);
  if (!current) return null;
  const changes = list(raw.changes)
    .slice(0, LIFECYCLE_CHANGES)
    .map(changeLifecycleOf)
    .filter((x): x is ChangeLifecycle => x !== null);
  return {
    ...(typeof raw.colonyId === "string" ? { colonyId: clip(raw.colonyId, 64) } : {}),
    intentId: clip(raw.intentId, 80),
    ...(typeof raw.title === "string" ? { title: clip(raw.title, 200) } : {}),
    current,
    changes,
    caption: LIFECYCLE_CAPTION,
  };
}
