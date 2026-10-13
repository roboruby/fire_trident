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
  NoteDecision,
  Proposal,
  ProposalStatus,
  Rule,
} from "@fire_trident/core";
import { changeSize, dangerLines, lookHereFirst, parseHunks, reviewOf, visible, type DiffLine, type ReviewFile, type ReviewView } from "./review.ts";
import { whySummary } from "./spec.ts";

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
  for (const cert of results) {
    const when = typeof cert.startedAt === "number" ? c.dim(ago(cert.finishedAt ?? cert.startedAt, now).padStart(8)) : "";
    let what: string;
    if (cert.status === "green") what = c.green(`✓ ${testsPhrase(cert)}`);
    else if (cert.status === "red") what = `${c.red(`✗ ${testsPhrase(cert)}`)} ${failingNames(cert, 2)}`;
    else what = c.dim(`${cert.status}${cert.detail ? `: ${cert.detail}` : ""}`);
    const extra = [
      typeof cert.durationMs === "number" ? `${cert.durationMs} ms` : "",
      cert.reusedFrom ? `as ${shortSha(cert.reusedFrom)}` : cert.cached ? `${cert.cached} file${cert.cached === 1 ? "" : "s"} reused` : "",
      cert.repairIntentId ? `repair ${cert.repairIntentId}` : "",
    ].filter(Boolean);
    out.push(`  ${shortSha(cert.trunkSha)} ${when}  ${what}${extra.length ? c.dim(`  (${extra.join(", ")})`) : ""}`);
  }
  return out.join("\n");
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
  const series = s.series;
  if (series && Array.isArray(series.landings) && series.landings.length > 0) {
    const total = series.landings.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
    const vs = Array.isArray(series.violations) ? series.violations : [];
    const first = vs[0];
    const last = vs[vs.length - 1];
    const trend = first !== undefined && last !== undefined && first !== last ? `${c.dim(" · violations ")}${num(first)} → ${num(last)}` : "";
    row("last 30m", `${total > 0 ? `${sparkline(series.landings)} ${num(total)} landing${total === 1 ? "" : "s"}` : c.dim("no landings")}${trend}`);
  }
  return out.join("\n");
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

function checkLine(checks: CheckResult[] | undefined, c: Colors): string {
  if (!checks || checks.length === 0) return c.dim("none recorded");
  return checks.map((k) => `${k.ok ? c.green("✓") : c.red("✗")} ${k.name} ${c.dim(ms(k.ms))}`).join("  ");
}

