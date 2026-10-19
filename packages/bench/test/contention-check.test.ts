import { blobId } from "@fire_trident/core";
import { describe, expect, it } from "vitest";
import { checkRun, esbuildParser, landedProposals, type CheckInput, type TaskRecord, type TrunkCommit } from "../src/contention/check.ts";
import { parseHistory } from "../src/contention/trunk.ts";
import { DEFAULT_WORKLOAD, editFor, generate, hotPath, incrementCounter, insertEntry, modulePath, seenName, setSeen, taskReads, type Task, type Workload, type WorkloadOptions } from "../src/contention/workload.ts";

const small = (over: Partial<WorkloadOptions> = {}): WorkloadOptions => ({ ...DEFAULT_WORKLOAD, hot: 3, modules: 12, counters: 2, registry: 6, intents: 60, ...over });
const sha = (n: number): string => blobId(`commit ${n}`);

/** Land every task in order, one commit each, as a correct trunk writer would: the input the check reads. */
function simulate(w: Workload): Omit<CheckInput, "parse" | "files"> & { files: Map<string, string>; snapshots: Map<string, Map<string, string>> } {
  let files = new Map(w.files.map((f) => [f.path, f.text]));
  const snapshots = new Map<string, Map<string, string>>();
  const history: TrunkCommit[] = [];
  let parent = sha(0);
  snapshots.set(parent, files);
  const records: TaskRecord[] = [];
  w.tasks.forEach((t, i) => {
    const paths = taskReads(t, w.options.modules);
    const read = new Map(paths.map((p) => [p, files.get(p) ?? null]));
    const e = editFor(t, read, w.options.modules);
    if ("nothing" in e) throw new Error("unexpected");
    const id = `prp_${t.id}`;
    files = new Map(files);
    files.set(e.path, e.text);
    const commit = sha(i + 1);
    const note = JSON.stringify({ schema: "firetrident.lineage/v1", proposals: [{ id, readSet: paths.map((p) => ({ path: p, blob: blobId(read.get(p)!) })), writeSet: [{ path: e.path, blob: blobId(e.text) }] }] });
    history.unshift({ sha: commit, parent, note });
    snapshots.set(commit, files);
    parent = commit;
    records.push({ task: t, intents: [`int_${t.id}`], proposals: [{ id, round: 1, status: "landed" }], end: "landed" });
  });
  return { workload: w, head: parent, files, history, records, snapshots, readAt: async (s, p) => snapshots.get(s)?.get(p) ?? null };
}

const check = async (input: Omit<CheckInput, "parse">) => checkRun({ ...input, parse: await esbuildParser() });
const failing = (r: Awaited<ReturnType<typeof checkRun>>): string[] => r.checks.filter((c) => !c.ok).map((c) => c.name);
const first = <K extends Task["kind"]>(w: Workload, kind: K): Extract<Task, { kind: K }> => w.tasks.find((t) => t.kind === kind) as Extract<Task, { kind: K }>;

