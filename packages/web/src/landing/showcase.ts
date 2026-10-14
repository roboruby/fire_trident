import { fmtInt } from "../format.ts";

/**
 * Two cards of the results strip (Results.tsx) about runs on the live service: `scale`, thousands of synthetic agents in
 * one repository, and `goals`, agents whose goals disagree, where the colony held the changes that would undo another's
 * landing for a person. Each reads only routes that answer without a token (metrics, the event record, the colony
 * listing, one proposal, one intent) and has nothing to show (null) until its colony has run.
 */

/** Reads JSON from the API; rejects when the read fails (injected, so tests answer it). */
export type GetJson = (url: string) => Promise<unknown>;

/** What a card says: the big number, the line under it, the details, and where the colony came from. */
export interface ShowcaseCard {
  headline: string;
  lede: string;
  details: string[];
  origin: string;
}

type Json = Record<string, unknown>;
const isObj = (x: unknown): x is Json => typeof x === "object" && x !== null && !Array.isArray(x);
const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);
const str = (x: unknown): string => (typeof x === "string" ? x.replace(/\s+/g, " ").trim() : "");
const api = (id: string): string => `/api/colonies/${encodeURIComponent(id)}`;

const WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
/** Small counts in words ("three agents"), larger ones in digits. */
function words(n: number): string {
  return WORDS[n] ?? fmtInt(n);
}

// ---------------------------------------------------------------------------
// scale: thousands of synthetic agents in one repository
// ---------------------------------------------------------------------------

/** What the scale card reads: the colony's metrics. */
export interface ScaleFacts {
  /** Trunk commits landed (the `landings` metric): each holds a batch of up to 50 changes. */
  landings: number;
  /** Changes landed: each synthetic intent is one change that adds one new file. */
  landedIntents: number;
  /** Agents that ever joined (the `agents` metric counts stopped ones too, and the setup probe). */
  agents: number;
}

/** The conditions of a synthetic run, in one line: what the number does and does not measure. */
export const SCALE_CONDITIONS = "synthetic agents: no model calls, review off, each change adds one new file";

/** Fewer changes landed than this is a setup or a probe, not a run at scale: the card waits for the run. */
export const SCALE_MIN_LANDINGS = 100;

/**
 * The scale card, or null before the run (fewer than SCALE_MIN_LANDINGS changes landed). The colony keeps no time to
 * land and its record starts with the setup probe, so the run's rates come from the load generator, as a measured line.
 */
export function scaleCard(f: ScaleFacts): ShowcaseCard | null {
  if (!(f.landedIntents >= SCALE_MIN_LANDINGS)) return null;
  const commits = f.landings > 0 ? `, in ${fmtInt(f.landings)} trunk ${f.landings === 1 ? "commit" : "commits"}` : "";
  return {
    headline: `${fmtInt(f.landedIntents)} ${f.landedIntents === 1 ? "change" : "changes"} landed`,
    lede: `by ${fmtInt(f.agents)} synthetic ${f.agents === 1 ? "agent" : "agents"} in one repository${commits}`,
    details: [SCALE_CONDITIONS],
    origin: "synthetic agents, no models",
  };
}

/** The scale card from the colony's metrics, or null before the run. */
export async function loadScaleCard(metric: (name: string) => number): Promise<ShowcaseCard | null> {
  return scaleCard({ landings: metric("landings"), landedIntents: metric("landedIntents"), agents: metric("agents") });
}

// ---------------------------------------------------------------------------
// goals: changes held because they would undo another goal's landing
// ---------------------------------------------------------------------------

/** A person's decision on a held change. */
export type Decision = "approve" | "reject" | "return";

/** One change the goal-conflict check held for a person: its intent, its agent, where it stands, what a person decided. */
export interface HeldChange {
  id: string;
  intentId: string;
  agentId: string;
  title: string;
  status: string;
  decision: Decision | null;
}