function ms(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${Math.round(n)}ms`;
}

/** Context that turns ids into words in `ft why`: intents (for parent chains) and rules. */
export interface WhyContext {
  intents?: Intent[];
  rules?: Rule[];
}

/**
 * Readable lineage for a file or line: landings, proposals, intent chain, rule, decisions, checks.
 * Landings print newest first; for a line, in the server's order, which puts the landing that wrote
 * the line first when it is known.
 */
export function formatWhy(
  target: { path: string; line?: number },
  entries: Array<{ landing: Landing; note: LineageNote }>,
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
  const owner = target.line !== undefined && sorted.slice(1).some((e) => at(e.landing) > first);
  const order = owner ? `the landing that wrote line ${target.line} first, then newest first` : "newest first";
  const out: string[] = [`${c.bold(where)}  ${c.dim(`${sorted.length} landing${sorted.length === 1 ? "" : "s"}, ${order}`)}`];
  const label = (s: string) => c.dim(s.padEnd(9));

  for (const { landing, note } of sorted) {
    out.push("");
    const when = at(landing) ? `  ${new Date(at(landing)).toISOString().replace("T", " ").slice(0, 16)}Z ${c.dim(`(${ago(at(landing), now)})`)}` : "";
    out.push(`${c.green("●")} ${c.bold(`landing ${landing.id}`)}  ${shortSha(landing.trunkSha)} ${c.dim(`← ${shortSha(landing.parentSha)}`)}${when}`);
    const proposals = (note?.proposals ?? []).map((p) => ({
      ...p,
      writeSet: p.writeSet ?? [],
      readSet: p.readSet ?? [],
      decisions: p.decisions ?? [],
      intent: p.intent ?? { id: "?", title: "(intent not recorded)", why: "" },
    }));
    if (note?.certification && (note.certification.status === "green" || note.certification.status === "red")) out.push(`  ${label("tests")}${noteCertLine(note.certification, c)}`);
    const touching = proposals.filter((p) => p.writeSet.some((w) => w.path === target.path));
    const shown = touching.length ? touching : proposals;
    if (proposals.length > shown.length) out.push(`  ${c.dim(`${proposals.length - shown.length} other proposal(s) in this landing touched other files`)}`);
    for (const p of shown) {
      out.push(`  ${label("proposal")}${p.id} ${c.dim("by")} ${p.agentId} ${c.dim(`(${p.agentKind}${p.model ? ` · ${p.model}` : ""})`)}`);
      out.push(`  ${label("intent")}${p.intent.id} ${quote(p.intent.title ?? "")}`);
      if (p.intent.why) out.push(`  ${label("why")}${whySummary(p.intent.why)}`);
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
      out.push(`  ${label("checks")}${checkLine(p.evidence?.checks, c)}`);
      if (p.evidence?.residual?.length) out.push(`  ${label("residual")}${c.yellow(paths(p.evidence.residual, 4))} ${c.dim("(outside the declared footprint)")}`);
      if (p.evidence?.notVerified) out.push(`  ${label("unproven")}${p.evidence.notVerified}`);
      out.push(`  ${label("wrote")}${paths(p.writeSet.map((w) => w.path), 4)}`);
      if (p.readSet.length) out.push(`  ${label("read")}${paths(p.readSet.map((r) => r.path), 4)}`);
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
  const reports = res.escalations && res.escalations.length > 0 ? res.escalations : i.escalation ? [i.escalation] : [];
  for (const [n, e] of reports.slice(0, 5).entries()) out.push(`  ${c.dim((n === 0 ? "report" : "").padEnd(10))}${reportLine(e, c, now)}`);
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
export function formatReview(proposals: Proposal[], intents: Intent[] | undefined, c: Colors, now: number, opts: ReviewOptions = {}): string {
  if (proposals.length === 0) return c.green("Review queue is empty: nothing needs a human.");
  const colony = opts.colony ?? "<colony>";
  const byId = new Map((intents ?? []).map((i) => [i.id, i]));
  const out = [`${c.bold(String(proposals.length))} proposal${proposals.length === 1 ? "" : "s"} waiting for a human`];
  let kept = 0;
  for (const p of [...proposals].sort((a, b) => a.createdAt - b.createdAt)) {
    const intent = byId.get(p.intentId);
    const view = reviewOf(p);
    out.push("");
    out.push(`${c.magenta(p.id)}  ${intent ? quote(intent.title, 60) : p.intentId}  ${c.dim(`${p.agentId} · ${p.writeSet.length} file(s) · ${ago(p.createdAt, now)}`)}`);
    if (p.declared?.summary) out.push(`  ${c.dim("summary ")} ${p.declared.summary.replace(/\s+/g, " ").trim()}`);
    if (view) out.push(...lookLines(view, colony, opts.diff === true, c));
    else if (p.evidence?.residual?.length) out.push(`  ${c.dim("residual")} ${c.yellow(paths(p.evidence.residual, 4))}`);
    if (p.reason) out.push(`  ${c.dim("reason  ")} ${p.reason}`);
    out.push(`  ${c.dim("checks  ")} ${checkLine(p.evidence?.checks, c)}`);
    if (view) {
      kept++;
      const size = changeSize(view);
      out.push(`  ${c.dim("diff    ")} ${num(view.filesChanged)} file${view.filesChanged === 1 ? "" : "s"}, ${plusMinus(size.added, size.removed, c)}`);
      if (opts.diff) out.push(...fullDiff(view, c));
    } else {
      out.push(`  ${c.dim("diff     not kept for this proposal")}`);
    }
  }
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
    case "status":
      return `${time} ${tag("status", "blue")} ${e.agentId} ${e.note}`;
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
