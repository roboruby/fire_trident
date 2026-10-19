/**
 * One contention-scale run against a deployment (scenarios/contention-scale.ts is the command). On a colony it creates:
 *
 *   1. review off, and the generated repository (workload.ts) landed as inline changes of at most SEED_FILES files each
 *   2. N synthetic agents (no model, no git of their own) work the shuffled tasks. Each task's intent is declared
 *      already claimed by the agent that does it (assignedTo), so hundreds hold intents on the same hot file at once,
 *      past the admission and claim-lease exclusion that would otherwise keep them apart. The agent takes it (a lease on
 *      the current trunk), reads the files the task needs at the lease's base from a stock git mirror of the trunk
 *      (trunk.ts), makes the edit, and proposes it inline with what it read as its read set. When the change comes back
 *      (a stale read, a text merge conflict, review), the agent declares the same work again as a new intent placed with
 *      itself, takes it on a fresh lease of the current trunk, reads again and redoes the edit; the returned intent is
 *      left open and no agent takes it. A change closed as already on trunk is not redone, as the agent guides say.
 *   3. after the last task settles (or the timeout), the check (check.ts) reads the final trunk, its history and its
 *      lineage notes with stock git, and the colony's metrics are read again
 *   4. the colony is deleted, unless kept
 *
 * Synthetic agents call the REST API with the admin token; nothing here calls a model.
 */
import { blobId, changesetId, type FileVersion, type Intent, type Proposal, type WorkspaceLease } from "@fire_trident/core";
import { redact, type LiveConfig } from "../env.ts";
import { Client, LiveFeed, errorBackoffMs, errorDetail } from "../live.ts";
import { Recorder, quantile, summarize, type Summary } from "../stats.ts";
import { checkRun, landedProposals, type CheckReport, type ProposalRecord, type TaskRecord } from "./check.ts";
import type { TrunkReader } from "./trunk.ts";
import { describeTask, editFor, taskReads, taskWrites, type Task, type TaskKind, type Workload } from "./workload.ts";

/** What every proposal of the run says it did not verify. */
export const NOT_VERIFIED = "Not verified: a scripted edit by a synthetic agent of the contention-scale benchmark (no model); no tests run.";
/** The report's label and what it measured. */
export const CONTENTION_NOTE =
  "MEASURED, real landings: synthetic agents (no model) on a generated TypeScript repository whose hot files every agent edits; each intent placed with its agent (assignedTo), every change an inline change built from the hot file read at its lease's base with stock git, redone against the current trunk whenever it comes back.";
/** Files and bytes one seed change carries at most (the inline change limits are 64 files and 512 KB). */
export const SEED_FILES = 60;
export const SEED_BYTES = 400_000;
/** Proposal states after which an agent stops waiting (escalated: it would wait for a person the run does not provide). */
const FINAL = new Set(["landed", "returned", "rejected", "already_on_trunk", "escalated"]);
/** With the live feed, how long an agent waits for its outcome event before it asks the colony once. */
const FEED_FALLBACK_MS = 20_000;

type Assignment = { intent: Intent; lease: WorkspaceLease };
type TakeResult = Assignment | { wait: true; retryInMs: number; reason: string };

/** Options of one run (the workload's options are in the workload). */
export interface RunOptions {
  colony: string;
  agents: number;
  /** Agents start spread over this many seconds. */
  rampS: number;
  /** From the first agent's start: no new task or redo after this. */
  timeoutS: number;
  /** After the timeout, changes in flight are waited on this long. */
  drainS: number;
  /** The first gap between polls of a proposal when the live feed is not connected (it grows 1.6 times, to 15 s). */
  pollMs: number;
  /** Connect the live feed (outcomes and landing times); polls alone without it. */
  feed: boolean;
  /** Region depth of the colony it creates (2: each hot file and module group is its own region). */
  regionDepth: number;
  /** Workspaces the colony's pool keeps ready. */
  pool: number;
  /** Leave the colony (its agents stopped) instead of deleting it. */
  keep: boolean;
  /** Call timeout for one request. */
  callTimeoutMs: number;
}

/** What a run needs from outside: the deployment, the trunk reader, a parser for the check, a log. */
export interface RunDeps {
  cfg: LiveConfig;
  trunk: TrunkReader;
  parse: (path: string, text: string) => string | null;
  log: (line: string) => void;
}

/** Why a change came back, in four causes and a rest. */
export type ReturnCause = "stale-read" | "merge-conflict" | "review" | "megafile-hold" | "other";

/** The cause of a return or rejection, from its status and reason. */
export function classifyReturn(status: string, reason: string | undefined): ReturnCause {
  const r = (reason ?? "").toLowerCase();
  if (/text merge of .*conflicting hunk/.test(r)) return "merge-conflict";
  if (/is being split by intent/.test(r)) return "megafile-hold";
  if (status === "rejected" || /\breview|second opinion|reviewer|a person\b/.test(r)) return "review";
  if (r.startsWith("stale")) return "stale-read";
  return "other";
}