describe("the contention-scale check", () => {
  const w = generate(small());

  it("passes a trunk where every task landed once, in order", async () => {
    const r = await check(simulate(w));
    expect(failing(r)).toEqual([]);
    expect(r.passed).toBe(true);
    expect(r.registry.landedEntries).toBe(w.tasks.filter((t) => t.kind === "register").length);
    expect(r.counters.landedIncrements).toBe(w.tasks.filter((t) => t.kind === "increment").length);
    expect(r.counters.total).toBe(r.counters.landedIncrements);
    expect(r.readOwn.landed).toBe(w.tasks.filter((t) => t.kind === "read-own").length);
    expect(r.record).toMatchObject({ notInNotes: 0, notSeenLanded: 0, landedTwice: 0 });
  });

  it("catches a lost update: two increments landed and the counter rose by one", async () => {
    const s = simulate(w);
    const t = first(w, "increment");
    const path = hotPath(t.hot);
    const text = s.files.get(path)!;
    const value = Number(new RegExp(`COUNTER_${t.counter} = (\\d+);`).exec(text)![1]);
    s.files.set(path, text.replace(`COUNTER_${t.counter} = ${value};`, `COUNTER_${t.counter} = ${value - 1};`));
    const r = await check(s);
    expect(failing(r)).toEqual(["every counter equals its landed increments"]);
    expect(r.counters.lostUpdates).toBe(1);
    expect(r.checks.find((c) => !c.ok)!.failures[0]).toMatch(/1 lost update/);
  });

  it("catches a counter counted twice", async () => {
    const s = simulate(w);
    const t = first(w, "increment");
    s.files.set(hotPath(t.hot), incrementCounter(s.files.get(hotPath(t.hot))!, t.counter).text);
    const r = await check(s);
    expect(r.counters.doubleCounts).toBe(1);
    expect(r.passed).toBe(false);
  });

  it("catches a duplicated registry entry", async () => {
    const s = simulate(w);
    const t = first(w, "register");
    const path = hotPath(t.hot);
    s.files.set(path, s.files.get(path)!.replace(`  "${t.entry}",\n`, `  "${t.entry}",\n  "${t.entry}",\n`));
    const r = await check(s);
    expect(failing(r)).toEqual(["registry entries appear exactly once"]);
    expect(r.registry.duplicates).toBe(1);
  });

  it("catches a landed entry that is gone, and an entry with no landing behind it", async () => {
    const s = simulate(w);
    const [a, b] = w.tasks.filter((t): t is Extract<Task, { kind: "register" }> => t.kind === "register");
    s.files.set(hotPath(a!.hot), s.files.get(hotPath(a!.hot))!.replace(`  "${a!.entry}",\n`, ""));
    // b's change went back, says its agent, and no note names it: yet its entry is in the registry.
    const rec = s.records.find((r) => r.task.id === b!.id)!;
    rec.proposals[0]!.status = "returned";
    s.history = s.history.map((c) => (c.note?.includes(`prp_${b!.id}`) ? { ...c, note: c.note.replace(`"id":"prp_${b!.id}"`, `"id":"prp_other"`) } : c));
    const r = await check(s);
    expect(r.registry.missingLanded).toBe(1);
    expect(r.registry.phantoms).toBe(1);
    expect(r.passed).toBe(false);
  });

  it("catches a stale read-own constant, and a change that landed on a version it did not read", async () => {
    const s = simulate(w);
    const t = first(w, "read-own");
    const path = modulePath(t.module, w.options.modules);
    const value = Number(new RegExp(`${seenName(t.hot)} = (\\d+);`).exec(s.files.get(path)!)![1]);
    s.files.set(path, setSeen(s.files.get(path)!, t.hot, value + 1));
    let r = await check(s);
    expect(failing(r)).toEqual(["every read-own constant matches the trunk it landed on"]);
    expect(r.readOwn.staleConstants).toBe(1);

    const s2 = simulate(w);
    s2.history = s2.history.map((c) => (c.note?.includes(`prp_${t.id}`) ? { ...c, note: c.note.replace(blobId(s2.snapshots.get(c.parent!)!.get(hotPath(t.hot))!), "f".repeat(40)) } : c));
    r = await check(s2);
    expect(r.readOwn.readNotBase).toBe(1);
    expect(r.checks.find((c) => !c.ok)!.failures[0]).toMatch(/a stale read landed/);
  });

  it("catches a read-own that landed behind a writer of its file in the same commit", async () => {
    const w1 = generate(small({ hot: 1, modules: 4, counters: 1, registry: 3, intents: 2, mix: { register: 1, increment: 0, "read-own": 1 } }));
    const reg = first(w1, "register");
    const own = first(w1, "read-own");
    const base = new Map(w1.files.map((f) => [f.path, f.text]));
    const hot = base.get(hotPath(0))!;
    const mod = base.get(modulePath(own.module, 4))!;
    const after = new Map(base);
    after.set(hotPath(0), insertEntry(hot, reg.entry)!);
    after.set(modulePath(own.module, 4), setSeen(mod, 0, 3));
    const note = JSON.stringify({
      proposals: [
        { id: "prp_reg", readSet: [{ path: hotPath(0), blob: blobId(hot) }], writeSet: [{ path: hotPath(0), blob: blobId(after.get(hotPath(0))!) }] },
        { id: "prp_own", readSet: [{ path: hotPath(0), blob: blobId(hot) }], writeSet: [{ path: modulePath(own.module, 4), blob: blobId(after.get(modulePath(own.module, 4))!) }] },
      ],
    });
    const snapshots = new Map([[sha(0), base], [sha(1), after]]);
    const r = await check({
      workload: w1,
      head: sha(1),
      files: after,
      history: [{ sha: sha(1), parent: sha(0), note }],
      records: [
        { task: reg, intents: ["i1"], proposals: [{ id: "prp_reg", round: 1, status: "landed" }], end: "landed" },
        { task: own, intents: ["i2"], proposals: [{ id: "prp_own", round: 1, status: "landed" }], end: "landed" },
      ],
      readAt: async (s, p) => snapshots.get(s)?.get(p) ?? null,
    });
    expect(r.readOwn).toMatchObject({ landed: 1, staleConstants: 0, readNotBase: 0, afterWriter: 1 });
    expect(r.passed).toBe(false);

    // A change ahead that wrote the file it already had (a merge that changed nothing) is no writer.
    const same = note.replace(blobId(after.get(hotPath(0))!), blobId(hot));
    const unchanged = new Map(after).set(hotPath(0), hot);
    const r2 = await check({
      workload: w1,
      head: sha(1),
      files: unchanged,
      history: [{ sha: sha(1), parent: sha(0), note: same }],
      records: [
        { task: reg, intents: ["i1"], proposals: [{ id: "prp_reg", round: 1, status: "landed" }], end: "landed" },
        { task: own, intents: ["i2"], proposals: [{ id: "prp_own", round: 1, status: "landed" }], end: "landed" },
      ],
      readAt: async (s, p) => (s === sha(0) ? base.get(p) ?? null : unchanged.get(p) ?? null),
    });
    expect(r2.readOwn.afterWriter).toBe(0);
    expect(r2.registry.missingLanded).toBe(1);
  });

  it("catches a file that no longer parses", async () => {
    const s = simulate(w);
    const path = modulePath(3, w.options.modules);
    s.files.set(path, s.files.get(path)!.replace("export const SEEN_H00 =", "export const SEEN_H00 = = "));
    const r = await check(s);
    expect(failing(r)).toContain("every file parses");
    expect(r.parse.failed).toBe(1);
    expect(r.checks.find((c) => c.name === "every file parses")!.failures[0]).toMatch(new RegExp(`${path} does not parse`));
  });

  it("fails an increment closed as already on trunk, and a landing the notes do not have", async () => {
    const s = simulate(w);
    const t = first(w, "increment");
    const rec = s.records.find((r) => r.task.id === t.id)!;
    rec.proposals.push({ id: "prp_again", round: 2, status: "already_on_trunk", reason: "already on trunk" });
    rec.end = "on-trunk";
    const other = s.records.find((r) => r.task.kind === "register")!;
    other.proposals.push({ id: "prp_ghost", round: 2, status: "landed" });
    const r = await check(s);
    expect(failing(r)).toEqual(["no increment was closed as already on trunk", "the agents' outcomes agree with the lineage notes"]);
    expect(r.counters.closedOnTrunk).toBe(1);
    expect(r.record.notInNotes).toBe(1);
  });

  it("reads lineage notes leniently, and stock git's log format", () => {
    const landed = landedProposals([
      { sha: sha(1), parent: sha(0), note: JSON.stringify({ proposals: [{ id: "a", readSet: [], writeSet: [{ path: "x", blob: "b" }], merged: [{ path: "x", rule: "insertions" }] }, { id: "b" }] }) },
      { sha: sha(2), parent: sha(1), note: "not json" },
      { sha: sha(3), parent: sha(2), note: null },
    ]);
    expect([...landed.keys()]).toEqual(["a", "b"]);
    expect(landed.get("a")![0]).toMatchObject({ commit: sha(1), parent: sha(0), index: 0, merged: [{ path: "x", rule: "insertions" }] });
    expect(landed.get("b")![0]!.index).toBe(1);
    const log = `${sha(2)}\x1f${sha(1)}\x1f1760900000\x1f{"proposals":[]}\n\x1e\n${sha(1)}\x1f${sha(0)} ${sha(9)}\x1f1760899999\x1f\x1e\n${sha(0)}\x1f\x1f\x1f\x1e`;
    expect(parseHistory(log)).toEqual([
      { sha: sha(2), parent: sha(1), note: '{"proposals":[]}', at: 1_760_900_000_000 },
      { sha: sha(1), parent: sha(0), note: null, at: 1_760_899_999_000 },
      { sha: sha(0), parent: null, note: null },
    ]);
  });
});
