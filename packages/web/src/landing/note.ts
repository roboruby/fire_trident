import type { LandingAnswer, LandingTests, LineageNote, NoteCheck, Speaker } from "@fire_trident/core";
import { evidenceLines, landingAnswerable, landingConfirmed, notVerifiedSpeaker, notVerifiedWords, type LandingConfirmation } from "@fire_trident/core";
import { decisionsFromChecks } from "../decisions.ts";
import { provenanceOf, type ProvenanceView } from "../lineage.ts";
import { checksOf, sealOf, uncheckedSeal, type NoteSeal } from "../verified.ts";
import { landingTestsOf } from "../tests.ts";

/**
 * The Remember card of the landing page: the newest sealed landing of a showcase colony, read live from the public
 * routes (the note check, the colony's snapshot for its rules and agents, and the lineage of a file the landing wrote)
 * with the badge its note check earned and the stock-git commands that check it again. When no colony answers, a note
 * kept in FireTrident's recorded results stands in, labeled as one that was not checked.
 */

/** Showcase colonies the card reads, in order; their trunks are public over plain git, so the commands work for them. */
export const NOTE_COLONIES: readonly string[] = ["byo-demo", "hono", "shortlinks"];
/** Newest landings of a colony whose note checks the card reads. */
const NEWEST = 5;
/** Files of each set the card lists before "and N more". */
const FILES_SHOWN = 4;

/** One decision of the note, with its probability (null when the layer gave none). */
export interface CardDecision {
  layer: string;
  kind: string;
  action: string;
  p: number | null;
  by: string | null;
}

/** One check the change landed with, and who said it (core/answerable.ts); an agent's detail is its own words, to quote. */
export interface CardCheck {
  name: string;
  ok: boolean;
  detail: string | null;
  speaker: Speaker;
  quoted: boolean;
}

/** A file the change read or wrote, with its blob (null: deleted, or absent when read). */
export interface CardFile {
  path: string;
  blob: string | null;
}

/** Everything the card shows of one landing's note. The first proposal is shown; `others` counts the rest. */
export interface NoteCard {
  /** False for the stand-in note from the recorded results. */
  live: boolean;
  colonyId: string;
  landingId: string;
  commit: string;
  at: number | null;
  /** A file the landing wrote, which the Why tab opens on. */
  path: string | null;
  seal: NoteSeal;
  intent: { title: string; why: string } | null;
  /** The rule the intent came from, null when it came from none; its name and approver when the colony says. */
  rule: { id: string; name: string | null; approvedBy: string | null } | null;
  agent: { id: string; name: string | null; kind: string; model: string | null } | null;
  provenance: ProvenanceView | null;
  decisions: CardDecision[];
  /** FireTrident's checks first, then models', then the agent's. */
  checks: CardCheck[];
  notVerified: string | null;
  /** Who wrote the statement of what was not verified: the agent (its words, quoted) or FireTrident. */
  notVerifiedBy: Speaker | null;
  /** Who answers for the landing (its whole note). */
  answerable: { answer: LandingAnswer; text: string };
  /** The rule that confirmed each change, with the values it used (core/decides.ts); absent on cards built before it. */
  confirmed?: LandingConfirmation;
  /** Its tests at its base against the certified commit (GET /landings/:ref/tests; tests.ts); null when not read (the recorded stand-in, or no answer). */
  tests?: LandingTests | null;
  reads: CardFile[];
  writes: CardFile[];
  /** Files beyond FILES_SHOWN in each set. */
  moreReads: number;
  moreWrites: number;
  others: number;
}

type Json = Record<string, unknown>;
const isObj = (x: unknown): x is Json => typeof x === "object" && x !== null && !Array.isArray(x);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const line = (v: unknown): string => str(v).replace(/\s+/g, " ").trim();

/** What the card is built from: the landing, its note, its seal, and the colony's rules and agent names when known. */
export interface CardInput {
  colonyId: string;
  landing: { id: string; trunkSha: string; at?: number | null; paths?: readonly string[] };
  note: LineageNote;
  seal: NoteSeal;
  rules?: ReadonlyMap<string, { description: string; approvedBy: string }>;
  agents?: ReadonlyMap<string, string>;
  live: boolean;
}

