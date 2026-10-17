import type { CertificationStatus, Id, IntentStatus, Rule } from "@fire_trident/core";
import { certCounts } from "./certs.ts";
import { lastResult } from "./distance.ts";
import { shortSha } from "./format.ts";
import { originOf, ruleBook, ruleHead } from "./intentTree.ts";
import type { ColonyStore } from "./store.ts";

/**
 * The colony's target (the first screen, components/FirstScreen.tsx): what it is asked to satisfy, read from its own
 * records. The rules a person approved, the acceptance lines of intents still open, the paths only a person may change
 * (the decide policy, a public read), the goals people and rules set that have not landed, and certification: the
 * newest result and the `certified` branch. Rule descriptions, intent titles and acceptance lines are people's and
 * agents' words: callers render them as text.
 */

/** One rule in force, with who approved it. */
export interface TargetRule {
  id: Id;
  /** The head of its description, as its intents' titles carry it. */
  head: string;
  description: string;
  approvedBy: string;
  kind: Rule["kind"];
  createdAt: number;
  /** Its violations still on trunk. */
  open: number;
}

/** The acceptance lines of one intent still to be met. */
export interface TargetAcceptance {
  intentId: Id;
  title: string;
  lines: string[];
}

/** A goal still open: an intent a person or a rule declared that has not landed. */
export interface TargetGoal {
  id: Id;
  title: string;
  status: IntentStatus;
  from: "people" | "rule";
}

/** The paths only a person may change, as far as this page could read them. */
export type ProtectedPaths =
  | { state: "loaded"; globs: string[] }
  | { state: "loading" }
  /** Not known: the simulator has no policy, a recording did not keep it, the server did not answer (`why` says which). */
  | { state: "unknown"; why: string };

/** Certification as the target reads it: the newest result, and where `certified` points. */
export interface TargetCert {
  /** The newest finished result's status, "running" while the head's run is going, "none" before any. */
  status: CertificationStatus | "none";
  /** The commit the result is for (short). */
  sha: string;
  /** "60/60 tests", "5 failing", or why it was skipped ("" when unknown). */
  detail: string;
  /** The `certified` branch's commit (short), "" before any green result. */
  certified: string;
  /** Whether `certified` is trunk's head (null while either is unknown). */
  atHead: boolean | null;
}

/** Everything the target column shows. */
export interface Target {
  rules: TargetRule[];
  /** Rules retracted (kept in history, no longer part of the target). */
  retracted: number;
  acceptance: TargetAcceptance[];
  acceptanceLines: number;
  protectedPaths: ProtectedPaths;
  goals: { people: number; rules: number; list: TargetGoal[] };
  cert: TargetCert;
}

const LIVE: ReadonlySet<IntentStatus> = new Set<IntentStatus>(["open", "claimed", "proposed"]);

/** Goals listed at most (the counts cover every one). */
const GOALS_KEPT = 50;

/** The target from what the store holds now, with the protected paths read separately (readProtected). */
export function targetOf(store: ColonyStore, protectedPaths: ProtectedPaths): Target {
  const rules: TargetRule[] = [];
  let retracted = 0;
  for (const r of store.rules.values()) {
    if (typeof r.retractedAt === "number") {
      retracted++;
      continue;
    }
    const description = typeof r.description === "string" ? r.description.trim() : "";
    const open = store.violations.byRule?.[r.id];
    rules.push({
      id: r.id,
      head: ruleHead(description) || r.id,
      description,
      approvedBy: typeof r.approvedBy === "string" && r.approvedBy.trim() ? r.approvedBy.trim() : "unknown",
      kind: r.kind,
      createdAt: typeof r.createdAt === "number" ? r.createdAt : 0,
      open: typeof open === "number" && Number.isFinite(open) ? Math.max(0, open) : 0,
    });
  }
  rules.sort((a, b) => a.createdAt - b.createdAt);

  const book = ruleBook(store.rules.values());
  const acceptance: TargetAcceptance[] = [];
  let acceptanceLines = 0;
  const goals = { people: 0, rules: 0, list: [] as TargetGoal[] };
  const people: TargetGoal[] = [];
  const fromRules: TargetGoal[] = [];
  const live = [...store.intents.values()].filter((it) => LIVE.has(it.status)).sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt);
  for (const it of live) {
    if (it.acceptance?.length) {
      acceptance.push({ intentId: it.id, title: it.title, lines: it.acceptance });
      acceptanceLines += it.acceptance.length;
    }
    const kind = originOf(it, book).kind;
    if (kind === "human") {
      goals.people++;
      people.push({ id: it.id, title: it.title, status: it.status, from: "people" });
    } else if (kind === "rule") {
      goals.rules++;
      fromRules.push({ id: it.id, title: it.title, status: it.status, from: "rule" });
    }
  }
  goals.list = [...people, ...fromRules].slice(0, GOALS_KEPT);
  return { rules, retracted, acceptance, acceptanceLines, protectedPaths, goals, cert: certOf(store) };
}

/** Certification for the target: the newest result (a run in progress says so), and `certified` against trunk's head. */
function certOf(store: ColonyStore): TargetCert {
  const head = store.headCert();
  const last = lastResult(store.certs.values());
  const running = head && head.cert.status === "running" ? head.cert : null;
  const shown = running ?? last;
  const certified = store.greenSha ? shortSha(store.greenSha) : "";
  const atHead = store.greenSha && store.trunkSha ? store.greenSha === store.trunkSha : null;
  if (!shown) return { status: "none", sha: "", detail: "", certified, atHead };
  const detail = shown.status === "running" ? "" : shown.counts ? certCounts(shown) : (shown.detail ?? "");
  return { status: shown.status, sha: shortSha(shown.trunkSha), detail, certified, atHead };
}

/** The protected globs of a decide policy answer (GET /decide/policy), or null when it holds none this page can read. */
export function policyGlobs(raw: unknown): string[] | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const list = (raw as { protectedPaths?: unknown }).protectedPaths;
  if (!Array.isArray(list)) return null;
  const out: string[] = [];
  for (const g of list) if (typeof g === "string" && g.trim() && !out.includes(g.trim())) out.push(g.trim());
  return out;
}

/**
 * Read the colony's protected paths (GET /api/colonies/:id/decide/policy, a public read with no token). The simulator
 * has no policy; a recording answers only what it kept; an older server answers with no policy.
 */
export async function readProtected(colonyId: string, mode: "live" | "mock" | "replay", fetcher: typeof fetch = (input, init) => fetch(input, init)): Promise<ProtectedPaths> {
  if (mode === "mock") return { state: "unknown", why: "the simulator has no decide policy" };
  let res: Response;
  try {
    res = await fetcher(`/api/colonies/${encodeURIComponent(colonyId)}/decide/policy`, { headers: { accept: "application/json" } });
  } catch {
    return { state: "unknown", why: "the colony API could not be reached" };
  }
  if (res.headers.get("x-ft-recording") === "miss") return { state: "unknown", why: "this recording did not keep the decide policy" };
  if (!res.ok) return { state: "unknown", why: `the server answered ${res.status}` };
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { state: "unknown", why: "the server's answer was not JSON" };
  }
  const globs = policyGlobs(body);
  return globs ? { state: "loaded", globs } : { state: "unknown", why: "this server does not report its protected paths" };
}