/** The inline proposal of one edit: what was read (path and the blob it held, null when absent) and the one file written. */
export function proposalBody(agentId: string, a: Assignment, reads: ReadonlyArray<{ path: string; text: string | null }>, edit: { path: string; text: string; detail: string }): Record<string, unknown> {
  const writeSet: FileVersion[] = [{ path: edit.path, blob: blobId(edit.text) }];
  return {
    intentId: a.intent.id,
    agentId,
    workspace: a.lease.repo,
    baseSha: a.lease.baseSha,
    headSha: changesetId(a.lease.baseSha, writeSet),
    writeSet,
    readSet: reads.map((r) => ({ path: r.path, blob: r.text === null ? null : blobId(r.text) })),
    contents: { [writeSet[0]!.blob!]: edit.text },
    declared: { footprint: [edit.path], summary: edit.detail },
    evidence: { checks: [], notVerified: NOT_VERIFIED },
  };
}

/** The seed as inline changes: files in path order, at most SEED_FILES files and SEED_BYTES bytes each, the last file last. */
export function seedChanges(files: ReadonlyArray<{ path: string; text: string }>): Array<Array<{ path: string; text: string }>> {
  const out: Array<Array<{ path: string; text: string }>> = [];
  let cur: Array<{ path: string; text: string }> = [];
  let bytes = 0;
  for (const f of files) {
    const size = Buffer.byteLength(f.text);
    if (cur.length > 0 && (cur.length >= SEED_FILES || bytes + size > SEED_BYTES)) {
      out.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(f);
    bytes += size;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

/** The whole report of one run (every number the README quotes). */
export interface ContentionReport {
  kind: "contention-scale";
  label: "MEASURED";
  note: string;
  url: string;
  build: string | null;
  flags: string[];
  colony: string;
  startedAt: string;
  finishedAt: string;
  options: Workload["options"] & Omit<RunOptions, "colony" | "keep" | "feed" | "pollMs" | "callTimeoutMs">;
  seed: { files: number; changes: number; bytes: number; ms: number; trunkSha: string | null };
  run: {
    agentsJoined: number;
    tasks: number;
    byKind: Record<TaskKind, number>;
    /** How the tasks ended for the agents. */
    ends: Record<string, number>;
    landedTasks: number;
    proposals: number;
    landedProposals: number;
    /** Trunk commits whose lineage note names this run's changes, and the changes they name. */
    commits: number;
    changesInNotes: number;
    /** Where the commits' times came from: the live feed (ms) or git's commit times (whole seconds). */
    timesFrom: { feed: number; git: number };
    firstLandingAt: string | null;
    lastLandingAt: string | null;
    spanS: number | null;
    landingsPerMin: number | null;
    changesPerMin: number | null;
    /** From the first agent's start to the last task settling. */
    wallS: number;
    /** Changes whose outcome came after their agent stopped waiting, read from the colony once at the end. */
    lateOutcomes: number;
    stoppedEarly: string | null;
  };
  /** From propose to landed, per landed proposal (the colony's clock; the agent's when the feed missed the landing). */
  timeToLandMs: Summary;
  timeToLandP95Ms: number | null;
  /** From a task's first proposal to its landing, rounds included. */
  taskTimeToLandMs: Summary;
  taskTimeToLandP95Ms: number | null;
  returns: { total: number; byCause: Record<ReturnCause, number>; byKind: Record<TaskKind, Record<ReturnCause, number>> };
  /** Proposals each landed task took. */
  rounds: { median: number | null; p95: number | null; max: number | null; histogram: Record<string, number> };
  /** Agents holding an assignment at once, and tasks on one hot file held at once. */
  holders: { peak: number; peakOneHot: number; peakPerHot: number[] };
  takes: { assigned: number; waits: Record<string, number>; lostAssignments: number; intentsDeclared: number; intentsLeftOpen: number };
  reads: { gitFetches?: { count: number; failed: number; ms: number }; readWaits: number };
  outcomes: { feed: number; poll: number };
  ops: Array<{ op: string; calls: number; errors: number } & Summary>;
  timeline: Array<{ s: number; holders: number; landed: number; returned: number }>;
  /** The colony's own metrics before the agents started and after the check, and the difference. */
  metrics: { before: Record<string, number> | null; after: Record<string, number> | null; delta: Record<string, number> };
  certification: { start: unknown; end: unknown };
  check: CheckReport | null;
  /** Every task: how it ended, its proposals, the one that landed (to audit against the lineage notes) and why the others came back. */
  tasks: Array<{ id: string; kind: TaskKind; hot: number; end: string; proposals: number; landed: string | null; returns?: Partial<Record<ReturnCause, number>> }>;
  checkError?: string;
  /** The colony at the end: deleted, or kept with its agents stopped. */
  cleanup: { deleted: boolean; kept: boolean; detail: string };
  errors: string[];
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, Math.max(0, ms)));

function isRecord(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === "object" && !Array.isArray(x);
}

/** Only the plain values of an object (no texts of files, no nested records): what the report keeps of a certification. */
function plain(x: unknown): Record<string, string | number | boolean | null> | null {
  if (!isRecord(x)) return null;
  return Object.fromEntries(Object.entries(x).filter(([, v]) => v === null || ["string", "number", "boolean"].includes(typeof v))) as Record<string, string | number | boolean | null>;
}

const cause0 = (): Record<ReturnCause, number> => ({ "stale-read": 0, "merge-conflict": 0, review: 0, "megafile-hold": 0, other: 0 });

/** One admin request with its HTTP status (0 when nothing came back) and JSON body. */
async function request(cfg: LiveConfig, method: "GET" | "POST" | "DELETE", path: string, body?: unknown, timeoutMs = 120_000): Promise<{ status: number; data: unknown; error?: string }> {
  const headers: Record<string, string> = { accept: "application/json", "user-agent": "ft-bench-contention/0.0.1", ...(cfg.headers ?? {}) };
  if (cfg.token) headers.authorization = `Bearer ${cfg.token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  try {
    const res = await fetch(`${cfg.url}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text.slice(0, 200);
    }
    return { status: res.status, data };
  } catch (e) {
    return { status: 0, data: null, error: redact(errorDetail(e)) };
  }
}

