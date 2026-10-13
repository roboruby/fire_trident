import type { Path, Sha } from "@fire_trident/core";
import { TEST_FILE, classify, compile, resolveExact, usesNodeTest, type Compiled } from "./compile.ts";
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

/** Compiled modules kept between runs, by path and blob id (a file's compile result depends on nothing else). */
export type CompileMemo = Map<string, { compiled: Compiled; nodeTest: boolean }>;

/** Test files in an index listing, sorted by path (dependency directories and dot directories left out). */
export function testFiles(files: readonly IndexedFile[]): IndexedFile[] {
  return files
    .filter((f) => TEST_FILE.test(f.path) && !/(^|\/)(node_modules|\.[^/]*)\//.test(f.path))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * Read the test files and every module they reach, compile them, and decide which test files run.
 * A test file runs when it imports node:test and every module it reaches imports only relative
 * paths and Node built-ins the runner provides (a package import would fail for a reason that is
 * not the code's: nothing is installed). Imports that name no file are left unresolved on purpose:
 * the file fails to load, as it would under `node --test`.
 */
export async function load(index: readonly IndexedFile[], read: (blobs: Sha[]) => Promise<Record<Sha, string | null>>, caps: LoadCaps = DEFAULT_CAPS, memo?: CompileMemo): Promise<Loaded> {
  const byPath = new Map(index.map((f) => [f.path, f]));
  const paths = new Set(byPath.keys());
  const modules = new Map<Path, Compiled>();
  const blobs = new Map<Path, Sha>();
  const tooBig = new Set<Path>();
  const unread = new Set<Path>();
  const nodeTestText = new Set<Path>();
  let bytes = 0;
  const tests = testFiles(index);
  const testSet = new Set(tests.map((t) => t.path));
  let frontier: Path[] = tests.map((t) => t.path);
  while (frontier.length > 0) {
    const want: IndexedFile[] = [];
    for (const path of new Set(frontier)) {
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
    if (want.length === 0) break;
    const key = (f: IndexedFile): string => `${f.path}\u0000${f.blob}`;
    const toRead = want.filter((f) => !memo?.has(key(f)));
    const texts = toRead.length > 0 ? await read([...new Set(toRead.map((f) => f.blob))]) : {};
    const next: Path[] = [];
    for (const f of want) {
      let entry = memo?.get(key(f));
      if (!entry) {
        const text = texts[f.blob];
        if (typeof text !== "string") {
          unread.add(f.path);
          continue;
        }
        entry = { compiled: compile(f.path, text), nodeTest: text.includes("node:test") };
        memo?.set(key(f), entry);
      }
      const c = entry.compiled;
      modules.set(f.path, c);
      blobs.set(f.path, f.blob);
      if (testSet.has(f.path) && entry.nodeTest) nodeTestText.add(f.path);
      for (const spec of c.imports) {
        if (classify(spec).kind !== "relative") continue;
        const target = resolveExact(f.path, spec, paths);
        if (target !== null && !modules.has(target)) next.push(target);
      }
    }
    frontier = next;
  }

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
    // A file that does not parse still runs (and fails) when it was written for node:test.
    if (!(c.error === undefined ? usesNodeTest(c) : nodeTestText.has(t.path))) {
      unsupported.push({ path: t.path, reason: "does not import node:test" });
      via.set(t.path, t.path);
      continue;
    }
    const blocked = blocker(closureOf(t.path, modules), modules, paths, tooBig, unread);
    if (blocked) {
      unsupported.push({ path: t.path, reason: blocked.reason });
      via.set(t.path, blocked.via);
    } else run.push(t.path);
  }
  return { modules, tests: run, unsupported, via, blobs, truncated: unread.size > 0 };
}

/**
 * Why a test file cannot run honestly here, and the file responsible, or null: a package or an
 * unprovided built-in in reach, or a module it reaches that was not read (over the per-file or
 * per-run cap). A relative import of a file that does not exist is not a blocker: it fails at
 * load, as under `node --test`.
 */
function blocker(closure: Path[], modules: ReadonlyMap<Path, Compiled>, paths: ReadonlySet<Path>, tooBig: ReadonlySet<Path>, unread: ReadonlySet<Path>): { reason: string; via: Path } | null {
  for (const path of closure) {
    const c = modules.get(path);
    if (!c) continue;
    for (const spec of c.imports) {
      const k = classify(spec);
      if (k.kind === "package") return { reason: `imports the package ${k.name} (${path}); nothing is installed`, via: path };
      if (k.kind === "unsupported") return { reason: `imports ${k.name} (${path}), which the test runner does not provide`, via: path };
      if (k.kind !== "relative") continue;
      const target = resolveExact(path, spec, paths);
      if (target === null || modules.has(target)) continue;
      if (tooBig.has(target)) return { reason: `reaches ${target}, larger than one run reads`, via: target };
      if (unread.has(target)) return { reason: `reaches ${target}, past the run's size cap`, via: target };
    }
  }
  return null;
}
