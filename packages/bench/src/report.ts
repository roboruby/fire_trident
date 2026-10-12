#!/usr/bin/env node
/**
 * Build the results page (self-contained HTML + inline SVG, dark, video-ready) and one combined
 * JSON from a results directory, written next to its data:
 *
 *   node packages/bench/src/report.ts packages/bench/results/2026-10-12 packages/bench/results/2026-10-12-g1 packages/bench/results/2026-10-12-scale
 *
 * The first directory holds the serial-trunk-writer live runs and the simulator results. The
 * optional second holds the same live runs with trunk group commit, and the optional third the
 * scale runs (1,000 to 5,000 synthetic agents after the scale fixes). All live runs are MEASURED.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SimResult } from "./sim/common.ts";
import type { LiveReport } from "./live.ts";

type Sim = { kind: "sim"; mode: string; workload: Record<string, unknown>; calibration: Record<string, unknown>; testMs: number; results: SimResult[]; generatedAt: string };
type Cascade = {
  colony: string;
  region: string;
  shared: string;
  readers: number;
  startedAt: string;
  writerLanding: { id: string; tMs: number };
  returned: number;
  relandings: Array<{ tMs: number; landed: number }>;
  sigma: { max: number; firstAboveOneMs: number | null; lastAboveOneMs: number | null; events: Array<{ tMs: number; sigma: number }>; polled: Array<{ tMs: number; sigma: number }> };
  inhibition: Array<{ tMs: number; factor: number }>;
  laneDelay: Array<{ tMs: number; ms: number }>;
  timeline: Array<{ tMs: number; event: string }>;
};
type BatchCost = { rows: Array<{ k: number; proposed: number; commits: Array<{ size: number; atMs: number }> }> };
/** Stock-git audit of a colony's lineage notes after the scale runs (notes-check.json). */
type NotesCheck = {
  colony: string;
  at: string;
  result: { landing_commits: number; notes: number; landing_commits_without_note: number; sampled: number; sampled_note_landing_mismatch: number; notes_root?: { fanout_directories: number; flat_notes: number } };
};
/** The parts of the scale summary the page uses (summary.json). */
type ScaleSummary = {
  benchClientAt5000?: { peakEstablishedSockets?: { established?: number } };
  /** Runs on the same colony with earlier builds (their raw files were not kept). */
  earlierRuns?: Array<{ agents: number; startedAt: string; landedPerMin: number; completed: boolean; stoppedEarly?: string; why?: string; trunkCycle?: { cycleMs?: { p50?: number } } }>;
};

const C = {
  bg: "#0b0f14",
  panel: "#10161d",
  grid: "#1d2731",
  axis: "#2a3642",
  text: "#e8edf3",
  text2: "#a3afbc",
  muted: "#6f7c8a",
  fire: "#F38020",
  base: "#3987e5",
  danger: "#d03b3b",
  /** FireTrident with trunk group commit (measured live and simulated). */
  group: "#F7C548",
  /** Group commit after the scale fixes (measured live, 1,000 to 5,000 agents). */
  scale: "#4FC3A1",
};
/** What limits the colony next, when no scale runs are given (the scale runs replace it with their own numbers). */
const NEXT_LIMIT =
  "The next limit is TrunkDO, the single trunk writer: each 3.4–3.9 s commit cycle hits the 200-proposal cap, so throughput is flat past 1,000 agents, and about 6 s of queueing for the writer dominates time to land.";
const MONO = `ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace`;
const SANS = `system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function fmt(n: number | null | undefined, digits = 0): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "-";
  if (Math.abs(n) >= 10_000) return `${Math.round(n / 1000)}K`;
  if (Math.abs(n) >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}K`;
  return n.toFixed(digits);
}

/** Table number: one decimal below 100, grouped integers above. */
function num(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "-";
  return Math.abs(n) >= 100 ? Math.round(n).toLocaleString("en-US") : n.toFixed(digits);
}

function fmtInt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

// ---------------------------------------------------------------------------
// A small SVG line chart (one y axis, optional log x/y, hairline grid, 2 px lines)
// ---------------------------------------------------------------------------

interface Pt {
  x: number;
  y: number;
  tip: string;
  /** Optional value label drawn above the point. */
  note?: string;
}
interface Series {
  name: string;
  color: string;
  points: Pt[];
  dash?: string;
  marker: "filled" | "hollow" | "none";
  line: boolean;
  label?: string;
  opacity?: number;
  step?: boolean;
}
interface ChartOpts {
  w: number;
  h: number;
  x: { log: boolean; min: number; max: number; ticks: number[]; label: string; tick?: (v: number) => string };
  y: { log?: boolean; min: number; max: number; ticks: number[]; label: string; tick?: (v: number) => string };
  series: Series[];
  bands?: Array<{ x0: number; x1: number; color: string; label: string }>;
  hlines?: Array<{ y: number; label: string }>;
  /** Fixed right margin (stacked charts that share an x axis must use the same one). */
  marginRight?: number;
}

function chart(o: ChartOpts): string {
  const labelled = o.series.some((s) => s.label) || (o.hlines ?? []).length > 0;
  const m = { l: 74, r: o.marginRight ?? (labelled ? 170 : 24), t: 18, b: 56 };
  const iw = o.w - m.l - m.r;
  const ih = o.h - m.t - m.b;
  const sx = (v: number) => {
    const a = o.x.log ? Math.log10(o.x.min) : o.x.min;
    const b = o.x.log ? Math.log10(o.x.max) : o.x.max;
    const t = o.x.log ? Math.log10(Math.max(v, o.x.min)) : v;
    return m.l + ((t - a) / (b - a)) * iw;
  };
  const sy = (v: number) => {
    const a = o.y.log ? Math.log10(o.y.min) : o.y.min;
    const b = o.y.log ? Math.log10(o.y.max) : o.y.max;
    const t = o.y.log ? Math.log10(Math.max(v, o.y.min)) : v;
    return m.t + ih - ((t - a) / (b - a)) * ih;
  };
  const xt = o.x.tick ?? ((v: number) => fmt(v));
  const yt = o.y.tick ?? ((v: number) => fmt(v));
  const parts: string[] = [];
  parts.push(`<svg viewBox="0 0 ${o.w} ${o.h}" width="100%" role="img" xmlns="http://www.w3.org/2000/svg" style="display:block;font-family:${MONO}">`);
  for (const b of o.bands ?? []) {
    const x0 = sx(b.x0);
    const x1 = sx(b.x1);
    parts.push(`<rect x="${x0.toFixed(1)}" y="${m.t}" width="${Math.max(1, x1 - x0).toFixed(1)}" height="${ih}" fill="${b.color}" opacity="0.13"/>`);
    parts.push(`<text x="${(x0 + 0.64 * (x1 - x0)).toFixed(1)}" y="${(m.t + ih * 0.36).toFixed(1)}" fill="${C.text2}" font-size="14" text-anchor="middle" font-family="${SANS}">${esc(b.label)}</text>`);
  }
  for (const v of o.y.ticks) {
    const y = sy(v);
    parts.push(`<line x1="${m.l}" x2="${m.l + iw}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" stroke="${C.grid}" stroke-width="1"/>`);
    parts.push(`<text x="${m.l - 10}" y="${(y + 4).toFixed(1)}" fill="${C.muted}" font-size="13" text-anchor="end">${esc(yt(v))}</text>`);
  }
  for (const v of o.x.ticks) {
    const x = sx(v);
    parts.push(`<line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${m.t}" y2="${m.t + ih}" stroke="${C.grid}" stroke-width="1"/>`);
    parts.push(`<text x="${x.toFixed(1)}" y="${m.t + ih + 22}" fill="${C.muted}" font-size="13" text-anchor="middle">${esc(xt(v))}</text>`);
  }
  parts.push(`<line x1="${m.l}" x2="${m.l + iw}" y1="${m.t + ih}" y2="${m.t + ih}" stroke="${C.axis}" stroke-width="1"/>`);
  parts.push(`<text x="${m.l + iw / 2}" y="${o.h - 10}" fill="${C.text2}" font-size="14" text-anchor="middle" font-family="${SANS}">${esc(o.x.label)}</text>`);
  parts.push(`<text x="16" y="${m.t + ih / 2}" fill="${C.text2}" font-size="14" text-anchor="middle" font-family="${SANS}" transform="rotate(-90 16 ${m.t + ih / 2})">${esc(o.y.label)}</text>`);
  for (const h of o.hlines ?? []) {
    const y = sy(h.y);
    parts.push(`<line x1="${m.l}" x2="${m.l + iw}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" stroke="${C.text2}" stroke-width="1" opacity="0.6"/>`);
    parts.push(`<text x="${m.l + iw - 4}" y="${(y - 6).toFixed(1)}" fill="${C.text2}" font-size="13" text-anchor="end">${esc(h.label)}</text>`);
  }
  for (const s of o.series) {
    const pts = s.points.filter((p) => Number.isFinite(p.y));
    if (s.line && pts.length > 1) {
      let d = "";
      pts.forEach((p, i) => {
        const x = sx(p.x).toFixed(1);
        const y = sy(p.y).toFixed(1);
        if (i === 0) d += `M${x},${y}`;
        else if (s.step) d += `H${x}V${y}`;
        else d += `L${x},${y}`;
      });
      parts.push(`<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"${s.dash ? ` stroke-dasharray="${s.dash}"` : ""} opacity="${s.opacity ?? 1}"/>`);
    }
    for (const p of pts) {
      const x = sx(p.x).toFixed(1);
      const y = sy(p.y).toFixed(1);
      if (s.marker === "filled") parts.push(`<circle cx="${x}" cy="${y}" r="6.5" fill="${s.color}" stroke="${C.bg}" stroke-width="2.5"/>`);
      else if (s.marker === "hollow") parts.push(`<circle cx="${x}" cy="${y}" r="4.5" fill="${C.bg}" stroke="${s.color}" stroke-width="2" opacity="${s.opacity ?? 1}"/>`);
      if (p.note) parts.push(`<text x="${x}" y="${(Number(y) + 26).toFixed(1)}" fill="${C.text}" font-size="14" font-weight="600" text-anchor="middle">${esc(p.note)}</text>`);
      parts.push(`<circle cx="${x}" cy="${y}" r="13" fill="transparent"><title>${esc(p.tip)}</title></circle>`);
    }
    const last = pts[pts.length - 1];
    if (s.label && last) {
      parts.push(`<text x="${(sx(last.x) + 12).toFixed(1)}" y="${(sy(last.y) + 4).toFixed(1)}" fill="${C.text}" font-size="13" font-family="${SANS}">${esc(s.label)}</text>`);
    }
  }
  parts.push(`</svg>`);
  return parts.join("");
}

