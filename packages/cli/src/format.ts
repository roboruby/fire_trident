import type {
  AgentState,
  Certification,
  CheckResult,
  ColonyEvent,
  ColonySnapshot,
  Direction,
  Intent,
  IntentEscalation,
  IntentStatus,
  Landing,
  LineageNote,
  MarkKind,
  NoteCertification,
  NoteCheck,
  NoteCheckStatus,
  NoteDecision,
  NotesVerification,
  Proposal,
  ProposalStatus,
  Rule,
} from "@fire_trident/core";
import type { StuckAction, StuckItem, StuckReport } from "@fire_trident/core";
import type { Evidence, LandingTests, WhyHolds, WhyWalk } from "@fire_trident/core";
// The published CLI ships without @fire_trident/core: answerable.ts is the CLI's copy of core's (test/package.test.ts).
import { bySpeaker, evidenceLines, landingAnswerable, notVerifiedSpeaker, notVerifiedWords } from "./answerable.ts";
import { testsRows } from "./tests.ts";
import type { IntentSpend } from "@fire_trident/core";
import type { IntentClosure } from "@fire_trident/core";
import { closureLine } from "./closure.ts";
import { changeSize, dangerLines, lookHereFirst, parseHunks, reviewOf, visible, type DiffLine, type ReviewFile, type ReviewView } from "./review.ts";
import { whySummary } from "./spec.ts";
import { megafileLines } from "./megafile.ts";
import { pauseLines } from "./pause.ts";
import { signatureLines } from "./signatures.ts";
import { intentSpendDetail, intentSpendLine, spendLine } from "./spend.ts";
import { spendCapStatus } from "./spendcap.ts";
import { acceptanceRows } from "./acceptance.ts";
import { contestLines } from "./contest.ts";
import { prelandLine } from "./preland.ts";
import { holdsRow, walkRows } from "./holds.ts";
import { entryPath, walkOwnsFirst, type CertNow } from "./whyholds.ts";
import { heldLines } from "./mergehold.ts";
import { confirmedLine } from "./gateline.ts";
import { reviewTestsLines } from "./reviewtests.ts";
import { batchLines, batchMembers, groupBatches } from "./batch.ts";
import { lifecycleLines, whyLifecycleRows } from "./strip.ts";
import { recipeWhyRows } from "./recipe.ts";
import { auditLines, splitAudits } from "./audit.ts";

/** ANSI styling functions; identity functions when color is off. */
export interface Colors {
  bold: (s: string) => string;
  dim: (s: string) => string;
  red: (s: string) => string;
  green: (s: string) => string;
  yellow: (s: string) => string;
  blue: (s: string) => string;
  magenta: (s: string) => string;
  cyan: (s: string) => string;
}

/** Build the styling functions. */
export function colors(enabled: boolean): Colors {
  const wrap = (open: number, close: number) => (s: string) => (enabled ? `\u001b[${open}m${s}\u001b[${close}m` : s);
  return {
    bold: wrap(1, 22),
    dim: wrap(2, 22),
    red: wrap(31, 39),
    green: wrap(32, 39),
    yellow: wrap(33, 39),
    blue: wrap(34, 39),
    magenta: wrap(35, 39),
    cyan: wrap(36, 39),
  };
}

/** Color is on for a terminal unless NO_COLOR is set or output is JSON; FORCE_COLOR turns it on. */
export function colorEnabled(env: Record<string, string | undefined>, isTTY: boolean, json: boolean): boolean {
  if (json || env.NO_COLOR) return false;
  if (env.FORCE_COLOR && env.FORCE_COLOR !== "0") return true;
  return isTTY && env.TERM !== "dumb";
}

/** First seven characters of a commit id. */
export function shortSha(sha: string | undefined | null): string {
  return sha ? sha.slice(0, 7) : "-";
}

/** Thousands separators, so 1284 reads 1,284. */
export function num(n: number): string {
  return Number.isFinite(n) ? n.toLocaleString("en-US") : String(n);
}

