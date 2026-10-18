import type { Path, Sha } from "@fire_trident/core";
import { TEST_FILE, VITEST_CONFIG, classify, compile, compileVitest, configProblem, importsFor, nearestConfig, resolveFor, runnerHints, usesNodeTest, type Compiled, type Runner, type RunnerHints } from "./compile.ts";
import { closureOf } from "./plan.ts";

/**
 * Choosing what a certification runs: the trunk's test files, the modules they reach, and which
 * test files the runner can honestly run. Reads go through `read` (blob id → text), level by
 * level along relative imports, so a large tree costs only the files its tests reach.
 */

/** A trunk file as the index lists it. */
export interface IndexedFile {
  path: Path;
  blob: Sha;
  size: number;
}

/** Caps on what one run reads and loads. */
export interface LoadCaps {
  /** Modules read at most (test files included). */
  maxModules: number;
  /** Bytes of source read at most. */
  maxBytes: number;
  /** A file larger than this is not read (a test reaching it is left out). */
  maxFileBytes: number;
}

export const DEFAULT_CAPS: LoadCaps = { maxModules: 400, maxBytes: 4 * 1024 * 1024, maxFileBytes: 512 * 1024 };

/** What load() found. */
export interface Loaded {
  /** Every module read and compiled, by path. */
  modules: Map<Path, Compiled>;
  /** Test files to run, sorted by path. */
  tests: Path[];
  /** Test files left out, with the reason. */
  unsupported: Array<{ path: Path; reason: string }>;
  /** For each test file left out, the file that kept it out: itself, or a module it reaches. */
  via: Map<Path, Path>;
  /** Blob ids of every module read (for the input digest), by path. */
  blobs: Map<Path, Sha>;
  /** The caps cut the read short. */
  truncated: boolean;
}

/** One compiled file as the memo keeps it: its compilations, and what its text says about the runner a test file is written for. */
export interface MemoEntry {
  compiled: Compiled;
  /** The text mentions node:test (a test file that does not compile still runs, and fails, when it was written for node:test). */
  nodeTest: boolean;
  /** For a test file: whether it imports vitest or uses vitest's globals (absent on entries made before vitest support). */
  hints?: RunnerHints;
}

/** Compiled modules kept between runs, by path and blob id (a file's compile result depends on nothing else). */
export type CompileMemo = Map<string, MemoEntry>;

/** Compile one file for the memo: as Node runs it, and also as vitest runs it when `vitest` (or when it is a test file written for vitest). */
export function memoEntry(path: Path, text: string, vitest = false): MemoEntry {
  const compiled = compile(path, text);
  const hints = TEST_FILE.test(path) ? runnerHints(text) : undefined;
  if (vitest || hints?.vitest || hints?.globals) compiled.vitest = compileVitest(path, text);
  const entry: MemoEntry = { compiled, nodeTest: text.includes("node:test") };
  if (hints) entry.hints = hints;
  return entry;
}