const problem = (r: { status: number; data: unknown; error?: string }): string =>
  r.error ?? `HTTP ${r.status}${isRecord(r.data) && typeof r.data.error === "string" ? `: ${r.data.error.slice(0, 200)}` : ""}`;

/** The flags GET /api/about lists and the build it names. Throws when it does not answer. */
export async function about(cfg: LiveConfig): Promise<{ flags: string[]; build: string | null }> {
  const r = await request(cfg, "GET", "/api/about", undefined, 30_000);
  if (r.status !== 200 || !isRecord(r.data)) throw new Error(`GET /api/about did not answer (${problem(r)}), so the run cannot read the deployment's flags`);
  return { flags: Array.isArray(r.data.flags) ? r.data.flags.filter((f): f is string => typeof f === "string").sort() : [], build: typeof r.data.commit === "string" ? r.data.commit : null };
}

/** Flags the run needs on, and flags whose absence or presence changes what it measures (said in the log and the README). */
export const REQUIRED_FLAGS: Readonly<Record<string, string>> = { FT_INLINE: "the seed and every change are inline changes" };
export const WANTED_FLAGS: Readonly<Record<string, string>> = {
  FT_TEXT_MERGE: "without text merge every change that finds its hot file moved goes back stale, however far apart the edits",
  FT_MERGE_INSERTIONS: "without the insertion rule two registers inserting at the same place conflict",
};
export const NOTED_FLAGS: Readonly<Record<string, string>> = {
  FT_MEGAFILE: "the megafile alarm may hold a hot file for a split no agent takes: changes to it then go back until the hold lifts",
  FT_ASYNC_PUBLISH: "with asynchronous publishing a take on a hot file waits for publishing and can lose its assignment",
  FT_ALREADY_ON_TRUNK: "an increment whose edit merges into an identical one closes as already on trunk instead of landing an empty change",
  FT_PRELAND: "tests run before each landing",
  FT_TRUNK_TESTS: "trunk certification runs the generated test after landings",
};