function legend(items: Array<{ color: string; label: string; kind: "line" | "dash" | "dot" | "hollow" }>): string {
  return `<div class="legend">${items
    .map((i) => {
      const key =
        i.kind === "dot"
          ? `<svg width="22" height="14"><circle cx="11" cy="7" r="6" fill="${i.color}" stroke="${C.bg}" stroke-width="2"/></svg>`
          : i.kind === "hollow"
            ? `<svg width="30" height="14"><line x1="0" x2="30" y1="7" y2="7" stroke="${i.color}" stroke-width="2.5"/><circle cx="15" cy="7" r="4.5" fill="${C.bg}" stroke="${i.color}" stroke-width="2"/></svg>`
            : `<svg width="30" height="14"><line x1="0" x2="30" y1="7" y2="7" stroke="${i.color}" stroke-width="2.5"${i.kind === "dash" ? ` stroke-dasharray="7 5"` : ""}/></svg>`;
      return `<span class="key">${key}<span>${esc(i.label)}</span></span>`;
    })
    .join("")}</div>`;
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

type Agg = { model: string; agents: number; n: number } & Record<string, number>;

function aggregate(results: SimResult[]): Agg[] {
  const keys = ["landingsPerMin", "commitsPerMin", "reworkPct", "conflictsPer1000", "writeWritePer1000", "ttlP50S", "ttlP99S", "e2eP50S", "e2eP99S", "meanBatch", "messagesPerLanded", "messagesPerAgentAction", "agentRequestsPerLanded", "trunkUtilization", "sigmaMax"] as const;
  const groups = new Map<string, SimResult[]>();
  for (const r of results) {
    const k = `${r.model}|${r.agents}`;
    const g = groups.get(k) ?? [];
    g.push(r);
    groups.set(k, g);
  }
  const out: Agg[] = [];
  for (const [k, g] of groups) {
    const [model, agents] = k.split("|");
    const row: Agg = { model: model!, agents: Number(agents), n: g.length } as Agg;
    for (const key of keys) {
      const vals = g.map((r) => r[key]).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
      row[key] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : NaN;
      row[`${key}Min`] = vals.length ? Math.min(...vals) : NaN;
      row[`${key}Max`] = vals.length ? Math.max(...vals) : NaN;
    }
    out.push(row);
  }
  return out.sort((a, b) => a.model.localeCompare(b.model) || a.agents - b.agents);
}

const MODEL_LABEL: Record<string, string> = {
  baseline: "Baseline: file locks + one merge queue",
  firetrident: "FireTrident with the serial trunk writer",
  "firetrident-group": "FireTrident + trunk group commit",
};

function seriesFor(agg: Agg[], model: string, key: string, opts: Partial<Series> & { color: string; tipUnit: string; digits?: number }): Series {
  const rows = agg.filter((r) => r.model === model).sort((a, b) => a.agents - b.agents);
  return {
    name: model,
    color: opts.color,
    marker: opts.marker ?? "hollow",
    line: opts.line ?? true,
    ...(opts.dash ? { dash: opts.dash } : {}),
    ...(opts.label ? { label: opts.label } : {}),
    ...(opts.opacity !== undefined ? { opacity: opts.opacity } : {}),
    points: rows.map((r) => ({
      x: r.agents,
      y: r[key]!,
      tip: `SIMULATED · ${MODEL_LABEL[model] ?? model} · ${fmtInt(r.agents)} agents: ${(r[key] ?? NaN).toFixed(opts.digits ?? 1)} ${opts.tipUnit}${r.n > 1 ? ` (mean of ${r.n} seeds, ${(r[`${key}Min`] ?? NaN).toFixed(opts.digits ?? 1)}–${(r[`${key}Max`] ?? NaN).toFixed(opts.digits ?? 1)})` : ""}`,
    })),
  };
}

function niceMax(v: number): number {
  const p = 10 ** Math.floor(Math.log10(Math.max(1e-9, v)));
  for (const f of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (f * p >= v) return f * p;
  return 10 * p;
}

function linTicks(max: number, n = 5): number[] {
  const step = niceMax(max / n);
  const out: number[] = [];
  for (let v = 0; v <= max + 1e-9; v += step) out.push(Math.round(v * 1000) / 1000);
  return out;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function load<T>(dir: string, name: string): T | null {
  const p = join(dir, name);
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as T) : null;
}

/** Calls one live run made, and how many of them failed. */
function callCounts(r: LiveReport): { calls: number; failed: number } {
  return { calls: r.ops.reduce((a, o) => a + o.calls, 0), failed: r.ops.reduce((a, o) => a + o.errors, 0) };
}

/**
 * Seconds from a run's start to the end of the last second in which a call failed; null when none
 * failed or the run predates the driver's per-second timeline.
 */
function lastFailureS(r: LiveReport): number | null {
  const t0 = Date.parse(r.startedAt);
  const day = r.startedAt.slice(0, 10);
  let last: number | null = null;
  for (const b of r.timeline ?? []) if (b.errors > 0) last = Math.max(last ?? 0, (Date.parse(`${day}T${b.t}Z`) + 1000 - t0) / 1000);
  return last;
}

/** "0 of 31,308 calls failed", or how many failed, their share and (for a completed run) how early. */
function failureLine(r: LiveReport): string {
  const { calls, failed } = callCounts(r);
  if (failed === 0) return `0 of ${fmtInt(calls)} calls failed`;
  const last = lastFailureS(r);
  return `${fmtInt(failed)} of ${fmtInt(calls)} calls failed (${((failed / calls) * 100).toFixed(2)}%)${last !== null && !r.stoppedEarly ? `, all in the first ${Math.ceil(last)} s` : ""}`;
}

/**
 * The distinct errors a run recorded (the driver keeps the first eight), split into failures on the
 * bench client's side (network causes such as ENOTFOUND, or its own 30 s timeout) and HTTP errors
 * the service answered with (quoted as recorded).
 */
function errorKinds(r: LiveReport): { client: string[]; service: string[] } {
  const client = new Set<string>();
  const service = new Set<string>();
  for (const e of r.errors) {
    const http = /^\w+: (\d{3} .*)$/.exec(e);
    if (http) service.add(http[1]!);
    else client.add(/\(([^)]+)\)\s*$/.exec(e)?.[1] ?? e.replace(/^\w+: /, ""));
  }
  return { client: [...client], service: [...service] };
}

/** A p50 range over runs, in seconds ("3.4–3.9 s"), from a trunk-cycle metric in milliseconds. */
function cycleRange(runs: LiveReport[], key: string, digits = 1): string {
  const v = runs.map((r) => r.trunkCycles?.metrics?.[key]?.p50).filter((x): x is number => typeof x === "number");
  if (!v.length) return "-";
  const [lo, hi] = [Math.min(...v) / 1000, Math.max(...v) / 1000];
  return lo.toFixed(digits) === hi.toFixed(digits) ? `${lo.toFixed(digits)} s` : `${lo.toFixed(digits)}–${hi.toFixed(digits)} s`;
}

/** The next limit after the scale fixes, with the scale runs' own numbers (NEXT_LIMIT without them). */
function nextLimitText(scale: LiveReport[]): string {
  if (!scale.length) return NEXT_LIMIT;
  const props = scale.map((r) => r.trunkCycles?.metrics?.["proposals"]?.p50).filter((x): x is number => typeof x === "number");
  const rates = scale.map((r) => r.window.landedPerMin);
  const ttl = scale.map((r) => (r.timeToLandMs.p50 ?? 0) / 1000);
  const agents = scale.map((r) => r.agents);
  const waits = scale.map((r) => r.trunkCycles?.metrics?.["waitMs"]?.p50).filter((x): x is number => typeof x === "number");
  const wait = waits.length ? `About ${Math.round(waits.reduce((a, b) => a + b, 0) / waits.length / 1000)} s` : "Time";
  return `The next limit is TrunkDO, the single trunk writer. Each commit cycle took ${cycleRange(scale, "cycleMs")} at the median and carried ${props.length ? `${Math.min(...props)}–${Math.max(...props)}` : "-"} proposals, against its cap of 200 (<code>CYCLE_MAX_PROPOSALS</code>), so throughput is flat past ${fmtInt(Math.min(...agents))} agents: ${fmtInt(Math.min(...rates))}–${fmtInt(Math.max(...rates))} landings/min from ${fmtInt(Math.min(...agents))} to ${fmtInt(Math.max(...agents))} agents. ${wait} of queueing for the writer (${cycleRange(scale, "waitMs")} p50) dominates time to land (${Math.min(...ttl).toFixed(1)}–${Math.max(...ttl).toFixed(1)} s p50). Inside a cycle, reading proposal blobs out of workspace forks takes longest (${cycleRange(scale, "pullMs")} p50), then the trunk push (${cycleRange(scale, "pushMs")}).`;
}

function main(): void {
  const dir = process.argv[2] ?? "packages/bench/results/2026-10-12";
  const live = [10, 50, 200, 1000].map((n) => load<LiveReport>(dir, `live-n${n}.json`)).filter((x): x is LiveReport => x !== null);
  // Optional second directory: the same live runs with trunk group commit built (MEASURED).
  const groupDir = process.argv[3];
  const group = groupDir ? [10, 50, 200, 1000].map((n) => load<LiveReport>(groupDir, `live-n${n}.json`)).filter((x): x is LiveReport => x !== null) : [];
  const groupName = groupDir ? groupDir.replace(/\/+$/, "").split("/").pop() ?? groupDir : "";
  // Optional third directory: the scale runs after the scale fixes (MEASURED, synthetic agents).
  const scaleDir = process.argv[4];
  const scale = scaleDir ? [1000, 2000, 5000].map((n) => load<LiveReport>(scaleDir, `live-n${n}.json`)).filter((x): x is LiveReport => x !== null) : [];
  const scaleName = scaleDir ? scaleDir.replace(/\/+$/, "").split("/").pop() ?? scaleDir : "";
  const scaleNotes = scaleDir ? load<NotesCheck>(scaleDir, "notes-check.json") : null;
  const scaleSummary = scaleDir ? load<ScaleSummary>(scaleDir, "summary.json") : null;
  const simLive = load<Sim>(dir, "sim-live.json");
  const simHist = load<Sim>(dir, "sim-history.json");
  const simTest = load<Sim>(dir, "sim-history-test30s.json");
  const cascade = load<Cascade>(dir, "cascade.json");
  const batch = load<BatchCost>(dir, "batchcost.json");
  const aggLive = simLive ? aggregate(simLive.results) : [];
  const aggHist = simHist ? aggregate(simHist.results) : [];
  const aggTest = simTest ? aggregate(simTest.results) : [];
  const get = (agg: Agg[], model: string, n: number) => agg.find((r) => r.model === model && r.agents === n);

  // ---- Chart 1: the measured setting (live workload) -----------------------
  const maxLive = niceMax(Math.max(...aggLive.map((r) => r.landingsPerMin ?? 0), ...live.map((r) => r.window.landedPerMin), ...group.map((r) => r.window.landedPerMin)) * 1.08);
  const measured: Series = {
    name: "measured",
    color: C.fire,
    marker: "filled",
    line: false,
    points: live.map((r) => ({
      x: r.agents,
      y: r.window.landedPerMin,
      note: r.window.landedPerMin.toFixed(0),
      tip: `MEASURED · FireTrident live, serial trunk writer · ${r.agents} agents: ${r.window.landedPerMin.toFixed(1)} landed changes/min (${r.window.commitsPerMin.toFixed(1)} commits/min, batch ${r.batchSize.mean?.toFixed(2)}), time-to-land p50 ${((r.timeToLandMs.p50 ?? 0) / 1000).toFixed(1)} s`,
    })),
  };
  const measuredGroup: Series = {
    name: "measured-group",
    color: C.group,
    marker: "filled",
    line: true,
    label: "group commit (measured)",
    points: group.map((r) => ({
      x: r.agents,
      y: r.window.landedPerMin,
      note: r.window.landedPerMin.toFixed(0),
      tip: `MEASURED · FireTrident live with trunk group commit · ${r.agents} agents: ${r.window.landedPerMin.toFixed(1)} landed changes/min (${r.window.commitsPerMin.toFixed(1)} commits/min, batch ${r.batchSize.mean?.toFixed(2)}), time-to-land p50 ${((r.timeToLandMs.p50 ?? 0) / 1000).toFixed(1)} s`,
    })),
  };
  const c1 = chart({
    w: 1100,
    h: 470,
    x: { log: true, min: 7, max: 1500, ticks: [10, 50, 100, 200, 500, 1000], label: "concurrent agents (log scale)", tick: (v) => fmtInt(v) },
    y: { min: 0, max: maxLive, ticks: linTicks(maxLive), label: "landed changes per minute" },
    series: [
      seriesFor(aggLive, "firetrident-group", "landingsPerMin", { color: C.group, dash: "7 5", opacity: 0.7, tipUnit: "landed/min", label: group.length ? "group commit (sim)" : "+ group commit (sim)" }),
      seriesFor(aggLive, "baseline", "landingsPerMin", { color: C.base, tipUnit: "landed/min", label: "Baseline" }),
      seriesFor(aggLive, "firetrident", "landingsPerMin", { color: C.fire, tipUnit: "landed/min", label: "serial writer (sim)" }),
      measured,
      ...(group.length ? [measuredGroup] : []),
    ],
  });

  // ---- Chart 5: the scale runs against the group-commit runs before them (both MEASURED) ----
  const maxScale = niceMax(Math.max(0, ...scale.map((r) => r.window.landedPerMin), ...group.map((r) => r.window.landedPerMin)) * 1.12);
  const c5 = scale.length
    ? chart({
        w: 1100,
        h: 430,
        x: { log: true, min: 7, max: 8000, ticks: [10, 100, 200, 1000, 2000, 5000], label: "concurrent agents (log scale)", tick: (v) => fmtInt(v) },
        y: { min: 0, max: maxScale, ticks: linTicks(maxScale), label: "landed changes per minute" },
        series: [
          {
            name: "group-before",
            color: C.group,
            marker: "filled",
            line: true,
            label: "before the fixes",
            points: group.map((r) => ({
              x: r.agents,
              y: r.window.landedPerMin,
              // A value label is drawn below its point: skip it where it would sit on the axis labels.
              ...(r.window.landedPerMin > maxScale * 0.1 ? { note: r.window.landedPerMin.toFixed(0) } : {}),
              tip: `MEASURED · group commit run, before the scale fixes (preview) · ${fmtInt(r.agents)} agents: ${r.window.landedPerMin.toFixed(1)} landed/min; ${failureLine(r)}${r.stoppedEarly ? `; stopped early (${r.stoppedEarly})` : ""}`,
            })),
          },
          {
            name: "scale",
            color: C.scale,
            marker: "filled",
            line: true,
            label: "after the fixes",
            points: scale.map((r) => ({
              x: r.agents,
              y: r.window.landedPerMin,
              note: fmtInt(r.window.landedPerMin),
              tip: `MEASURED · scale run, after the scale fixes (preview) · ${fmtInt(r.agents)} agents: ${r.window.landedPerMin.toFixed(1)} landed/min, time to land p50 ${((r.timeToLandMs.p50 ?? 0) / 1000).toFixed(1)} s; ${failureLine(r)}`,
            })),
          },
        ],
      })
    : "";

  // ---- Chart 2: the hono workload, 10 to 100,000 agents ------------------
  const maxHist = niceMax(Math.max(...aggHist.map((r) => r.landingsPerMin ?? 0)) * 1.1);
  const c2 = chart({
    w: 1100,
    h: 470,
    x: { log: true, min: 7, max: 150_000, ticks: [10, 100, 1000, 10_000, 100_000], label: "concurrent agents (log scale)", tick: (v) => fmt(v) },
    y: { min: 0, max: maxHist, ticks: linTicks(maxHist), label: "landed changes per minute" },
    series: [
      seriesFor(aggHist, "firetrident-group", "landingsPerMin", { color: C.group, dash: "7 5", opacity: 0.75, tipUnit: "landed/min", label: "+ group commit" }),
      seriesFor(aggHist, "baseline", "landingsPerMin", { color: C.base, tipUnit: "landed/min", label: "Baseline" }),
      seriesFor(aggHist, "firetrident", "landingsPerMin", { color: C.fire, tipUnit: "landed/min", label: "serial writer" }),
    ],
  });

  // ---- Small multiples (hono workload) ----------------------------------
  const small = (key: string, label: string, unit: string, opts: { log?: boolean; digits?: number } = {}) => {
    const vals = aggHist.map((r) => r[key] ?? NaN).filter((v) => Number.isFinite(v) && v > 0);
    const max = niceMax(Math.max(...vals) * 1.1);
    const min = opts.log ? Math.max(1, 10 ** Math.floor(Math.log10(Math.min(...vals)))) : 0;
    const ticks = opts.log ? [1, 10, 100, 1000, 10_000, 100_000].filter((t) => t >= min && t <= max) : linTicks(max, 4);
    return chart({
      w: 540,
      h: 320,
      x: { log: true, min: 7, max: 150_000, ticks: [10, 100, 1000, 10_000, 100_000], label: "agents (log)", tick: (v) => fmt(v) },
      y: { log: !!opts.log, min, max: opts.log ? 10 ** Math.ceil(Math.log10(max)) : max, ticks, label },
      series: [
        seriesFor(aggHist, "firetrident-group", key, { color: C.group, dash: "7 5", opacity: 0.75, tipUnit: unit, digits: opts.digits ?? 1 }),
        seriesFor(aggHist, "baseline", key, { color: C.base, tipUnit: unit, digits: opts.digits ?? 1 }),
        seriesFor(aggHist, "firetrident", key, { color: C.fire, tipUnit: unit, digits: opts.digits ?? 1 }),
      ],
    }).replace(`style="display:block`, `style="display:block;max-width:540px`);
  };

  // ---- Chart 3: the cascade ----------------------------------------------
  let c3 = "";
  let c4 = "";
  if (cascade) {
    const t0 = cascade.writerLanding.tMs;
    const toS = (ms: number) => (ms - t0) / 1000;
    const ev = cascade.sigma.events
      .filter((e, i, a) => i === 0 || Math.abs(e.sigma - a[i - 1]!.sigma) > 1e-9)
      .map((e) => ({ x: toS(e.tMs), y: e.sigma, tip: `MEASURED · σ in ${cascade.region} at +${toS(e.tMs).toFixed(1)} s: ${e.sigma.toFixed(2)}` }));
    const polled = cascade.sigma.polled.map((e) => ({ x: toS(e.tMs), y: e.sigma, tip: `MEASURED (polled /field) · σ at +${toS(e.tMs).toFixed(1)} s: ${e.sigma.toFixed(2)}` }));
    const xmin = Math.floor(Math.min(...polled.map((p) => p.x), -5));
    const xmax = Math.ceil(Math.max(...polled.map((p) => p.x), 70));
    const ticks: number[] = [];
    for (let v = Math.ceil(xmin / 10) * 10; v <= xmax; v += 10) ticks.push(v);
    const above = cascade.sigma.firstAboveOneMs !== null && cascade.sigma.lastAboveOneMs !== null ? [{ x0: toS(cascade.sigma.firstAboveOneMs), x1: toS(cascade.sigma.lastAboveOneMs + 2_000), color: C.danger, label: "σ > 1: governor engaged" }] : [];
    const step: Pt[] = [];
    for (const p of polled) step.push(p);
    c3 = chart({
      w: 1100,
      h: 380,
      x: { log: false, min: xmin, max: xmax, ticks, label: `seconds after the landing of ${cascade.shared}`, tick: (v) => `${v > 0 ? "+" : ""}${v}` },
      y: { min: 0, max: 32, ticks: [0, 5, 10, 15, 20, 25, 30], label: "σ (stale returns per landed change)" },
      bands: above,
      hlines: [{ y: 1, label: "σ = 1" }],
      marginRight: 40,
      series: [
        { name: "sigma-polled", color: C.fire, marker: "none", line: true, step: true, points: polled },
        { name: "sigma-ws", color: C.fire, marker: "filled", line: false, points: ev },
      ],
    });
    const delayPts: Pt[] = [{ x: xmin, y: 1, tip: "lane cadence before the cascade: 1 s" }];
    for (const d of cascade.laneDelay) delayPts.push({ x: toS(d.tMs), y: d.ms / 1000, tip: `MEASURED · lane delay at +${toS(d.tMs).toFixed(1)} s: ${(d.ms / 1000).toFixed(2)} s (inhibition ×${(d.ms / 1000).toFixed(2)})` });
    delayPts.push({ x: xmax, y: delayPts[delayPts.length - 1]!.y, tip: "" });
    const reland: Pt[] = cascade.relandings.map((r) => ({ x: toS(r.tMs), y: 0.35, tip: `re-landing commit at +${toS(r.tMs).toFixed(1)} s: ${r.landed} reworked proposals` }));
    c4 = chart({
      w: 1100,
      h: 260,
      x: { log: false, min: xmin, max: xmax, ticks, label: "seconds after the landing (dots: re-landing commits of the reworked proposals)", tick: (v) => `${v > 0 ? "+" : ""}${v}` },
      y: { min: 0, max: 9, ticks: [0, 2, 4, 6, 8], label: "lane cadence (s)" },
      marginRight: 40,
      series: [
        { name: "delay", color: C.base, marker: "none", line: true, step: true, points: delayPts },
        { name: "reland", color: C.text2, marker: "filled", line: false, points: reland },
      ],
    });
  }

  // ---- Headline numbers ---------------------------------------------------
  const peakLive = live.reduce((m, r) => Math.max(m, r.window.landedPerMin), 0);
  const l1000 = live.find((r) => r.agents === 1000);
  const baseLiveCeil = Math.max(...aggLive.filter((r) => r.model === "baseline").map((r) => r.landingsPerMin ?? 0));
  const fireHist = get(aggHist, "firetrident", 100_000);
  const baseHist = get(aggHist, "baseline", 100_000);
  const groupHist = get(aggHist, "firetrident-group", 100_000);
  const fireLive1k = get(aggLive, "firetrident", 1000);
  const groupLive1k = get(aggLive, "firetrident-group", 1000);
  const ratio = (a: Agg | undefined, b: Agg | undefined) => (a && b && b.landingsPerMin ? a.landingsPerMin! / b.landingsPerMin : NaN);
  const hono = (m: string) => get(aggHist, m, 1000);
  const t30 = ratio(get(aggTest, "firetrident", 1000), get(aggTest, "baseline", 1000));
  const gTop = group.find((r) => r.agents === 1000) ?? group[group.length - 1];
  const gBefore = gTop ? live.find((r) => r.agents === gTop.agents) : undefined;
  const gCycles = gTop?.trunkCycles;
  const gMetric = (k: string, q: "p50" | "mean" = "p50"): number => gCycles?.metrics?.[k]?.[q] ?? NaN;
  const gPeak = group.reduce<LiveReport | undefined>((m, r) => (!m || r.window.landedPerMin > m.window.landedPerMin ? r : m), undefined);
  const gPeakBefore = gPeak ? live.find((r) => r.agents === gPeak.agents) : undefined;
  const pLive = live.reduce<LiveReport | undefined>((m, r) => (!m || r.window.landedPerMin > m.window.landedPerMin ? r : m), undefined);
  const sPeak = scale.reduce<LiveReport | undefined>((m, r) => (!m || r.window.landedPerMin > m.window.landedPerMin ? r : m), undefined);
  const sClean = scale.filter((r) => callCounts(r).failed === 0).map((r) => fmtInt(r.agents));
  const sFailed = scale.filter((r) => callCounts(r).failed > 0);
  const tiles = [
    ...(sPeak
      ? [
          {
            label: "After the scale fixes, measured peak",
            value: `${fmtInt(sPeak.window.landedPerMin)}/min`,
            sub: `${fmtInt(sPeak.agents)} synthetic agents (no model calls, review off)${scale
              .filter((r) => r !== sPeak)
              .map((r) => `; ${fmtInt(r.window.landedPerMin)}/min at ${fmtInt(r.agents)}`)
              .join("")}. Failed calls in these runs: ${sClean.length ? `0 at ${sClean.join(" and ")} agents` : ""}${sFailed.map((r) => `${sClean.length ? ", " : ""}${((callCounts(r).failed / callCounts(r).calls) * 100).toFixed(2)}% at ${fmtInt(r.agents)}`).join("")}`,
            tag: "MEASURED",
          },
        ]
      : []),
    ...(scaleNotes
      ? [
          {
            label: "Lineage notes after the scale runs",
            value: `${fmtInt(scaleNotes.result.notes)}/${fmtInt(scaleNotes.result.landing_commits)}`,
            sub: `landing commits on the scale colony's trunk with a note, read with stock git (${scaleNotes.result.landing_commits_without_note} without)`,
            tag: "MEASURED",
          },
        ]
      : []),
    ...(gPeak && gTop
      ? [
          {
            label: "Group commit run, measured peak",
            value: `${gPeak.window.landedPerMin.toFixed(0)}/min`,
            sub: `${fmtInt(gPeak.agents)} agents: ${gPeakBefore ? `${(gPeak.window.landedPerMin / gPeakBefore.window.landedPerMin).toFixed(1)}× the serial writer's ${gPeakBefore.window.landedPerMin.toFixed(0)}/min` : ""}${
              gTop !== gPeak && gBefore
                ? `; ${fmtInt(gTop.agents)} agents ${gTop.window.landedPerMin.toFixed(0)}/min (${(gTop.window.landedPerMin / gBefore.window.landedPerMin).toFixed(1)}×${gTop.stoppedEarly ? ", stopped early: coordinator overload" : ""})`
                : ""
            }${scale.length ? ". Preview, before the scale fixes" : ""}`,
            tag: "MEASURED",
          },
        ]
      : []),
    {
      label: gTop ? "Serial trunk writer run, measured peak" : "Measured peak, real commits",
      value: `${peakLive.toFixed(0)}/min`,
      sub: pLive ? `production, ${fmtInt(pLive.agents)} agents: ${failureLine(pLive)}` : "",
      tag: "MEASURED",
    },
    { label: "Baseline ceiling, same costs", value: `${baseLiveCeil.toFixed(0)}/min`, sub: "locks + one merge queue, live workload", tag: "SIMULATED" },
    { label: "Serial trunk writer vs baseline", value: `${ratio(fireLive1k, get(aggLive, "baseline", 1000)).toFixed(1)}× · ${ratio(hono("firetrident"), hono("baseline")).toFixed(1)}×`, sub: "live workload · hono workload, 1,000 agents", tag: "SIMULATED" },
    { label: "Group commit vs baseline", value: `${ratio(groupLive1k, get(aggLive, "baseline", 1000)).toFixed(0)}× · ${ratio(hono("firetrident-group"), hono("baseline")).toFixed(0)}×`, sub: gTop ? "simulator; same two workloads" : "proposed, not built; same two workloads", tag: "SIMULATED" },
    ...(Number.isFinite(t30) ? [{ label: "When checks take 30 s", value: `${t30.toFixed(0)}×`, sub: "hono, 1,000 agents: the queue retests serially", tag: "SIMULATED" }] : []),
    { label: "Cascade detected and damped", value: cascade ? `σ ${cascade.sigma.max.toFixed(0)}` : "-", sub: cascade ? `1 landing, ${cascade.returned} stale returns; σ < 1 in ${(((cascade.sigma.lastAboveOneMs ?? 0) - cascade.writerLanding.tMs) / 1000 + 2).toFixed(0)} s` : "", tag: "MEASURED" },
  ];
  void fireHist;
  void baseHist;
  void groupHist;

  // ---- Tables -------------------------------------------------------------
  const liveRow = (r: LiveReport, writer: string) =>
    `<tr><td>${fmtInt(r.agents)}</td><td class="l">${writer}</td><td>${r.window.landedPerMin.toFixed(1)}</td><td>${r.window.commitsPerMin.toFixed(1)}</td><td>${(r.batchSize.mean ?? 0).toFixed(2)}</td><td>${fmt((r.timeToLandMs.p50 ?? 0) / 1000, 1)}</td><td>${fmt((r.timeToLandMs.p99 ?? 0) / 1000, 1)}</td><td>${fmtInt(r.takeAssigned.p50 ?? 0)}</td><td>${fmtInt(r.takeAssigned.p99 ?? 0)}</td><td>${fmtInt(r.ops.find((o) => o.op === "propose")?.p50 ?? 0)}</td><td>${fmtInt(r.ops.find((o) => o.op === "propose")?.p99 ?? 0)}</td><td>${fmtInt(Object.values(r.counts.waits).reduce((a, b) => a + b, 0))}</td><td>${r.counts.returned}</td><td>${fmtInt(callCounts(r).failed)} / ${fmtInt(callCounts(r).calls)}${r.stoppedEarly ? " (stopped early)" : ""}</td></tr>`;
  const liveRows = [
    ...live.map((r) => ({ r, w: `<span class="sw" style="background:${C.fire}"></span>serial` })),
    ...group.map((r) => ({ r, w: `<span class="sw" style="background:${C.group}"></span>group commit` })),
    ...scale.map((r) => ({ r, w: `<span class="sw" style="background:${C.scale}"></span>group commit + scale fixes` })),
  ]
    .sort((a, b) => a.r.agents - b.r.agents)
    .map(({ r, w }) => liveRow(r, w))
    .join("");
  const simRows = (agg: Agg[]) =>
    agg
      .slice()
      .sort((a, b) => a.agents - b.agents || a.model.localeCompare(b.model))
      .map(
        (r) =>
          `<tr><td>${fmtInt(r.agents)}</td><td class="l"><span class="sw" style="background:${r.model === "baseline" ? C.base : r.model === "firetrident-group" ? C.group : C.fire}"></span>${esc(r.model === "firetrident-group" ? "FireTrident + group commit" : r.model === "firetrident" ? "FireTrident, serial writer" : "Baseline")}</td><td>${(r.landingsPerMin ?? 0).toFixed(1)}</td><td>${(r.meanBatch ?? 0).toFixed(2)}</td><td>${(r.reworkPct ?? 0).toFixed(1)}</td><td>${(r.conflictsPer1000 ?? 0).toFixed(0)}</td><td>${num(r.ttlP50S)}</td><td>${num(r.ttlP99S)}</td><td>${num(r.messagesPerLanded, 0)}</td><td>${(r.messagesPerAgentAction ?? 0).toFixed(2)}</td></tr>`,
      )
      .join("");
  const calib = (simLive?.calibration ?? simHist?.calibration ?? {}) as { inPlatform?: Record<string, number> };
  const cal = calib.inPlatform ?? {};
  const check = (runs: LiveReport[], model: string, name: string) =>
    runs
      .map((r) => {
        const s = get(aggLive, model, r.agents);
        if (!s) return "";
        const err = ((s.landingsPerMin! - r.window.landedPerMin) / r.window.landedPerMin) * 100;
        // The simulator's group model folds a whole cycle into one commit: compare its batch with proposals per cycle.
        const perCycle = model === "firetrident-group" ? r.trunkCycles?.metrics?.proposals?.mean : undefined;
        const batch = perCycle !== undefined && perCycle !== null ? `${perCycle.toFixed(1)} / cycle` : (r.batchSize.mean ?? 0).toFixed(2);
        return `<tr><td>${fmtInt(r.agents)}</td><td class="l">${name}</td><td>${r.window.landedPerMin.toFixed(1)}</td><td>${s.landingsPerMin!.toFixed(1)}</td><td>${err >= 0 ? "+" : ""}${err.toFixed(0)}%</td><td>${fmt((r.timeToLandMs.p50 ?? 0) / 1000, 1)}</td><td>${fmt(s.ttlP50S ?? NaN, 1)}</td><td>${batch}</td><td>${(s.meanBatch ?? 0).toFixed(2)}</td></tr>`;
      })
      .join("");
  const validation = check(live, "firetrident", "serial writer") + check(group, "firetrident-group", "group commit");
  const testRows = aggTest.length
    ? aggTest
        .filter((r) => r.model !== "firetrident-group")
        .sort((a, b) => a.agents - b.agents || a.model.localeCompare(b.model))
        .map((r) => `<tr><td>${fmtInt(r.agents)}</td><td class="l">${r.model === "baseline" ? "Baseline" : "FireTrident"}</td><td>${(r.landingsPerMin ?? 0).toFixed(1)}</td><td>${fmt(r.ttlP50S ?? NaN, 1)}</td><td>${(r.reworkPct ?? 0).toFixed(1)}</td></tr>`)
        .join("")
    : "";
  const batchRows = (batch?.rows ?? [])
    .map((r) => `<tr><td>${r.k}</td><td class="l">${r.commits.map((c) => `${c.size} @ ${(c.atMs / 1000).toFixed(2)} s`).join(", ")}</td></tr>`)
    .join("");

  // ---- Scale section (MEASURED) --------------------------------------------
  const scaleRows = scale
    .map((r) => {
      const m = r.trunkCycles?.metrics ?? {};
      const sec = (k: string) => fmt((m[k]?.p50 ?? NaN) / 1000, 1);
      const { calls, failed } = callCounts(r);
      return `<tr><td>${fmtInt(r.agents)}</td><td>${fmtInt(r.window.landedPerMin)}</td><td>${r.window.commitsPerMin.toFixed(0)}</td><td>${fmt((r.timeToLandMs.p50 ?? 0) / 1000, 1)} / ${fmt((r.timeToLandMs.p90 ?? 0) / 1000, 1)} / ${fmt((r.timeToLandMs.p99 ?? 0) / 1000, 1)}</td><td>${fmtInt(r.takeAssigned.p50 ?? 0)} / ${fmtInt(r.takeAssigned.p99 ?? 0)}</td><td>${sec("cycleMs")}</td><td>${fmtInt(m["proposals"]?.p50 ?? 0)}</td><td>${sec("waitMs")}</td><td>${sec("pullMs")}</td><td>${sec("pushMs")}</td><td>${fmtInt(calls)}</td><td>${fmtInt(failed)}</td></tr>`;
    })
    .join("");
  const scaleFailures = scale
    .map((r) => {
      const line = `${fmtInt(r.agents)} agents: ${failureLine(r)}`;
      if (callCounts(r).failed === 0) return `${line}.`;
      const k = errorKinds(r);
      const sockets = r.agents === 5000 ? scaleSummary?.benchClientAt5000?.peakEstablishedSockets?.established : undefined;
      const kinds = [
        k.client.length ? `connection failures on the bench client (${k.client.join(", ")})${sockets ? `, while one bench machine held up to ${fmtInt(sockets)} open sockets around the end of the ramp` : ""}` : "",
        ...k.service.map((s) => `the service answering <code>${esc(s)}</code>${/code was updated/.test(s) ? " (a Durable Object restarting on newly deployed code)" : ""}`),
      ].filter(Boolean);
      return `${line}. The error kinds the driver recorded (it keeps the first eight distinct messages) are ${kinds.join(", and ")}.`;
    })
    .join(" ");
  const notesLine = scaleNotes
    ? `After the runs, stock git fetched trunk and <code>refs/notes/firetrident</code> from colony <code>${esc(scaleNotes.colony)}</code>'s Artifacts repository: ${fmtInt(scaleNotes.result.notes)} of ${fmtInt(scaleNotes.result.landing_commits)} landing commits carry a lineage note (${scaleNotes.result.landing_commits_without_note} without), ${scaleNotes.result.sampled} sampled <code>git notes show</code> name their landing (${scaleNotes.result.sampled_note_landing_mismatch} mismatches), and the notes tree is ${scaleNotes.result.notes_root?.fanout_directories ?? "-"} two-character fanout directories with ${scaleNotes.result.notes_root?.flat_notes ?? "-"} flat notes.`
    : "";
  const earlier = scaleSummary?.earlierRuns ?? [];
  const earlierDone = earlier.filter((r) => r.completed);
  const earlierStopped = earlier.filter((r) => !r.completed);
  const completedCycles = [
    ...earlierDone.map((r) => ({ at: r.startedAt, ms: r.trunkCycle?.cycleMs?.p50 })),
    ...scale.map((r) => ({ at: r.startedAt, ms: r.trunkCycles?.metrics?.["cycleMs"]?.p50 })),
  ]
    .filter((c): c is { at: string; ms: number } => typeof c.ms === "number")
    .sort((a, b) => a.at.localeCompare(b.at));
  const earlierLine = earlier.length
    ? `Earlier runs on the same colony, not in the table: ${earlierDone.map((r) => `${fmtInt(r.landedPerMin)}/min at ${fmtInt(r.agents)} agents`).join(" and ")} with the build before the take gate${
        completedCycles.length > 1
          ? `; the trunk cycle grew from ${(completedCycles[0]!.ms / 1000).toFixed(1)} s to ${(completedCycles[completedCycles.length - 1]!.ms / 1000).toFixed(1)} s p50 over the ${completedCycles.length} completed runs as the bench's trunk tree grew (each intent adds a file)`
          : ""
      }. ${earlierStopped.length} attempts at ${[...new Set(earlierStopped.map((r) => fmtInt(r.agents)))].join(" and ")} agents stopped early: ${earlierStopped.map((r) => `${esc((r.why ?? r.stoppedEarly ?? "").split(";")[0]!.trim())} (${esc(r.stoppedEarly ?? "")})`).join("; and ")}. <code>summary.json</code> records all of them; their raw files were not kept.`
    : "";

  const wl = (simHist?.workload ?? {}) as Record<string, unknown>;
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>FireTrident Scaling Benchmark</title>
<style>
:root { color-scheme: dark; --bg: ${C.bg}; --panel: ${C.panel}; --line: ${C.grid}; --text: ${C.text}; --text2: ${C.text2}; --muted: ${C.muted}; --fire: ${C.fire}; --base: ${C.base}; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font-family: ${SANS}; line-height: 1.45; }
main { max-width: 1180px; margin: 0 auto; padding: 40px 16px 80px; }
h1 { font-size: 40px; margin: 0 0 6px; letter-spacing: -0.01em; }
h1 .accent { color: var(--fire); }
h2 { font-size: 24px; margin: 52px 0 6px; }
h3 { font-size: 17px; margin: 0 0 8px; color: var(--text2); font-weight: 600; }
p.lede { color: var(--text2); font-size: 18px; margin: 0 0 28px; max-width: 980px; }
p { color: var(--text2); max-width: 1000px; }
.tag { display: inline-block; font: 600 11px/1 ${MONO}; letter-spacing: .08em; padding: 5px 7px; border-radius: 4px; margin-left: 8px; vertical-align: 3px; }
.tag.m { color: #1b0c00; background: var(--fire); }
.tag.s { color: var(--text); border: 1px solid #3a4756; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 14px; margin: 8px 0 8px; }
.tile { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 16px 18px; }
.tile .label { color: var(--text2); font-size: 13px; }
.tile .tag { margin: 0 0 8px; display: inline-block; }
.tile .value { font: 600 36px/1.15 ${MONO}; margin: 6px 0 4px; }
.tile .sub { color: var(--muted); font-size: 12.5px; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 20px 20px 12px; margin-top: 16px; }
.legend { display: flex; flex-wrap: wrap; gap: 8px 22px; margin: 4px 0 10px; color: var(--text2); font-size: 13.5px; }
.legend .key { display: inline-flex; align-items: center; gap: 8px; }
.grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(420px, 1fr)); gap: 16px; }
table { width: 100%; border-collapse: collapse; font-size: 13.5px; margin-top: 10px; }
th, td { text-align: right; padding: 7px 10px; border-bottom: 1px solid var(--line); font-family: ${MONO}; font-variant-numeric: tabular-nums; white-space: nowrap; }
th { color: var(--muted); font: 600 12px ${SANS}; text-transform: none; }
th:first-child, td:first-child, th.l, td.l { text-align: left; }
.table-wrap { overflow-x: auto; }
.sw { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 8px; vertical-align: 0; }
ul { color: var(--text2); max-width: 1000px; }
li { margin: 4px 0; }
code { font-family: ${MONO}; font-size: .92em; color: var(--text); }
.foot { color: var(--muted); font-size: 13px; margin-top: 40px; }
@media (max-width: 640px) { h1 { font-size: 28px; } .tile .value { font-size: 28px; } .grid2 { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<main>
<h1>FireTrident: <span class="accent">a colony</span>, not a queue</h1>
<p class="lede">Scaling benchmark, 2026-10-12. Live runs with real Artifacts commits (the serial trunk writer on the production deployment; group commit${scale.length ? " and the scale runs" : ""} on preview deployments) and a discrete-event simulator calibrated on them, comparing FireTrident with the common design: exclusive file locks plus one serialized merge queue. Every chart and tile says whether its points are <b>MEASURED</b> or <b>SIMULATED</b>, and every count of failed calls names its run.</p>

<div class="tiles">
${tiles.map((t) => `<div class="tile"><span class="tag ${t.tag === "MEASURED" ? "m" : "s"}">${t.tag}</span><div class="label">${esc(t.label)}</div><div class="value">${esc(t.value)}</div><div class="sub">${esc(t.sub)}</div></div>`).join("\n")}
</div>

<h2>Throughput on the live workload<span class="tag m">MEASURED</span><span class="tag s">SIMULATED</span></h2>
<p>Synthetic agents on the production deployment with the serial trunk writer, ${live.length} runs at 10 to 1,000 concurrent agents. Each change adds one file in one of 64 directories, and every landing is a real trunk commit pushed with compare-and-swap. The lines are the simulator replaying the same workload with costs fitted to these runs: it lands within about 10% of every measured point.</p>
${
  group.length
    ? `<p><b>Trunk group commit, built and MEASURED</b> (${esc(groupName)}, on a preview deployment${scale.length ? ", before the scale fixes" : ""}). The trunk writer now takes every lane batch that queued while its previous cycle ran: it re-validates each proposal against trunk and against the batches ahead of it, builds one commit per batch chained on the one before (so lineage and <code>why</code> stay per landing), pushes trunk once and all lineage notes once. Same driver, same workload: ${group
        .map((r) => {
          const b = live.find((x) => x.agents === r.agents);
          return `${fmtInt(r.agents)} agents ${r.window.landedPerMin.toFixed(0)}/min${b ? ` (serial writer ${b.window.landedPerMin.toFixed(0)}/min)` : ""}${r.stoppedEarly ? ", stopped early by the driver's error guard" : ""}`;
        })
        .join(", ")}.</p>`
    : ""
}
<div class="card">
${legend([
  { color: C.fire, label: "FireTrident, serial trunk writer, MEASURED live", kind: "dot" },
  ...(group.length ? [{ color: C.group, label: "FireTrident + trunk group commit, MEASURED live", kind: "dot" as const }] : []),
  { color: C.fire, label: "FireTrident, serial trunk writer, SIMULATED", kind: "hollow" },
  { color: C.base, label: "Baseline: locks + one merge queue, SIMULATED", kind: "hollow" },
  { color: C.group, label: group.length ? "FireTrident + trunk group commit, SIMULATED" : "FireTrident + trunk group commit, SIMULATED (proposed, not built)", kind: "dash" },
])}
${c1}
</div>
${
  scale.length
    ? `
<h2>Scale: ${fmtInt(Math.min(...scale.map((r) => r.agents)))} to ${fmtInt(Math.max(...scale.map((r) => r.agents)))} agents on one colony<span class="tag m">MEASURED</span></h2>
<p><b>These are synthetic agents: no model calls, no agent-side git and no work time, with the review layer turned off on the colony</b> (<code>POST /api/colonies/:id/decide/policy {"enabled":false}</code>), so the runs measure coordination and landing only. Same driver and workload as above: each change adds one file in one of ${scale[0]!.regions} directories, and every landing is a real Artifacts commit pushed with compare-and-swap. ${scale[0]!.durationS} s per run with a 10 s ramp; outcomes reach the agents over the live WebSocket with a 20 s fallback poll; group commit on; one colony (<code>${esc(scale[0]!.colony)}</code>) on a preview deployment with its own Durable Objects and a pre-forked workspace pool. Raw runs: <code>../${esc(scaleName)}/</code>.</p>
<p>What changed since the group-commit run: takes share one read of each region's claims, at most 128 takes score at once and waiting agents are paced, outcomes are pushed to agents instead of polled, stopped agents release their claims at once, leasing a workspace is pure SQL with one token kept per slot, and lineage notes use git's two-character fanout (docs/ARCHITECTURE.md, Scale).</p>
<div class="card">
${legend([
  { color: C.group, label: "group commit before the scale fixes, MEASURED (preview)", kind: "dot" },
  { color: C.scale, label: "group commit after the scale fixes, MEASURED (preview)", kind: "dot" },
])}
${c5}
</div>
<div class="card table-wrap"><h3>Scale runs (MEASURED). ttl: time to land. cycle, proposals/cycle, queue (waiting for the trunk writer), pull (proposal blobs from workspace forks) and push: trunk writer medians over the steady window</h3>
<table><thead><tr><th>agents</th><th>landed/min</th><th>commits/min</th><th>ttl p50/p90/p99 s</th><th>take p50/p99 ms</th><th>cycle s</th><th>proposals/cycle</th><th>queue s</th><th>pull s</th><th>push s</th><th>calls</th><th>failed</th></tr></thead><tbody>${scaleRows}</tbody></table></div>
<p><b>Failed calls, per run.</b> ${scaleFailures}</p>
${notesLine ? `<p><b>Lineage.</b> ${notesLine}</p>` : ""}
<p><b>Next limit.</b> ${nextLimitText(scale)}</p>
${earlierLine ? `<p>${earlierLine}</p>` : ""}`
    : ""
}

<h2>Throughput from 10 to 100,000 agents on hono's history<span class="tag s">SIMULATED</span></h2>
<p>Write sets drawn from ${esc(String(wl.commitsUsed ?? ""))} real changes to honojs/hono, grown along co-change edges. Read sets are the written files' direct imports. The repo is a monorepo of ${esc(String(wl.packages ?? ""))} copies (regions at depth ${esc(String(wl.regionDepth ?? ""))}), and agents work a log-normal median of 60 s per change. Mean of 3 seeds; hover a point for the seed range.</p>
<div class="card">
${legend([
  { color: C.fire, label: "FireTrident, serial trunk writer", kind: "hollow" },
  { color: C.base, label: "Baseline: locks + one merge queue", kind: "hollow" },
  { color: C.group, label: group.length ? "FireTrident + trunk group commit" : "FireTrident + trunk group commit (proposed, not built)", kind: "dash" },
])}
${c2}
</div>

<div class="grid2">
<div class="card"><h3>Wasted work: rework % of all work time</h3>${small("reworkPct", "rework %", "%")}</div>
<div class="card"><h3>Time to land, p99 (s, submit to landing)</h3>${small("ttlP99S", "seconds", "s")}</div>
<div class="card"><h3>Conflicts per 1,000 submitted changes</h3>${small("conflictsPer1000", "per 1,000", "per 1,000", { digits: 0 })}</div>
<div class="card"><h3>Coordination messages per landed change (log)</h3>${small("messagesPerLanded", "messages", "messages", { log: true, digits: 0 })}</div>
</div>

${
  cascade
    ? `<h2>The seizure detector: one landing, ${cascade.returned} stale returns<span class="tag m">MEASURED</span></h2>
<p>Live, colony <code>${esc(cascade.colony)}</code>. ${cascade.readers} agents in <code>${esc(cascade.region)}</code> read <code>${esc(cascade.shared)}</code> and kept working. A real commit to that file landed, and all ${cascade.returned} in-flight proposals came back stale, each attributed to that one landing. σ jumped to ${cascade.sigma.max.toFixed(0)}, so the lane's cadence stretched from 1 s to 8 s. The reworked proposals then landed in inhibited batches until σ fell below 1. σ points are the <code>sigma</code> events on <code>/api/colonies/:id/live</code>; the line is <code>GET /field</code> polled every second.</p>
<div class="card">
${legend([
  { color: C.fire, label: "σ events on the live WebSocket", kind: "dot" },
  { color: C.fire, label: "σ polled from /field", kind: "line" },
])}
${c3}
${legend([
  { color: C.base, label: "lane cadence (inhibition metric on the WebSocket)", kind: "line" },
  { color: C.text2, label: "re-landing commits", kind: "dot" },
])}
${c4}
</div>`
    : ""
}

<h2>Tables</h2>
<div class="card table-wrap"><h3>Live runs (MEASURED, laptop-side latencies; serial writer on production, group commit${scale.length ? " and scale fixes" : ""} on previews)</h3>
<table><thead><tr><th>agents</th><th class="l">trunk writer</th><th>landed/min</th><th>commits/min</th><th>batch</th><th>ttl p50 s</th><th>ttl p99 s</th><th>take p50 ms</th><th>take p99 ms</th><th>propose p50 ms</th><th>propose p99 ms</th><th>admission waits</th><th>returned</th><th>failed / calls</th></tr></thead><tbody>${liveRows}</tbody></table></div>
<div class="card table-wrap"><h3>Simulator check against the live runs</h3>
<table><thead><tr><th>agents</th><th class="l">trunk writer</th><th>measured/min</th><th>simulated/min</th><th>error</th><th>ttl p50 measured s</th><th>ttl p50 sim s</th><th>batch measured</th><th>batch sim</th></tr></thead><tbody>${validation}</tbody></table></div>
<div class="card table-wrap"><h3>hono workload (SIMULATED, mean of seeds)</h3>
<table><thead><tr><th>agents</th><th class="l">model</th><th>landed/min</th><th>batch</th><th>rework %</th><th>conflicts/1k</th><th>ttl p50 s</th><th>ttl p99 s</th><th>msgs/landed</th><th>msgs/agent action</th></tr></thead><tbody>${simRows(aggHist)}</tbody></table></div>
${testRows ? `<div class="card table-wrap"><h3>Sensitivity: checks take 30 s (SIMULATED, hono workload)</h3><p>FireTrident agents run checks in their own workspace before proposing, so the checks run in parallel. The baseline also re-runs them in the queue after every rebase, so they run serially.</p><table><thead><tr><th>agents</th><th class="l">model</th><th>landed/min</th><th>ttl p50 s</th><th>rework %</th></tr></thead><tbody>${testRows}</tbody></table></div>` : ""}
${batchRows ? `<div class="card table-wrap"><h3>Trunk writer cost per batch (MEASURED: k proposals in one region, landing time after the first proposal)</h3><table><thead><tr><th>k</th><th class="l">commits: size @ time</th></tr></thead><tbody>${batchRows}</tbody></table></div>` : ""}

<h2>Method and assumptions</h2>
<ul>
<li><b>Live (MEASURED).</b> Synthetic REST agents take, propose, and poll their outcome on the in-platform schedule (1.5 s, ×1.6, capped at 15 s). Each proposal writes a new file whose blob already exists in every workspace fork. That makes the trunk writer do the real work (read the blob from the agent's fork, build the tree, push trunk with compare-and-swap, write the lineage note), while the agents need no git of their own. The review prong (reflex and LLM triage) was turned off on the two bench colonies, so the numbers isolate coordination and landing. Latencies are laptop-side and include about 100 ms of internet round trip.</li>
<li><b>Calibration.</b> In-platform take ${cal.takeMs} ms and propose ${cal.proposeMs} ms; lane overhead ${cal.laneOverheadMs} ms. Trunk writer per commit: ${cal.commitBaseMs} ms + ${cal.commitPerProposalMs} ms per proposal (fitted on the swarm runs and a single-region batch experiment). The baseline lands a change in ${cal.landMs} ms (the same writer with one proposal) plus ${cal.rebaseMs} ms to rebase a stale change (fetch and replay, from the Artifacts spike). Checks cost ${cal.testMs} ms in the headline runs, the most favourable setting for the baseline.</li>
<li><b>FireTrident model.</b> Mirrors the deployed code: take scores the 200 oldest open intents with core <code>chooseIntent</code>, using repulsion from claims and <code>admissionOpen</code> per region. Each proposal joins the lane of its primary region, where core <code>validateProposal</code> and <code>selectBatch</code> run. The tick interval is <code>laneIntervalMs</code> × <code>inhibitionFactor</code>(σ), and σ is computed with core <code>branchingRatio</code> over recorded causes, where returns are never parents. One trunk writer per colony serves the lanes' commits one at a time and re-validates each batch. A returned intent reopens and is redone in full.</li>
<li><b>Baseline model.</b> Exclusive locks on write sets, offered from the same 200 oldest tasks, with the same 3 s retry hint. One FIFO merge queue: a stale change is rebased and its checks re-run, and a change whose read or written files changed since its base fails (the same rule as read-set validation). It goes back to its agent, which keeps its locks, reworks half of the change, and resubmits.</li>
${
  scale.length
    ? `<li><b>Scale runs (MEASURED).</b> The same synthetic agents with no work time, the review layer off, 120 s per run, outcomes pushed over the live WebSocket (20 s fallback poll), and every run's agents stopped at its end so their claims never hold the next run's admission. Throughput is counted from 25 s to 120 s, after the ramp.</li>`
    : ""
}
<li><b>Not modelled.</b> The coordinator's own request capacity (one ColonyDO per colony) is assumed to scale in the simulator. Live, it held in the serial trunk writer run (${l1000 ? `${fmtInt(l1000.agents)} agents: ${failureLine(l1000)}, take p99 ${fmtInt(l1000.takeAssigned.p99 ?? 0)} ms` : "-"})${
  gTop && gBefore
    ? `; in the group-commit run, which pushed ${(gTop.window.landedPerMin / gBefore.window.landedPerMin).toFixed(1)}× as many landings through it, it saturated at ${fmtInt(gTop.agents)} agents (${failureLine(gTop)}${gTop.stoppedEarly ? `; the driver stopped the run: ${esc(gTop.stoppedEarly)}` : ""})`
    : ""
}${scale.length ? `; after the scale fixes: ${scale.map((r) => `${fmtInt(r.agents)} agents, ${failureLine(r)}`).join("; ")}` : ""}. Fork creation is not modelled (the pool is assumed warm).</li>
</ul>
<h2>What changed in RegionDO for the demo</h2>
<ul>
<li><b>σ treats returns as leaves.</b> A returned proposal changed nothing on trunk, so it cannot make anything stale. Counting every event in the window as a parent pinned a burst of N returns from one landing at N/(N+1) &lt; 1 and hid every cascade. σ is now stale returns per landed proposal, with core <code>branchingRatio</code>'s window semantics (60 s window, 5 s settle).</li>
<li><b>σ is re-evaluated after the lane empties.</b> While σ &gt; 1, or while a recent return may still raise it, an empty lane keeps a 2 s alarm. Previously σ was sent only after ticks that had proposals, so neither the spike (which arrives after the settle time) nor the recovery reached the UI. An enqueue into an empty lane replaces that alarm, so the inhibited cadence still holds.</li>
<li><b>Inhibition is published.</b> Every alarm sends <code>sigma</code>, and while the factor is above 1 (and once when it lifts) it also sends <code>metric</code> events <code>inhibition:&lt;region&gt;</code> and <code>laneDelayMs:&lt;region&gt;</code>. Deployed 2026-10-12 06:14 UTC; DO tests pass, including a new case where 4 returns from 1 landing give σ = 4.</li>
</ul>

<h2>Findings and open issues</h2>
<ul>
${
  gTop
    ? `<li><b>Trunk group commit lifts the one-commit-at-a-time ceiling (MEASURED).</b> At ${fmtInt(gTop.agents)} agents the colony landed ${gTop.window.landedPerMin.toFixed(0)} changes/min${gBefore ? `, ${(gTop.window.landedPerMin / gBefore.window.landedPerMin).toFixed(1)}× the serial writer's ${gBefore.window.landedPerMin.toFixed(0)}/min` : ""}, with ${group.reduce((n, r) => n + r.counts.returned, 0)} returns across the group-commit runs. Failed calls in the group-commit runs: ${group.map((r) => `${fmtInt(r.agents)} agents, ${failureLine(r)}`).join("; ")}.${
        gTop.stoppedEarly
          ? ` The ${fmtInt(gTop.agents)}-agent run stopped early (${esc(gTop.stoppedEarly)}): the one ColonyDO that serves every take, poll and propose saturated, so that run's rate is measured over a window it only partly worked in.`
          : ""
      } ${
        gCycles
          ? `The writer ran ${gCycles.perMin.toFixed(0)} cycles/min, each landing ${fmt(gMetric("batches", "mean"), 1)} lane batches (${fmt(gMetric("proposals", "mean"), 1)} proposals) as chained commits behind one trunk push and one notes push. A cycle took ${fmtInt(gMetric("cycleMs"))} ms at the median: pull ${fmtInt(gMetric("pullMs"))} ms, build ${fmtInt(gMetric("buildMs"))} ms, push ${fmtInt(gMetric("pushMs"))} ms.`
          : ""
      } Each lane batch is still its own commit with its own lineage note, so <code>why</code> stays per landing.</li>
${
  scale.length
    ? `<li><b>The scale fixes remove the coordinator limit (MEASURED; synthetic agents, no model calls, review off).</b> ${scale.map((r) => `${fmtInt(r.agents)} agents ${fmtInt(r.window.landedPerMin)}/min`).join(", ")}, against ${gTop.window.landedPerMin.toFixed(0)}/min for the group-commit run at ${fmtInt(gTop.agents)} agents before them. Failed calls: ${scale.map((r) => `${fmtInt(r.agents)} agents, ${failureLine(r)}`).join("; ")}.</li>`
    : ""
}
<li><b>Next limit: the trunk writer.</b> ${nextLimitText(scale)}</li>
<li><b>Fixed: landed proposals reported as returned.</b> A lane's <code>TrunkDO.land</code> call could fail on the lane's side after the trunk writer had landed the batch (the logs show <code>Durable Object reset because its code was updated</code> during deploys). The retry then reported those proposals as <code>already landed in lnd_…</code> (13 times at 1,000 agents), and a lane re-validating them saw them stale against their own new blob (on the Hono run one landed proposal was returned and its intent taken and abandoned 19 times). Outcomes are now idempotent per proposal id: the trunk writer reports earlier landings in <code>prior</code>, and a lane asks <code>TrunkDO.landingsOf</code> before returning a stale-looking proposal, so a landed proposal is always settled as landed.</li>`
    : `<li><b>One trunk writer serializes every commit.</b> Each lane's batch is its own commit, so work spread over many regions never batches (batch 1.0-2.0 live), and the deployed system behaves close to one merge queue with tree surgery. Folding every batch waiting on the trunk writer's chain into one commit (group commit) is the change that unlocks the colony: ${fmt(ratio(groupLive1k, get(aggLive, "baseline", 1000)), 0)}× and ${fmt(ratio(hono("firetrident-group"), hono("baseline")), 0)}× the baseline here. The next limit is the sequential blob pull at about 72 ms per proposal.</li>
<li><b>"already landed" reported as returned.</b> A retried <code>TrunkDO.land</code> returns proposals from an earlier landing with <code>already landed in lnd_…</code>. The lane reports them as returned, so the intent reopens and the work is redone (13 times at 1,000 agents).</li>`
}
<li><b>Admission ignores the shared trunk writer.</b> The floor of 3 agents per region admits far more agents than one writer serves when a colony has many regions. With the 200-oldest candidate window and repulsion, contended intents clog the window and are eventually taken anyway. That is why rework is about 42% vs 22% for locks on hono's history.</li>
<li><b>σ was per region (fixed since).</b> A stale read caused by a landing in another region got no cause, so cross-region cascades stayed invisible to the governor. A stale return with no local cause now records the other region's landing as its parent (<code>RegionDO.landedFor</code>).</li>
<li><b>The review prong triages every proposal</b> (deployed 06:32 UTC). It returned 41 of 87 synthetic proposals and added seconds each, so it was turned off on the two bench colonies with <code>POST /api/colonies/:id/decide/policy {"enabled":false}</code>. The 10-1,000 agent runs predate it. Two other deploys happened during the runs (06:24 and 06:32 UTC); the 200-agent run spans the first.</li>
<li><b>Account use.</b> 286 workspace forks (bench-w2-load 249, bench-w2-cascade 37), 8 seeds, 2 trunk imports. Both colonies are kept for re-runs and video capture; <code>DELETE /api/colonies/:id</code> removes them.${group.length ? ` The group-commit runs used one more colony on a preview deployment (g1-bench: 253 workspace forks, 4 seeds, 1 trunk import).` : ""}${scale.length ? ` The scale runs used one colony on another preview (${esc(scale[0]!.colony)}, with a workspace pool pre-forked to a target of 6,000).` : ""}</li>
</ul>

<h2>Reproduce</h2>
<div class="card table-wrap"><pre style="margin:0;color:var(--text2);font:13px/1.6 ${MONO};white-space:pre"># live runs talk to a deployment: FT_URL and FT_TOKEN (its admin token) come from the environment or ~/.config/firetrident/env
node packages/bench/src/workload.ts --repo /tmp/ft-w2/hono --tree &lt;checkout of hono HEAD&gt; --out packages/bench/data/hono-workload.json
FT_URL=&lt;your deployment&gt; FT_TOKEN=&lt;admin token&gt; node packages/bench/src/live.ts --colony bench-w2-load --agents 200 --duration 90 --out results/live-n200.json
FT_URL=&lt;your deployment&gt; FT_TOKEN=&lt;admin token&gt; node packages/bench/src/scenarios/batchcost.ts --colony bench-w2-load --sizes 2,10,25,50 --out results/batchcost.json
FT_URL=&lt;your deployment&gt; FT_TOKEN=&lt;admin token&gt; node packages/bench/src/scenarios/cascade.ts --colony bench-w2-cascade --readers 30 --out results/cascade.json
node packages/bench/src/sim/sweep.ts --mode live --agents 10,50,200,1000 --seeds 1,2,3 --out results/sim-live.json
node packages/bench/src/sim/sweep.ts --mode history --agents 10,100,1000,10000,100000 --seeds 1,2,3 --duration 1200 --warmup 300 --out results/sim-history.json
node packages/bench/src/sim/sweep.ts --mode history --agents 10,100,1000,10000,100000 --test-ms 30000 --out results/sim-history-test30s.json${
  group.length
    ? `
# group commit: same driver, intents topped up so the supply never runs out
FT_URL=&lt;your deployment&gt; FT_TOKEN=&lt;admin token&gt; node packages/bench/src/live.ts --colony g1-bench --agents 200 --duration 90 --intents 3000 --out results/${esc(groupName)}/live-n200.json`
    : ""
}${
  scale.length
    ? `
# scale: synthetic agents on a colony with review off (POST /api/colonies/&lt;colony&gt;/decide/policy {"enabled":false}) and a pre-forked pool
FT_URL=&lt;your deployment&gt; FT_TOKEN=&lt;admin token&gt; node packages/bench/src/live.ts --colony &lt;colony&gt; --agents 5000 --duration 120 --out results/${esc(scaleName)}/live-n5000.json`
    : ""
}
node packages/bench/src/report.ts packages/bench/results/2026-10-12${group.length ? ` packages/bench/results/${esc(groupName)}` : ""}${scale.length ? ` packages/bench/results/${esc(scaleName)}` : ""}</pre></div>

<p class="foot">Data: <code>live-n*.json</code>, <code>sim-live.json</code>, <code>sim-history.json</code>, <code>sim-history-test30s.json</code>, <code>cascade.json</code>, <code>batchcost.json</code>, <code>results.json</code> next to this page${group.length ? `; <code>../${esc(groupName)}/</code> (group commit)` : ""}${scale.length ? `; <code>../${esc(scaleName)}/</code> (scale runs, <code>notes-check.json</code>, <code>summary.json</code>)` : ""}. The production runs behind the README's results (Hono, a new project from a spec, an external agent over MCP, the vaccination meter) are in <code>../2026-10-12-prod/</code>. Code: <code>packages/bench</code>. Generated ${new Date().toISOString()}.</p>
</main>
</body>
</html>
`;
  writeFileSync(join(dir, "index.html"), html);

  // ---- Combined JSON -----------------------------------------------------
  const measuredRow = (r: LiveReport) => ({
    label: "MEASURED",
    agents: r.agents,
    landedPerMin: r.window.landedPerMin,
    commitsPerMin: r.window.commitsPerMin,
    batchMean: r.batchSize.mean,
    timeToLandP50S: (r.timeToLandMs.p50 ?? 0) / 1000,
    timeToLandP99S: (r.timeToLandMs.p99 ?? 0) / 1000,
    takeAssignedMs: { p50: r.takeAssigned.p50, p90: r.takeAssigned.p90, p99: r.takeAssigned.p99 },
    takeWaitMs: { p50: r.takeWait.p50, p99: r.takeWait.p99 },
    proposeMs: { p50: r.ops.find((o) => o.op === "propose")?.p50, p99: r.ops.find((o) => o.op === "propose")?.p99 },
    admissionWaits: Object.values(r.counts.waits).reduce((a, b) => a + b, 0),
    returned: r.counts.returned,
    returns: r.returns,
    calls: callCounts(r).calls,
    errors: callCounts(r).failed,
    stoppedEarly: r.stoppedEarly,
  });
  const combined = {
    generatedAt: new Date().toISOString(),
    ...(scale.length
      ? {
          measuredScale: {
            source: scaleName,
            note: "MEASURED on a preview deployment after the scale fixes: synthetic API agents (no model calls, no agent-side git, no work time), review layer off on the colony, 120 s runs, group commit on. Every landing is a real Artifacts commit. `errors` counts failed calls of that run.",
            runs: scale.map((r) => ({
              ...measuredRow(r),
              deployment: "preview",
              colony: r.colony,
              startedAt: r.startedAt,
              failedCallsLastAtS: lastFailureS(r),
              errorKinds: errorKinds(r),
              trunkCycles: r.trunkCycles ?? null,
            })),
            notesAudit: scaleNotes ? { colony: scaleNotes.colony, at: scaleNotes.at, ...scaleNotes.result } : null,
            nextLimit: nextLimitText(scale).replace(/<[^>]+>/g, ""),
          },
        }
      : {}),
    ...(group.length
      ? {
          measuredGroupCommit: {
            source: groupName,
            note: "MEASURED with trunk group commit built, before the scale fixes: same driver and workload as `measured`, on a preview deployment. `errors` counts failed calls of that run.",
            runs: group.map((r) => ({ ...measuredRow(r), deployment: "preview", colony: r.colony, startedAt: r.startedAt, trunkCycles: r.trunkCycles ?? null })),
          },
        }
      : {}),
    measured: live.map((r) => ({ ...measuredRow(r), deployment: "production", colony: r.colony, startedAt: r.startedAt })),
    simulatedLive: aggLive,
    simulatedHistory: aggHist,
    simulatedHistoryChecks30s: aggTest,
    cascade: cascade ? { region: cascade.region, shared: cascade.shared, readers: cascade.readers, returned: cascade.returned, sigmaMax: cascade.sigma.max, sigmaTrace: cascade.sigma.events, inhibition: cascade.inhibition, laneDelay: cascade.laneDelay, relandings: cascade.relandings } : null,
    batchCost: batch?.rows ?? null,
  };
  writeFileSync(join(dir, "results.json"), `${JSON.stringify(combined, null, 2)}\n`);
  console.log(`wrote ${join(dir, "index.html")} and results.json`);
}

main();
