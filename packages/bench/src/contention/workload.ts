/**
 * The contention-scale workload (scenarios/contention-scale.ts): a generated TypeScript repository of M ordinary modules
 * and H hot files, and a shuffled list of tasks of three kinds that put hundreds of agents on the same files at once.
 *
 * - register: insert one uniquely named entry into a hot file's registry, at the position its name sorts to, so
 *   concurrent inserts land on nearby lines (line merge territory). Correct: every landed entry appears exactly once.
 * - increment: add exactly 1 to one named counter of a hot file (read the value, write value + 1). Two increments of the
 *   same counter cannot both apply to one base. Correct: each counter equals the number of increments that landed on it.
 * - read-own: read a hot file and write only the task's own module, copying the registry's length into a constant there.
 *   Correct: the constant equals the registry's length on the trunk the change landed on.
 *
 * Every hot file holds a registry (one entry a line, each ending with a comma, so an insert anywhere keeps the file
 * valid), counters separated by comment lines (so edits of two counters never touch) and a few functions. Pure and
 * deterministic given the options: no I/O, no clock and no Math.random.
 */

/** The three kinds of task. */
export type TaskKind = "register" | "increment" | "read-own";
/** The kinds in the order the mix names them. */
export const TASK_KINDS: readonly TaskKind[] = ["register", "increment", "read-own"];

/** What the generator makes. */
export interface WorkloadOptions {
  /** The pseudo-random seed: the same seed and options give the same repository and tasks. */
  seed: number;
  /** Hot files. */
  hot: number;
  /** Ordinary modules. */
  modules: number;
  /** Counters in each hot file. */
  counters: number;
  /** Entries each hot file's registry starts with. */
  registry: number;
  /** Tasks (one intent each, redone as often as it comes back). */
  intents: number;
  /** Relative weight of each kind of task. */
  mix: Record<TaskKind, number>;
  /** Include test/contention.test.ts, a node:test file the colony's certification runs (no duplicate names, every file loads). */
  certTest: boolean;
}

/** The defaults the command line starts from (intents: three a agent). */
export const DEFAULT_WORKLOAD: Omit<WorkloadOptions, "intents"> = {
  seed: 1,
  hot: 10,
  modules: 400,
  counters: 4,
  registry: 32,
  mix: { register: 1, increment: 1, "read-own": 1 },
  certTest: true,
};

/** One unit of work: an intent the agents land, redone against the current trunk each time it comes back. */
export type Task =
  | { id: string; kind: "register"; hot: number; entry: string }
  | { id: string; kind: "increment"; hot: number; counter: number }
  | { id: string; kind: "read-own"; hot: number; module: number };

/** A task before it has an id (each member of the union without its `id`). */
type WithoutId<T> = T extends unknown ? Omit<T, "id"> : never;

/** A generated repository and its tasks. */
export interface Workload {
  options: WorkloadOptions;
  /** The seed files in path order. */
  files: Array<{ path: string; text: string }>;
  /** The tasks, mixed and shuffled: the order agents pick them up in. */
  tasks: Task[];
  /** Each hot file's starting registry, by hot file index. */
  seedEntries: string[][];
}

/** A small, fast pseudo-random generator (mulberry32): numbers in [0, 1) from a 32-bit seed. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pad = (n: number, width: number): string => String(n).padStart(width, "0");

/** The path of hot file `h`: one directory each, so each is its own region at region depth 2. */
export function hotPath(h: number): string {
  return `hot/h${pad(h, 2)}/state.ts`;
}

/** Module groups: modules are spread over up to 16 directories. */
export function moduleGroups(modules: number): number {
  return Math.max(1, Math.min(16, modules));
}

/** The path of module `m` of `modules`. */
export function modulePath(m: number, modules: number): string {
  return `mods/g${pad(m % moduleGroups(modules), 2)}/mod_${pad(m, 4)}.ts`;
}

/** The name of a hot file's constant in every module (SEEN_H03). */
export function seenName(h: number): string {
  return `SEEN_H${pad(h, 2)}`;
}

/** The path of the generated node:test file. */
export const TEST_PATH = "test/contention.test.ts";

const REGISTRY_OPEN = "export const REGISTRY: readonly string[] = [";
const REGISTRY_LINE = /^ {2}"([0-9a-z-]+)",$/;