/** Run the scenario. Throws (with the colony deleted unless kept) when a step before the agents cannot be done. */
export async function runContention(w: Workload, opts: RunOptions, deps: RunDeps): Promise<ContentionReport> {
  const { cfg, trunk, log } = deps;
  const startedAt = new Date().toISOString();
  const rec = new Recorder();
  const client = new Client(cfg, opts.colony, rec, opts.callTimeoutMs);
  const { flags, build } = await about(cfg);
  const missing = Object.keys(REQUIRED_FLAGS).filter((f) => !flags.includes(f));
  if (missing.length > 0) throw new Error(missing.map((f) => `${f} is not on in /api/about, and ${REQUIRED_FLAGS[f]}`).join("; "));
  for (const [f, why] of Object.entries(WANTED_FLAGS)) if (!flags.includes(f)) log(`note: ${f} is off: ${why}`);
  for (const [f, why] of Object.entries(NOTED_FLAGS)) if (flags.includes(f)) log(`note: ${f} is on (for some colony): ${why}`);
  log(`deployment build ${build ?? "unknown"}; flags on: ${flags.join(", ") || "none"}`);

  const made = await request(cfg, "POST", "/api/colonies", { name: opts.colony, regionDepth: opts.regionDepth, poolTarget: opts.pool }, 600_000);
  if (made.status === 409) throw new Error(`colony ${opts.colony} already exists: pass --colony with a new name, or delete it first`);
  if (made.status !== 201 && made.status !== 200) throw new Error(`could not create colony ${opts.colony}: ${problem(made)}`);
  log(`created colony ${opts.colony} (region depth ${opts.regionDepth}, pool ${opts.pool})`);
  let cleanup: ContentionReport["cleanup"] = { deleted: false, kept: opts.keep, detail: "" };
  const feed = new LiveFeed();
  try {
    const policy = await request(cfg, "POST", `/api/colonies/${opts.colony}/decide/policy`, { enabled: false });
    if (policy.status !== 200) throw new Error(`could not turn review off for ${opts.colony}: ${problem(policy)}`);
    if (opts.feed) {
      await feed.connect(cfg, opts.colony);
      log(`live feed ${feed.open ? "connected" : "NOT connected: outcomes come from polling"}`);
    }
    const via = { feed: 0, poll: 0 };
    const waitOutcome = async (id: string, untilMs: number): Promise<{ status: string; reason?: string } | null> => {
      let last: Proposal | null = null;
      let gap = opts.pollMs;
      while (Date.now() < untilMs) {
        if (feed.open) {
          const got = await feed.waitFor(id, Math.min(FEED_FALLBACK_MS, untilMs - Date.now()));
          if (got) {
            via.feed++;
            return got;
          }
        } else {
          await sleep(Math.min(gap, untilMs - Date.now()));
          gap = Math.min(15_000, Math.round(gap * 1.6));
        }
        const p = await client.call<Proposal>("poll", "GET", `/proposals/${encodeURIComponent(id)}`);
        if (p) {
          last = p;
          if (FINAL.has(p.status)) {
            via.poll++;
            return p.reason ? { status: p.status, reason: p.reason } : { status: p.status };
          }
        }
      }
      return last ? { status: last.status } : null;
    };

    // 1. The seed, as inline changes by one scripted agent.
    const seedT0 = Date.now();
    const seedAgent = await client.call<{ id: string }>("register", "POST", "/agents", { name: `contention-scale-seed`, kind: "synthetic" });
    if (!seedAgent?.id) throw new Error(`the seed agent could not register: ${rec.errorSamples.join("; ")}`);
    const changes = seedChanges(w.files);
    let seedSha: string | null = null;
    for (const [i, files] of changes.entries()) {
      const intent = await client.call<Intent>("intent", "POST", "/intents", {
        title: `contention-scale: seed ${i + 1} of ${changes.length} (${files.length} files)`,
        why: "The generated repository the contention-scale benchmark's agents edit.",
        footprint: files.map((f) => f.path),
        assignedTo: seedAgent.id,
        createdBy: "contention-scale",
        force: true,
      });
      if (!intent?.id) throw new Error(`the seed intent could not be declared: ${rec.errorSamples.join("; ")}`);
      let took: Assignment | null = null;
      for (let attempt = 0; attempt < 60 && !took; attempt++) {
        const t = await client.call<TakeResult>("take", "POST", `/agents/${seedAgent.id}/take`, {});
        if (t && !("wait" in t)) took = t;
        else await sleep(Math.min(3_000, Math.max(250, t && "wait" in t ? t.retryInMs : 1_000)));
      }
      if (!took || took.intent.id !== intent.id) throw new Error(`the seed agent was not handed its intent ${intent.id}`);
      trunk.setAuth?.({ remote: took.lease.trunk.remote, token: took.lease.trunk.token });
      const writeSet: FileVersion[] = files.map((f) => ({ path: f.path, blob: blobId(f.text) }));
      const proposal = await request(cfg, "POST", `/api/colonies/${opts.colony}/proposals`, {
        intentId: intent.id,
        agentId: seedAgent.id,
        workspace: took.lease.repo,
        baseSha: took.lease.baseSha,
        headSha: changesetId(took.lease.baseSha, writeSet),
        writeSet,
        readSet: [],
        contents: Object.fromEntries(files.map((f) => [blobId(f.text), f.text])),
        declared: { footprint: files.map((f) => f.path), summary: `seed ${i + 1} of ${changes.length}` },
        evidence: { checks: [], notVerified: NOT_VERIFIED },
      });
      if (proposal.status === 409) throw new Error(`the colony refuses inline changes (FT_INLINE must list ${opts.colony} or be on): ${problem(proposal)}`);
      const p = proposal.data as Proposal | null;
      if ((proposal.status !== 201 && proposal.status !== 200) || !p?.id) throw new Error(`the seed proposal failed: ${problem(proposal)}`);
      const done = FINAL.has(p.status) ? p : await waitOutcome(p.id, Date.now() + 180_000);
      if (done?.status !== "landed") throw new Error(`seed change ${i + 1} did not land: ${done?.status ?? "no outcome in 180 s"} ${done?.reason ?? ""}`);
      seedSha = feed.landings.find((l) => l.proposalIds.includes(p.id))?.trunkSha ?? seedSha;
    }
    // The seeded trunk, read with git: the last seed landing's commit when the feed named it, else main's head, read
    // again (for at most two minutes) until git serves the whole seed, as it does once publishing caught up.
    let head = seedSha ?? (await trunk.refresh());
    for (const until = Date.now() + 120_000; ; ) {
      const tree = head && (await trunk.ensure(head, 30_000)) ? await trunk.tree(head) : null;
      const differ = tree ? w.files.filter((f) => tree.get(f.path) !== f.text).map((f) => f.path) : null;
      if (tree && differ && differ.length === 0 && tree.size === w.files.length) break;
      if (Date.now() >= until) {
        throw new Error(tree ? `the seeded trunk differs from the seed (${differ!.slice(0, 3).join(", ") || `${tree.size} files, not ${w.files.length}`})` : "the seeded trunk could not be read with git");
      }
      await sleep(2_000);
      head = (await trunk.refresh()) ?? head;
    }
    if (!head) throw new Error("the seeded trunk could not be read with git");
    const seed = { files: w.files.length, changes: changes.length, bytes: w.files.reduce((s, f) => s + Buffer.byteLength(f.text), 0), ms: Date.now() - seedT0, trunkSha: head };
    log(`seeded ${seed.files} files in ${seed.changes} landings (${(seed.ms / 1000).toFixed(1)} s) at ${head.slice(0, 12)}`);

    const certStart = await request(cfg, "GET", `/api/colonies/${opts.colony}/certifications?limit=1`, undefined, 30_000);
    const before = await client.call<{ metrics?: Record<string, number> }>("metrics", "GET", "/metrics");

    // 2. The agents.
    const records: TaskRecord[] = w.tasks.map((task) => ({ task, intents: [], proposals: [], end: "not-started" }));
    const modules = w.options.modules;
    const t0 = Date.now();
    const deadline = t0 + opts.timeoutS * 1000;
    const drainUntil = deadline + opts.drainS * 1000;
    let stop = false;
    let stoppedEarly: string | null = null;
    let cursor = 0;
    let joined = 0;
    let assigned = 0;
    let lostAssignments = 0;
    let readWaits = 0;
    let declared = 0;
    const waits: Record<string, number> = {};
    const clientTimes = new Map<string, { proposedAt: number; seenAt?: number }>();
    const holders = { now: 0, peak: 0, perHot: new Array<number>(w.options.hot).fill(0), peakPerHot: new Array<number>(w.options.hot).fill(0) };
    const count = { landed: 0, returned: 0 };
    const hold = (t: Task, d: 1 | -1): void => {
      holders.now += d;
      holders.perHot[t.hot]! += d;
      holders.peak = Math.max(holders.peak, holders.now);
      holders.peakPerHot[t.hot] = Math.max(holders.peakPerHot[t.hot]!, holders.perHot[t.hot]!);
    };
    const timeline: ContentionReport["timeline"] = [];
    const sampler = setInterval(() => timeline.push({ s: Math.round((Date.now() - t0) / 1000), holders: holders.now, landed: count.landed, returned: count.returned }), 1_000);
    const progress = setInterval(() => {
      log(`${Math.round((Date.now() - t0) / 1000)} s: ${count.landed} of ${records.length} tasks landed, ${count.returned} changes back, ${holders.now} holding (peak ${holders.peak}), ${client.failures} failed calls`);
    }, 10_000);
    let lastCalls = 0;
    let lastFailures = 0;
    const guard = setInterval(() => {
      const calls = client.calls - lastCalls;
      const fails = client.failures - lastFailures;
      lastCalls = client.calls;
      lastFailures = client.failures;
      if (calls >= 50 && fails / calls > 0.25 && !stop) {
        stop = true;
        stoppedEarly = `error rate ${((fails / calls) * 100).toFixed(0)}% over 5 s at ${Math.round((Date.now() - t0) / 1000)} s`;
        log(`stopping early: ${stoppedEarly}`);
      }
    }, 5_000);

    const declare = async (agentId: string, r: TaskRecord): Promise<string | null> => {
      const round = r.proposals.length + 1;
      const intent = await client.call<Intent>("intent", "POST", "/intents", {
        title: `contention-scale ${r.task.id}${round > 1 ? ` (round ${round})` : ""}: ${describeTask(r.task, modules)}`,
        why: `Contention-scale benchmark task ${r.task.id} (${r.task.kind}).`,
        footprint: [taskWrites(r.task, modules)],
        assignedTo: agentId,
        createdBy: "contention-scale",
        force: true,
      });
      if (!intent?.id) return null;
      declared++;
      r.intents.push(intent.id);
      return intent.id;
    };

    /** One agent works one task until it lands, closes, or the run ends. */
    const work = async (agentId: string, r: TaskRecord, beat: { at: number }): Promise<void> => {
      r.end = "unresolved";
      let held: string | null = null;
      let failures = 0;
      while (!stop && Date.now() < deadline) {
        if (!held) {
          held = await declare(agentId, r);
          if (!held) {
            await sleep(errorBackoffMs(++failures));
            continue;
          }
        }
        const t = await client.call<TakeResult>("take", "POST", `/agents/${agentId}/take`, {});
        if (!t) {
          await sleep(errorBackoffMs(++failures));
          continue;
        }
        if ("wait" in t) {
          // Counted by reason, with the paths a reason names left out so the same reason adds up.
          const why = t.reason.replace(/\S*\/\S+/g, "<path>");
          waits[why] = (waits[why] ?? 0) + 1;
          // A wait after the colony began leasing gives the intent back (open): declare the work again.
          const row = await client.call<Intent>("intent", "GET", `/intents/${encodeURIComponent(held)}`);
          if (row && (row.status !== "claimed" || row.assignedTo !== agentId)) {
            lostAssignments++;
            held = null;
          }
          await sleep(Math.min(5_000, Math.max(200, t.retryInMs)));
          continue;
        }
        if (t.intent.id !== held) {
          rec.error("take", 0, `handed ${t.intent.id}, not the intent ${held} placed with it`);
          held = null;
          continue;
        }
        failures = 0;
        assigned++;
        if (t.lease?.trunk?.remote) trunk.setAuth?.({ remote: t.lease.trunk.remote, token: t.lease.trunk.token });
        if (Date.now() - beat.at > 45_000) {
          beat.at = Date.now();
          await client.call("heartbeat", "POST", `/agents/${agentId}/heartbeat`, {});
        }
        hold(r.task, 1);
        try {
          const base = t.lease.baseSha;
          if (!(await trunk.ensure(base, 60_000))) {
            readWaits++;
            continue;
          }
          const paths = taskReads(r.task, modules);
          const texts = await Promise.all(paths.map((p) => trunk.read(base, p)));
          const edit = editFor(r.task, new Map(paths.map((p, i) => [p, texts[i] ?? null])), modules);
          if ("nothing" in edit) {
            r.end = "present";
            return;
          }
          const body = proposalBody(agentId, t, paths.map((p, i) => ({ path: p, text: texts[i] ?? null })), edit);
          const proposedAt = Date.now();
          const p = await client.call<Proposal>("propose", "POST", "/proposals", body);
          if (!p?.id) {
            if (++failures >= 6) return;
            await sleep(errorBackoffMs(failures));
            continue;
          }
          const pr: ProposalRecord = { id: p.id, round: r.proposals.length + 1, status: p.status, createdAt: p.createdAt, ...(edit.value !== undefined ? { value: edit.value } : {}) };
          r.proposals.push(pr);
          clientTimes.set(p.id, { proposedAt });
          const done = FINAL.has(p.status) ? (p.reason ? { status: p.status, reason: p.reason } : { status: p.status }) : await waitOutcome(p.id, drainUntil);
          clientTimes.get(p.id)!.seenAt = Date.now();
          pr.status = done?.status ?? "unresolved";
          if (done?.reason) pr.reason = done.reason;
          if (pr.status === "landed") {
            count.landed++;
            r.end = "landed";
            return;
          }
          if (pr.status === "already_on_trunk") {
            r.end = "on-trunk";
            return;
          }
          if (pr.status === "returned" || pr.status === "rejected") {
            count.returned++;
            held = null;
            // A megafile hold lasts until a split lands, and no agent of this run takes the split: redoing cannot land.
            if (classifyReturn(pr.status, pr.reason) === "megafile-hold") return;
            continue;
          }
          return;
        } catch (e) {
          rec.error("edit", 0, redact(errorDetail(e)));
          await sleep(errorBackoffMs(++failures));
          if (failures >= 6) return;
        } finally {
          hold(r.task, -1);
        }
      }
    };

    const agent = async (i: number): Promise<void> => {
      await sleep(opts.agents > 1 ? (i * opts.rampS * 1000) / opts.agents : 0);
      let id: string | null = null;
      for (let attempt = 1; attempt <= 5 && !id && !stop; attempt++) {
        const reg = await client.call<{ id: string }>("register", "POST", "/agents", { name: `contention-scale-${i + 1}`, kind: "synthetic" });
        if (reg?.id) id = reg.id;
        else await sleep(errorBackoffMs(attempt));
      }
      if (!id) return;
      joined++;
      const beat = { at: Date.now() };
      while (!stop && Date.now() < deadline && cursor < records.length) await work(id, records[cursor++]!, beat);
    };
    log(`${opts.agents} agents on ${records.length} tasks (ramp ${opts.rampS} s, timeout ${opts.timeoutS} s)`);
    await Promise.all(Array.from({ length: opts.agents }, (_, i) => agent(i)));
    const wallS = (Date.now() - t0) / 1000;
    clearInterval(sampler);
    clearInterval(progress);
    clearInterval(guard);
    log(`agents done after ${wallS.toFixed(1)} s: ${count.landed} of ${records.length} tasks landed, ${count.returned} changes came back`);
    await sleep(1_500);
    // A change whose outcome its agent did not see before the drain ended: ask the colony once for its final word.
    let lateOutcomes = 0;
    for (const r of records) {
      const p = r.proposals.at(-1);
      if (!p || FINAL.has(p.status)) continue;
      const now = await client.call<Proposal>("poll", "GET", `/proposals/${encodeURIComponent(p.id)}`);
      if (!now || !FINAL.has(now.status)) continue;
      lateOutcomes++;
      p.status = now.status;
      if (now.reason) p.reason = now.reason;
      if (now.status === "landed") r.end = "landed";
      else if (now.status === "already_on_trunk") r.end = "on-trunk";
    }
    if (lateOutcomes > 0) log(`${lateOutcomes} changes settled after their agents stopped waiting`);

    // 3. Wait (at most two minutes) until every change the agents saw land is in a lineage note on the trunk git serves.
    const seenLanded = new Set(records.flatMap((r) => r.proposals.filter((p) => p.status === "landed").map((p) => p.id)));
    let finalHead: string | null = null;
    let history = await trunk.history().catch(() => []);
    for (const until = Date.now() + 120_000; ; ) {
      finalHead = await trunk.refresh();
      history = await trunk.history().catch(() => history);
      const noted = landedProposals(history);
      const missingNotes = [...seenLanded].filter((id) => !noted.has(id)).length;
      if (missingNotes === 0 || Date.now() >= until) {
        if (missingNotes > 0) log(`${missingNotes} landed changes are still in no lineage note on trunk after two minutes`);
        break;
      }
      await sleep(3_000);
    }
    let check: CheckReport | null = null;
    let checkError: string | undefined;
    try {
      if (!finalHead) throw new Error("the final trunk could not be read with git");
      const files = await trunk.tree(finalHead);
      check = await checkRun({
        workload: w,
        head: finalHead,
        files,
        history,
        records,
        readAt: async (sha, path) => ((await trunk.ensure(sha, 30_000)) ? trunk.read(sha, path) : null),
        parse: deps.parse,
      });
      for (const c of check.checks) log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}: ${c.summary}`);
    } catch (e) {
      checkError = redact(errorDetail(e));
      log(`the check could not run: ${checkError}`);
    }
    const after = await client.call<{ metrics?: Record<string, number> }>("metrics", "GET", "/metrics");
    const certEnd = await request(cfg, "GET", `/api/colonies/${opts.colony}/certifications?limit=1`, undefined, 30_000);
    feed.close();

    // Numbers. The commits come from the lineage notes; their times from the live feed (the colony's clock, in ms), else
    // from git's commit times (whole seconds).
    const runIds = new Set(records.flatMap((r) => r.proposals.map((p) => p.id)));
    const noted = landedProposals(history);
    const feedAt = new Map<string, number>();
    for (const l of feed.landings) if (l.trunkSha) feedAt.set(l.trunkSha, l.at);
    const commitAt = new Map(history.map((c) => [c.sha, c.at]));
    const runCommits = new Map<string, number | undefined>();
    const landingAt = new Map<string, number>();
    let changesNoted = 0;
    const timesFrom = { feed: 0, git: 0 };
    for (const id of runIds) {
      for (const l of noted.get(id) ?? []) {
        changesNoted++;
        const at = feedAt.get(l.commit) ?? commitAt.get(l.commit);
        runCommits.set(l.commit, at);
        if (at !== undefined) landingAt.set(id, at);
      }
    }
    for (const at of runCommits.keys()) {
      if (feedAt.has(at)) timesFrom.feed++;
      else if (commitAt.get(at) !== undefined) timesFrom.git++;
    }
    // Feed landings the notes do not have yet (none, once the notes caught up) still give their proposals a time.
    for (const l of feed.landings) for (const id of l.proposalIds) if (runIds.has(id) && !landingAt.has(id)) landingAt.set(id, l.at);
    const ttl: number[] = [];
    for (const r of records) {
      for (const p of r.proposals) {
        if (p.status !== "landed") continue;
        const at = landingAt.get(p.id);
        if (at !== undefined) p.landedAt = at;
        const c = clientTimes.get(p.id);
        if (at !== undefined && typeof p.createdAt === "number") ttl.push(at - p.createdAt);
        else if (c?.seenAt !== undefined) ttl.push(c.seenAt - c.proposedAt);
      }
    }
    const taskTtl: number[] = [];
    for (const r of records) {
      const opened = r.proposals[0];
      const closed = r.proposals.at(-1);
      if (r.end !== "landed" || !opened || !closed) continue;
      const fc = clientTimes.get(opened.id);
      const lc = clientTimes.get(closed.id);
      if (closed.landedAt !== undefined && typeof opened.createdAt === "number") taskTtl.push(closed.landedAt - opened.createdAt);
      else if (fc && lc?.seenAt !== undefined) taskTtl.push(lc.seenAt - fc.proposedAt);
    }
    const times = [...runCommits.values()].filter((t): t is number => t !== undefined);
    const first = times.length > 0 ? Math.min(...times) : null;
    const last = times.length > 0 ? Math.max(...times) : null;
    const spanMs = first !== null && last !== null && last > first ? last - first : null;
    const landedCount = records.reduce((s, r) => s + r.proposals.filter((p) => p.status === "landed").length, 0);
    const returns: ContentionReport["returns"] = { total: 0, byCause: cause0(), byKind: { register: cause0(), increment: cause0(), "read-own": cause0() } };
    for (const r of records) {
      for (const p of r.proposals) {
        if (p.status !== "returned" && p.status !== "rejected") continue;
        const c = classifyReturn(p.status, p.reason);
        returns.total++;
        returns.byCause[c]++;
        returns.byKind[r.task.kind][c]++;
      }
    }
    const rounds = records.filter((r) => r.end === "landed").map((r) => r.proposals.length).sort((a, b) => a - b);
    const histogram: Record<string, number> = {};
    for (const n of rounds) histogram[String(n)] = (histogram[String(n)] ?? 0) + 1;
    const ends: Record<string, number> = {};
    for (const r of records) ends[r.end] = (ends[r.end] ?? 0) + 1;
    const byKind = { register: 0, increment: 0, "read-own": 0 } as Record<TaskKind, number>;
    for (const r of records) byKind[r.task.kind]++;
    const delta: Record<string, number> = {};
    for (const [k, v] of Object.entries(after?.metrics ?? {})) {
      const b = before?.metrics?.[k];
      if (typeof v === "number") delta[k] = v - (typeof b === "number" ? b : 0);
    }
    // Every change that came back reopened its intent, and so did every take that lost its assignment: the work was declared again.
    const intentsLeftOpen = returns.total + lostAssignments;

    // 4. Cleanup.
    cleanup = await finish(cfg, opts, log);
    return {
      kind: "contention-scale",
      label: "MEASURED",
      note: CONTENTION_NOTE,
      url: cfg.url,
      build,
      flags,
      colony: opts.colony,
      startedAt,
      finishedAt: new Date().toISOString(),
      options: { ...w.options, agents: opts.agents, rampS: opts.rampS, timeoutS: opts.timeoutS, drainS: opts.drainS, regionDepth: opts.regionDepth, pool: opts.pool },
      seed,
      run: {
        agentsJoined: joined,
        tasks: records.length,
        byKind,
        ends,
        landedTasks: records.filter((r) => r.end === "landed").length,
        proposals: records.reduce((s, r) => s + r.proposals.length, 0),
        landedProposals: landedCount,
        commits: runCommits.size,
        changesInNotes: changesNoted,
        timesFrom,
        firstLandingAt: first !== null ? new Date(first).toISOString() : null,
        lastLandingAt: last !== null ? new Date(last).toISOString() : null,
        spanS: spanMs !== null ? spanMs / 1000 : null,
        landingsPerMin: spanMs !== null ? runCommits.size / (spanMs / 60_000) : null,
        changesPerMin: spanMs !== null ? changesNoted / (spanMs / 60_000) : null,
        wallS,
        lateOutcomes,
        stoppedEarly,
      },
      timeToLandMs: summarize(ttl),
      timeToLandP95Ms: quantile([...ttl].sort((a, b) => a - b), 0.95),
      taskTimeToLandMs: summarize(taskTtl),
      taskTimeToLandP95Ms: quantile([...taskTtl].sort((a, b) => a - b), 0.95),
      returns,
      rounds: { median: quantile(rounds, 0.5), p95: quantile(rounds, 0.95), max: rounds.at(-1) ?? null, histogram },
      holders: { peak: holders.peak, peakOneHot: Math.max(0, ...holders.peakPerHot), peakPerHot: holders.peakPerHot },
      takes: { assigned, waits, lostAssignments, intentsDeclared: declared, intentsLeftOpen },
      reads: { ...(fetchStats(trunk) ? { gitFetches: fetchStats(trunk)! } : {}), readWaits },
      outcomes: via,
      ops: rec.ops().map((op) => ({ op, calls: rec.summary(op).n, errors: rec.errors(op), ...rec.summary(op) })),
      timeline,
      metrics: { before: before?.metrics ?? null, after: after?.metrics ?? null, delta },
      certification: { start: certState(certStart.data), end: certState(certEnd.data) },
      check,
      ...(checkError ? { checkError } : {}),
      tasks: records.map((r) => {
        const back: Partial<Record<ReturnCause, number>> = {};
        for (const p of r.proposals) if (p.status === "returned" || p.status === "rejected") back[classifyReturn(p.status, p.reason)] = (back[classifyReturn(p.status, p.reason)] ?? 0) + 1;
        return {
          id: r.task.id,
          kind: r.task.kind,
          hot: r.task.hot,
          end: r.end,
          proposals: r.proposals.length,
          landed: r.proposals.find((p) => p.status === "landed")?.id ?? null,
          ...(Object.keys(back).length > 0 ? { returns: back } : {}),
        };
      }),
      cleanup,
      errors: rec.errorSamples,
    };
  } catch (e) {
    feed.close();
    cleanup = await finish(cfg, opts, log);
    throw e;
  }
}

/** A certification listing as the report keeps it: whether it is on, and the plain fields of the newest result. */
function certState(data: unknown): unknown {
  if (!isRecord(data)) return null;
  const latest = Array.isArray(data.results) ? plain(data.results[0]) : null;
  return { on: data.on ?? null, latest };
}

function fetchStats(trunk: TrunkReader): { count: number; failed: number; ms: number } | null {
  const f = (trunk as { fetches?: { count: number; failed: number; ms: number } }).fetches;
  return f ? { count: f.count, failed: f.failed, ms: Math.round(f.ms) } : null;
}

/** Delete the colony (a few tries: a large one can take more than one call), or with --keep stop its agents. */
async function finish(cfg: LiveConfig, opts: RunOptions, log: (s: string) => void): Promise<ContentionReport["cleanup"]> {
  if (opts.keep) {
    const s = await request(cfg, "POST", `/api/colonies/${opts.colony}/swarm/stop`, { reason: "contention-scale run over" }, 300_000);
    const detail = s.status === 200 ? "kept; its agents were stopped" : `kept; stopping its agents failed (${problem(s)})`;
    log(`colony ${opts.colony} ${detail}`);
    return { deleted: false, kept: true, detail };
  }
  let last = "";
  for (let attempt = 1; attempt <= 4; attempt++) {
    const d = await request(cfg, "DELETE", `/api/colonies/${opts.colony}`, undefined, 600_000);
    if (d.status === 200) {
      log(`deleted colony ${opts.colony}`);
      return { deleted: true, kept: false, detail: "deleted" };
    }
    last = problem(d);
    await sleep(5_000 * attempt);
  }
  log(`could not delete colony ${opts.colony}: ${last}; delete it by hand`);
  return { deleted: false, kept: false, detail: `delete failed: ${last}` };
}
