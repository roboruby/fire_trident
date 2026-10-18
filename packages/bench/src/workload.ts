#!/usr/bin/env node
/**
 * Workload model from a real repository's history (read-only analysis; nothing in the
 * repository is executed). It extracts:
 *  - files touched per change (empirical histogram) and per-file touch counts,
 *  - co-change neighbours (files committed together), which shape synthetic write sets,
 *  - the direct relative-import graph at HEAD, which gives each change a read set
 *    (the files an agent reads to make it).
 *
 *   node packages/bench/src/workload.ts --repo /tmp/ft-w2/hono --tree <checkout of HEAD> --out data/hono-workload.json
 *
 * Filters (documented in the model): merges, release/version commits, generated or lock
 * files, and changes with more than --cap files (mass edits) are left out.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

/** The compact model the simulator samples from. */
export interface WorkloadModel {
  schema: "firetrident.workload/v1";
  source: { repo: string; head: string; headDate: string; commitsSeen: number; commitsUsed: number; firstDate: string; lastDate: string };
  filters: string[];
  /** sizeHist[k] = number of used changes that touched exactly k files (index 0 unused). */
  sizeHist: number[];
  files: string[];
  touches: number[];
  /** Per file: up to `maxNeighbours` [fileIndex, coChangeCount] pairs, strongest first. */
  neighbours: Array<Array<[number, number]>>;
  /** Per file: direct relative imports at HEAD (file indices), when the file exists at HEAD. */
  imports: number[][];
  stats: Record<string, number | string>;
}

const RELEASE = /^(v?\d+\.\d+\.\d+(?:[-+][\w.]+)?|chore(?:\([^)]*\))?:\s*(?:release|bump|version)\b.*|release\b.*|bump version.*)$/i;
const GENERATED = [/^deno_dist\//, /(^|\/)(yarn\.lock|bun\.lockb?|package-lock\.json|pnpm-lock\.yaml)$/, /^\.yarn\//];

/** Parse `git log --format=@@%H%x09%at%x09%s --name-only` output. */
export function parseLog(text: string): Array<{ hash: string; at: number; subject: string; files: string[] }> {
  const out: Array<{ hash: string; at: number; subject: string; files: string[] }> = [];
  let cur: { hash: string; at: number; subject: string; files: string[] } | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("@@")) {
      const [hash = "", at = "0", ...rest] = line.slice(2).split("\t");
      cur = { hash, at: Number(at), subject: rest.join("\t"), files: [] };
      out.push(cur);
    } else if (line.trim() && cur) {
      cur.files.push(line.trim());
    }
  }
  return out;
}

const SOURCE_EXT = [".ts", ".tsx", ".mts", ".js", ".mjs", ".jsx"];
const IMPORT_RE = /(?:\bimport\s+(?:type\s+)?(?:[\w*{}\s,$]+\s+from\s+)?|\bexport\s+(?:type\s+)?(?:\*|\{[^}]*\})\s+from\s+|\bimport\s*\(\s*)["'](\.{1,2}\/[^"']+)["']/g;

/** Resolve a relative specifier against the importing file, the way the TS bundler resolution would. */
function resolveImport(from: string, spec: string, exists: (p: string) => boolean): string | null {
  const base = posix.normalize(posix.join(posix.dirname(from), spec));
  const stripped = base.replace(/\.(js|mjs|jsx)$/, "");
  const candidates = [base, ...SOURCE_EXT.map((e) => stripped + e), ...SOURCE_EXT.map((e) => `${base}/index${e}`)];
  for (const c of candidates) if (exists(c)) return c;
  return null;
}

/** Direct relative imports of every source file under `root` (read-only). */
export function importGraph(root: string): Map<string, string[]> {
  const files: string[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === ".git" || name === "node_modules") continue;
      const abs = join(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      const st = statSync(abs);
      if (st.isDirectory()) walk(abs, r);
      else files.push(r);
    }
  };
  walk(root, "");
  const set = new Set(files);
  const out = new Map<string, string[]>();
  for (const f of files) {
    if (!SOURCE_EXT.some((e) => f.endsWith(e))) continue;
    const text = readFileSync(join(root, f), "utf8");
    const deps = new Set<string>();
    for (const m of text.matchAll(IMPORT_RE)) {
      const target = resolveImport(f, m[1]!, (p) => set.has(p));
      if (target && target !== f) deps.add(target);
    }
    out.set(f, [...deps].sort());
  }
  return out;
}