/** The text of hot file `h` with these registry entries and counter values. */
export function hotText(h: number, entries: readonly string[], counters: readonly number[]): string {
  const name = `h${pad(h, 2)}`;
  const lines = [
    `/** Hot file ${name} of the contention-scale benchmark: every agent of a run may edit it. */`,
    "",
    "/** Registered names, one a line, each inserted where its name sorts. */",
    REGISTRY_OPEN,
    ...entries.map((e) => `  "${e}",`),
    "];",
    "",
  ];
  counters.forEach((v, k) => lines.push(`/** Counter ${k} of ${name}: each increment intent adds one. */`, `export const COUNTER_${k} = ${v};`, ""));
  lines.push(
    "/** How many names are registered. */",
    "export function registrySize(): number {",
    "  return REGISTRY.length;",
    "}",
    "",
    "/** Whether `name` is registered. */",
    "export function isRegistered(name: string): boolean {",
    "  return REGISTRY.includes(name);",
    "}",
    "",
    "/** Every counter of this file added up. */",
    "export function counterTotal(): number {",
    `  return ${counters.length > 0 ? counters.map((_, k) => `COUNTER_${k}`).join(" + ") : "0"};`,
    "}",
  );
  return `${lines.join("\n")}\n`;
}

/** The text of module `m`: one SEEN constant per hot file, each 0 (never read), separated by comment lines. */
export function moduleText(m: number, hot: number): string {
  const lines = [`/** Module ${pad(m, 4)} of the contention-scale benchmark: what it last read of each hot file. */`, ""];
  for (let h = 0; h < hot; h++) {
    lines.push(`/** The size of ${hotPath(h)}'s registry when this module last read it (0: never). */`, `export const ${seenName(h)} = 0;`, "");
  }
  lines.push("/** This module's name. */", "export function moduleName(): string {", `  return "mod_${pad(m, 4)}";`, "}");
  return `${lines.join("\n")}\n`;
}

/** The node:test file: every hot file and module is imported (so each must load), and no registry holds a name twice. */
export function testText(hot: number, modules: number): string {
  const lines = ['import { test } from "node:test";', 'import assert from "node:assert/strict";'];
  for (let h = 0; h < hot; h++) lines.push(`import * as h${pad(h, 2)} from "../${hotPath(h)}";`);
  for (let m = 0; m < modules; m++) lines.push(`import * as m${pad(m, 4)} from "../${modulePath(m, modules)}";`);
  lines.push(
    "",
    `const hot = [${Array.from({ length: hot }, (_, h) => `h${pad(h, 2)}`).join(", ")}];`,
    `const modules = [${Array.from({ length: modules }, (_, m) => `m${pad(m, 4)}`).join(", ")}];`,
    "",
    'test("every registry holds each name once", () => {',
    "  for (const h of hot) assert.equal(new Set(h.REGISTRY).size, h.REGISTRY.length);",
    "});",
    "",
    'test("every counter is a whole number of at least zero", () => {',
    "  for (const h of hot) assert.ok(Number.isInteger(h.counterTotal()) && h.counterTotal() >= 0);",
    "});",
    "",
    'test("every module loads", () => {',
    `  assert.equal(modules.filter((m) => typeof m.moduleName() === "string").length, ${modules});`,
    "});",
  );
  return `${lines.join("\n")}\n`;
}

/** How many tasks of each kind `intents` splits into by the mix's weights (largest remainders, ties in kind order). */
export function splitMix(intents: number, mix: Record<TaskKind, number>): Record<TaskKind, number> {
  const total = TASK_KINDS.reduce((s, k) => s + Math.max(0, mix[k] ?? 0), 0);
  if (!(total > 0)) throw new Error("the mix gives every kind of task a weight of 0: give at least one a weight above 0");
  const exact = TASK_KINDS.map((k) => (intents * Math.max(0, mix[k] ?? 0)) / total);
  const out = exact.map(Math.floor);
  let left = intents - out.reduce((s, n) => s + n, 0);
  const order = TASK_KINDS.map((_, i) => i).sort((a, b) => exact[b]! - Math.floor(exact[b]!) - (exact[a]! - Math.floor(exact[a]!)) || a - b);
  for (const i of order) {
    if (left <= 0) break;
    out[i]!++;
    left--;
  }
  return { register: out[0]!, increment: out[1]!, "read-own": out[2]! };
}

/** Parse a mix such as "register=2,increment=1,read-own=1" (kinds left out weigh 0). Throws a sentence on a bad one. */
export function parseMix(text: string): Record<TaskKind, number> {
  const out: Record<TaskKind, number> = { register: 0, increment: 0, "read-own": 0 };
  for (const part of text.split(",").map((s) => s.trim()).filter(Boolean)) {
    const m = /^([a-z-]+)\s*=\s*(\d+(?:\.\d+)?)$/.exec(part);
    if (!m || !TASK_KINDS.includes(m[1] as TaskKind)) throw new Error(`--mix takes kind=weight pairs of ${TASK_KINDS.join(", ")} (got "${part}")`);
    out[m[1] as TaskKind] = Number(m[2]);
  }
  splitMix(1, out);
  return out;
}