/** What the goals card reads: the held changes, and the landing they would undo (its intent and the agent that wrote it). */
export interface GoalsFacts {
  held: HeldChange[];
  undone: { landingId: string; intentId: string; title: string; agentId: string | null } | null;
}

/** "the Go version" for an intent titled "Move the order backend to Go"; any other title quoted whole. */
export function versionOf(title: string): string {
  const m = /\bto ([A-Z][\w+#.-]*)$/.exec(title.trim());
  return m ? `the ${m[1]} version` : `“${title}”`;
}

/** What became of a held change, in words, when a person decided it (or it left the queue another way); null while it waits. */
function outcome(h: HeldChange): string | null {
  const v = versionOf(h.title);
  if (h.decision === "approve") {
    if (h.status === "landed") return `a person kept ${v}`;
    if (h.status === "returned" || h.status === "rejected") return `a person approved ${v}, and it went back to its agent`;
    return `a person approved ${v}`;
  }
  if (h.decision === "return") return `a person sent ${v} back to its agent`;
  if (h.decision === "reject") return `a person rejected ${v}`;
  if (h.status === "escalated") return null;
  return h.status === "landed" ? `${v} landed` : `${v} went back to its agent`;
}

/** The goals card, or null when no change was held for a goal conflict. */
export function goalsCard(f: GoalsFacts): ShowcaseCard | null {
  const held = f.held;
  if (held.length === 0) return null;
  const waiting = held.filter((h) => h.status === "escalated").length;
  const agents = new Set([...held.map((h) => h.agentId), ...(f.undone?.agentId ? [f.undone.agentId] : [])].filter((a) => a !== "")).size;
  const goals = new Set([...held.map((h) => h.intentId), ...(f.undone ? [f.undone.intentId] : [])].filter((i) => i !== "")).size;
  const titles = [...held.map((h) => h.title), ...(f.undone ? [f.undone.title] : [])];
  const languages = titles.every((t) => versionOf(t).startsWith("the "));
  const others = held.length === 1 ? "the other" : "the others";
  const verb = waiting > 0 ? "would undo it" : "would have undone it";
  const details: string[] = [];
  if (f.undone) {
    const who = held.length === 1 ? "it" : held.length === 2 ? "both" : "each";
    details.push(`${who} ${waiting > 0 ? "would undo" : "would have undone"} the landing of “${f.undone.title}”`);
  }
  for (const h of held) {
    const said = outcome(h);
    if (said) details.push(said);
  }
  details.push("held by a deterministic check, not a model");
  return {
    headline: waiting > 0 ? `${fmtInt(waiting)} ${waiting === 1 ? "change waits" : "changes wait"} for a person` : "Decided by a person",
    lede: `${words(agents)} ${agents === 1 ? "agent" : "agents"} ${languages ? `moved one backend to ${words(goals)} languages` : `had ${words(goals)} goals for one file`}; the first landed and ${others} ${verb}`,
    details,
    origin: "scripted agents over MCP",
  };
}

/** Pages of the event record the goals card reads at most (a demo colony's whole record fits in the first). */
const RECORD_PAGES = 4;
const PAGE = 5_000;
/** Held changes whose records the card reads at most. */
const HELD_MAX = 10;

/** The colony's event record, oldest first, up to RECORD_PAGES pages (GET /events: public). */
async function recordOf(id: string, get: GetJson): Promise<Json[]> {
  const out: Json[] = [];
  let after = 0;
  for (let i = 0; i < RECORD_PAGES; i++) {
    const page = await get(`${api(id)}/events?after=${after}&limit=${PAGE}`);
    if (!isObj(page) || !Array.isArray(page.events)) break;
    out.push(...page.events.filter(isObj));
    const next = num(page.next);
    if (next === null || next <= after) break;
    after = next;
  }
  return out;
}

/** The decision a human layer's decision event records ("approve", "reject" or "return"), or null. */
function decisionOf(action: unknown): Decision | null {
  return action === "approve" || action === "reject" || action === "return" ? action : null;
}

/**
 * The goals card: from the colony's event record, the changes the goal-conflict check sent to a person (their reasons say
 * what they "would undo") and what a person decided; from each one's own record (GET /proposals/:pid) where it stands now
 * and the landing it would undo; that landing's intent from the record, or GET /intents/:iid.
 */
export async function loadGoalsCard(id: string, get: GetJson): Promise<ShowcaseCard | null> {
  const events = await recordOf(id, get);
  const titles = new Map<string, string>();
  const byProposal = new Map<string, { intentId: string; agentId: string }>();
  const heldIds: string[] = [];
  const decisions = new Map<string, Decision>();
  const landed = new Map<string, string[]>();
  for (const e of events) {
    if (e.t === "intent" && typeof e.intentId === "string" && str(e.title)) titles.set(e.intentId, str(e.title));
    else if (e.t === "proposal" && typeof e.proposalId === "string") {
      byProposal.set(e.proposalId, { intentId: str(e.intentId), agentId: str(e.agentId) });
      if (e.status === "escalated" && /would undo/.test(str(e.reason)) && !heldIds.includes(e.proposalId)) heldIds.push(e.proposalId);
    } else if (e.t === "decision" && e.layer === "human" && typeof e.subject === "string") {
      const d = decisionOf(e.action);
      if (d) decisions.set(e.subject, d);
    } else if (e.t === "landing" && typeof e.landingId === "string" && Array.isArray(e.proposalIds)) {
      landed.set(e.landingId, e.proposalIds.filter((p): p is string => typeof p === "string"));
    }
  }
  if (heldIds.length === 0) return null;
  const records = await Promise.all(heldIds.slice(0, HELD_MAX).map((pid) => get(`${api(id)}/proposals/${encodeURIComponent(pid)}`).catch(() => null)));
  const held: HeldChange[] = [];
  const undoneCount = new Map<string, { n: number; intentId: string }>();
  records.forEach((r, i) => {
    const pid = heldIds[i] ?? "";
    const seen = byProposal.get(pid);
    const intentId = isObj(r) && typeof r.intentId === "string" ? r.intentId : (seen?.intentId ?? "");
    // A change whose record does not say it undoes a landing was not held for a goal conflict after all.
    const undoes = isObj(r) && Array.isArray(r.undoes) ? r.undoes.filter(isObj) : [];
    if (undoes.length === 0) return;
    for (const u of undoes) {
      if (typeof u.landingId !== "string") continue;
      const c = undoneCount.get(u.landingId) ?? { n: 0, intentId: str(u.intentId) };
      c.n++;
      undoneCount.set(u.landingId, c);
    }
    held.push({
      id: pid,
      intentId,
      agentId: isObj(r) && typeof r.agentId === "string" ? r.agentId : (seen?.agentId ?? ""),
      title: titles.get(intentId) ?? intentId,
      status: isObj(r) && typeof r.status === "string" ? r.status : "escalated",
      decision: decisions.get(pid) ?? null,
    });
  });
  if (held.length === 0) return null;
  // The landing they would undo: the one most of them name.
  const top = [...undoneCount.entries()].sort((a, b) => b[1].n - a[1].n)[0];
  let undone: GoalsFacts["undone"] = null;
  if (top) {
    const [landingId, { intentId }] = top;
    let title = titles.get(intentId) ?? "";
    if (!title && intentId) {
      const intent = await get(`${api(id)}/intents/${encodeURIComponent(intentId)}`).catch(() => null);
      const i = isObj(intent) && isObj(intent.intent) ? intent.intent : intent;
      title = isObj(i) ? str(i.title) : "";
    }
    const writer = (landed.get(landingId) ?? []).map((p) => byProposal.get(p)).find((p) => p?.intentId === intentId);
    undone = { landingId, intentId, title: title || intentId, agentId: writer?.agentId || null };
  }
  return goalsCard({ held, undone });
}
