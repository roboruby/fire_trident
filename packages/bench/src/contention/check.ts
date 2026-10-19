/**
 * The contention-scale correctness check: after a run, from the final trunk and its lineage notes (read with stock git,
 * trunk.ts), and from what the agents saw (run.ts), decide whether every landed change is on trunk exactly as it should
 * be. Each check names what it found and up to EXAMPLES instances of each failure. The file reads go through injected
 * functions, so the check runs the same on a fake trunk in tests. No model, no clock.
 */
import { blobId, type FileVersion } from "@fire_trident/core";
import { counterValue, hotPath, modulePath, registryEntries, seenName, seenValue, type Task, type Workload } from "./workload.ts";

/** Failures named per check at most. */
export const EXAMPLES = 10;

/** A trunk commit as stock git shows it: its first parent, its lineage note's text (null: no note) and its commit time (ms). */
export interface TrunkCommit {
  sha: string;
  parent: string | null;
  note: string | null;
  at?: number;
}

/** One proposal a lineage note says landed: the commit, its parent, its place in the note, and what it read and wrote. */
export interface LandedProposal {
  proposalId: string;
  commit: string;
  parent: string | null;
  /** Its position among the proposals of its commit's note (the order the trunk writer applied them). */
  index: number;
  readSet: FileVersion[];
  writeSet: FileVersion[];
  /** Files it landed merged line by line, with the rule that merged them when one beyond git's did. */
  merged: Array<{ path: string; rule?: string }>;
}

/** What the agents saw of one proposal. */
export interface ProposalRecord {
  id: string;
  round: number;
  status: string;
  reason?: string;
  /** The colony's time the proposal was made, and the landing's time when it landed (from the live feed). */
  createdAt?: number;
  landedAt?: number;
  /** The value an increment wrote, or the registry length a read-own copied. */
  value?: number;
}

/** How a task ended for the agents: landed, closed as already on trunk, found done when redone, never resolved, never started. */
export type TaskEnd = "landed" | "on-trunk" | "present" | "unresolved" | "not-started";

/** What the agents did for one task. */
export interface TaskRecord {
  task: Task;
  /** Intents declared for it, in order (one per round, and again after a take lost its assignment). */
  intents: string[];
  proposals: ProposalRecord[];
  end: TaskEnd;
}

/** One check's result. */
export interface Check {
  name: string;
  ok: boolean;
  /** One sentence: what was checked and found. */
  summary: string;
  /** Up to EXAMPLES failures, one sentence each. */
  failures: string[];
}

/** Everything the check found, with the counts behind each check. */
export interface CheckReport {
  passed: boolean;
  head: string;
  checks: Check[];
  registry: { landedEntries: number; duplicates: number; missingLanded: number; phantoms: number; missingSeed: number; unknown: number };
  counters: { counters: number; landedIncrements: number; total: number; lostUpdates: number; doubleCounts: number; closedOnTrunk: number; perCounter: Array<{ path: string; counter: number; value: number | null; landed: number }> };
  readOwn: { landed: number; staleConstants: number; readNotBase: number; afterWriter: number; unlandedSet: number };
  record: { notedProposals: number; seenLanded: number; notInNotes: number; notSeenLanded: number; landedTwice: number };
  parse: { files: number; failed: number };
  /** Line-by-line merges the lineage notes record for the run's proposals: proposals merged, files merged, by the insertion rule. */
  merges: { proposals: number; files: number; insertions: number };
}

/** What the check reads. */
export interface CheckInput {
  workload: Workload;
  /** The trunk head the check reads. */
  head: string;
  /** Every file at the head, with its text. */
  files: ReadonlyMap<string, string>;
  /** The trunk's first-parent history (any order). */
  history: readonly TrunkCommit[];
  records: readonly TaskRecord[];
  /** A file's text at a commit, or null when it is absent there. */
  readAt: (sha: string, path: string) => Promise<string | null>;
  /** A parse error for a file's text, or null when it parses. */
  parse: (path: string, text: string) => string | null;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === "object" && !Array.isArray(x);
}

function versions(x: unknown): FileVersion[] {
  return Array.isArray(x) ? x.filter(isRecord).filter((f) => typeof f.path === "string").map((f) => ({ path: f.path as string, blob: typeof f.blob === "string" ? f.blob : null })) : [];
}