/** Check the options; throws a sentence naming the first one that cannot work. */
export function checkOptions(o: WorkloadOptions): void {
  const whole = (name: string, v: number, min: number, max: number): void => {
    if (!Number.isInteger(v) || v < min || v > max) throw new Error(`--${name} must be a whole number from ${min} to ${max} (got ${v})`);
  };
  whole("hot", o.hot, 1, 99);
  whole("modules", o.modules, 1, 9_999);
  whole("counters", o.counters, 1, 50);
  whole("registry", o.registry, 1, 2_000);
  whole("intents", o.intents, 1, 100_000);
  whole("seed", o.seed, 0, 0xffffffff);
  const split = splitMix(o.intents, o.mix);
  const pairs = o.hot * o.modules;
  if (split["read-own"] > pairs) {
    throw new Error(`${split["read-own"]} read-own tasks need as many (module, hot file) pairs, and ${o.modules} modules and ${o.hot} hot files give ${pairs}: add modules or lower the read-own weight`);
  }
}

/** Generate the repository and the tasks. Throws a sentence when the options cannot work (see checkOptions). */
export function generate(o: WorkloadOptions): Workload {
  checkOptions(o);
  const rand = rng(o.seed);
  const int = (n: number): number => Math.floor(rand() * n);
  const shuffle = <T>(xs: T[]): T[] => {
    for (let i = xs.length - 1; i > 0; i--) {
      const j = int(i + 1);
      [xs[i], xs[j]] = [xs[j]!, xs[i]!];
    }
    return xs;
  };
  const used = new Set<string>();
  const hex = (n: number): string => (n >>> 0).toString(16).padStart(8, "0");
  // Seed entries spread evenly over the name space, so new names sort in between them all over the registry.
  const seedEntries = Array.from({ length: o.hot }, (_, h) =>
    Array.from({ length: o.registry }, (_, i) => {
      let n = Math.floor(((i + 0.5) / o.registry) * 4294967296) + h;
      while (used.has(hex(n))) n++;
      used.add(hex(n));
      return hex(n);
    }).sort(),
  );
  const fresh = (): string => {
    for (;;) {
      const name = hex(Math.floor(rand() * 4294967296));
      if (!used.has(name)) {
        used.add(name);
        return name;
      }
    }
  };
  const split = splitMix(o.intents, o.mix);
  const drafts: Array<WithoutId<Task>> = [];
  for (let i = 0; i < split.register; i++) drafts.push({ kind: "register", hot: int(o.hot), entry: fresh() });
  for (let i = 0; i < split.increment; i++) drafts.push({ kind: "increment", hot: int(o.hot), counter: int(o.counters) });
  if (split["read-own"] > 0) {
    // Each read-own task owns one (module, hot file) constant: no two of them write the same line.
    const pairs = shuffle(Array.from({ length: o.hot * o.modules }, (_, i) => i)).slice(0, split["read-own"]);
    for (const p of pairs) drafts.push({ kind: "read-own", hot: p % o.hot, module: Math.floor(p / o.hot) });
  }
  const width = Math.max(5, String(drafts.length).length);
  const tasks = shuffle(drafts).map((d, i) => ({ id: `t${pad(i + 1, width)}`, ...d }) as Task);
  const zeros = Array.from({ length: o.counters }, () => 0);
  const files: Array<{ path: string; text: string }> = [
    {
      path: "README.md",
      text: `# contention-scale\n\nA generated repository for FireTrident's contention-scale benchmark: ${o.hot} hot files under \`hot/\` that every agent of a run edits (a registry, ${o.counters} counters and a few functions each) and ${o.modules} modules under \`mods/\`, one constant per hot file each. Seed ${o.seed}.\n`,
    },
    { path: "package.json", text: `${JSON.stringify({ name: "contention-scale", private: true, type: "module", scripts: { test: "node --test" } }, null, 2)}\n` },
  ];
  for (let h = 0; h < o.hot; h++) files.push({ path: hotPath(h), text: hotText(h, seedEntries[h]!, zeros) });
  for (let m = 0; m < o.modules; m++) files.push({ path: modulePath(m, o.modules), text: moduleText(m, o.hot) });
  if (o.certTest) files.push({ path: TEST_PATH, text: testText(o.hot, o.modules) });
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { options: o, files, tasks, seedEntries };
}

/** The registry entries of a hot file's text, in file order; null when the registry block is missing or holds a line that is not one entry. */
export function registryEntries(text: string): string[] | null {
  const lines = text.split("\n");
  const open = lines.indexOf(REGISTRY_OPEN);
  if (open < 0) return null;
  const out: string[] = [];
  for (let i = open + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line === "];") return out;
    const m = REGISTRY_LINE.exec(line);
    if (!m) return null;
    out.push(m[1]!);
  }
  return null;
}

