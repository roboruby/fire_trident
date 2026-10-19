import { mergeText } from "@fire_trident/core";
import { describe, expect, it } from "vitest";
import { esbuildParser } from "../src/contention/check.ts";
import {
  DEFAULT_WORKLOAD,
  counterValue,
  editFor,
  generate,
  hotPath,
  incrementCounter,
  insertEntry,
  modulePath,
  parseMix,
  registryEntries,
  seenValue,
  splitMix,
  taskReads,
  type Task,
  type WorkloadOptions,
} from "../src/contention/workload.ts";

const small = (over: Partial<WorkloadOptions> = {}): WorkloadOptions => ({ ...DEFAULT_WORKLOAD, hot: 3, modules: 12, counters: 2, registry: 6, intents: 60, ...over });
const reads = (pairs: Array<[string, string | null]>): Map<string, string | null> => new Map(pairs);

describe("the workload generator", () => {
  it("is deterministic from its seed, and another seed gives other tasks", () => {
    const a = generate(small({ seed: 7 }));
    const b = generate(small({ seed: 7 }));
    expect(b).toEqual(a);
    const c = generate(small({ seed: 8 }));
    expect(c.tasks).not.toEqual(a.tasks);
    expect(c.files.filter((f) => f.path.startsWith("mods/"))).toEqual(a.files.filter((f) => f.path.startsWith("mods/")));
  });

  it("splits the intents by the mix and shuffles the kinds together", () => {
    expect(splitMix(10, { register: 1, increment: 1, "read-own": 1 })).toEqual({ register: 4, increment: 3, "read-own": 3 });
    expect(splitMix(7, parseMix("register=2,increment=1"))).toEqual({ register: 5, increment: 2, "read-own": 0 });
    expect(() => parseMix("register=0")).toThrow(/weight of 0/);
    expect(() => parseMix("delete=1")).toThrow(/kind=weight/);
    const w = generate(small({ intents: 90 }));
    expect(w.tasks.filter((t) => t.kind === "register")).toHaveLength(30);
    expect(w.tasks.filter((t) => t.kind === "read-own")).toHaveLength(30);
    const kinds = w.tasks.slice(0, 15).map((t) => t.kind);
    expect(new Set(kinds).size).toBe(3);
    expect(w.tasks.map((t) => t.id)).toEqual(Array.from({ length: 90 }, (_, i) => `t${String(i + 1).padStart(5, "0")}`));
  });

  it("names every register entry once across the repository, and gives every read-own task its own constant", () => {
    const w = generate(small({ intents: 105 }));
    const names = [...w.seedEntries.flat(), ...w.tasks.flatMap((t) => (t.kind === "register" ? [t.entry] : []))];
    expect(new Set(names).size).toBe(names.length);
    const pairs = w.tasks.flatMap((t) => (t.kind === "read-own" ? [`${t.module}:${t.hot}`] : []));
    expect(new Set(pairs).size).toBe(pairs.length);
    expect(() => generate(small({ hot: 1, modules: 2, intents: 30 }))).toThrow(/pairs/);
  });

  it("writes a repository whose every TypeScript file parses, hot files with their seed registry and counters at zero", async () => {
    const w = generate(small());
    const parse = await esbuildParser();
    for (const f of w.files) if (f.path.endsWith(".ts")) expect(parse(f.path, f.text), f.path).toBeNull();
    const hot = w.files.find((f) => f.path === hotPath(1))!.text;
    expect(registryEntries(hot)).toEqual(w.seedEntries[1]);
    expect(counterValue(hot, 0)).toBe(0);
    expect(counterValue(hot, 1)).toBe(0);
    const mod = w.files.find((f) => f.path === modulePath(5, 12))!.text;
    expect(seenValue(mod, 2)).toBe(0);
    expect(w.files.map((f) => f.path)).toContain("test/contention.test.ts");
    expect(generate(small({ certTest: false })).files.map((f) => f.path)).not.toContain("test/contention.test.ts");
    expect(parse("bad.ts", "export const = ;")).toMatch(/line 1/);
  });
});