/** Build the model from parsed commits and the import graph. */
export function buildModel(
  commits: Array<{ hash: string; at: number; subject: string; files: string[] }>,
  imports: Map<string, string[]>,
  opts: { repo: string; head: string; cap: number; maxNeighbours: number },
): WorkloadModel {
  const used: string[][] = [];
  const dropped = { release: 0, generatedOnly: 0, tooBig: 0 };
  for (const c of commits) {
    if (RELEASE.test(c.subject.trim())) {
      dropped.release++;
      continue;
    }
    const files = [...new Set(c.files.filter((f) => !GENERATED.some((g) => g.test(f))))];
    if (files.length === 0) {
      dropped.generatedOnly++;
      continue;
    }
    if (files.length > opts.cap) {
      dropped.tooBig++;
      continue;
    }
    used.push(files);
  }
  const index = new Map<string, number>();
  const files: string[] = [];
  const touches: number[] = [];
  const idx = (f: string): number => {
    let i = index.get(f);
    if (i === undefined) {
      i = files.length;
      index.set(f, i);
      files.push(f);
      touches.push(0);
    }
    return i;
  };
  const sizeHist: number[] = new Array(opts.cap + 1).fill(0);
  const pairs = new Map<number, Map<number, number>>();
  for (const change of used) {
    sizeHist[change.length] = (sizeHist[change.length] ?? 0) + 1;
    const ids = change.map(idx);
    for (const i of ids) touches[i] = (touches[i] ?? 0) + 1;
    for (const a of ids) {
      let m = pairs.get(a);
      if (!m) {
        m = new Map();
        pairs.set(a, m);
      }
      for (const b of ids) if (a !== b) m.set(b, (m.get(b) ?? 0) + 1);
    }
  }
  // Import targets that were never touched still need an index (they can be read).
  for (const deps of imports.values()) for (const d of deps) idx(d);
  for (const f of imports.keys()) idx(f);
  const neighbours = files.map((_, i) =>
    [...(pairs.get(i) ?? new Map<number, number>())]
      .sort((x, y) => y[1] - x[1] || x[0] - y[0])
      .slice(0, opts.maxNeighbours)
      .map(([j, n]) => [j, n] as [number, number]),
  );
  const importsIdx = files.map((f) => (imports.get(f) ?? []).map((d) => index.get(d)!).filter((d) => d !== undefined));
  const atHead = files.filter((f) => imports.has(f)).length;
  const withReads = used.filter((ch) => ch.some((f) => (imports.get(f)?.length ?? 0) > 0)).length;
  const meanSize = used.reduce((n, c) => n + c.length, 0) / Math.max(1, used.length);
  const dates = commits.map((c) => c.at).filter((t) => t > 0);
  return {
    schema: "firetrident.workload/v1",
    source: {
      repo: opts.repo,
      head: opts.head,
      headDate: new Date(Math.max(...dates) * 1000).toISOString(),
      commitsSeen: commits.length,
      commitsUsed: used.length,
      firstDate: new Date(Math.min(...dates) * 1000).toISOString(),
      lastDate: new Date(Math.max(...dates) * 1000).toISOString(),
    },
    filters: [
      "merge commits excluded (git log --no-merges)",
      `release/version commits excluded (subject matches ${RELEASE.source}): ${dropped.release}`,
      `generated and lock files removed (deno_dist/, lockfiles); changes left empty: ${dropped.generatedOnly}`,
      `changes touching more than ${opts.cap} files excluded (mass edits): ${dropped.tooBig}`,
      "read sets: direct relative imports at HEAD of each written source file",
    ],
    sizeHist,
    files,
    touches,
    neighbours,
    imports: importsIdx,
    stats: {
      meanFilesPerChange: Math.round(meanSize * 100) / 100,
      singleFileChanges: sizeHist[1] ?? 0,
      distinctFilesTouched: touches.filter((t) => t > 0).length,
      sourceFilesAtHead: atHead,
      changesWithImportReads: withReads,
      meanDirectImports: Math.round((importsIdx.reduce((n, d) => n + d.length, 0) / Math.max(1, atHead)) * 100) / 100,
      maxTouches: Math.max(...touches),
      hottestFile: files[touches.indexOf(Math.max(...touches))] ?? "",
    },
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { repo: { type: "string" }, tree: { type: "string" }, out: { type: "string" }, cap: { type: "string" }, url: { type: "string" } },
    strict: true,
  });
  const repo = values.repo ?? "/tmp/ft-w2/hono";
  const tree = values.tree ?? repo;
  const out = values.out ?? "packages/bench/data/hono-workload.json";
  const cap = Number(values.cap ?? 30);
  const log = execFileSync("git", ["-C", repo, "log", "--no-merges", "--format=@@%H%x09%at%x09%s", "--name-only", "HEAD"], { maxBuffer: 256 * 1024 * 1024 }).toString();
  const head = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"]).toString().trim();
  if (!existsSync(tree)) throw new Error(`no tree at ${tree}`);
  const model = buildModel(parseLog(log), importGraph(tree), { repo: values.url ?? "https://github.com/honojs/hono", head, cap, maxNeighbours: 16 });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(model));
  console.log(JSON.stringify({ out, source: model.source, stats: model.stats, filters: model.filters }, null, 2));
}

function isEntry(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntry()) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