/** Relative age such as "12s ago" or "3h ago". */
export function ago(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

/** The region a path belongs to: its first `depth` directory segments ("." for root files). Mirrors core's regionOf. */
export function regionOf(path: string, depth = 1): string {
  const dirs = path.split("/").slice(0, -1);
  return dirs.length === 0 ? "." : dirs.slice(0, Math.max(1, depth)).join("/");
}

/** "a, b +3" for long path lists. */
export function paths(list: readonly string[] | undefined, max = 2): string {
  if (!list || list.length === 0) return "";
  const head = list.slice(0, max).join(", ");
  return list.length > max ? `${head} +${list.length - max}` : head;
}

function countBy<T>(items: readonly T[], key: (t: T) => string): Map<string, number> {
  const m = new Map<string, number>();
  for (const it of items) m.set(key(it), (m.get(key(it)) ?? 0) + 1);
  return m;
}

function breakdown(counts: Map<string, number>, order: readonly string[], c: Colors): string {
  const known = order.filter((k) => (counts.get(k) ?? 0) > 0);
  const extra = [...counts.keys()].filter((k) => !order.includes(k));
  return [...known, ...extra].map((k) => `${num(counts.get(k) ?? 0)} ${k}`).join(c.dim(" · "));
}

function quote(s: string, max = 72): string {
  const one = s.replace(/\s+/g, " ").trim();
  return `"${one.length > max ? `${one.slice(0, max - 1)}…` : one}"`;
}

const INTENT_ORDER: readonly IntentStatus[] = ["open", "claimed", "proposed", "landed", "abandoned", "withdrawn"];
const AGENT_ORDER: readonly AgentState[] = ["working", "proposing", "waiting", "idle", "dead"];

/** Per-minute history the server adds to the snapshot (the last 30 minutes, oldest first). */
export interface SeriesLike {
  bucketMs?: number;
  start?: number;
  landings?: number[];
  violations?: number[];
}

/** A snapshot as the CLI reads it: every list optional, plus rules and series when the server sends them. */
export type SnapshotLike = Partial<Omit<ColonySnapshot, "colony" | "series">> & { colony: ColonySnapshot["colony"]; rules?: Rule[]; series?: SeriesLike };

const BARS = "▁▂▃▄▅▆▇█";

/** A one-line bar chart of `values` (the lowest bar for zero; any positive value shows at least the second). */
export function sparkline(values: readonly number[]): string {
  const finite = values.map((v) => (Number.isFinite(v) && v > 0 ? v : 0));
  const max = Math.max(0, ...finite);
  return finite.map((v) => (max <= 0 || v <= 0 ? BARS[0] : BARS[Math.min(7, Math.max(1, Math.ceil((v / max) * 7)))])).join("");
}

/**
 * Test counts in one phrase: "60/60 tests", "58/60 tests · 2 skipped", "5 of 67 failing" (skipped and
 * todo tests named whenever there are any). `verb` follows a passing count: "58/60 tests pass · 2 skipped".
 */
export function testsPhrase(cert: Pick<Certification, "counts">, verb = ""): string {
  const k = cert.counts;
  if (!k) return "";
  const bad = k.fail + k.cancelled;
  const head = bad === 0 ? `${num(k.pass)}/${num(k.tests)} tests${verb ? ` ${verb}` : ""}` : `${num(bad)} of ${num(k.tests)} failing`;
  const notRun = [k.skipped > 0 ? `${num(k.skipped)} skipped` : "", k.todo > 0 ? `${num(k.todo)} todo` : ""].filter(Boolean);
  return [head, ...notRun].join(" · ");
}

/** Names of failing tests, "a, b +3". */
function failingNames(cert: Pick<Certification, "failing">, max = 3): string {
  const names = (cert.failing ?? []).map((f) => f.name);
  return names.length ? quoteList(names, max) : "";
}

function quoteList(names: string[], max: number): string {
  const head = names.slice(0, max).map((n) => quote(n, 48)).join(", ");
  return names.length > max ? `${head} +${names.length - max}` : head;
}

/**
 * The trunk row of `ft status`: the head commit, whether its own tests passed (trunk
 * certification), and the newest green commit.
 */
export function trunkLine(col: Pick<ColonySnapshot["colony"], "trunkSha" | "greenSha" | "certification">, c: Colors): string {
  const head = shortSha(col.trunkSha);
  const green = col.greenSha ? `${c.dim("green")} ${shortSha(col.greenSha)}` : c.dim("never green yet");
  const cert = col.certification;
  if (!cert) return `${head}  ${col.greenSha ? green : c.dim("not certified yet")}`;
  const onHead = cert.trunkSha === col.trunkSha;
  const which = onHead ? "" : c.dim(` (certified ${shortSha(cert.trunkSha)}; head not yet)`);
  switch (cert.status) {
    case "green":
      return `${head}  ${c.green(`✓ green, ${testsPhrase(cert)}`)}${which}${onHead ? "" : `  ${green}`}`;
    case "red": {
      const names = failingNames(cert);
      return `${head}  ${c.red(`✗ red, ${testsPhrase(cert)}`)}${names ? ` ${names}` : ""}${which}  ${green}`;
    }
    case "running":
      return `${head}  ${c.yellow("testing…")}  ${green}`;
    case "error":
      return `${head}  ${c.yellow(`tests could not run: ${cert.detail ?? "unknown error"}`)}${which}  ${green}`;
    default:
      return `${head}  ${c.dim(cert.detail ?? "nothing to certify")}${col.greenSha ? `  ${green}` : ""}`;
  }
}

/** One line for a certification recorded in a lineage note (ft why). */
export function noteCertLine(cert: NoteCertification, c: Colors): string {
  const reused = cert.reusedFrom ? c.dim(` (same tested files as ${shortSha(cert.reusedFrom)})`) : "";
  const took = typeof cert.durationMs === "number" ? c.dim(` in ${(cert.durationMs / 1000).toFixed(1)} s`) : "";
  if (cert.status === "green") return `${c.green(`✓ ${testsPhrase(cert, "pass")}`)}${took}${reused}`;
  const names = failingNames(cert);
  return `${c.red(`✗ ${testsPhrase(cert)}`)}${names ? ` ${names}` : ""}${took}${reused}`;
}

/** What `ft certify` prints: the state and latest results, or the outcome of --now / --on / --off. */
export function formatCertify(colony: string, action: "show" | "now" | "on" | "off", res: unknown, c: Colors, now: number): string {
  const r = (res ?? {}) as {
    started?: boolean;
    reason?: string;
    enabled?: boolean;
    on?: boolean;
    deployment?: boolean;
    runner?: boolean;
    running?: boolean;
    pending?: boolean;
    greenSha?: string | null;
    policy?: { enabled?: boolean; repair?: boolean; repairsPerHour?: number };
    results?: Certification[];
  };
  if (action === "now") return r.started ? `${c.green("✓")} certifying ${c.bold(colony)}'s trunk now. Watch: ft watch ${colony} --only certify` : `${c.yellow("!")} not started: ${r.reason ?? "unknown reason"}`;
  if (action === "on" || action === "off") return `${c.green("✓")} trunk certification ${r.enabled ? "on" : "off"} for ${c.bold(colony)}`;
  const out: string[] = [];
  const why = r.on ? c.green("on") : c.yellow(`off${r.deployment === false ? " (deployment: FT_TRUNK_TESTS)" : r.runner === false ? " (no Worker Loader binding)" : r.policy?.enabled === false ? " (colony policy)" : ""}`);
  out.push(`${c.bold(colony)} trunk certification ${why}${r.running ? c.yellow(" · running") : r.pending ? c.dim(" · queued") : ""}`);
  out.push(`${c.dim("green".padEnd(11))}${r.greenSha ? shortSha(r.greenSha) : c.dim("never green yet")}`);
  if (r.policy) out.push(`${c.dim("repairs".padEnd(11))}${r.policy.repair === false ? "off" : `on, at most ${r.policy.repairsPerHour ?? 3} an hour`}`);
  const results = Array.isArray(r.results) ? r.results : [];
  if (results.length === 0) out.push(c.dim("no results yet"));
  // A run of red results with the same suspects lists them once, under the newest; the same goes for the first failing commit.
  let listed = "";
  let listedFirst = "";
  for (const cert of results) {
    const when = typeof cert.startedAt === "number" ? c.dim(ago(cert.finishedAt ?? cert.startedAt, now).padStart(8)) : "";
    let what: string;
    if (cert.status === "green") what = c.green(`✓ ${testsPhrase(cert)}`);
    else if (cert.status === "red") what = `${c.red(`✗ ${testsPhrase(cert)}`)} ${failingNames(cert, 2)}`;
    else what = c.dim(`${cert.status}${cert.detail ? `: ${cert.detail}` : ""}`);
    const suspects = cert.status === "red" ? suspectsOf(cert) : [];
    const extra = [
      typeof cert.durationMs === "number" ? `${cert.durationMs} ms` : "",
      cert.reusedFrom ? `as ${shortSha(cert.reusedFrom)}` : cert.cached ? `${cert.cached} file${cert.cached === 1 ? "" : "s"} reused` : "",
      cert.repairIntentId ? `repair ${cert.repairIntentId}` : "",
      suspects.length > 0 ? `${suspects.length} suspect${suspects.length === 1 ? "" : "s"}` : "",
    ].filter(Boolean);
    out.push(`  ${shortSha(cert.trunkSha)} ${when}  ${what}${extra.length ? c.dim(`  (${extra.join(", ")})`) : ""}`);
    const key = suspects.map((s) => s.proposalId ?? s.landingId).join(" ");
    if (suspects.length > 0 && key !== listed) out.push(...suspectLines(colony, suspects, c));
    if (suspects.length > 0) listed = key;
    // The first red search (FT_BISECT): the commit at which the failing tests first failed, once the search ended.
    const first = cert.status === "red" ? firstRedLines(colony, cert.firstRed, c) : [];
    if (first.length > 0 && first[0] !== listedFirst) out.push(...first);
    if (first.length > 0) listedFirst = first[0]!;
  }
  return out.join("\n");
}

/**
 * A red result's first failing commit for `ft certify`: "first red 1a2b3c4 (landing lnd_4, intent "..."), found in 3
 * test runs; its change to src/math.ts is the likely cause.", with the command that undoes each proposal it names, or
 * why the search named none. Nothing for a result without an answer or with one it cannot read.
 */
function firstRedLines(colony: string, raw: unknown, c: Colors): string[] {
  const f = (raw ?? null) as Partial<NonNullable<Certification["firstRed"]>> | null;
  if (!f || typeof f !== "object") return [];
  const runs = typeof f.probes === "number" ? `${f.probes} test run${f.probes === 1 ? "" : "s"}` : "";
  if (f.status === "inconclusive") return [c.dim(`    first red not found: ${typeof f.reason === "string" && f.reason ? f.reason : "the search was inconclusive"}`)];
  if (f.status !== "found" || typeof f.trunkSha !== "string") return [];
  const intents = (Array.isArray(f.intents) ? f.intents : []).filter((i) => i && typeof i.id === "string");
  const proposals = (Array.isArray(f.proposals) ? f.proposals : []).filter((p) => p && typeof p.id === "string" && Array.isArray(p.paths));
  const titled = intents.map((i) => (typeof i.title === "string" && i.title ? quote(i.title, 60) : i.id));
  const who = titled.length === 0 ? "a commit FireTrident made itself" : titled.length === 1 ? `intent ${titled[0]}` : `intents ${titled[0]} and ${titled.length - 1} more`;
  const where = [typeof f.landingId === "string" && f.landingId ? `landing ${f.landingId}` : "", who].filter(Boolean).join(", ");
  const paths = [...new Set(proposals.flatMap((p) => p.paths.filter((x): x is string => typeof x === "string")))].sort();
  const shown = paths.length > 3 ? `${paths.slice(0, 3).join(", ")} +${paths.length - 3}` : paths.join(", ");
  const cause = paths.length > 0 ? `its change to ${shown} is the likely cause.` : "none of its proposals changed a file the failing tests load.";
  // Proposal isolation: the proposal inside the landing, and its undo shown as proven only when reverting it alone turned the tests green.
  const iso = isolationOf(f);
  const inside = !iso ? "" : iso.culprit ? ` Isolated ${iso.culprit}${iso.proven ? " (proven)" : " (not shown causal)"}.` : iso.status === "inconclusive" ? " Isolating a proposal inside it was inconclusive." : " No single proposal inside it.";
  const out = [`    ${c.red("first red")} ${c.bold(shortSha(f.trunkSha))} (${where})${runs ? `, found in ${runs}` : ""}; ${cause}${inside}`];
  if (!iso) {
    for (const p of proposals.slice(0, SUSPECTS_SHOWN)) out.push(`      ${c.dim("undo:")} ft revert ${colony} ${p.id}`);
    return out;
  }
  if (iso.culprit) {
    const about = [iso.title ? `intent ${quote(iso.title, 60)}` : iso.intent ? `intent ${iso.intent}` : "", iso.agent ? `agent ${iso.agent}` : ""].filter(Boolean).join(", ");
    out.push(`      ${c.dim("inside:")} ${iso.culprit}${about ? ` (${about})` : ""}: the failing tests pass without it${iso.probes > 0 ? `, in ${iso.probes} more test run${iso.probes === 1 ? "" : "s"}` : ""}; ${iso.revert || "not shown causal"}`);
    out.push(`      ${c.dim(iso.proven ? "undo (proven):" : "undo (not proven):")} ft revert ${colony} ${iso.culprit}`);
    return out;
  }
  out.push(`      ${c.dim("inside:")} ${iso.reason}`);
  for (const p of proposals.slice(0, SUSPECTS_SHOWN)) out.push(`      ${c.dim("undo (not proven):")} ft revert ${colony} ${p.id}`);
  return out;
}

/** A first red answer's proposal isolation as `ft certify` reads it (older answers carry none; odd data reads as none). */
function isolationOf(f: unknown): { status: string; reason: string; culprit: string; title: string; intent: string; agent: string; proven: boolean; revert: string; probes: number } | null {
  const iso = f && typeof f === "object" ? (f as { isolated?: unknown }).isolated : null;
  if (!iso || typeof iso !== "object") return null;
  const i = iso as Record<string, unknown>;
  if (typeof i.status !== "string" || typeof i.reason !== "string") return null;
  const c = (i.culprit && typeof i.culprit === "object" ? i.culprit : {}) as Record<string, unknown>;
  const r = (i.revert && typeof i.revert === "object" ? i.revert : {}) as Record<string, unknown>;
  const text = (x: unknown): string => (typeof x === "string" ? plainLine(x) : "");
  const culprit = i.status === "isolated" ? text(c.id) : "";
  return {
    status: i.status,
    reason: plainLine(i.reason),
    culprit,
    title: typeof c.title === "string" ? c.title : "",
    intent: text(c.intentId),
    agent: text(c.agentId),
    proven: culprit !== "" && r.causal === true,
    revert: text(r.reason),
    probes: typeof i.probes === "number" ? i.probes : 0,
  };
}

/** Suspects listed under one red result of `ft certify`. */
const SUSPECTS_SHOWN = 3;

/** A change culprit finding suspects of breaking failing tests (core's Suspect). */
type Suspect = NonNullable<Certification["suspects"]>[number];

/** A result's suspects (culprit finding), keeping only well-formed entries (a server may send odd or older data). */
function suspectsOf(cert: Pick<Certification, "suspects">): Suspect[] {
  const list: unknown[] = Array.isArray(cert.suspects) ? cert.suspects : [];
  const strings = (x: unknown): string[] => (Array.isArray(x) ? x.filter((p): p is string => typeof p === "string" && p !== "") : []);
  return list.flatMap((raw): Suspect[] => {
    const s = (raw ?? {}) as Partial<Record<keyof Suspect, unknown>>;
    if (typeof s.landingId !== "string" || s.landingId === "") return [];
    const out: Suspect = { landingId: s.landingId, paths: strings(s.paths), files: strings(s.files), at: typeof s.at === "number" ? s.at : 0 };
    if (typeof s.proposalId === "string" && s.proposalId) out.proposalId = s.proposalId;
    if (typeof s.intentId === "string" && s.intentId) out.intentId = s.intentId;
    if (typeof s.title === "string" && s.title) out.title = s.title;
    if (typeof s.trunkSha === "string" && s.trunkSha) out.trunkSha = s.trunkSha;
    const labels = strings(s.labels).filter((l): l is SuspectLabel => Object.hasOwn(LABEL_WORDS, l));
    if (labels.length > 0) out.labels = labels;
    return [out];
  });
}

/** Why culprit finding lists a suspect (core's SuspectLabel). */
type SuspectLabel = NonNullable<Suspect["labels"]>[number];

/** The labels in words, in the order `ft certify` prints them. */
const LABEL_WORDS: Record<SuspectLabel, string> = { "first-red": "first red", isolated: "isolated", "first-since-green": "first since green", latest: "latest" };

/** At most `n` suspects in their order (newest first), the first red and first since green ones kept before newer ones. */
function shownSuspects(list: Suspect[], n: number): Suspect[] {
  const rank = (s: Suspect): number => (s.labels?.includes("first-red") ? 0 : s.labels?.includes("first-since-green") ? 1 : 2);
  const kept = new Set(
    list
      .map((s, i) => ({ r: rank(s), i }))
      .sort((a, b) => a.r - b.r || a.i - b.i)
      .slice(0, n)
      .map((x) => x.i),
  );
  return list.filter((_, i) => kept.has(i));
}

/**
 * A red result's suspects for `ft certify`, newest first: why each is listed (its labels, when the
 * server recorded them), the proposal (or landing) that changed what the failing tests load, its
 * intent's title, the files it changed, and the command that undoes it.
 */
function suspectLines(colony: string, suspects: Suspect[], c: Colors): string[] {
  const out: string[] = [];
  const names = (list: string[], max: number): string => (list.length > max ? `${list.slice(0, max).join(", ")} +${list.length - max}` : list.join(", "));
  for (const s of shownSuspects(suspects, SUSPECTS_SHOWN)) {
    const ref = s.proposalId ?? s.landingId;
    const labels = (Object.keys(LABEL_WORDS) as SuspectLabel[]).filter((l) => s.labels?.includes(l)).map((l) => LABEL_WORDS[l]);
    const where = [s.proposalId ? `landing ${s.landingId}` : "", s.trunkSha ? shortSha(s.trunkSha) : ""].filter(Boolean).join(", ");
    const changed = s.paths.length > 0 ? ` changed ${names(s.paths, 3)}` : "";
    const files = s.files.length > 0 ? ` for ${names(s.files, 2)}` : "";
    out.push(`    ${c.yellow("suspect")} ${labels.length > 0 ? `${c.yellow(`[${labels.join(", ")}]`)} ` : ""}${c.bold(ref)}${s.title ? ` ${quote(s.title, 60)}` : ""}${changed}${c.dim(`${where ? ` (${where})` : ""}${files}`)}`);
    out.push(`      ${c.dim("undo:")} ft revert ${colony} ${ref}`);
  }
  if (suspects.length > SUSPECTS_SHOWN) out.push(c.dim(`    and ${suspects.length - SUSPECTS_SHOWN} more (--json lists them)`));
  return out;
}

/** Compact human summary of a colony snapshot. */
export function formatStatus(s: SnapshotLike, c: Colors, now: number): string {
  const col = s.colony;
  const files = s.files ?? [];
  const intents = s.intents ?? [];
  const agents = s.agents ?? [];
  const landings = s.recentLandings ?? [];
  const rules = new Map((s.rules ?? []).map((r) => [r.id, r]));
  const out: string[] = [];
  const row = (label: string, value: string) => out.push(`${c.dim(label.padEnd(11))}${value}`);

  const head = `${c.bold(col.name ?? col.id)} ${c.dim(col.id)}`;
  out.push(col.source ? `${head}  ${c.dim("from")} ${col.source.url}${col.source.branch ? c.dim(` (${col.source.branch})`) : ""}` : head);
  // The pauses in force (pause.ts) come first; a server without the switch sends none.
  out.push(...pauseLines(s.pauses, col.id, c));
  row("trunk", trunkLine(col, c));
  const regions = new Set(files.map((f) => regionOf(f.path, col.regionDepth || 1)));
  row("files", `${num(files.length)} in ${num(regions.size)} region${regions.size === 1 ? "" : "s"}`);
  row("intents", intents.length ? `${num(intents.length)}: ${breakdown(countBy(intents, (i) => i.status), INTENT_ORDER, c)}` : c.dim("none"));
  row("agents", agents.length ? `${num(agents.length)}: ${breakdown(countBy(agents, (a) => a.state), AGENT_ORDER, c)}` : c.dim("none"));

  const v = s.violations ?? { total: 0, byRule: {} };
  const byRule = Object.entries(v.byRule ?? {}).sort((a, b) => b[1] - a[1]);
  const ruleText = byRule
    .slice(0, 3)
    .map(([id, n]) => {
      const r = rules.get(id);
      return `${id}${r ? ` ${quote(r.description, 40)}` : ""} ${num(n)}`;
    })
    .join(c.dim(" · "));
  const vText = v.total === 0 ? c.green("0 left") : c.yellow(`${num(v.total)} left`);
  row("violations", `${vText}${ruleText ? `  ${ruleText}` : ""}${byRule.length > 3 ? c.dim(` +${byRule.length - 3} rules`) : ""}`);

  const f = s.funnel;
  if (f) row("decisions", `reflex ${num(f.reflex ?? 0)}${c.dim(" · ")}llm ${num(f.llm ?? 0)}${c.dim(" · ")}human ${num(f.human ?? 0)}`);
  if (landings.length) {
    const latest = [...landings].sort((a, b) => b.at - a.at)[0] as Landing;
    row("landings", `${num(landings.length)} recent, latest ${shortSha(latest.trunkSha)} ${ago(latest.at, now)} (${latest.proposalIds.length} proposals, ${latest.paths.length} paths)`);
  } else {
    row("landings", c.dim("none yet"));
  }
  const m = s.metrics;
  if (m && typeof m.proposalsInFlight === "number") {
    const review = m.reviewQueue ? ` · ${num(m.reviewQueue)} awaiting review` : "";
    const rate = typeof m.landingsPerMin === "number" ? c.dim(` · ${num(m.landingsPerMin)} landings/min`) : "";
    row("in flight", `${num(m.proposalsInFlight)} proposal${m.proposalsInFlight === 1 ? "" : "s"}${review}${rate}`);
  }
  // Model spend as the colony prices it from the tokens it counted (spend.ts); a server that predates it sends none.
  const spent = spendLine(s.spend);
  if (spent) row("spend", `${spent}${s.spend?.priceDate ? c.dim(` (Workers AI list prices on ${plainLine(s.spend.priceDate)})`) : ""}`);
  // The spend cap (spendcap.ts), when a person set one.
  const capped = spendCapStatus(s.spend?.cap, c);
  if (capped) row("spend cap", capped);
  const series = s.series;
  if (series && Array.isArray(series.landings) && series.landings.length > 0) {
    const total = series.landings.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
    const vs = Array.isArray(series.violations) ? series.violations : [];
    const first = vs[0];
    const last = vs[vs.length - 1];
    const trend = first !== undefined && last !== undefined && first !== last ? `${c.dim(" · violations ")}${num(first)} → ${num(last)}` : "";
    row("last 30m", `${total > 0 ? `${sparkline(series.landings)} ${num(total)} landing${total === 1 ? "" : "s"}` : c.dim("no landings")}${trend}`);
  }
  if (s.stuck) out.push(...stuckLines(s.stuck, col.id, c, now));
  // The megafile alarm's held files (megafile.ts); a server without the alarm on for the colony sends none.
  if (s.megafiles) out.push(...megafileLines(s.megafiles, col.id, c, now));
  return out.join("\n");
}

/** What a person can do about a stuck item, in words. */
const STUCK_DO: Readonly<Record<StuckAction, string>> = {
  agent: "look at the agent",
  intent: "amend or withdraw the intent",
  tests: "look at the failing tests",
  answer: "answer the report",
  review: "review the change",
};

/** Text from the server (it quotes agents' words) as one terminal line: no control characters. */
function plainLine(s: unknown): string {
  return typeof s === "string" ? s.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim() : "";
}

/** The command that does what a stuck item asks, for `colony`. */
export function stuckCommand(item: Pick<StuckItem, "action" | "intentId" | "agentId" | "proposalId">, colony: string): string {
  switch (item.action) {
    case "answer":
      return `ft escalation ${colony} ${item.intentId ?? "<intentId>"} amend|withdraw|dismiss --note <text>`;
    case "review":
      return `ft review ${colony}`;
    case "intent":
      return `ft intent show ${colony} ${item.intentId ?? "<intentId>"}`;
    case "tests":
      return `ft certify ${colony}`;
    default:
      return item.agentId ? `ft agents ${colony}  (steer it: ft direct ${colony} ${item.agentId} "<message>")` : `ft agents ${colony}`;
  }
}

/**
 * The stuck rows of `ft status`: how many items, then each one with how long it has been stuck, what
 * is stuck, and what to do about it (the command). "none" when nothing is stuck.
 */
export function stuckLines(report: StuckReport, colony: string, c: Colors, now: number): string[] {
  const items = Array.isArray(report.items) ? report.items.filter((i) => i && typeof i.text === "string") : [];
  const total = typeof report.total === "number" && report.total > items.length ? report.total : items.length;
  if (total === 0) return [`${c.dim("stuck".padEnd(11))}${c.green("none")}`];
  const oldest = Math.min(...items.map((i) => (Number.isFinite(i.since) ? i.since : now)));
  const out = [`${c.dim("stuck".padEnd(11))}${c.yellow(`${num(total)} item${total === 1 ? "" : "s"}`)}${items.length ? c.dim(`, the oldest for ${ago(oldest, now).replace(/ ago$/, "")}`) : ""}`];
  for (const item of items) {
    const age = ago(Number.isFinite(item.since) ? item.since : now, now).replace(/ ago$/, "").padStart(4);
    const what = STUCK_DO[item.action] ?? STUCK_DO.agent;
    out.push(`  ${item.kind === "red" ? c.red(age) : c.yellow(age)}  ${plainLine(item.text)}`);
    out.push(`        ${c.dim("→")} ${what}: ${c.cyan(stuckCommand(item, colony))}`);
  }
  if (total > items.length) out.push(c.dim(`  +${num(total - items.length)} more`));
  return out;
}

/** One row of GET /api/colonies as the CLI reads it. */
export interface ColonyRow {
  id: string;
  name?: string;
  source?: { url: string; branch?: string };
  createdAt?: number;
  trunkSha?: string;
  lastLandingAt?: number | null;
  counters?: Record<string, number>;
  error?: string;
}

/** One row of GET /api/colonies/:id/agents as the CLI reads it. */
export interface AgentRow {
  id: string;
  kind?: string;
  name?: string;
  model?: string;
  state?: string;
  intentId?: string;
  intentTitle?: string;
  lastSeen?: number;
  step?: string;
  running?: boolean;
  attempts?: number;
  lastError?: string;
  stopReason?: string;
  journalError?: string;
  /** The agent's own counters (taken, proposed, landed, returned, waits, ...). */
  counters?: Record<string, number>;
  /** What the agent says it is doing now (its relayed status note), and when it said it. */
  note?: string;
  noteAt?: number;
}

/** Visible width of a string (ANSI color codes do not count). */
function width(s: string): number {
  return [...s.replace(/\u001b\[[0-9;]*m/g, "")].length;
}

function cut(s: string, max: number): string {
  const chars = [...s];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : s;
}

/** Aligned columns: `right` holds the indexes of right-aligned (numeric) columns; the header is dimmed. */
export function table(header: string[], rows: string[][], right: ReadonlySet<number>, c: Colors): string[] {
  const widths = header.map((h, i) => Math.max(width(h), ...rows.map((r) => width(r[i] ?? ""))));
  const line = (cells: string[]) =>
    cells
      .map((cell, i) => {
        const pad = " ".repeat(Math.max(0, (widths[i] ?? 0) - width(cell)));
        return right.has(i) ? pad + cell : i === cells.length - 1 ? cell : cell + pad;
      })
      .join("  ")
      .trimEnd();
  return [c.dim(line(header)), ...rows.map(line)];
}

/** "github.com/org/repo" for a source URL. */
export function shortSource(url: string | undefined): string {
  if (!url) return "-";
  return url.replace(/^https?:\/\//i, "").replace(/\.git$/i, "").replace(/\/+$/, "");
}

/** The colony list: counters, trunk, age, and source per colony. */
export function formatColonies(rows: ColonyRow[], c: Colors, now: number): string {
  if (rows.length === 0) return c.dim("No colonies yet. Start one: ft import <git-url>   or   ft new --spec <file>");
  const n = (r: ColonyRow, k: string) => num(r.counters?.[k] ?? 0);
  const age = (r: ColonyRow) => (typeof r.createdAt === "number" ? ago(r.createdAt, now) : "-");
  const body = rows.map((r) =>
    r.error
      ? [r.id, "?", "?", "?", "?", "?", "?", "-", age(r), c.red(`unreachable: ${cut(r.error, 60)}`)]
      : [
          r.id,
          n(r, "agentsActive"),
          n(r, "intentsOpen"),
          n(r, "intentsLanded"),
          n(r, "landings"),
          n(r, "landingsPerMin"),
          n(r, "violations"),
          shortSha(r.trunkSha),
          age(r),
          shortSource(r.source?.url),
        ],
  );
  const lines = table(["COLONY", "AGENTS", "OPEN", "LANDED", "LANDINGS", "/MIN", "VIOLATIONS", "TRUNK", "CREATED", "SOURCE"], body, new Set([1, 2, 3, 4, 5, 6]), c);
  return [`${c.bold(String(rows.length))} ${rows.length === 1 ? "colony" : "colonies"}`, ...lines].join("\n");
}

/** What an agent is doing right now, from its journal when it has one (a running agent without a job is polling take). */
function agentStep(a: AgentRow): string {
  if (a.state === "dead") return a.running ? "stopping" : "-";
  if (a.step) return a.attempts && a.attempts > 1 ? `${a.step} (try ${a.attempts})` : a.step;
  if (a.running === false) return "stopped";
  return a.running ? "take" : "-";
}

/** A colony's agents: kind, state, step, intent, model, last seen, and any error. */
export function formatAgents(colony: string, rows: AgentRow[], c: Colors, now: number): string {
  if (rows.length === 0) return `${c.bold(colony)}  ${c.dim("no agents (ft swarm <colony> --agents <n> starts some; --all shows stopped ones)")}`;
  const states = breakdown(countBy(rows, (a) => a.state ?? "?"), AGENT_ORDER, c);
  const notes = rows.map((a) => a.lastError ?? (a.state === "dead" ? a.stopReason : undefined) ?? a.journalError ?? "");
  const withNotes = notes.some(Boolean);
  const withLanded = rows.some((a) => a.counters !== undefined);
  // What each agent says it is doing (its relayed status note), with how old the note is.
  const withNow = rows.some((a) => typeof a.note === "string" && a.note !== "");
  const body = rows.map((a, i) => {
    const state = c[AGENT_COLOR[a.state as AgentState] ?? "dim"](a.state ?? "?");
    const intent = a.intentTitle ? quote(a.intentTitle, 40) : (a.intentId ?? "-");
    const cells = [a.id, a.kind ?? "-", state, agentStep(a), intent, a.model ?? "-"];
    if (withLanded) cells.push(a.counters ? num(a.counters.landed ?? 0) : "-");
    cells.push(typeof a.lastSeen === "number" ? ago(a.lastSeen, now) : "-");
    if (withNow) cells.push(a.note ? `${cut(a.note, 70)}${typeof a.noteAt === "number" ? c.dim(` (${ago(a.noteAt, now)})`) : ""}` : "");
    if (withNotes) cells.push(notes[i] ? c.dim(cut(notes[i] ?? "", 60)) : "");
    return cells;
  });
  const header = ["AGENT", "KIND", "STATE", "STEP", "INTENT", "MODEL", ...(withLanded ? ["LANDED"] : []), "SEEN", ...(withNow ? ["NOW"] : []), ...(withNotes ? ["NOTE"] : [])];
  return [`${c.bold(colony)}  ${num(rows.length)} agent${rows.length === 1 ? "" : "s"}: ${states}`, ...table(header, body, withLanded ? new Set([6]) : new Set(), c)].join("\n");
}

/** What POST .../stop and .../swarm/stop answered. */
export interface StopResult {
  ok?: boolean;
  agentId?: string;
  considered?: number;
  stopped?: string[];
  failed?: Array<{ agentId: string; error: string }>;
  retired?: number;
}

/** The outcome of `ft stop`. */
export function formatStop(colony: string, agentId: string | undefined, res: StopResult, c: Colors): string {
  const stopped = res.stopped ?? [];
  const failed = res.failed ?? [];
  const out: string[] = [];
  if (agentId) {
    out.push(stopped.includes(agentId) ? `${c.green("✓")} Stopped ${c.bold(agentId)} in ${colony}` : `${c.red("✗")} ${agentId} did not stop`);
    if (stopped.includes(agentId)) out.push(c.dim("  Its claimed intent is open again; a proposal already in a lane stands."));
  } else if (stopped.length === 0 && failed.length === 0) {
    out.push(`${c.green("✓")} No running in-platform agents in ${colony}`);
  } else {
    out.push(`${c.green("✓")} Stopped ${num(stopped.length)} agent${stopped.length === 1 ? "" : "s"} in ${c.bold(colony)}`);
  }
  for (const f of failed.slice(0, 10)) out.push(`  ${c.red("✗")} ${f.agentId}: ${f.error}`);
  if (failed.length > 10) out.push(c.dim(`  +${failed.length - 10} more failures`));
  return out.join("\n");
}

/** What DELETE /api/colonies/:id answered. */
export interface DeleteResult {
  found?: boolean;
  ok?: boolean;
  agents?: { stopped?: number; failed?: Array<{ agentId: string; error: string }> };
  repos?: { deleted?: string[]; failed?: Array<{ repo: string; error: string }> };
  objects?: Array<{ object: string; cleared: boolean; detail?: string }>;
  unregistered?: boolean;
}

/** The outcome of `ft delete`: agents stopped, repos deleted per namespace, object storage cleared. */
export function formatDelete(colony: string, res: DeleteResult, c: Colors): string {
  const deleted = res.repos?.deleted ?? [];
  const objects = res.objects ?? [];
  if (!res.found && deleted.length === 0 && objects.length === 0) {
    return `${c.green("✓")} Nothing left of ${c.bold(colony)}: no colony record and no repos${res.unregistered ? " (dropped its registry entry)" : ""}`;
  }
  const out = [`${c.green("✓")} Deleted colony ${c.bold(colony)}${res.found ? "" : c.dim(" (leftovers of a colony without a record)")}`];
  const row = (label: string, value: string) => out.push(`  ${c.dim(label.padEnd(9))}${value}`);
  row("agents", `${num(res.agents?.stopped ?? 0)} stopped`);
  const perNs = countBy(deleted, (r) => r.split("/")[0] ?? "?");
  row("repos", deleted.length ? `${num(deleted.length)} deleted ${c.dim(`(${[...perNs].map(([ns, n]) => `${ns} ${n}`).join(", ")})`)}` : "none left");
  const kinds = new Map<string, { cleared: number; total: number; detail?: string }>();
  for (const o of objects) {
    const kind = o.object.split(" ")[0] ?? o.object;
    const k = kinds.get(kind) ?? { cleared: 0, total: 0 };
    k.total++;
    if (o.cleared) k.cleared++;
    else k.detail ??= o.detail;
    kinds.set(kind, k);
  }
  const parts = [...kinds].map(([kind, k]) => (k.cleared === k.total ? `${kind} ${k.total > 1 ? `${k.cleared}/${k.total} ` : ""}${c.green("cleared")}` : `${kind} ${k.cleared}/${k.total} ${c.yellow("cleared")}${k.detail ? c.dim(` (${cut(k.detail, 50)})`) : ""}`));
  if (parts.length) row("storage", parts.join(c.dim(" · ")));
  if (res.unregistered) row("registry", "removed");
  return out.join("\n");
}

/**
 * The outcome of `ft vaccinate`: `{ batch, requested, started, vaccines: [{ cls, ... }], skipped: [{ cls, reason }] }`,
 * read defensively (any other shape prints its numeric fields).
 */
export function formatVaccinate(colony: string, count: number, res: unknown, c: Colors): string {
  const o = res && typeof res === "object" && !Array.isArray(res) ? (res as Record<string, unknown>) : {};
  const vaccines = Array.isArray(o.vaccines) ? (o.vaccines as Array<{ cls?: unknown }>) : null;
  const skipped = Array.isArray(o.skipped) ? (o.skipped as Array<{ cls?: unknown; reason?: unknown }>) : [];
  if (vaccines) {
    const started = typeof o.started === "number" ? o.started : vaccines.length;
    const batch = typeof o.batch === "string" ? c.dim(` (batch ${o.batch})`) : "";
    const out = [`${c.green("✓")} Vaccinated ${c.bold(colony)}: ${num(started)} of ${num(typeof o.requested === "number" ? o.requested : count)} vaccine${started === 1 ? "" : "s"} started${batch}`];
    const byClass = countBy(vaccines, (v) => (typeof v.cls === "string" ? v.cls : "?"));
    if (byClass.size) out.push(`  ${[...byClass].map(([cls, n]) => `${cls} ${num(n)}`).join(c.dim(" · "))}`);
    for (const s of skipped.slice(0, 5)) out.push(c.dim(`  skipped ${typeof s.cls === "string" ? s.cls : "?"}: ${typeof s.reason === "string" ? s.reason : "no reason given"}`));
    out.push(c.dim(`  Watch the meter: ft watch ${colony} --only decision`));
    return out.join("\n");
  }
  const extra = Object.entries(o)
    .filter(([, v]) => typeof v === "number")
    .map(([k, v]) => `${k} ${num(v as number)}`);
  const head = `${c.green("✓")} Vaccinated ${c.bold(colony)}: asked for ${num(count)}`;
  return extra.length ? `${head}\n  ${c.dim(extra.join(" · "))}` : head;
}

/** The decide policy fields `ft policy` and `ft status` show (GET /api/colonies/:id/decide/policy). */
export interface DecidePolicyView {
  enabled?: boolean;
  deterministic?: boolean;
  commentProof?: boolean;
  protectedPaths?: string[];
  /** After a POST that protected new globs: what that did to the changes already cleared to land. */
  protection?: ProtectionView;
}

/** What protecting new globs did to the changes already cleared to land (the policy answer's `protection`). */
export interface ProtectionView {
  added?: string[];
  stopped?: Array<{ proposalId?: string; path?: string; glob?: string }>;
  landed?: Array<{ proposalId?: string; landingId?: string; trunkSha?: string; path?: string; glob?: string }>;
  confirmed?: boolean;
  unconfirmed?: string[];
}

/**
 * The lines `ft policy` prints after protecting new globs: each change already cleared to land that now waits for a
 * person, each one the trunk writer had already landed (with the revert that undoes it), and the ones it did not answer for.
 */
export function protectionLines(colony: string, p: ProtectionView | undefined, c: Colors): string[] {
  if (!p || typeof p !== "object") return [];
  const out: string[] = [];
  const where = (x: { path?: string; glob?: string }) => `${x.path ?? "?"} (protected by ${x.glob ?? "?"})`;
  for (const s of Array.isArray(p.stopped) ? p.stopped : []) out.push(`  ${c.yellow("stopped")} ${s.proposalId ?? "?"}: ${where(s)} waits for a person in the review queue`);
  for (const l of Array.isArray(p.landed) ? p.landed : []) {
    out.push(`  ${c.yellow("landed")}  ${l.proposalId ?? "?"} in ${l.landingId ?? "?"} (trunk ${(l.trunkSha ?? "").slice(0, 7)}) before the protection reached the trunk writer: ${where(l)}; ft revert ${colony} ${l.proposalId ?? "<proposal>"} undoes it`);
  }
  for (const id of Array.isArray(p.unconfirmed) ? p.unconfirmed : []) out.push(`  ${c.red("unconfirmed")} ${id}: the trunk writer did not answer, so it may still land`);
  return out;
}

/** The protected paths, comma-separated, or "none". */
function protectedList(p: DecidePolicyView, c: Colors): string {
  const globs = Array.isArray(p.protectedPaths) ? p.protectedPaths.filter((g) => typeof g === "string") : [];
  return globs.length === 0 ? c.dim("none") : `${globs.join(", ")} ${c.dim("(a person decides every change to them)")}`;
}

/** What `ft policy` prints: whether review runs, the deterministic proofs, and the protected paths. */
export function formatPolicy(colony: string, p: DecidePolicyView, c: Colors): string {
  const out = [`${c.bold(colony)} decide policy`];
  const row = (label: string, value: string) => out.push(`${c.dim(label.padEnd(11))}${value}`);
  row("review", p.enabled === false ? c.yellow("off: changes go to their lanes without review") : "on");
  const comments = p.commentProof === false ? c.yellow("comment-only proof off") : "comment-only changes";
  row("proofs", p.deterministic === false ? c.yellow("off: every change needs a model or a person") : `import rewrites, rule replacements, ${comments}`);
  row("protected", protectedList(p, c));
  return out.join("\n");
}

/** Rows `ft status` adds under its summary: the protected paths, and the comment-only proof when it is off. None for an older server. */
export function policyRows(p: DecidePolicyView | undefined, c: Colors): string[] {
  if (!p || typeof p !== "object") return [];
  const out: string[] = [];
  if (Array.isArray(p.protectedPaths) && p.protectedPaths.length > 0) out.push(`${c.dim("protected".padEnd(11))}${protectedList(p, c)}`);
  if (p.commentProof === false) out.push(`${c.dim("proofs".padEnd(11))}${c.yellow("comment-only proof off")}`);
  return out;
}

/** A change's checks in runs of who said them (core/answerable.ts): FireTrident's first, then the models', then the agent's. */
function checkLine(evidence: Partial<Evidence> | undefined, c: Colors): string {
  const runs = bySpeaker(evidenceLines(evidence).filter((l) => l.kind === "check"));
  if (runs.length === 0) return c.dim("none recorded");
  return runs.map((r) => `${c.dim(`${r.speaker.label}:`)} ${r.lines.map((k) => `${k.ok ? c.green("✓") : c.red("✗")} ${k.name} ${c.dim(ms(k.ms ?? 0))}`).join("  ")}`).join(c.dim(" · "));
}

/** The statement of what a change did not verify, with who wrote it: the agent's words quoted, FireTrident's as they are. */
function unprovenLine(evidence: Partial<Evidence> | undefined, c: Colors): string | null {
  const words = notVerifiedWords(evidence?.notVerified);
  if (!words) return null;
  const s = notVerifiedSpeaker(evidence);
  return `${c.dim(`${s.label}:`)} ${s.kind === "platform" ? words : `"${words}"`}`;
}

function ms(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${Math.round(n)}ms`;
}

/** Context that turns ids into words in `ft why`: intents (for parent chains) and rules. */
export interface WhyContext {
  intents?: Intent[];
  rules?: Rule[];
  /** Each landing's test row, by landing id, where the colony gave one (tests.ts). */
  tests?: Record<string, LandingTests>;
  /** The status read's newest green commit and recent landings: the lifecycle strip places a landing without a test row by them (strip.ts). */
  greenSha?: string;
  landings?: Landing[];
  /** The status read's latest certification: each landing's holds row ends with the tests that cover it (holds.ts). */
  certification?: CertNow;
}

/**
 * Readable lineage for a file or line: landings, proposals, intent chain, rule, decisions, checks.
 * Landings print newest first; for a line, in the server's order, which puts the landing that wrote
 * the line first when it is known.
 */
export function formatWhy(
  target: { path: string; line?: number },
  entries: Array<{ landing: Landing; note: LineageNote; holds?: WhyHolds; walk?: WhyWalk }>,
  ctx: WhyContext,
  c: Colors,
  now: number,
): string {
  const where = target.line !== undefined ? `${target.path}:${target.line}` : target.path;
  // Lineage comes from stored notes; tolerate partial ones rather than crash mid-demo.
  const at = (l: Partial<Landing> | undefined) => (typeof l?.at === "number" && Number.isFinite(l.at) ? l.at : 0);
  const found = entries.filter((e) => e && e.landing);
  const sorted = target.line !== undefined ? found : found.sort((a, b) => at(b.landing) - at(a.landing));
  if (sorted.length === 0) return `${c.bold(where)}  ${c.dim("no FireTrident landing touched this yet (history before import has no lineage)")}`;
  const intents = new Map((ctx.intents ?? []).map((i) => [i.id, i]));
  const rules = new Map((ctx.rules ?? []).map((r) => [r.id, r]));
  // The server only ever moves the line's landing ahead of newer ones: a newer landing after the first means it did.
  const first = at(sorted[0]?.landing);
  // A server with the walk (trunk/whywalk.ts) says whether the first landing wrote the line; else the order tells.
  const owner = target.line !== undefined && (walkOwnsFirst(sorted[0]) ?? sorted.slice(1).some((e) => at(e.landing) > first));
  const order = owner ? `the landing that wrote line ${target.line} first, then newest first` : "newest first";
  const out: string[] = [`${c.bold(where)}  ${c.dim(`${sorted.length} landing${sorted.length === 1 ? "" : "s"}, ${order}`)}`];
  // How the walk found it: the formatting-only landings it skipped, the moves it followed (holds.ts).
  out.push(...walkRows(sorted[0]?.walk, target, c));
  const label = (s: string) => c.dim(s.padEnd(9));

  for (const entry of sorted) {
    const { landing, note } = entry;
    out.push("");
    const when = at(landing) ? `  ${new Date(at(landing)).toISOString().replace("T", " ").slice(0, 16)}Z ${c.dim(`(${ago(at(landing), now)})`)}` : "";
    out.push(`${c.green("●")} ${c.bold(`landing ${landing.id}`)}  ${shortSha(landing.trunkSha)} ${c.dim(`← ${shortSha(landing.parentSha)}`)}${when}`);
    // Who answers for this landing, from its whole note (core/answerable.ts), as the Why tab says it.
    const answer = landingAnswerable(note);
    out.push(`  ${label("answer")}${answer.answer === "person" ? answer.text : c.yellow(answer.text)}`);
    // The rule that confirmed it, with the values it used (gateline.ts, core/decides.ts).
    out.push(`  ${label("gate")}${confirmedLine(note, c)}`);
    // Its tests at its base against the certified commit (tests.ts), where the colony gave its row.
    const row = ctx.tests && Object.hasOwn(ctx.tests, landing.id) ? ctx.tests[landing.id] : undefined;
    if (row) for (const r of testsRows(row, c)) out.push(`  ${label(r.k)}${r.v}`);
    // Whether it still holds on today's trunk, and the tests that cover it now (holds.ts).
    const holds = holdsRow(entry, row, ctx.certification, c);
    if (holds) out.push(`  ${label("holds")}${holds}`);
    // Recipes (recipe.ts): a recipe's batch names the recipe and who declared it.
    for (const r of recipeWhyRows(note, null)) out.push(`  ${label(r.k)}${r.v}`);
    const proposals = (note?.proposals ?? []).map((p) => ({
      ...p,
      writeSet: p.writeSet ?? [],
      readSet: p.readSet ?? [],
      decisions: p.decisions ?? [],
      intent: p.intent ?? { id: "?", title: "(intent not recorded)", why: "" },
    }));
    if (note?.certification && (note.certification.status === "green" || note.certification.status === "red")) out.push(`  ${label("tests")}${noteCertLine(note.certification, c)}`);
    // The landing that wrote the line in another file (moved since) shows the changes that wrote that file.
    const path = entryPath(entry, target.path);
    const touching = proposals.filter((p) => p.writeSet.some((w) => w.path === path));
    const shown = touching.length ? touching : proposals;
    if (proposals.length > shown.length) out.push(`  ${c.dim(`${proposals.length - shown.length} other proposal(s) in this landing touched other files`)}`);
    for (const p of shown) {
      out.push(`  ${label("proposal")}${p.id} ${c.dim("by")} ${p.agentId} ${c.dim(`(${p.agentKind}${p.model ? ` · ${p.model}` : ""})`)}`);
      const source = provenanceLine((p as { provenance?: unknown }).provenance, p.model, c);
      if (source) out.push(`  ${label("source")}${source}`);
      out.push(`  ${label("intent")}${p.intent.id} ${quote(p.intent.title ?? "")}`);
      if (p.intent.why) out.push(`  ${label("why")}${whySummary(p.intent.why)}`);
      // Recipes (recipe.ts): the recipes that rewrote its files as it landed.
      for (const r of recipeWhyRows(null, p)) out.push(`  ${label(r.k)}${r.v}`);
      // Walk the parent chain (the why behind the why), guarding against cycles.
      const seen = new Set<string>([p.intent.id]);
      let parentId = p.intent.parentId;
      let ruleId = p.intent.ruleId;
      while (parentId && !seen.has(parentId)) {
        seen.add(parentId);
        const parent = intents.get(parentId);
        out.push(`  ${label("parent")}${parentId}${parent ? ` ${quote(parent.title)}` : ""}`);
        ruleId ??= parent?.ruleId;
        parentId = parent?.parentId;
      }
      if (ruleId) {
        const r = rules.get(ruleId);
        out.push(`  ${label("rule")}${ruleId}${r ? ` ${quote(r.description)} ${c.dim("approved by")} ${r.approvedBy}` : ""}`);
      }
      for (const line of directionLines(p.evidence?.direction, c, now)) out.push(`  ${label(line.k)}${line.v}`);
      const steps = decisionSteps(p.decisions, p.evidence?.checks, c);
      if (steps.length) {
        out.push(`  ${label("decided")}${steps.map((s) => s.head).join(c.dim(" · "))}`);
        for (const s of steps) if (s.detail) out.push(`  ${label("")}${c.dim(s.detail)}`);
      }
      // Quoted acceptance (FT_QUOTED_ACCEPTANCE): the changed line quoted for each acceptance line (acceptance.ts).
      for (const row of acceptanceRows(p.decisions, c)) out.push(`  ${label(row.k)}${row.v}`);
      out.push(`  ${label("checks")}${checkLine(p.evidence, c)}`);
      // Contest mode (contest.ts): how the change won its contest, and the attempts it was chosen over.
      for (const line of contestLines(p.evidence?.checks, p.alternatives, c)) out.push(`  ${label(line.k)}${line.v}`);
      // Tests before landing (FT_PRELAND, preland.ts): what ran on its base with the change before it landed.
      const tested = prelandLine(p.evidence?.preland, c);
      if (tested) out.push(`  ${label("tested")}${tested}`);
      if (p.evidence?.residual?.length) out.push(`  ${label("residual")}${c.yellow(paths(p.evidence.residual, 4))} ${c.dim("(outside the declared footprint)")}`);
      const unproven = unprovenLine(p.evidence, c);
      if (unproven) out.push(`  ${label("unproven")}${unproven}`);
      out.push(`  ${label("wrote")}${paths(p.writeSet.map((w) => w.path), 4)}`);
      if (p.readSet.length) out.push(`  ${label("read")}${paths(p.readSet.map((r) => r.path), 4)}`);
      // Last, its lifecycle strip, declared to merged by a person, from its note (strip.ts, core/lifecycle.ts).
      for (const row of whyLifecycleRows(landing, p, note?.certification, { ...ctx, intents }, c)) out.push(`  ${label(row.k)}${row.v}`);
    }
  }
  return out.join("\n");
}

/**
 * The direction a landed change was built under (its evidence): the intent revision, the amendments
 * up to it, the human directives the agent had, and what the agent said it was doing.
 */
export function directionLines(d: Direction | undefined, c: Colors, now: number): Array<{ k: string; v: string }> {
  if (!d || typeof d.intentRevision !== "number") return [];
  const out: Array<{ k: string; v: string }> = [];
  const revisions = Array.isArray(d.revisions) ? d.revisions : [];
  out.push({ k: "revision", v: `built on r${d.intentRevision}${revisions.length > 0 ? c.dim(` (amended ${revisions.length} time${revisions.length === 1 ? "" : "s"})`) : ""}` });
  for (const r of revisions) {
    const changed = Array.isArray(r.changed) && r.changed.length > 0 ? r.changed.join(", ") : "nothing";
    out.push({ k: "", v: `r${r.revision}: ${changed} changed by ${r.by}${typeof r.at === "number" ? c.dim(` ${ago(r.at, now)}`) : ""}: ${quote(r.reason ?? "", 80)}` });
  }
  for (const g of Array.isArray(d.directives) ? d.directives : []) {
    out.push({ k: "directive", v: `${quote(g.message ?? "", 80)} ${c.dim(`from ${g.by}${typeof g.at === "number" ? ` ${ago(g.at, now)}` : ""}`)}` });
  }
  if (d.note) out.push({ k: "doing", v: c.dim(quote(d.note, 90)) });
  return out;
}

/**
 * The decide arc of a change, in order: the deterministic proof when it decided alone (from the
 * evidence's gate check), then each recorded decision (layer, kind, p, action, who answered), with
 * its one-line answer when the note has one.
 */
export function decisionSteps(decisions: NoteDecision[] | undefined, checks: CheckResult[] | undefined, c: Colors): Array<{ head: string; detail?: string }> {
  const out: Array<{ head: string; detail?: string }> = [];
  const gate = (checks ?? []).find((k) => k.name === "gate");
  const m = gate?.detail ? /→ (\S+) by (\S+)/.exec(gate.detail) : null;
  if (m && m[2] === "deterministic") {
    const proof = (checks ?? []).find((k) => k.name.startsWith("deterministic"));
    out.push({ head: `deterministic proof → ${m[1]}`, ...(proof?.detail ? { detail: `deterministic: ${cut(proof.detail.replace(/\s+/g, " "), 160)}` } : {}) });
  }
  for (const d of decisions ?? []) {
    const p = typeof d.p === "number" && Number.isFinite(d.p) ? ` ${c.dim(`p=${d.p.toFixed(2)}`)}` : "";
    const head = `${d.layer} ${d.kind}${p} → ${d.action}${d.by ? c.dim(` (${d.by})`) : ""}`;
    out.push(d.answer ? { head, detail: `${d.layer}: ${cut(d.answer, 160)}` } : { head });
  }
  return out;
}

const provText = (v: unknown): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");
const provCount = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

/**
 * How a landed change's author and model are known, from its note's provenance, in one line: "in-platform agent, run by
 * FireTrident · model observed by FireTrident: 3 calls, 4,120 in / 812 out tokens", or "external agent (MCP token and
 * its resume key) · model declared by the agent". Null for a note written before provenance was kept; a value it does
 * not know is shown as it is. `model` is the model the proposal line already names.
 */
export function provenanceLine(provenance: unknown, model: string | undefined, c: Colors): string | null {
  if (!provenance || typeof provenance !== "object" || Array.isArray(provenance)) return null;
  const p = provenance as { author?: unknown; auth?: unknown; model?: { evidence?: unknown; name?: unknown; observed?: unknown } | null };
  const auth = provText(p.auth);
  const via = auth === "mcp" ? "MCP token and its resume key" : auth === "token" ? "a deployment token, not bound to it" : auth === "" ? "MCP or API token" : auth;
  const author = provText(p.author);
  const who =
    author === "platform" ? "in-platform agent, run by FireTrident" : author === "external" ? `external agent ${c.dim(`(${via})`)}` : author === "synthetic" ? "bench agent" : `author ${author || "unknown"}`;
  const m = p.model && typeof p.model === "object" ? p.model : null;
  const evidence = provText(m?.evidence);
  const name = provText(m?.name);
  const named = name && name !== model ? ` ${name}` : "";
  let how: string;
  if (!m || evidence === "") how = c.dim("model not known");
  else if (evidence === "observed") {
    const calls = (Array.isArray(m.observed) ? m.observed : []).filter((o): o is Record<string, unknown> => !!o && typeof o === "object");
    const usage = calls.map((o) => {
      const id = provText(o.model);
      const [n, input, output, cached] = [o.calls, o.inputTokens, o.outputTokens, o.cachedTokens].map(provCount);
      const parts = [
        n === null || n === undefined ? "" : `${num(n)} call${n === 1 ? "" : "s"}`,
        input == null || output == null ? "" : `${num(input)} in / ${num(output)} out tokens${cached ? ` (${num(cached)} cached)` : ""}`,
      ].filter(Boolean);
      return `${id && id !== model ? `${id} ` : ""}${parts.join(", ")}`.trim();
    }).filter(Boolean);
    how = `${c.green("model observed by FireTrident")}${usage.length > 0 ? `: ${usage.join("; ")}` : named ? `:${named}` : ""}${usage.length === 0 ? c.dim(" (no model call recorded for this change)") : ""}`;
  } else if (evidence === "declared") how = `${c.yellow("model declared by the agent")}${named ? `:${named}` : ""}`;
  else how = `model ${evidence}${named ? `:${named}` : ""}`;
  return `${who} ${c.dim("·")} ${how}`;
}

/** What `ft verify` lists per status: its mark, its words, and its color. */
const VERIFY_ROWS: ReadonlyArray<{ status: NoteCheckStatus; mark: string; words: string; color: keyof Colors }> = [
  { status: "intact", mark: "✓", words: "intact", color: "green" },
  { status: "altered", mark: "✗", words: "altered", color: "red" },
  { status: "missing", mark: "✗", words: "missing", color: "red" },
  { status: "unreadable", mark: "?", words: "could not be read", color: "yellow" },
  { status: "pending", mark: "…", words: "not pushed yet", color: "dim" },
  { status: "no-trailer", mark: "-", words: "landed before commits carried the note's digest", color: "dim" },
];
/** Notes listed one by one per status at most. */
const VERIFY_LISTED = 10;

/** Whether a verification found a note that was altered or is missing (`ft verify` then exits 1). */
export function verifyFailed(res: unknown): boolean {
  const notes = (res as Partial<NotesVerification> | null)?.notes;
  return Array.isArray(notes) && notes.some((n) => n?.status === "altered" || n?.status === "missing");
}

/**
 * What `ft verify` prints: the newest landings' lineage notes on the trunk repository against the FT-Note trailer each
 * commit carries, counted by status, then each note that is not intact with the reason, and whether FireTrident's own
 * copy still matches (so the note can be put back from it).
 */
export function formatVerify(colony: string, res: unknown, c: Colors, now: number): string {
  const r = (res ?? {}) as Partial<NotesVerification>;
  const notes = (Array.isArray(r.notes) ? r.notes : []).filter((n): n is NoteCheck => !!n && typeof n === "object" && typeof n.status === "string");
  const where = typeof r.notesTip === "string" ? `notes commit ${shortSha(r.notesTip)}` : "the trunk repository has no notes";
  const out = [`${c.bold(colony)} lineage notes on the trunk repository against each commit's FT-Note trailer ${c.dim(`(newest ${num(notes.length)} landing${notes.length === 1 ? "" : "s"}; ${where})`)}`];
  if (notes.length === 0) return [...out, c.dim("  no landings yet")].join("\n");
  const known = new Set<string>(VERIFY_ROWS.map((v) => v.status));
  const rows = [...VERIFY_ROWS, ...[...new Set(notes.map((n) => n.status).filter((s) => !known.has(s)))].map((s) => ({ status: s, mark: "?", words: s, color: "yellow" as const }))];
  const of = (s: string): NoteCheck[] => notes.filter((n) => n.status === s);
  out.push(`  ${rows.filter((v) => of(v.status).length > 0).map((v) => c[v.color](`${v.mark} ${num(of(v.status).length)} ${v.words}`)).join(c.dim(" · "))}`);
  for (const v of rows) {
    if (v.status === "intact" || v.status === "no-trailer") continue;
    const list = of(v.status);
    for (const n of list.slice(0, VERIFY_LISTED)) {
      const when = typeof n.at === "number" && n.at > 0 ? c.dim(` ${ago(n.at, now)}`) : "";
      const own = v.status === "altered" || v.status === "missing" ? c.dim(n.ownCopy ? "; FireTrident's own copy still matches the trailer" : "; FireTrident's own copy does not match the trailer") : "";
      out.push(`  ${c[v.color](v.mark)} ${n.landingId} ${shortSha(n.trunkSha)}${when}  ${n.detail ?? v.words}${own}`);
    }
    if (list.length > VERIFY_LISTED) out.push(c.dim(`    +${num(list.length - VERIFY_LISTED)} more`));
  }
  if (verifyFailed(r)) out.push(c.dim("  A commit's trailer cannot change without changing the commit: the note on the repository is what changed."));
  // Signed lineage notes (signatures.ts): where the server signs, whether each commit is signed by its published key.
  out.push(...signatureLines(notes, c, now));
  return out.join("\n");
}

/**
 * What withdraw, amend and retract say about the changes in flight, from the trunk writer's direction fence:
 * `returned` were stopped, `landed` had already landed, and when `confirmed` is false the writer did not answer
 * for `unconfirmed`, which may still land. A server without the fence sends only `returned` (changes sent back).
 */
export interface Redirected {
  returned?: number;
  landed?: Array<{ proposalId: string; landingId: string; trunkSha: string }>;
  confirmed?: boolean;
  unconfirmed?: string[];
}

/** What PATCH /intents/:iid answered. */
export interface AmendResult extends Redirected {
  intent?: Partial<Intent>;
  revision?: { revision: number; changed: string[]; reason: string; substantive: boolean } | null;
  notified?: Array<{ agentId: string; delivery: string }>;
}

function deliveries(list: Array<{ agentId: string; delivery: string }> | undefined): string {
  const l = list ?? [];
  if (l.length === 0) return "";
  if (l.length === 1) return `${l[0]!.agentId} ${l[0]!.delivery === "pushed" ? "was told at once" : l[0]!.delivery === "inbox" ? "will read it in its inbox" : "could not be reached (the notice waits in the colony)"}`;
  const by = countBy(l, (n) => n.delivery);
  return `${num(l.length)} agents told (${[...by].map(([k, n]) => `${num(n)} ${k}`).join(", ")})`;
}

/** "2 changes in flight stopped" (the trunk writer confirmed it), or "sent back" from a server that cannot say. */
function stoppedPart(res: Redirected, which: string): string | null {
  const n = res.returned ?? 0;
  if (n === 0) return null;
  return `${num(n)} change${n === 1 ? "" : "s"} ${which} ${res.confirmed === undefined ? "sent back" : "stopped"}`;
}

/** Whether the outcome needs a second look: a change landed anyway, or the trunk writer did not answer. */
function raced(res: Redirected): boolean {
  return (res.landed?.length ?? 0) > 0 || res.confirmed === false;
}

/** One line per change that landed before the change of direction reached the trunk writer, and one when it did not answer. */
function racedLines(colony: string | undefined, res: Redirected, c: Colors): string[] {
  const out = (res.landed ?? []).map(
    (l) => `  ${c.yellow("!")} ${l.proposalId} already landed in ${shortSha(l.trunkSha)} as ${l.landingId}; undo with ${c.bold(`ft revert ${colony ?? "<colony>"} ${l.landingId}`)}`,
  );
  if (res.confirmed === false) {
    const n = res.unconfirmed?.length ?? 0;
    out.push(`  ${c.yellow("!")} unconfirmed: the trunk writer did not answer${n > 0 ? `; ${num(n)} change${n === 1 ? "" : "s"} sent back may still land` : ""}`);
  }
  return out;
}

/** The outcome of `ft intent amend`. */
export function formatAmend(intentId: string, res: AmendResult, c: Colors): string {
  const title = res.intent?.title ? ` ${quote(res.intent.title, 60)}` : "";
  if (!res.revision) return `${c.green("✓")} Nothing changed: ${c.bold(intentId)}${title} already says that ${c.dim(`(r${res.intent?.revision ?? 1})`)}`;
  const r = res.revision;
  const out = [`${raced(res) ? c.yellow("!") : c.green("✓")} Amended ${c.bold(intentId)}${title} to ${c.bold(`r${r.revision}`)}: ${r.changed.join(", ")} changed`];
  out.push(c.dim(`  reason: ${r.reason}`));
  const parts: string[] = [];
  if (!r.substantive) parts.push("priority only: work in progress still fits");
  const stopped = stoppedPart(res, `built on r${r.revision - 1}`);
  if (stopped) parts.push(stopped);
  const told = deliveries(res.notified);
  if (told) parts.push(told);
  if (parts.length) out.push(`  ${parts.join("; ")}`);
  out.push(...racedLines(res.intent?.colonyId, res, c));
  if (r.substantive) out.push(c.dim("  The agent holding it keeps it and redoes the work against the new revision."));
  if ((res.landed?.length ?? 0) > 0) out.push(c.dim(`  The change that landed was built on an older revision: the intent stays live and r${r.revision} is still to do.`));
  return out.join("\n");
}

/** What POST /intents/:iid/withdraw answered. */
export interface WithdrawResult extends Redirected {
  intent?: Partial<Intent>;
  notified?: Array<{ agentId: string; delivery: string }>;
  already?: boolean;
}

/** The outcome of `ft intent withdraw`. */
export function formatWithdraw(intentId: string, reason: string, res: WithdrawResult, c: Colors): string {
  const title = res.intent?.title ? ` ${quote(res.intent.title, 60)}` : "";
  if (res.already) return `${c.green("✓")} ${c.bold(intentId)}${title} was already withdrawn${res.intent?.withdrawnReason ? `: ${res.intent.withdrawnReason}` : ""}`;
  const out = [`${raced(res) ? c.yellow("!") : c.green("✓")} Withdrew ${c.bold(intentId)}${title}: ${reason}`];
  const parts = ["its needs evaporated"];
  const stopped = stoppedPart(res, "in flight");
  if (stopped) parts.push(stopped);
  const told = deliveries(res.notified);
  if (told) parts.push(told);
  out.push(`  ${parts.join("; ")}`);
  out.push(...racedLines(res.intent?.colonyId, res, c));
  if ((res.landed?.length ?? 0) > 0 && res.intent?.status === "landed") out.push(c.dim("  The intent shows landed: its change reached trunk before the withdrawal did."));
  return out.join("\n");
}

/** What DELETE /rules/:rid answered. */
export interface RetractResult extends Redirected {
  rule?: Partial<Rule>;
  withdrawn?: number;
  notified?: Array<{ agentId: string; delivery: string }>;
  already?: boolean;
}

/** The outcome of `ft rule retract`. */
export function formatRetract(ruleId: string, reason: string, res: RetractResult, c: Colors): string {
  const desc = res.rule?.description ? ` ${quote(res.rule.description, 60)}` : "";
  if (res.already) return `${c.green("✓")} ${c.bold(ruleId)}${desc} was already retracted${res.rule?.retractReason ? `: ${res.rule.retractReason}` : ""}`;
  const out = [`${raced(res) ? c.yellow("!") : c.green("✓")} Retracted ${c.bold(ruleId)}${desc}: ${reason}`];
  const parts = [`${num(res.withdrawn ?? 0)} unlanded intent${res.withdrawn === 1 ? "" : "s"} withdrawn`];
  const stopped = stoppedPart(res, "in flight");
  if (stopped) parts.push(stopped);
  const told = deliveries(res.notified);
  if (told) parts.push(told);
  out.push(`  ${parts.join("; ")}`);
  out.push(...racedLines(res.rule?.colonyId, res, c));
  out.push(c.dim("  The rule stays in history; landed work is untouched."));
  return out.join("\n");
}

/** What POST /landings/:ref/revert answered. */
export interface RevertResult {
  landing?: Partial<Landing>;
  reverted?: Partial<Landing>;
  redo?: string[];
  /** The one proposal undone, when the revert named one (the rest of its landing stayed). */
  proposal?: string;
}

/**
 * The outcome of `ft revert`: what was undone (a landing, or one proposal of it) and as which commit,
 * the files that went back, the other proposals of that landing that stayed, and the intents declared again.
 */
export function formatRevert(ref: string, reason: string, res: RevertResult, c: Colors): string {
  const short = (sha?: string) => (sha ? ` (${sha.slice(0, 7)})` : "");
  const of = res.reverted?.id ?? ref;
  const what = res.proposal ? `${c.bold(res.proposal)} of ${c.bold(of)}` : c.bold(of);
  const out = [`${c.yellow("Reverted")} ${what}${short(res.reverted?.trunkSha)} as ${c.bold(res.landing?.id ?? "?")}${short(res.landing?.trunkSha)}: ${reason}`];
  const files = res.landing?.paths ?? [];
  if (files.length > 0) out.push(`  undone  ${paths(files, 5)}`);
  if (res.proposal) {
    const kept = (res.reverted?.proposalIds ?? []).filter((id) => id !== res.proposal);
    out.push(`  stayed  ${kept.length > 0 ? `${paths(kept, 5)} ${c.dim(`(the rest of ${of}, untouched)`)}` : c.dim(`nothing else: it was the only proposal of ${of}`)}`);
  }
  const redo = res.redo ?? [];
  if (redo.length > 0) out.push(c.dim(`  ${redo.length} intent${redo.length === 1 ? "" : "s"} declared again: ${redo.join(", ")}`));
  return out.join("\n");
}

/** What POST /agents/:aid/directive answered. */
export interface DirectResult {
  id?: string;
  agentId?: string;
  intentId?: string;
  message?: string;
  delivery?: string;
}

/** The outcome of `ft direct`. */
export function formatDirect(agentId: string, res: DirectResult, c: Colors): string {
  const about = res.intentId ? c.dim(` about ${res.intentId}`) : "";
  const how =
    res.delivery === "pushed"
      ? "delivered: the agent acts on it at its next step"
      : res.delivery === "inbox"
        ? "waiting in its inbox (an external agent reads it there)"
        : c.yellow("not delivered: the agent did not answer (it is kept in the colony's record)");
  return [`${res.delivery === "failed" ? c.yellow("!") : c.green("✓")} Directive ${c.bold(res.id ?? "?")} to ${c.bold(agentId)}${about}: ${how}`, c.dim(`  ${quote(res.message ?? "", 100)}`), c.dim(`  Follow it: ft agents <colony> (NOW column) or ft watch <colony> --only status,directive`)].join("\n");
}

/** What GET /intents/:iid answered. */
export interface IntentShowResult {
  intent?: Partial<Intent>;
  revisions?: Array<{ revision: number; changed: string[]; before?: Record<string, unknown>; after?: Record<string, unknown>; reason: string; by: string; at: number; substantive?: boolean }>;
  directives?: Array<{ id: string; kind: string; agentId: string; message: string; by: string; at: number; deliveredAt?: number; via?: string }>;
  /** The reports agents made on it, newest first (servers before reports send none). */
  escalations?: IntentEscalation[];
  /** What its model calls cost, where the colony counts per intent (FT_INTENT_SPEND); servers before it, and intents nothing was counted for, send none. */
  spend?: IntentSpend;
  /** Why it closed or reopened while agents held it, newest first (the closure ledger; servers before it send none). */
  closures?: IntentClosure[];
  /** Its lifecycle strip (GET /intents/:iid/lifecycle, read beside it; servers before it have none). */
  lifecycle?: unknown;
}

const ANSWERED: Record<string, string> = { amend: "amended", withdraw: "withdrawn", dismiss: "dismissed" };

/** One report as a line: kind, reporter, age, the report, and the answer or that it waits. */
function reportLine(e: IntentEscalation, c: Colors, now: number): string {
  const head = `${c.yellow(e.kind)} by ${e.by} ${c.dim(ago(e.at, now))}: ${quote(e.report, 100)}`;
  if (!e.resolved) return `${head} ${c.magenta("(waiting for a person)")}`;
  return `${head} ${c.dim(`(${ANSWERED[e.resolved.decision] ?? e.resolved.decision} by ${e.resolved.by} ${ago(e.resolved.at, now)}${e.resolved.note ? `: ${cut(e.resolved.note.replace(/\s+/g, " "), 80)}` : ""})`)}`;
}

/** An intent with its revision history, the directives about it, and the reports agents made on it. */
export function formatIntentShow(res: IntentShowResult, c: Colors, now: number): string {
  const i = res.intent ?? {};
  const out = [`${c.bold(i.id ?? "?")} ${quote(i.title ?? "", 70)} ${c.dim(`r${i.revision ?? 1} · ${i.status ?? "?"}${i.assignedTo ? ` · held by ${i.assignedTo}` : ""}`)}`];
  if (i.footprint?.length) out.push(`  ${c.dim("footprint".padEnd(10))}${paths(i.footprint, 4)}`);
  if (i.withdrawnReason) out.push(`  ${c.dim("withdrawn".padEnd(10))}${i.withdrawnReason}`);
  if (i.why) out.push(`  ${c.dim("why".padEnd(10))}${cut(i.why.replace(/\s+/g, " "), 160)}`);
  // What its model calls cost, as the colony priced them (spend.ts); a server that does not count per intent sends none.
  const spent = intentSpendLine(res.spend);
  if (spent) out.push(`  ${c.dim("spend".padEnd(10))}${spent}${c.dim(` (${intentSpendDetail(res.spend).replace(/\.$/, "")})`)}`);
  const reports = res.escalations && res.escalations.length > 0 ? res.escalations : i.escalation ? [i.escalation] : [];
  for (const [n, e] of reports.slice(0, 5).entries()) out.push(`  ${c.dim((n === 0 ? "report" : "").padEnd(10))}${reportLine(e, c, now)}`);
  // The closure ledger (closure.ts): why it closed or reopened while agents held it, newest first.
  const closures = res.closures && res.closures.length > 0 ? res.closures : i.closure ? [i.closure] : [];
  for (const [n, cl] of closures.slice(0, 5).entries()) out.push(`  ${c.dim((n === 0 ? "closed" : "").padEnd(10))}${closureLine(cl, c, now)}`);
  if (closures.length > 5) out.push(`  ${"".padEnd(10)}${c.dim(`${closures.length - 5} earlier (--json lists them)`)}`);
  // Its lifecycle strip (strip.ts): a row per step with its evidence, where a change left the path, and its other changes.
  out.push(...lifecycleLines(res.lifecycle, c, now));
  for (const r of res.revisions ?? []) {
    out.push(`  ${c.dim(`r${r.revision}`.padEnd(10))}${r.changed.join(", ")} changed by ${r.by} ${c.dim(ago(r.at, now))}: ${quote(r.reason, 80)}${r.substantive === false ? c.dim(" (priority only)") : ""}`);
    for (const f of r.changed) {
      const was = r.before?.[f];
      const is = r.after?.[f];
      const show = (v: unknown) => (Array.isArray(v) ? v.join(", ") : typeof v === "string" ? quote(v, 60) : String(v));
      if (was !== undefined || is !== undefined) out.push(`  ${"".padEnd(10)}${c.dim(`${f}: ${show(was)} → `)}${show(is)}`);
    }
  }
  const ds = res.directives ?? [];
  if (ds.length) {
    out.push(`  ${c.dim("directives")}`);
    for (const d of ds) {
      const seen = d.deliveredAt ? c.dim(` (${d.via ?? "delivered"} ${ago(d.deliveredAt, now)})`) : c.dim(" (not delivered yet)");
      out.push(`    ${d.id} ${d.kind} → ${d.agentId} from ${d.by} ${c.dim(ago(d.at, now))}: ${quote(d.message, 80)}${seen}`);
    }
  }
  return out.join("\n");
}

/** The reports waiting for a person (`ft escalations`): each intent with its report, newest first, and how to answer. */
export function formatEscalations(colony: string, intents: Array<Partial<Intent>>, c: Colors, now: number): string {
  const open = intents.filter((i) => i.escalation && !i.escalation.resolved);
  if (open.length === 0) return `${c.green("✓")} No reports waiting for a person in ${c.bold(colony)}.`;
  const out = [`${c.bold(num(open.length))} report${open.length === 1 ? "" : "s"} waiting for a person in ${c.bold(colony)} ${c.dim("(no agent is offered these intents until you answer)")}`];
  for (const i of open) {
    const e = i.escalation as IntentEscalation;
    out.push("");
    out.push(`${c.bold(i.id ?? "?")} ${quote(i.title ?? "", 70)}${i.footprint?.length ? c.dim(` ${paths(i.footprint, 3)}`) : ""}`);
    out.push(`  ${c.yellow(e.kind)} by ${e.by} ${c.dim(ago(e.at, now))}`);
    for (const line of e.report.split("\n").slice(0, 8)) out.push(`  ${c.dim("│")} ${cut(line, 160)}`);
  }
  out.push("", c.dim(`  Answer one: ft escalation ${colony} <intentId> amend|withdraw|dismiss --note <text>`));
  return out.join("\n");
}

/** What POST /intents/:iid/escalation answered. */
export interface EscalationResult {
  intent?: Partial<Intent>;
}

/** The outcome of `ft escalation`. */
export function formatEscalationAnswer(intentId: string, decision: string, res: EscalationResult, c: Colors): string {
  const i = res.intent ?? {};
  const title = i.title ? ` ${quote(i.title, 60)}` : "";
  const note = i.escalation?.resolved?.note;
  const head =
    decision === "withdraw"
      ? `${c.green("✓")} Withdrew ${c.bold(intentId)}${title}`
      : decision === "amend"
        ? `${c.green("✓")} Amended ${c.bold(intentId)}${title}${i.revision ? ` to ${c.bold(`r${i.revision}`)}` : ""}; agents are offered it again`
        : `${c.green("✓")} Dismissed the report on ${c.bold(intentId)}${title}; agents are offered it again`;
  const out = [head];
  if (note) out.push(c.dim(`  answer: ${cut(note.replace(/\s+/g, " "), 160)}`));
  if (decision === "dismiss") out.push(c.dim("  The answer is guidance on the intent: the next agent to take it reads it."));
  return out.join("\n");
}

/** What `ft review` adds to the queue: every kept file's diff in full (`--diff`), and the colony its hints name. */
export interface ReviewOptions {
  diff?: boolean;
  colony?: string;
}

/** Danger lines listed under "look here first"; --diff marks every one. */
const LOOK_SPOTS = 8;
/** Lines of a file changed outside the footprint shown under "look here first"; --diff shows them all. */
const LOOK_LINES = 12;

/** One diff line for a terminal: marker, line number and text; added lines green, removed red, a danger line flagged. */
function diffText(l: DiffLine, c: Colors, hit = false): string {
  if (l.kind === "hunk" || l.kind === "note") return c.cyan(visible(l.text));
  const n = l.kind === "del" ? l.old : l.new;
  const body = `${l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}${String(n ?? "").padStart(5)}  ${visible(l.text)}`;
  const colored = l.kind === "add" ? c.green(body) : l.kind === "del" ? c.red(body) : c.dim(body);
  return hit ? `${colored}  ${c.red("← danger")}` : colored;
}

function plusMinus(added: number, removed: number, c: Colors): string {
  return `${c.green(`+${num(added)}`)} ${c.red(`−${num(removed)}`)}`;
}

/** Why a file shows no diff lines. */
function noLines(f: ReviewFile | null): string {
  if (!f) return "its diff was not kept";
  if (f.status === "binary") return "binary file: no text diff";
  if (f.status === "unreadable") return "the file could not be read for review";
  return f.truncated ? "too large to keep" : "no line changes kept";
}

/** "Look here first" for one change: its danger lines with the line itself, then each file changed outside the declared footprint. */
function lookLines(view: ReviewView, colony: string, diff: boolean, c: Colors): string[] {
  const look = lookHereFirst(view, 0);
  if (look.danger.length === 0 && look.residual.length === 0) return [];
  const out = [`  ${c.bold("look here first")}`];
  for (const s of look.danger.slice(0, LOOK_SPOTS)) {
    const what = s.what.map(visible).join(" · ");
    out.push(`    ${visible(s.line > 0 ? `${s.path}:${s.line}` : s.path)}  ${s.severe ? c.red(what) : c.yellow(what)}`);
    for (const l of s.lines) out.push(`      ${diffText(l, c)}`);
  }
  if (look.danger.length > LOOK_SPOTS) out.push(c.dim(`    … ${num(look.danger.length - LOOK_SPOTS)} more danger lines${diff ? ", marked below" : `: ft review ${colony} --diff`}`));
  for (const r of look.residual) {
    const f = r.file;
    out.push(`    ${visible(r.path)}  ${c.yellow("changed outside the declared footprint")}${f ? `  ${plusMinus(f.added, f.removed, c)}${f.truncated ? c.dim("  truncated") : ""}` : ""}`);
    const lines = f ? parseHunks(f.hunks) : [];
    if (lines.length === 0) out.push(c.dim(`      ${noLines(f)}`));
    for (const l of lines.slice(0, LOOK_LINES)) out.push(`      ${diffText(l, c)}`);
    if (lines.length > LOOK_LINES) out.push(c.dim(`      … ${num(lines.length - LOOK_LINES)} more lines${diff ? " below" : `: ft review ${colony} --diff`}`));
  }
  return out;
}

/** Every kept file's diff in full, with its danger lines flagged (`ft review --diff`). */
function fullDiff(view: ReviewView, c: Colors): string[] {
  const hits = dangerLines(view);
  const out: string[] = [];
  for (const f of view.files) {
    out.push(`    ${c.bold(visible(f.path))}  ${c.dim(visible(f.status) || "changed")}  ${plusMinus(f.added, f.removed, c)}${f.truncated ? c.yellow("  truncated") : ""}`);
    const lines = parseHunks(f.hunks);
    if (lines.length === 0) out.push(c.dim(`      ${noLines(f)}`));
    const h = hits.get(f.path);
    for (const l of lines) out.push(`      ${diffText(l, c, l.kind === "add" && l.new !== undefined && h?.has(l.new) === true)}`);
  }
  const left = view.filesChanged - view.files.length;
  if (left > 0) out.push(c.dim(`    ${num(left)} more changed file${left === 1 ? " was" : "s were"} not kept`));
  return out;
}

/**
 * The review queue: escalated proposals with their intent and size, code first. When the server kept
 * a proposal's change, "look here first" shows its danger lines and the files it changed outside its
 * declared footprint, before the reason and the checks; `opts.diff` adds every kept file's diff.
 */
export function formatReview(queue: Proposal[], intents: Intent[] | undefined, c: Colors, now: number, opts: ReviewOptions = {}): string {
  // The baseline stream (audit.ts): the audit sample's landed changes are listed after the escalations, marked AUDIT.
  const { escalations: proposals, audits } = splitAudits(queue);
  const audited = auditLines(audits, intents, c, opts.colony ?? "<colony>");
  if (proposals.length === 0) return [c.green("Review queue is empty: nothing needs a human."), ...audited].join("\n");
  const colony = opts.colony ?? "<colony>";
  const byId = new Map((intents ?? []).map((i) => [i.id, i]));
  const out = [`${c.bold(String(proposals.length))} proposal${proposals.length === 1 ? "" : "s"} waiting for a human`];
  let kept = 0;
  // Escalation batching (batch.ts): one block per batch, its changes listed; their own entries follow only with --diff.
  const batches = groupBatches(proposals);
  for (const g of batches) out.push("", ...batchLines(g, byId, c, colony, (at) => ago(at, now)));
  const folded = opts.diff ? new Set<string>() : batchMembers(batches);
  for (const p of [...proposals].sort((a, b) => a.createdAt - b.createdAt)) {
    if (folded.has(p.id)) continue;
    const intent = byId.get(p.intentId);
    const view = reviewOf(p);
    out.push("");
    out.push(`${c.magenta(p.id)}  ${intent ? quote(intent.title, 60) : p.intentId}  ${c.dim(`${p.agentId} · ${p.writeSet.length} file(s) · ${ago(p.createdAt, now)}`)}`);
    if (p.declared?.summary) out.push(`  ${c.dim("summary ")} ${p.declared.summary.replace(/\s+/g, " ").trim()}`);
    // Tests before approval: the colony's tests on the change at its base lead what a person reads.
    out.push(...reviewTestsLines(p, c, colony));
    // Merge locks: the merge a person is asked to approve, before the change itself.
    out.push(...heldLines(p, c, (l) => diffText(l, c)));
    if (view) out.push(...lookLines(view, colony, opts.diff === true, c));
    else if (p.evidence?.residual?.length) out.push(`  ${c.dim("residual")} ${c.yellow(paths(p.evidence.residual, 4))}`);
    if (p.reason) out.push(`  ${c.dim("reason  ")} ${p.reason}`);
    out.push(`  ${c.dim("checks  ")} ${checkLine(p.evidence, c)}`);
    if (view) {
      kept++;
      const size = changeSize(view);
      out.push(`  ${c.dim("diff    ")} ${num(view.filesChanged)} file${view.filesChanged === 1 ? "" : "s"}, ${plusMinus(size.added, size.removed, c)}`);
      if (opts.diff) out.push(...fullDiff(view, c));
    } else {
      out.push(`  ${c.dim("diff     not kept for this proposal")}`);
    }
  }
  out.push(...audited);
  out.push("");
  if (kept > 0 && !opts.diff) out.push(c.dim(`Full diffs: ft review ${colony} --diff`));
  out.push(c.dim("Decide with: ft review <colony> <proposalId> approve|reject|return --reason <text>"));
  return out.join("\n");
}

const MARK_COLOR: Record<MarkKind, keyof Colors> = { claim: "cyan", need: "yellow", trail: "green", failure: "red", danger: "red" };
const PROPOSAL_COLOR: Partial<Record<ProposalStatus, keyof Colors>> = { landed: "green", returned: "yellow", rejected: "red", escalated: "magenta", ready: "cyan" };
const AGENT_COLOR: Partial<Record<AgentState, keyof Colors>> = { working: "cyan", proposing: "magenta", waiting: "yellow", dead: "red" };

function clockTime(at: number): string {
  return new Date(at).toTimeString().slice(0, 8);
}

/** One line for one live event. `clock` formats the timestamp (local HH:MM:SS by default). */
export function formatEvent(e: ColonyEvent, c: Colors, clock: (at: number) => string = clockTime): string {
  const time = c.dim(clock(typeof e.at === "number" ? e.at : Date.now()));
  const tag = (s: string, color: keyof Colors) => c[color](s.padEnd(10));
  switch (e.t) {
    case "agent": {
      const state = c[AGENT_COLOR[e.state] ?? "dim"](e.state);
      return `${time} ${tag("agent", "blue")} ${e.agentId} ${state}${e.intentId ? ` ${c.dim(e.intentId)}` : ""}${e.paths?.length ? ` ${paths(e.paths)}` : ""}`;
    }
    case "mark":
      return `${time} ${tag("mark", MARK_COLOR[e.kind] ?? "dim")} ${e.kind} ${e.value.toFixed(2)} ${e.path} ${c.dim(`(${e.region})`)}`;
    case "intent":
      return `${time} ${tag("intent", "yellow")} ${e.intentId} ${e.status} ${quote(e.title, 60)}${e.footprint?.length ? c.dim(` ${paths(e.footprint)}`) : ""}`;
    case "proposal": {
      const status = c[PROPOSAL_COLOR[e.status] ?? "dim"](e.status);
      return `${time} ${tag("proposal", "magenta")} ${e.proposalId} ${status} ${c.dim(`${e.intentId} by ${e.agentId}`)}${e.reason ? ` ${c.yellow(e.reason)}` : ""}`;
    }
    case "landing":
      return `${time} ${tag("landing", "green")} ${c.bold(shortSha(e.trunkSha))} ${e.proposalIds.length} proposal${e.proposalIds.length === 1 ? "" : "s"}, ${e.paths.length} path${e.paths.length === 1 ? "" : "s"} ${c.dim(paths(e.paths))}`;
    case "decision":
      return `${time} ${tag("decision", "cyan")} ${e.layer} ${e.kind} ${c.dim(`p=${e.p.toFixed(2)}`)} → ${e.action} ${c.dim(e.subject)}`;
    case "sigma": {
      const color: keyof Colors = e.sigma > 1 ? "red" : e.sigma > 0.9 ? "yellow" : "green";
      return `${time} ${tag("sigma", "dim")} ${e.region} ${c[color](e.sigma.toFixed(2))}`;
    }
    case "violations": {
      const rules = Object.entries(e.byRule ?? {}).map(([id, n]) => `${id} ${num(n)}`).join(", ");
      return `${time} ${tag("violations", "bold")} ${e.total === 0 ? c.green("0 left") : c.yellow(`${num(e.total)} left`)}${rules ? c.dim(` (${rules})`) : ""}`;
    }
    case "metric":
      return `${time} ${tag("metric", "dim")} ${e.name} ${num(e.value)}`;
    case "amended":
      return `${time} ${tag("amended", "magenta")} ${e.intentId} ${c.bold(`r${e.revision}`)} ${(e.changed ?? []).join(", ")} changed ${quote(e.title, 50)} ${c.dim(`by ${e.by}: ${e.reason}`)}${e.returned ? c.yellow(` (${e.returned} returned)`) : ""}`;
    case "withdrawn":
      return `${time} ${tag("withdrawn", "red")} ${e.intentId} ${quote(e.title, 50)} ${c.dim(`by ${e.by}: ${e.reason}`)}${e.returned ? c.yellow(` (${e.returned} returned)`) : ""}`;
    case "retracted":
      return `${time} ${tag("retracted", "red")} ${e.ruleId} ${c.dim(`by ${e.by}: ${e.reason}`)} ${e.withdrawn} intent${e.withdrawn === 1 ? "" : "s"} withdrawn`;
    case "reverted":
      return `${time} ${tag("reverted", "red")} ${e.proposal ? `${e.proposal} of ` : ""}${e.of} ${c.dim(`by ${e.by}: ${e.reason}`)} as ${e.landingId}${e.redo.length ? ` ${e.redo.length} intent${e.redo.length === 1 ? "" : "s"} declared again` : ""}`;
    case "directive":
      return `${time} ${tag("directive", "cyan")} ${e.agentId} ← ${e.by}${e.kind === "landing" ? c.dim(" (landing notice)") : ""}: ${quote(e.message, 80)}${e.intentId ? c.dim(` (${e.intentId})`) : ""}${e.via ? c.dim(` ${e.via}`) : ""}`;
    case "escalation":
      if (e.resolved) {
        return `${time} ${tag("escalation", "magenta")} ${e.intentId} ${ANSWERED[e.resolved.decision] ?? e.resolved.decision} by ${e.resolved.by}: ${quote(e.resolved.note, 80)} ${c.dim(`(${e.kind} report by ${e.agentId})`)}`;
      }
      return `${time} ${tag("escalation", "magenta")} ${e.intentId} ${c.yellow(e.kind)} by ${e.agentId} ${quote(e.title, 50)}: ${quote(e.report, 80)}`;
    case "stuck": {
      const item: Partial<StuckItem> = e.item ?? {};
      const what = (item.action && STUCK_DO[item.action]) || "look at it";
      return `${time} ${tag("stuck", item.kind === "red" ? "red" : "yellow")} ${item.kind ?? "?"} ${plainLine(item.text)} ${c.dim(`→ ${what}`)}`;
    }
    case "status":
      return `${time} ${tag("status", "blue")} ${e.agentId} ${e.note}`;
    // The pause switch (pause.ts): who paused or resumed the colony's agents (or the deployment's), and why.
    case "paused":
      return `${time} ${tag("paused", "red")} ${e.scope} ${c.dim(`by ${plainLine(e.by)}: ${plainLine(e.reason)}`)}`;
    case "resumed":
      return `${time} ${tag("resumed", "green")} ${e.scope} ${c.dim(`by ${plainLine(e.by)}${e.reason ? `: ${plainLine(e.reason)}` : ""}`)}`;
    case "certify": {
      const sha = c.bold(shortSha(e.trunkSha));
      if (e.status === "running") return `${time} ${tag("certify", "yellow")} ${sha} testing…`;
      if (e.status === "green") return `${time} ${tag("certify", "green")} ${sha} ${c.green(`✓ green, ${testsPhrase(e)}`)}${e.reusedFrom ? c.dim(` (as ${shortSha(e.reusedFrom)})`) : ""}`;
      if (e.status === "red") {
        const names = failingNames(e);
        return `${time} ${tag("certify", "red")} ${sha} ${c.red(`✗ red, ${testsPhrase(e)}`)}${names ? ` ${names}` : ""}${e.greenSha ? c.dim(` · green ${shortSha(e.greenSha)}`) : ""}`;
      }
      return `${time} ${tag("certify", "dim")} ${sha} ${c.dim(`${e.status}${e.detail ? `: ${e.detail}` : ""}`)}`;
    }
    case "bisect": {
      // The first red search ended for the red result of this commit.
      const line = firstRedLines("", e.firstRed, c)[0]?.trim() ?? "";
      return `${time} ${tag("bisect", e.firstRed?.status === "found" ? "red" : "dim")} ${c.bold(shortSha(e.trunkSha))} ${line}`;
    }
    default: {
      const unknown = e as { t?: unknown };
      return `${time} ${tag(String(unknown.t ?? "event"), "dim")} ${c.dim(JSON.stringify(e).slice(0, 160))}`;
    }
  }
}

/** Split one WebSocket message into events: a single event, an array, or `{ events: [...] }`. */
export function eventsFromMessage(text: string): ColonyEvent[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  const list = Array.isArray(data) ? data : data && typeof data === "object" && Array.isArray((data as { events?: unknown }).events) ? (data as { events: unknown[] }).events : [data];
  return list.filter((x): x is ColonyEvent => !!x && typeof x === "object" && typeof (x as { t?: unknown }).t === "string");
}
