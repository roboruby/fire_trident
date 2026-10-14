import { fmtDuration, fmtInt, fmtMs, shortSha } from "../format.ts";
import { KEYS_PATH } from "../signed.ts";

/**
 * Cards of the results strip (Results.tsx) about runs on the live service: `scale`, thousands of synthetic agents in
 * one repository; `goals`, agents whose goals disagree, where the colony held the changes that would undo another's
 * landing for a person; and `firstred`, a red certification whose first red search named the landing that broke the
 * tests, and the repair after it; and `signed`, lineage notes signed by the trunk writer's published key. Each reads
 * only routes that answer without a token (metrics, the event record, the colony listing, one proposal, one intent, the
 * certification results, the snapshot, the note checks, the published keys) and has nothing to show (null) until its
 * colony has run.
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
// spec: a new project built from a written spec
// ---------------------------------------------------------------------------

/** Intents declared within this long of the colony's creation are the spec's own; later ones (a documentation pass) are not. */
export const SPEC_WINDOW_MS = 10 * 60_000;

/** The build from the spec: its intents, how many landed, and when the last of their landings came. */
export interface SpecBuild {
  intents: number;
  landed: number;
  /** Landings that carried a spec intent. */
  landings: number;
  lastLandingAt: number | null;
}

/**
 * The spec's build from the colony's snapshot (its intents and its recent landings): the intents declared within
 * SPEC_WINDOW_MS of `createdAt`, and the latest landing that carried one of them. Null without a creation time.
 */