function files(v: unknown): CardFile[] {
  return (Array.isArray(v) ? v : []).filter(isObj).flatMap((f) => (typeof f.path === "string" && f.path !== "" ? [{ path: f.path, blob: typeof f.blob === "string" ? f.blob : null }] : []));
}

/** The note's decisions with their probabilities: the recorded ones, else those its checks name, after a deterministic proof that decided alone. */
function decisionsOf(p: Json, checks: CardCheck[]): CardDecision[] {
  const out: CardDecision[] = [];
  const gate = checks.find((c) => c.name === "gate");
  const proof = gate?.detail ? /→ (\S+) by deterministic\b/.exec(gate.detail) : null;
  if (proof) out.push({ layer: "proof", kind: "deterministic", action: proof[1] ?? "land", p: null, by: null });
  const recorded = (Array.isArray(p.decisions) ? p.decisions : []).filter(isObj);
  const steps = recorded.length > 0 ? recorded : decisionsFromChecks(checks.map((c) => ({ name: c.name, ok: c.ok, ms: 0, ...(c.detail ? { detail: c.detail } : {}) })));
  for (const d of steps as Json[]) {
    const p = typeof d.p === "number" && Number.isFinite(d.p) ? Math.max(0, Math.min(1, d.p)) : null;
    out.push({ layer: line(d.layer) || "decision", kind: line(d.kind), action: line(d.action), p, by: line(d.by) || null });
  }
  return out;
}

/** The card for one landing's note (see NoteCard), read defensively: notes written before a field existed lack it. */
export function cardOf(x: CardInput): NoteCard {
  const proposals = (Array.isArray(x.note?.proposals) ? x.note.proposals : []).filter(isObj) as Json[];
  const p = proposals[0] ?? null;
  const intent = p && isObj(p.intent) ? p.intent : null;
  const evidence = p && isObj(p.evidence) ? p.evidence : {};
  // Who said each check (core/answerable.ts): the agent's words never sit in a FireTrident line.
  const checks: CardCheck[] = evidenceLines(evidence)
    .filter((l) => l.kind === "check")
    .map((l) => ({ name: l.name, ok: l.ok === true, detail: line(l.text) || null, speaker: l.speaker, quoted: l.quoted }));
  const notVerified = notVerifiedWords(evidence.notVerified) || null;
  const answerable = landingAnswerable(x.note);
  const ruleId = intent ? line(intent.ruleId) : "";
  const rule = ruleId ? x.rules?.get(ruleId) : undefined;
  const agentId = p ? line(p.agentId) : "";
  const reads = p ? files(p.readSet) : [];
  const writes = p ? files(p.writeSet) : [];
  return {
    live: x.live,
    colonyId: x.colonyId,
    landingId: x.landing.id,
    commit: x.landing.trunkSha,
    at: typeof x.landing.at === "number" && Number.isFinite(x.landing.at) ? x.landing.at : null,
    path: writes[0]?.path ?? x.landing.paths?.[0] ?? null,
    seal: x.seal,
    intent: intent ? { title: line(intent.title) || "Untitled intent", why: str(intent.why).trim() } : null,
    rule: ruleId ? { id: ruleId, name: rule ? line(rule.description) || null : null, approvedBy: rule ? line(rule.approvedBy) || null : null } : null,
    agent: p ? { id: agentId, name: x.agents?.get(agentId) ?? null, kind: line(p.agentKind) || "agent", model: line(p.model) || null } : null,
    provenance: p ? provenanceOf(p as unknown as LineageNote["proposals"][number]) : null,
    decisions: p ? decisionsOf(p, checks) : [],
    checks,
    notVerified,
    notVerifiedBy: notVerified ? notVerifiedSpeaker(evidence) : null,
    answerable: { answer: answerable.answer, text: answerable.text },
    confirmed: landingConfirmed(x.note),
    reads: reads.slice(0, FILES_SHOWN),
    writes: writes.slice(0, FILES_SHOWN),
    moreReads: Math.max(0, reads.length - FILES_SHOWN),
    moreWrites: Math.max(0, writes.length - FILES_SHOWN),
    others: Math.max(0, proposals.length - 1),
  };
}

/** Reads JSON from the API; rejects when the read fails (injected, so tests answer it). */
export type GetJson = (url: string) => Promise<unknown>;

const api = (id: string): string => `/api/colonies/${encodeURIComponent(id)}`;