/** Test files in an index listing, sorted by path (dependency directories and dot directories left out). */
export function testFiles(files: readonly IndexedFile[]): IndexedFile[] {
  return files
    .filter((f) => TEST_FILE.test(f.path) && !/(^|\/)(node_modules|\.[^/]*)\//.test(f.path))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * The runner a test file is written for: node:test when it imports it (or, not compiling, mentions it), vitest when it
 * imports vitest or, in a project with a vitest configuration, calls describe / it / expect without importing them;
 * null otherwise (another runner, or none).
 */
export function runnerOf(entry: MemoEntry, vitestConfig: boolean): Runner | null {
  const c = entry.compiled;
  if (c.error === undefined && usesNodeTest(c)) return "node:test";
  if (entry.hints?.vitest) return "vitest";
  if (c.error !== undefined && entry.nodeTest) return "node:test";
  if (entry.hints?.globals && vitestConfig) return "vitest";
  return null;
}

/**
 * Read the test files and every module they reach, compile them, and decide which test files run.
 * A test file runs when it is written for node:test or vitest (runnerOf) and every module it reaches
 * imports only relative paths, Node built-ins the runner provides and the runner itself (a package
 * import would fail for a reason that is not the code's: nothing is installed). Relative imports
 * resolve as the file's runner resolves them: exactly as written for node:test, as vite does for
 * vitest. Imports that name no file are left unresolved on purpose: the file fails to load, as it
 * would under `node --test` or vitest.
 */
export async function load(index: readonly IndexedFile[], read: (blobs: Sha[]) => Promise<Record<Sha, string | null>>, caps: LoadCaps = DEFAULT_CAPS, memo?: CompileMemo): Promise<Loaded> {
  const byPath = new Map(index.map((f) => [f.path, f]));
  const paths = new Set(byPath.keys());
  const vitestConfig = index.some((f) => VITEST_CONFIG.test(f.path) && !/(^|\/)node_modules\//.test(f.path));
  const modules = new Map<Path, Compiled>();
  const blobs = new Map<Path, Sha>();
  const tooBig = new Set<Path>();
  const unread = new Set<Path>();
  const runners = new Map<Path, Runner | null>();
  /** (runner, path) pairs whose imports were followed. */
  const followed = new Set<string>();
  let bytes = 0;
  let vitestProject = false;
  const tests = testFiles(index);
  const testSet = new Set(tests.map((t) => t.path));
  // Each entry: a path, and the runner whose resolution reached it (null: a test file, whose runner its text decides).
  let frontier: Array<[Path, Runner | null]> = tests.map((t) => [t.path, null]);
  while (frontier.length > 0) {
    const want: IndexedFile[] = [];
    for (const path of new Set(frontier.map(([p]) => p))) {
      if (modules.has(path) || tooBig.has(path) || unread.has(path)) continue;
      const f = byPath.get(path);
      if (!f) continue;
      if (f.size > caps.maxFileBytes) tooBig.add(path);
      else if (modules.size + want.length >= caps.maxModules || bytes + f.size > caps.maxBytes) unread.add(path);
      else {
        bytes += f.size;
        want.push(f);
      }
    }
    const key = (f: IndexedFile): string => `${f.path}\u0000${f.blob}`;
    // The test files are all read at the first level, so past it a project with one written for vitest compiles what
    // it reads for vitest too; a memo entry made before that was needed (or by a reader that keeps no hints) is compiled again.
    const stale = (f: IndexedFile, e: MemoEntry): boolean => (vitestProject && e.compiled.vitest === undefined) || (testSet.has(f.path) && e.hints === undefined);
    const toRead = want.filter((f) => {
      const e = memo?.get(key(f));
      return !e || stale(f, e);
    });
    const texts = toRead.length > 0 ? await read([...new Set(toRead.map((f) => f.blob))]) : {};
    for (const f of want) {
      let entry = memo?.get(key(f));
      if (!entry || stale(f, entry)) {
        const text = texts[f.blob];
        if (typeof text !== "string") {
          unread.add(f.path);
          continue;
        }
        entry = memoEntry(f.path, text, vitestProject);
        memo?.set(key(f), entry);
      }
      modules.set(f.path, entry.compiled);
      blobs.set(f.path, f.blob);
      if (testSet.has(f.path)) {
        const runner = runnerOf(entry, vitestConfig);
        runners.set(f.path, runner);
        if (runner === "vitest") vitestProject = true;
      }
    }
    const next: Array<[Path, Runner | null]> = [];
    for (const [path, reached] of frontier) {
      const c = modules.get(path);
      if (!c) continue;
      // A test file follows its own runner's imports; one written for neither is read as node:test reads it.
      const runner: Runner = reached ?? runners.get(path) ?? "node:test";
      const k = `${runner}\u0000${path}`;
      if (followed.has(k)) continue;
      followed.add(k);
      for (const spec of importsFor(c, runner)) {
        if (classify(spec).kind !== "relative") continue;
        const target = resolveFor(runner, path, spec, paths);
        if (target !== null && !followed.has(`${runner}\u0000${target}`)) next.push([target, runner]);
      }
    }
    frontier = next;
  }
  // vitest configurations decide how a project's tests run: a test file under one that sets what certification does
  // not apply (setup files, plugins, environment variables) is left out rather than run differently.
  const problems = vitestProject ? await configProblems(index.filter((f) => VITEST_CONFIG.test(f.path) && !/(^|\/)node_modules\//.test(f.path)), read, memo) : new Map<Path, string>();
  const configs = [...problems.keys()];

  const run: Path[] = [];
  const unsupported: Array<{ path: Path; reason: string }> = [];
  const via = new Map<Path, Path>();
  for (const t of tests) {
    const c = modules.get(t.path);
    if (!c) {
      unsupported.push({ path: t.path, reason: tooBig.has(t.path) ? `larger than one run reads (${caps.maxFileBytes} bytes)` : "past the run's size cap" });
      via.set(t.path, t.path);
      continue;
    }
    const runner = runners.get(t.path) ?? null;
    if (runner === null) {
      unsupported.push({ path: t.path, reason: "does not import node:test" });
      via.set(t.path, t.path);
      continue;
    }
    // The module map names the runner of each vitest test file (closureOf and buildPlan read it there).
    if (runner === "vitest") {
      modules.set(t.path, { ...c, runner });
      const config = nearestConfig(t.path, configs);
      const problem = config === null ? "" : (problems.get(config) ?? "");
      if (config !== null && problem !== "") {
        unsupported.push({ path: t.path, reason: `runs under ${config}, which sets ${problem}; trunk certification does not apply vitest configurations` });
        via.set(t.path, config);
        continue;
      }
    }
    const blocked = blocker(closureOf(t.path, modules), modules, paths, tooBig, unread, runner);
    if (blocked) {
      unsupported.push({ path: t.path, reason: blocked.reason });
      via.set(t.path, blocked.via);
    } else run.push(t.path);
  }
  return { modules, tests: run, unsupported, via, blobs, truncated: unread.size > 0 };
}

/** Each vitest configuration's setting certification does not apply ("" when none), read from its text (memoized like modules). */
async function configProblems(configs: readonly IndexedFile[], read: (blobs: Sha[]) => Promise<Record<Sha, string | null>>, memo?: CompileMemo): Promise<Map<Path, string>> {
  const out = new Map<Path, string>();
  const key = (f: IndexedFile): string => `${f.path}\u0000${f.blob}`;
  const missing = configs.filter((f) => !memo?.has(key(f)));
  const texts = missing.length > 0 ? await read([...new Set(missing.map((f) => f.blob))]) : {};
  for (const f of configs) {
    let entry = memo?.get(key(f));
    if (!entry) {
      const text = texts[f.blob];
      if (typeof text !== "string") continue;
      entry = memoEntry(f.path, text);
      memo?.set(key(f), entry);
    }
    out.set(f.path, configProblem(entry.compiled.code ?? "") ?? "");
  }
  return out;
}

/** File types vite imports that the trunk index does not list for certification: such an import cannot be found here, whatever is on trunk. */
const NOT_INDEXED = /\.(tsx|jsx|mts|cts|cjs|css|scss|sass|less|styl|svg|png|jpe?g|gif|webp|avif|ico|wasm|html|txt|md|vue|svelte|graphql|gql|ya?ml|toml|node)$/i;

/**
 * Why a test file cannot run honestly here, and the file responsible, or null: a package or an
 * unprovided built-in in reach, or a module it reaches that was not read (over the per-file or
 * per-run cap); for vitest also a module this runner cannot compile or run (Compiled.unsupported)
 * or an import of a file type the trunk index does not list (a stylesheet, a .tsx file). A relative
 * import of a file that does not exist is not a blocker: it fails at load, as under `node --test`.
 */
function blocker(closure: Path[], modules: ReadonlyMap<Path, Compiled>, paths: ReadonlySet<Path>, tooBig: ReadonlySet<Path>, unread: ReadonlySet<Path>, runner: Runner): { reason: string; via: Path } | null {
  for (const path of closure) {
    const c = modules.get(path);
    if (!c) continue;
    if (runner === "vitest" && c.vitest?.unsupported) return { reason: c.vitest.unsupported, via: path };
    for (const spec of importsFor(c, runner)) {
      const k = classify(spec);
      if (k.kind === "package") return { reason: `imports the package ${k.name} (${path}); nothing is installed`, via: path };
      if (k.kind === "unsupported") return { reason: `imports ${k.name} (${path}), which the test runner does not provide`, via: path };
      if (k.kind !== "relative") continue;
      const target = resolveFor(runner, path, spec, paths);
      if (target === null) {
        const named = spec.replace(/[?#].*$/, "");
        if (runner === "vitest" && (spec !== named || NOT_INDEXED.test(named))) return { reason: `imports ${spec} (${path}), a file type trunk certification does not load`, via: path };
        continue;
      }
      if (modules.has(target)) continue;
      if (tooBig.has(target)) return { reason: `reaches ${target}, larger than one run reads`, via: target };
      if (unread.has(target)) return { reason: `reaches ${target}, past the run's size cap`, via: target };
    }
  }
  return null;
}