/** Every proposal the lineage notes of `history` say landed, by proposal id (an id landed twice has two entries). Notes that do not parse are skipped. */
export function landedProposals(history: readonly TrunkCommit[]): Map<string, LandedProposal[]> {
  const out = new Map<string, LandedProposal[]>();
  for (const c of history) {
    if (!c.note) continue;
    let note: unknown;
    try {
      note = JSON.parse(c.note);
    } catch {
      continue;
    }
    const proposals = isRecord(note) && Array.isArray(note.proposals) ? note.proposals : [];
    proposals.forEach((p, index) => {
      if (!isRecord(p) || typeof p.id !== "string") return;
      const merged = Array.isArray(p.merged) ? p.merged.filter(isRecord).map((m) => ({ path: String(m.path ?? ""), ...(typeof m.rule === "string" ? { rule: m.rule } : {}) })) : [];
      const entry: LandedProposal = { proposalId: p.id, commit: c.sha, parent: c.parent, index, readSet: versions(p.readSet), writeSet: versions(p.writeSet), merged };
      const list = out.get(p.id);
      if (list) list.push(entry);
      else out.set(p.id, [entry]);
    });
  }
  return out;
}

class Findings {
  readonly lines: string[] = [];
  count = 0;
  add(line: string): void {
    this.count++;
    if (this.lines.length < EXAMPLES) this.lines.push(line);
  }
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** Run every check. */
export async function checkRun(input: CheckInput): Promise<CheckReport> {
  const { workload: w, files, records } = input;
  const modules = w.options.modules;
  const landed = landedProposals(input.history);
  const byProposal = new Map<string, TaskRecord>();
  for (const r of records) for (const p of r.proposals) byProposal.set(p.id, r);
  /** The landings of each task according to the notes, in commit order of discovery. */
  const landedOf = new Map<string, LandedProposal[]>();
  for (const r of records) {
    const list: LandedProposal[] = [];
    for (const p of r.proposals) list.push(...(landed.get(p.id) ?? []));
    landedOf.set(r.task.id, list);
  }
  const checks: Check[] = [];

  // 1. Every file parses, and the tree holds the seeded files and no others.
  const parseFails = new Findings();
  for (const [path, text] of files) {
    const err = path.endsWith(".json") ? jsonError(text) : /\.[cm]?[jt]sx?$/.test(path) ? input.parse(path, text) : null;
    if (err) parseFails.add(`${path} does not parse: ${err.split("\n")[0]}`);
  }
  const seeded = new Set(w.files.map((f) => f.path));
  const shape = new Findings();
  for (const p of seeded) if (!files.has(p)) shape.add(`${p} is gone from trunk`);
  for (const p of files.keys()) if (!seeded.has(p)) shape.add(`${p} is on trunk but no task writes it`);
  checks.push({
    name: "every file parses",
    ok: parseFails.count === 0 && shape.count === 0,
    summary: `${plural(files.size, "file")} at ${input.head.slice(0, 12)}: ${parseFails.count === 0 ? "all parse" : `${plural(parseFails.count, "file")} do not parse`}; ${shape.count === 0 ? "the tree holds the seeded files and no others" : `${plural(shape.count, "path")} differ from the seed's`}.`,
    failures: [...parseFails.lines, ...shape.lines].slice(0, EXAMPLES),
  });

  // 2. Registries: every landed entry exactly once, every seed entry exactly once, nothing else.
  const reg = { landedEntries: 0, duplicates: 0, missingLanded: 0, phantoms: 0, missingSeed: 0, unknown: 0 };
  const regFails = new Findings();
  const registerTasks = records.filter((r): r is TaskRecord & { task: Extract<Task, { kind: "register" }> } => r.task.kind === "register");
  for (let h = 0; h < w.options.hot; h++) {
    const path = hotPath(h);
    const text = files.get(path);
    const entries = text === undefined ? null : registryEntries(text);
    if (entries === null) {
      regFails.add(`${path}: its registry is missing or not one entry a line`);
      continue;
    }
    const count = new Map<string, number>();
    for (const e of entries) count.set(e, (count.get(e) ?? 0) + 1);
    for (const [e, n] of count) {
      if (n > 1) {
        reg.duplicates += n - 1;
        regFails.add(`${path}: "${e}" appears ${n} times`);
      }
    }
    const expected = new Set(w.seedEntries[h]);
    for (const e of w.seedEntries[h] ?? []) {
      if (!count.has(e)) {
        reg.missingSeed++;
        regFails.add(`${path}: seed entry "${e}" is gone`);
      }
    }
    for (const r of registerTasks.filter((r) => r.task.hot === h)) {
      expected.add(r.task.entry);
      const lands = landedOf.get(r.task.id)?.length ?? 0;
      const n = count.get(r.task.entry) ?? 0;
      if (lands > 0) {
        reg.landedEntries++;
        if (n === 0) {
          reg.missingLanded++;
          regFails.add(`${path}: "${r.task.entry}" landed (task ${r.task.id}) but is not in the registry: a lost update`);
        }
      } else if (n > 0) {
        reg.phantoms++;
        regFails.add(`${path}: "${r.task.entry}" is in the registry but no landing of task ${r.task.id} put it there`);
      }
    }
    for (const e of count.keys()) {
      if (!expected.has(e)) {
        reg.unknown++;
        regFails.add(`${path}: "${e}" is in the registry but no task or seed names it`);
      }
    }
  }
  checks.push({
    name: "registry entries appear exactly once",
    ok: regFails.count === 0,
    summary: `${plural(reg.landedEntries, "landed register task")}: ${reg.duplicates} duplicated, ${reg.missingLanded} missing, ${reg.phantoms} present without a landing, ${reg.missingSeed} seed entries gone, ${reg.unknown} unknown.`,
    failures: regFails.lines,
  });

  // 3. Counters: each one equals the increments that landed on it (it starts at 0).
  const ctr: CheckReport["counters"] = { counters: 0, landedIncrements: 0, total: 0, lostUpdates: 0, doubleCounts: 0, closedOnTrunk: 0, perCounter: [] };
  const ctrFails = new Findings();
  for (let h = 0; h < w.options.hot; h++) {
    const path = hotPath(h);
    const text = files.get(path);
    for (let k = 0; k < w.options.counters; k++) {
      const value = text === undefined ? null : counterValue(text, k);
      const tasks = records.filter((r) => r.task.kind === "increment" && r.task.hot === h && r.task.counter === k);
      const n = tasks.reduce((s, r) => s + (landedOf.get(r.task.id)?.length ?? 0), 0);
      ctr.counters++;
      ctr.landedIncrements += n;
      ctr.total += value ?? 0;
      ctr.perCounter.push({ path, counter: k, value, landed: n });
      if (value === null) ctrFails.add(`${path}: COUNTER_${k} is missing or not a whole number`);
      else if (value < n) {
        ctr.lostUpdates += n - value;
        ctrFails.add(`${path}: COUNTER_${k} is ${value} after ${plural(n, "landed increment")}: ${plural(n - value, "lost update")}`);
      } else if (value > n) {
        ctr.doubleCounts += value - n;
        ctrFails.add(`${path}: COUNTER_${k} is ${value} after ${plural(n, "landed increment")}: counted ${value - n} too many`);
      }
    }
  }
  checks.push({
    name: "every counter equals its landed increments",
    ok: ctrFails.count === 0,
    summary: `${plural(ctr.counters, "counter")}, ${plural(ctr.landedIncrements, "landed increment")}, counters adding up to ${ctr.total}: ${plural(ctr.lostUpdates, "lost update")}, ${ctr.doubleCounts} counted twice.`,
    failures: ctrFails.lines,
  });

  // 4. An increment closed as already on trunk never applied: its +1 is lost although nothing landed wrong.
  const closed = records.filter((r) => r.task.kind === "increment" && r.end === "on-trunk");
  ctr.closedOnTrunk = closed.length;
  checks.push({
    name: "no increment was closed as already on trunk",
    ok: closed.length === 0,
    summary:
      closed.length === 0
        ? "No increment came back as already on trunk."
        : `${plural(closed.length, "increment")} came back as already on trunk (its edit merged into an identical one from the same base), so its +1 never applied and its agent was told there was nothing to redo.`,
    failures: closed.slice(0, EXAMPLES).map((r) => `task ${r.task.id} (${hotPath(r.task.hot)} COUNTER_${(r.task as Extract<Task, { kind: "increment" }>).counter}): ${r.proposals.at(-1)?.reason ?? "already on trunk"}`),
  });

  // 5. Read-own: the constant equals the registry length on the trunk its landing was built on, and nothing else set one.
  const ro: CheckReport["readOwn"] = { landed: 0, staleConstants: 0, readNotBase: 0, afterWriter: 0, unlandedSet: 0 };
  const roFails = new Findings();
  const byCommit = new Map<string, LandedProposal[]>();
  for (const list of landed.values()) for (const l of list) byCommit.set(l.commit, [...(byCommit.get(l.commit) ?? []), l]);
  for (const r of records) {
    if (r.task.kind !== "read-own") continue;
    const t = r.task;
    const path = modulePath(t.module, modules);
    const hot = hotPath(t.hot);
    const text = files.get(path);
    const value = text === undefined ? null : seenValue(text, t.hot);
    const lands = landedOf.get(t.id) ?? [];
    if (lands.length === 0) {
      if (value !== 0) {
        ro.unlandedSet++;
        roFails.add(`${path}: ${seenName(t.hot)} is ${value} but task ${t.id} never landed`);
      }
      continue;
    }
    ro.landed++;
    const l = lands[lands.length - 1]!;
    const before = l.parent ? await input.readAt(l.parent, hot) : null;
    const size = before === null ? null : (registryEntries(before)?.length ?? null);
    if (size === null || value !== size) {
      ro.staleConstants++;
      roFails.add(`${path}: ${seenName(t.hot)} is ${value} but ${hot} held ${size ?? "no readable registry"} entries on the trunk its landing ${l.commit.slice(0, 12)} was built on`);
    }
    const read = l.readSet.find((f) => f.path === hot);
    if (read && before !== null && read.blob !== blobId(before)) {
      ro.readNotBase++;
      roFails.add(`task ${t.id}: it read ${hot} at ${String(read.blob).slice(0, 12)} but landed on ${blobId(before).slice(0, 12)}: a stale read landed`);
    }
    // The file as the commit's changes ahead of it left it: the last one that wrote it decides (a write of the same
    // version, as a merge that changed nothing leaves, is no change).
    const ahead = (byCommit.get(l.commit) ?? []).filter((o) => o.index < l.index && o.writeSet.some((f) => f.path === hot)).sort((a, b) => a.index - b.index).at(-1);
    const left = ahead?.writeSet.find((f) => f.path === hot)?.blob;
    if (ahead && read && left !== read.blob) {
      ro.afterWriter++;
      roFails.add(`task ${t.id}: it landed in ${l.commit.slice(0, 12)} after ${ahead.proposalId} there changed ${hot}, which it read`);
    }
  }
  checks.push({
    name: "every read-own constant matches the trunk it landed on",
    ok: roFails.count === 0,
    summary: `${plural(ro.landed, "landed read-own change")}: ${ro.staleConstants} constants differ from the registry they landed on, ${ro.readNotBase} landed on a version they did not read, ${ro.afterWriter} landed behind a writer of their file in the same commit, ${ro.unlandedSet} set without a landing.`,
    failures: roFails.lines,
  });

  // 6. The agents' outcomes and the lineage notes agree, and no task landed twice.
  const rec: CheckReport["record"] = { notedProposals: 0, seenLanded: 0, notInNotes: 0, notSeenLanded: 0, landedTwice: 0 };
  const recFails = new Findings();
  for (const [id, list] of landed) {
    const r = byProposal.get(id);
    if (!r) continue;
    rec.notedProposals++;
    if (list.length > 1) recFails.add(`proposal ${id} is in ${list.length} landing notes`);
    const seen = r.proposals.find((p) => p.id === id);
    if (seen && seen.status !== "landed") {
      rec.notSeenLanded++;
      recFails.add(`proposal ${id} (task ${r.task.id}) is in landing ${list[0]!.commit.slice(0, 12)}'s note but its agent was told ${seen.status}${seen.reason ? `: ${seen.reason.slice(0, 120)}` : ""}`);
    }
  }
  for (const r of records) {
    for (const p of r.proposals) {
      if (p.status !== "landed") continue;
      rec.seenLanded++;
      if (!landed.has(p.id)) {
        rec.notInNotes++;
        recFails.add(`proposal ${p.id} (task ${r.task.id}) was reported landed but no lineage note on trunk names it`);
      }
    }
    if ((landedOf.get(r.task.id)?.length ?? 0) > 1) {
      rec.landedTwice++;
      recFails.add(`task ${r.task.id} landed ${landedOf.get(r.task.id)!.length} times`);
    }
  }
  checks.push({
    name: "the agents' outcomes agree with the lineage notes",
    ok: recFails.count === 0,
    summary: `${plural(rec.seenLanded, "proposal")} reported landed, ${plural(rec.notedProposals, "proposal")} of this run in the notes: ${rec.notInNotes} reported landed but not in a note, ${rec.notSeenLanded} in a note but reported otherwise, ${rec.landedTwice} tasks landed twice.`,
    failures: recFails.lines,
  });

  const merges = { proposals: 0, files: 0, insertions: 0 };
  for (const [id, list] of landed) {
    if (!byProposal.has(id)) continue;
    for (const l of list) {
      if (l.merged.length === 0) continue;
      merges.proposals++;
      merges.files += l.merged.length;
      merges.insertions += l.merged.filter((m) => m.rule === "insertions").length;
    }
  }
  return {
    passed: checks.every((c) => c.ok),
    head: input.head,
    checks,
    registry: reg,
    counters: ctr,
    readOwn: ro,
    record: rec,
    parse: { files: files.size, failed: parseFails.count },
    merges,
  };
}

function jsonError(text: string): string | null {
  try {
    JSON.parse(text);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** A parser for the check: esbuild's TypeScript transform (already in node_modules), which reports the first syntax error. */
export async function esbuildParser(): Promise<(path: string, text: string) => string | null> {
  const esbuild = await import("esbuild");
  return (path, text) => {
    try {
      esbuild.transformSync(text, { loader: path.endsWith("x") ? "tsx" : "ts", sourcefile: path, format: "esm" });
      return null;
    } catch (e) {
      const errors = (e as { errors?: Array<{ text: string; location?: { line: number } | null }> }).errors;
      const first = errors?.[0];
      return first ? `line ${first.location?.line ?? "?"}: ${first.text}` : e instanceof Error ? e.message : String(e);
    }
  };
}