/** `text` with `entry` inserted before the first entry that sorts after it; null when the entry is already there. Throws on a malformed registry. */
export function insertEntry(text: string, entry: string): string | null {
  const entries = registryEntries(text);
  if (entries === null) throw new Error("the registry of this hot file is not a list of one entry a line");
  if (entries.includes(entry)) return null;
  const lines = text.split("\n");
  const open = lines.indexOf(REGISTRY_OPEN);
  const at = entries.findIndex((e) => e > entry);
  lines.splice(open + 1 + (at < 0 ? entries.length : at), 0, `  "${entry}",`);
  return lines.join("\n");
}

/** The value of counter `k` in a hot file's text, or null when the line is missing or not a whole number. */
export function counterValue(text: string, k: number): number | null {
  const m = new RegExp(`^export const COUNTER_${k} = (\\d+);$`, "m").exec(text);
  return m ? Number(m[1]) : null;
}

/** `text` with counter `k` one higher: the value read and the value written. Throws when the counter is missing. */
export function incrementCounter(text: string, k: number): { text: string; from: number; to: number } {
  const from = counterValue(text, k);
  if (from === null) throw new Error(`COUNTER_${k} is not in this hot file`);
  return { text: text.replace(new RegExp(`^export const COUNTER_${k} = \\d+;$`, "m"), `export const COUNTER_${k} = ${from + 1};`), from, to: from + 1 };
}

/** The SEEN constant of hot file `h` in a module's text, or null when it is missing. */
export function seenValue(text: string, h: number): number | null {
  const m = new RegExp(`^export const ${seenName(h)} = (\\d+);$`, "m").exec(text);
  return m ? Number(m[1]) : null;
}

/** A module's text with hot file `h`'s SEEN constant set to `value`. Throws when the constant is missing. */
export function setSeen(text: string, h: number, value: number): string {
  if (seenValue(text, h) === null) throw new Error(`${seenName(h)} is not in this module`);
  return text.replace(new RegExp(`^export const ${seenName(h)} = \\d+;$`, "m"), `export const ${seenName(h)} = ${value};`);
}

/** The files a task reads, in order: its hot file, then (read-own) its own module. */
export function taskReads(t: Task, modules: number): string[] {
  return t.kind === "read-own" ? [hotPath(t.hot), modulePath(t.module, modules)] : [hotPath(t.hot)];
}

/** The file a task writes. */
export function taskWrites(t: Task, modules: number): string {
  return t.kind === "read-own" ? modulePath(t.module, modules) : hotPath(t.hot);
}

/** What an agent does for a task, given the texts it read: the file and text it writes, or nothing left to do (an entry already registered). */
export type Edit = { path: string; text: string; detail: string; value?: number } | { nothing: string };

/**
 * The edit for a task on the trunk an agent read: `read` gives the text of each file it read (taskReads). register inserts
 * its entry where it sorts (nothing to do when the entry is already there), increment writes the value read plus one,
 * read-own copies the hot file's registry length into its module. Throws when a file it needs is missing or malformed.
 */
export function editFor(t: Task, read: ReadonlyMap<string, string | null>, modules: number): Edit {
  const need = (path: string): string => {
    const text = read.get(path);
    if (typeof text !== "string") throw new Error(`${path} is not on the trunk the agent read`);
    return text;
  };
  const hot = hotPath(t.hot);
  if (t.kind === "register") {
    const text = insertEntry(need(hot), t.entry);
    return text === null ? { nothing: `${t.entry} is already registered in ${hot}` } : { path: hot, text, detail: `register ${t.entry} in ${hot}` };
  }
  if (t.kind === "increment") {
    const r = incrementCounter(need(hot), t.counter);
    return { path: hot, text: r.text, detail: `COUNTER_${t.counter} of ${hot} from ${r.from} to ${r.to}`, value: r.to };
  }
  const entries = registryEntries(need(hot));
  if (entries === null) throw new Error(`the registry of ${hot} is not a list of one entry a line`);
  const path = modulePath(t.module, modules);
  return { path, text: setSeen(need(path), t.hot, entries.length), detail: `${seenName(t.hot)} of ${path} = ${entries.length}`, value: entries.length };
}

/** A one-line description of a task (its intent's title). */
export function describeTask(t: Task, modules: number): string {
  if (t.kind === "register") return `register ${t.entry} in ${hotPath(t.hot)}`;
  if (t.kind === "increment") return `add one to COUNTER_${t.counter} of ${hotPath(t.hot)}`;
  return `copy the registry size of ${hotPath(t.hot)} into ${seenName(t.hot)} of ${modulePath(t.module, modules)}`;
}