/** The landing `id` among a snapshot's recent landings, with its paths. */
function recentLanding(snap: unknown, id: string): { id: string; trunkSha: string; at: number | null; paths: string[] } | null {
  const list = isObj(snap) && Array.isArray(snap.recentLandings) ? snap.recentLandings : [];
  const l = list.filter(isObj).find((x) => x.id === id);
  if (!l || typeof l.trunkSha !== "string") return null;
  const paths = Array.isArray(l.paths) ? l.paths.filter((x): x is string => typeof x === "string" && x !== "") : [];
  return { id, trunkSha: l.trunkSha, at: typeof l.at === "number" ? l.at : null, paths };
}

/** The colony's rules by id, with their descriptions and approvers (a snapshot's `rules`). */
function rulesOf(snap: unknown): Map<string, { description: string; approvedBy: string }> {
  const out = new Map<string, { description: string; approvedBy: string }>();
  for (const r of (isObj(snap) && Array.isArray(snap.rules) ? snap.rules : []).filter(isObj)) {
    if (typeof r.id === "string") out.set(r.id, { description: line(r.description), approvedBy: line(r.approvedBy) });
  }
  return out;
}

/** Agent names by id, from a snapshot's or the agents route's `agents`. */
function agentNames(answer: unknown): Map<string, string> {
  const out = new Map<string, string>();
  for (const a of (isObj(answer) && Array.isArray(answer.agents) ? answer.agents : []).filter(isObj)) {
    if (typeof a.id === "string" && line(a.name)) out.set(a.id, line(a.name));
  }
  return out;
}

/** The note of landing `id` in a why answer, or null. */
function noteIn(why: unknown, id: string): LineageNote | null {
  const entry = (Array.isArray(why) ? why : []).filter(isObj).find((e) => isObj(e.landing) && e.landing.id === id && isObj(e.note));
  return entry ? (entry.note as unknown as LineageNote) : null;
}

/** The card of one checked landing of colony `id`, or null when its note cannot be found. */
async function cardFor(id: string, check: NoteCheck, get: GetJson): Promise<NoteCard | null> {
  const snap = await get(api(id));
  const landing = recentLanding(snap, check.landingId);
  const path = landing?.paths[0];
  if (!landing || !path) return null;
  // The landing's test row is read beside its lineage; the card shows its note without it when it does not come.
  const [why, tests] = await Promise.all([get(`${api(id)}/why?path=${encodeURIComponent(path)}`), get(`${api(id)}/landings/${encodeURIComponent(landing.id)}/tests`).then(landingTestsOf, () => null)]);
  const note = noteIn(why, landing.id);
  if (!note) return null;
  const agents = agentNames(snap);
  const first = note.proposals?.[0]?.agentId;
  if (typeof first === "string" && !agents.has(first)) {
    // An agent that stopped more than an hour ago is not in the snapshot: the agents route still names it.
    for (const [k, v] of agentNames(await get(`${api(id)}/agents?all=1&journal=0&limit=500`).catch(() => null))) agents.set(k, v);
  }
  return { ...cardOf({ colonyId: id, landing, note, seal: sealOf(check), rules: rulesOf(snap), agents, live: true }), tests };
}

/**
 * The card for the newest sealed landing of the first colony in `colonies` with an intact note among its newest
 * landings. When none has one, the newest landing of the first colony that answered, with the badge its check earned
 * (altered, landed before notes were sealed, ...). Null when no colony answered.
 */
export async function loadNoteCard(colonies: readonly string[], get: GetJson): Promise<NoteCard | null> {
  let fallback: { id: string; check: NoteCheck } | null = null;
  for (const id of colonies) {
    const checks = checksOf(await get(`${api(id)}/notes/verify?limit=${NEWEST}`).catch(() => null));
    if (checks.length === 0) continue;
    const sealed = checks.find((c) => c.status === "intact");
    if (sealed) {
      const card = await cardFor(id, sealed, get).catch(() => null);
      if (card) return card;
    } else fallback ??= { id, check: checks[0]! };
  }
  return fallback ? cardFor(fallback.id, fallback.check, get).catch(() => null) : null;
}

/** The colonies to read, in order: `?note=<colony>` first when the address names one (a preview's own colony), then the showcase ones. */
export function noteColonies(search: string): string[] {
  const asked = new URLSearchParams(search).get("note")?.trim() ?? "";
  const valid = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/.test(asked);
  return valid ? [asked, ...NOTE_COLONIES.filter((c) => c !== asked)] : [...NOTE_COLONIES];
}

