import type {
  AgentState,
  CheckResult,
  ColonyEvent,
  ColonySnapshot,
  Intent,
  IntentStatus,
  Landing,
  LineageNote,
  MarkKind,
  Proposal,
  ProposalStatus,
  Rule,
} from "@fire_trident/core";
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

const INTENT_ORDER: readonly IntentStatus[] = ["open", "claimed", "proposed", "landed", "abandoned"];
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
  row("trunk", `${shortSha(col.trunkSha)}  ${col.greenSha ? `green ${shortSha(col.greenSha)}` : c.dim("green not certified yet")}`);
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
  const body = rows.map((a, i) => {
    const state = c[AGENT_COLOR[a.state as AgentState] ?? "dim"](a.state ?? "?");
    const intent = a.intentTitle ? quote(a.intentTitle, 40) : (a.intentId ?? "-");
    const cells = [a.id, a.kind ?? "-", state, agentStep(a), intent, a.model ?? "-"];
    if (withLanded) cells.push(a.counters ? num(a.counters.landed ?? 0) : "-");
    cells.push(typeof a.lastSeen === "number" ? ago(a.lastSeen, now) : "-");
    if (withNotes) cells.push(notes[i] ? c.dim(cut(notes[i] ?? "", 60)) : "");
    return cells;
  });
  const header = ["AGENT", "KIND", "STATE", "STEP", "INTENT", "MODEL", ...(withLanded ? ["LANDED"] : []), "SEEN", ...(withNotes ? ["NOTE"] : [])];
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

/** Readable lineage for a file or line: landings, proposals, intent chain, rule, decisions, checks. */
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
  const sorted = entries.filter((e) => e && e.landing).sort((a, b) => at(b.landing) - at(a.landing));
  if (sorted.length === 0) return `${c.bold(where)}  ${c.dim("no FireTrident landing touched this yet (history before import has no lineage)")}`;
  const intents = new Map((ctx.intents ?? []).map((i) => [i.id, i]));
  const rules = new Map((ctx.rules ?? []).map((r) => [r.id, r]));
  const out: string[] = [`${c.bold(where)}  ${c.dim(`${sorted.length} landing${sorted.length === 1 ? "" : "s"}, newest first`)}`];
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
      if (p.decisions.length) {
        out.push(`  ${label("decided")}${p.decisions.map((d) => `${d.layer} ${d.kind}${typeof d.p === "number" ? ` ${c.dim(`p=${d.p.toFixed(2)}`)}` : ""} → ${d.action}`).join(c.dim(" · "))}`);
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

/** The review queue: escalated proposals with their intent, size, residual, and reason. */
export function formatReview(proposals: Proposal[], intents: Intent[] | undefined, c: Colors, now: number): string {
  if (proposals.length === 0) return c.green("Review queue is empty: nothing needs a human.");
  const byId = new Map((intents ?? []).map((i) => [i.id, i]));
  const out = [`${c.bold(String(proposals.length))} proposal${proposals.length === 1 ? "" : "s"} waiting for a human`];
  for (const p of [...proposals].sort((a, b) => a.createdAt - b.createdAt)) {
    const intent = byId.get(p.intentId);
    out.push("");
    out.push(`${c.magenta(p.id)}  ${intent ? quote(intent.title, 60) : p.intentId}  ${c.dim(`${p.agentId} · ${p.writeSet.length} file(s) · ${ago(p.createdAt, now)}`)}`);
    if (p.declared?.summary) out.push(`  ${c.dim("summary ")} ${p.declared.summary.replace(/\s+/g, " ").trim()}`);
    if (p.evidence?.residual?.length) out.push(`  ${c.dim("residual")} ${c.yellow(paths(p.evidence.residual, 4))}`);
    if (p.reason) out.push(`  ${c.dim("reason  ")} ${p.reason}`);
    out.push(`  ${c.dim("checks  ")} ${checkLine(p.evidence?.checks, c)}`);
  }
  out.push("");
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