describe("the edits", () => {
  const w = generate(small());
  const hot0 = w.files.find((f) => f.path === hotPath(0))!.text;
  const seed = w.seedEntries[0]!;

  it("register inserts its entry where it sorts, and does nothing when it is there already", () => {
    const entry = `${seed[2]!.slice(0, 7)}z`;
    const t: Task = { id: "t1", kind: "register", hot: 0, entry };
    const e = editFor(t, reads([[hotPath(0), hot0]]), 12);
    if ("nothing" in e) throw new Error("expected an edit");
    const entries = registryEntries(e.text)!;
    expect(entries).toEqual([...seed].concat(entry).sort());
    expect(editFor(t, reads([[hotPath(0), e.text]]), 12)).toEqual({ nothing: `${entry} is already registered in ${hotPath(0)}` });
  });

  it("register redone on a moved trunk keeps the other insert and lands its own once", () => {
    const other = insertEntry(hot0, "00000001")!;
    const t: Task = { id: "t1", kind: "register", hot: 0, entry: "ffffff00" };
    const e = editFor(t, reads([[hotPath(0), other]]), 12);
    if ("nothing" in e) throw new Error("expected an edit");
    expect(registryEntries(e.text)).toEqual(["00000001", ...seed, "ffffff00"]);
  });

  it("increment writes the value it read plus one, and a redo reads the moved value", () => {
    const t: Task = { id: "t2", kind: "increment", hot: 0, counter: 1 };
    const first = editFor(t, reads([[hotPath(0), hot0]]), 12);
    if ("nothing" in first) throw new Error("expected an edit");
    expect(counterValue(first.text, 1)).toBe(1);
    expect(counterValue(first.text, 0)).toBe(0);
    const moved = incrementCounter(incrementCounter(hot0, 1).text, 1).text;
    const redo = editFor(t, reads([[hotPath(0), moved]]), 12);
    if ("nothing" in redo) throw new Error("expected an edit");
    expect(counterValue(redo.text, 1)).toBe(3);
    expect(redo.value).toBe(3);
  });

  it("read-own copies the registry length it read into its own module, and a redo copies the moved length", () => {
    const t: Task = { id: "t3", kind: "read-own", hot: 0, module: 4 };
    const mod = w.files.find((f) => f.path === modulePath(4, 12))!.text;
    expect(taskReads(t, 12)).toEqual([hotPath(0), modulePath(4, 12)]);
    const e = editFor(t, reads([[hotPath(0), hot0], [modulePath(4, 12), mod]]), 12);
    if ("nothing" in e) throw new Error("expected an edit");
    expect(e.path).toBe(modulePath(4, 12));
    expect(seenValue(e.text, 0)).toBe(seed.length);
    const grown = insertEntry(insertEntry(hot0, "00000001")!, "00000002")!;
    const redo = editFor(t, reads([[hotPath(0), grown], [modulePath(4, 12), e.text]]), 12);
    if ("nothing" in redo) throw new Error("expected an edit");
    expect(seenValue(redo.text, 0)).toBe(seed.length + 2);
    expect(() => editFor(t, reads([[hotPath(0), null]]), 12)).toThrow(/not on the trunk/);
  });

  it("edits merge line by line where they should, and two increments of one counter from one base merge as one (the lost update the check must catch)", () => {
    const a = insertEntry(hot0, "00000001")!;
    const b = insertEntry(hot0, "fffffff0")!;
    const both = mergeText(hot0, a, b);
    expect(both.clean && registryEntries(both.text)).toEqual(["00000001", ...seed, "fffffff0"]);
    const c0 = incrementCounter(hot0, 0).text;
    const c1 = incrementCounter(hot0, 1).text;
    const counters = mergeText(hot0, c0, c1);
    expect(counters.clean && [counterValue(counters.text, 0), counterValue(counters.text, 1)]).toEqual([1, 1]);
    const same = mergeText(hot0, c0, c0);
    expect(same.clean && counterValue(same.text, 0)).toBe(1);
  });
});