/** The two stock-git commands that check a landing's note again: clone the colony with its notes, then run FireTrident's checker inside the clone. */
export function verifyCommands(origin: string, colonyId: string, commit: string): string {
  return [
    `git clone ${origin}/git/${colonyId}.git && cd ${colonyId} && git fetch origin refs/notes/firetrident:refs/notes/firetrident`,
    `node ../fire_trident/scripts/verify_note.mjs ${commit.slice(0, 12)}`,
  ].join("\n");
}

/**
 * A note kept in FireTrident's recorded results (packages/bench/results/2026-10-12-prod/colony-byo-demo.json): an
 * external agent, joined over MCP, made benchmark.js keep the colony's quote rule on 12 October 2026. It stands in when
 * no colony answers. It landed before notes were sealed, and the page did not check it.
 */
const RECORDED: LineageNote = {
  schema: "firetrident.lineage/v1",
  landingId: "lnd_mv51rqpw2c7pal",
  colonyId: "byo-demo",
  proposals: [
    {
      id: "prp_mv51rlub8exo6x",
      agentId: "agt_mv51r2f72a0w8y",
      agentKind: "external",
      model: "claude-sonnet-5-5",
      intent: {
        id: "int_mv51qwrhbackzi",
        ruleId: "rul_mv51qwr1iv2wb2",
        title: "JavaScript strings use double quotes in benchmark.js",
        why: 'JavaScript strings use double quotes.\nHint: Write string literals with double quotes: \'x\' becomes "x". Change nothing else.\n8 violations on lines 1, 2, 3, 25, 27, 38, 43, 54.',
      },
      readSet: [{ path: "benchmark.js", blob: "4dbc605d9619af78d22c87d13cbb00776bd7534a" }],
      writeSet: [{ path: "benchmark.js", blob: "b22377d424b988cf9bb89c9bb7beed7e9d98ddd0" }],
      decisions: [],
      evidence: {
        checks: [
          { name: "innate: blobs", ok: true, ms: 45, detail: "1 file(s) read" },
          { name: "innate: rule rul_mv51qwr1iv2wb2", ok: true, ms: 0, detail: "benchmark.js 8→0" },
          { name: "innate: footprint", ok: true, ms: 0, detail: "every write is inside the intent's footprint" },
          {
            name: "innate: not-verified",
            ok: true,
            ms: 0,
            detail: "Not verified: Did not run the benchmark, linter, or tests (instructed not to execute repo content). Checked only that no single quotes remain in the file.",
          },
          {
            name: "deterministic: mechanical proof",
            ok: true,
            ms: 0,
            detail: "pass: 1 file proven: only import specifiers changed, each still resolving to the same file (or exactly the rule's replacement); inside the footprint; no sensitive path; rule re-check passes",
          },
          {
            name: "gate",
            ok: true,
            ms: 0,
            detail: "D3 innate+proof → land by deterministic at head 9a7220a8f2f2 (confirmations: innate + deterministic): deterministic proof: 1 file proven: only import specifiers changed, each still resolving to the same file (or exactly the rule's replacement); inside the footprint; no sensitive path; rule re-check passes",
          },
        ],
        notVerified: "Not verified: Did not run the benchmark, linter, or tests (instructed not to execute repo content). Checked only that no single quotes remain in the file.",
        residual: [],
      },
    },
  ],
};

/** The stand-in card: the recorded note and its rule as the colony recorded it, under a badge that says it was not checked. */
export function recordedCard(): NoteCard {
  return cardOf({
    colonyId: "byo-demo",
    landing: { id: "lnd_mv51rqpw2c7pal", trunkSha: "8fbe556265698732c5934903e8f534d123e8220e", at: 1791797167364, paths: ["benchmark.js"] },
    note: RECORDED,
    seal: uncheckedSeal(
      "no colony answered just now, so this is a note kept in FireTrident's recorded results (byo-demo, 12 October 2026). It landed before notes were sealed: its commit carries no FT-Note trailer to check it against",
    ),
    rules: new Map([["rul_mv51qwr1iv2wb2", { description: "JavaScript strings use double quotes", approvedBy: "mcp_join" }]]),
    live: false,
  });
}