export function specBuild(createdAt: number | null, snapshot: unknown): SpecBuild | null {
  if (createdAt === null || !isObj(snapshot)) return null;
  const intents = Array.isArray(snapshot.intents) ? snapshot.intents.filter(isObj) : [];
  const spec = intents.filter((i) => (num(i.createdAt) ?? Number.POSITIVE_INFINITY) <= createdAt + SPEC_WINDOW_MS);
  const ids = new Set(spec.map((i) => i.id));
  const lands = (Array.isArray(snapshot.recentLandings) ? snapshot.recentLandings.filter(isObj) : []).filter(
    (l) => Array.isArray(l.intentIds) && l.intentIds.some((id) => ids.has(id)),
  );
  let last: number | null = null;
  for (const l of lands) {
    const at = num(l.at);
    if (at !== null && (last === null || at > last)) last = at;
  }
  return { intents: spec.length, landed: spec.filter((i) => i.status === "landed").length, landings: lands.length, lastLandingAt: last };
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

// ---------------------------------------------------------------------------
// firstred: the landing that broke the tests, found by running them, and the repair
// ---------------------------------------------------------------------------

/** Where the first red colony came from: the demo's scripted agents (scripts/bisect.ts --demo), which call no model. */
export const FIRSTRED_ORIGIN = "scripted agents, no models";

/** A test's own name: the last part of "suite > test". */
function leafName(name: string): string {
  const parts = name.split(" > ");
  return parts[parts.length - 1] ?? name;
}

/** "a, b" for up to `max` items, "a, b +2" past it. */
function listed(items: readonly string[], max: number): string {
  return items.length > max ? `${items.slice(0, max).join(", ")} +${items.length - max}` : items.join(", ");
}

/**
 * The first red card, from the colony's certification results (GET /certifications: newest first, a red result
 * carrying the first red search's answer once the search ends) and its snapshot (only for the status of the repair
 * intent the red result declared). It speaks of the newest red result whose search found the commit: the intent of the
 * landing that broke the tests, the failing test, the search's test runs and time, and the first green result after it.
 * Null when no search found a commit (none ran, or each was inconclusive).
 */
export function firstRedCard(certs: unknown, snapshot: unknown): ShowcaseCard | null {
  const results = isObj(certs) && Array.isArray(certs.results) ? certs.results.filter(isObj) : [];
  const red = results.find((r) => r.status === "red" && isObj(r.firstRed) && r.firstRed.status === "found");
  const f = red && isObj(red.firstRed) ? red.firstRed : null;
  const probes = num(f?.probes);
  const sha = str(f?.trunkSha);
  if (!red || !f || probes === null || probes < 1 || !sha) return null;
  const commit = shortSha(sha);

  // The proposals that changed what the failing tests load come first; their intent is the one that broke them.
  const proposals = Array.isArray(f.proposals) ? f.proposals.filter(isObj) : [];
  const intents = Array.isArray(f.intents) ? f.intents.filter(isObj) : [];
  const lead = proposals[0];
  const title = str(lead?.title) || str(intents.find((i) => i.id === lead?.intentId)?.title) || str(intents[0]?.title);
  const failing = Array.isArray(red.failing) ? red.failing.filter(isObj) : [];
  const names = [...new Set(failing.map((t) => leafName(str(t.name))).filter((n) => n !== ""))];
  const broke = names.length === 0 ? "the tests" : names.length === 1 ? `the test “${names[0]}”` : `“${names[0]}” and ${words(names.length - 1)} more ${names.length === 2 ? "test" : "tests"}`;
  const landings = num(f.landings);
  const lede =
    landings !== null && landings > 1
      ? `of the ${words(landings)} landings since green, the one ${title ? `for “${title}”` : `at commit ${commit}`} broke ${broke}`
      : `the landing ${title ? `for “${title}”` : `at commit ${commit}`} broke ${broke}`;

  const details: string[] = [];
  const paths = [...new Set(proposals.flatMap((p) => (Array.isArray(p.paths) ? p.paths : []).filter((x): x is string => typeof x === "string" && x !== "")))].sort();
  const landingId = str(f.landingId);
  details.push(paths.length > 0 ? `commit ${commit} changed ${listed(paths, 2)}` : `commit ${commit}${landingId ? `, landing ${landingId}` : ""}`);
  const ms = num(f.ms);
  details.push(`found${ms !== null ? ` in ${fmtMs(ms)}` : ""} by running the failing ${names.length === 1 ? "test" : "tests"} on earlier commits, not by a model`);

  // The repair: the first green result after the red one (results come newest first), and how long trunk was red.
  const redStart = num(red.startedAt);
  const greens = redStart === null ? [] : results.filter((r) => r.status === "green" && (num(r.startedAt) ?? Number.NEGATIVE_INFINITY) > redStart);
  const green = greens[greens.length - 1];
  const repairId = str(red.repairIntentId);
  const repairs = isObj(snapshot) && Array.isArray(snapshot.intents) ? snapshot.intents.filter(isObj) : [];
  const repaired = repairId !== "" && repairs.some((i) => i.id === repairId && i.status === "landed");
  if (green) {
    const from = num(red.finishedAt) ?? redStart;
    const to = num(green.finishedAt) ?? num(green.startedAt);
    const after = from !== null && to !== null && to >= from ? ` ${fmtDuration(to - from)} after the red result` : "";
    details.push(`${repaired ? "its repair intent landed; " : ""}trunk was certified green again${after}`);
  } else if (repairId) {
    details.push("the colony declared a repair intent; trunk is not green again yet");
  }
  return { headline: `Found the breaking landing in ${fmtInt(probes)} test ${probes === 1 ? "run" : "runs"}`, lede, details, origin: FIRSTRED_ORIGIN };
}

/**
 * The first red card from routes that answer without a token: the colony's certification results and its snapshot.
 * Null when the colony does not answer or no first red search found a commit, so it can be listed before its colony runs.
 */
export async function loadFirstRedCard(id: string, get: GetJson): Promise<ShowcaseCard | null> {
  const [certs, snapshot] = await Promise.all([get(`${api(id)}/certifications?limit=50`).catch(() => null), get(api(id)).catch(() => null)]);
  return firstRedCard(certs, snapshot);
}

// ---------------------------------------------------------------------------
// signed: lineage notes signed by the trunk writer's published key
// ---------------------------------------------------------------------------

/** Where the signed notes colony came from: one scripted agent over MCP (scripts/signed_notes.ts), which calls no model. */
export const SIGNED_ORIGIN = "one scripted agent over MCP, no models";

/** Newest landings whose note checks the signed card reads (the route's own default). */
export const SIGNED_NOTES_LIMIT = 20;

/** A published key as GET /.well-known/firetrident-keys.json lists it: its id, and when it started signing. */
interface PublishedKey {
  id: string;
  since: string | null;
}

const KEY_ID = /^[0-9a-f]{16}$/;

/** The keys a deployment publishes, by id; empty when the answer is not a key list. */
function keysOf(answer: unknown): Map<string, PublishedKey> {
  const out = new Map<string, PublishedKey>();
  const list = isObj(answer) && Array.isArray(answer.keys) ? answer.keys.filter(isObj) : [];
  for (const k of list) {
    const id = str(k.id);
    if (!KEY_ID.test(id)) continue;
    const at = typeof k.since === "string" ? Date.parse(k.since) : Number.NaN;
    out.set(id, { id, since: Number.isFinite(at) ? new Date(at).toISOString() : null });
  }
  return out;
}

/** The published key that signed an intact note's commit, or null for any other check: the rule the badge on the colony page reads by (signed.ts). */
function signerOf(note: Json, keys: ReadonlyMap<string, PublishedKey>): string | null {
  const sig = isObj(note.signature) ? note.signature : null;
  const id = str(sig?.keyId);
  return note.status === "intact" && sig?.status === "signed" && keys.has(id) ? id : null;
}

/** A note check in the words of the badge on the colony page (verified.ts, signed.ts), for a detail line. */
function badgeWords(note: Json, signed: boolean): string {
  if (signed) return "note intact and signed";
  const sig = isObj(note.signature) ? note.signature : null;
  switch (note.status) {
    case "intact":
      return sig?.status === "bad-signature" ? "note intact, but its signature does not match" : sig?.status === "unsigned" ? "note intact, landed before signing" : "note intact";
    case "altered":
      return "note altered";
    case "missing":
      return "note missing";
    case "pending":
      return "note not pushed yet";
    case "no-trailer":
      return "landed before notes were sealed";
    default:
      return "note not checked";
  }
}

/** "2026-10-14 15:59 UTC" for an ISO 8601 time. */
const utc = (iso: string): string => `${iso.slice(0, 16).replace("T", " ")} UTC`;

/**
 * The signed card, from the colony's newest note checks (GET /notes/verify, newest first, each with `signature` where the
 * deployment signs) and the keys it publishes (GET /.well-known/firetrident-keys.json). A note counts as signed when it
 * is intact and its commit's signature verifies with a published key, as the badge on the colony page reads it. Null
 * when the colony has no checked note, when no key is published, or when no note is signed, so the card can be listed
 * before its colony exists or before the deployment signs. `origin` is the server the stock-git line names.
 */
export function signedCard(verify: unknown, keys: unknown, p: { colonyId: string; origin: string }): ShowcaseCard | null {
  const published = keysOf(keys);
  const notes = isObj(verify) && Array.isArray(verify.notes) ? verify.notes.filter(isObj) : [];
  const newest = notes[0];
  if (published.size === 0 || !newest) return null;
  const signers = notes.map((n) => signerOf(n, published));
  const signed = signers.filter((s) => s !== null).length;
  if (signed === 0) return null;
  // The key named is the newest signed note's, so after a rotation the card names the key signing now.
  const first = signers.findIndex((s) => s !== null);
  const keyId = signers[first]!;
  const key = published.get(keyId)!;
  const all = signed === notes.length;
  // The stock-git check names HEAD when the newest landing is signed, else the newest signed commit.
  const target = first === 0 ? "HEAD" : str(notes[first]!.trunkSha).slice(0, 12);
  const keysUrl = `${p.origin}${KEYS_PATH}`;
  return {
    headline: all ? `Signed by ${keyId}` : `${fmtInt(signed)} of ${fmtInt(notes.length)} notes signed`,
    lede: all
      ? "every landing's note is sealed by its digest and signed by the trunk writer's key, published for any git client to check"
      : `the newest landings' notes are sealed by their digests; ${words(signed)} of ${words(notes.length)} ${signed === 1 ? "is" : "are"} signed by the trunk writer's key, published for any git client to check`,
    details: [
      `key ${keyId} (Ed25519)${key.since ? `, signing since ${utc(key.since)}` : ""}, published at ${KEYS_PATH}`,
      `newest landing ${shortSha(str(newest.trunkSha))}: ${badgeWords(newest, first === 0)}${all && notes.length > 1 ? `, as are the ${words(notes.length - 1)} before it` : ""}`,
      `from a stock clone (git clone ${p.origin}/git/${p.colonyId}.git, fetch refs/notes/firetrident), node scripts/verify_note.mjs ${target} --keys ${keysUrl} prints “intact, signed by ${keyId}”`,
    ],
    origin: SIGNED_ORIGIN,
  };
}

/**
 * The signed card from routes that answer without a token: the colony's newest note checks and the deployment's
 * published keys. Null when either does not answer, so it can be listed before its colony exists.
 */
export async function loadSignedCard(id: string, get: GetJson, origin: string): Promise<ShowcaseCard | null> {
  const [verify, keys] = await Promise.all([get(`${api(id)}/notes/verify?limit=${SIGNED_NOTES_LIMIT}`).catch(() => null), get(KEYS_PATH).catch(() => null)]);
  return signedCard(verify, keys, { colonyId: id, origin });
}
