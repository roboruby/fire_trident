import type { Path } from "@fire_trident/core";
import { relativeSpecifier } from "../agents/context.ts";
import { classify, resolveExact, rewriteSpecifiers, type Compiled } from "./compile.ts";
import { NODE_TEST_SHIM } from "./shim.ts";

/**
 * The module map one certification run loads into a Dynamic Worker. Each test file gets its own
 * copy of the modules it imports under a prefix (`t0/`, `t1/`, ...): `node --test` runs every file
 * in its own process, so module state never leaks from one file to the next. Keys keep their
 * trunk paths (`t0/src/http.ts`), so relative imports resolve exactly as written and errors name
 * the real files. The harness (`__ft_certify__/main.js`) imports each file's shim, then the file,
 * runs its tests and answers one JSON report.
 */

/** Where the harness and each prefix's node:test shim live inside the module map. */
export const HARNESS_DIR = "__ft_certify__";
export const MAIN_MODULE = `${HARNESS_DIR}/main.js`;
export const SHIM_MODULE = `${HARNESS_DIR}/node-test.js`;
/** Bumped whenever the shim or harness changes how results come out (part of the input digest). */
export const RUNNER_VERSION = "ft-node-test/1";

/** A module of the map: JavaScript or data. */
export type PlanModule = { js: string } | { json: unknown };

/** Limits of one run (per test, and for the whole run inside the worker). */
export interface RunConfig {
  testTimeoutMs: number;
  budgetMs: number;
}

/** What buildPlan needs: the test files to run (in order) and every compiled module they may reach. */
export interface PlanInput {
  tests: Path[];
  modules: ReadonlyMap<Path, Compiled>;
  config: RunConfig;
  /** One module copy per test file (default true); false shares one copy between files. */
  isolate?: boolean;
}

/** The Dynamic Worker's code: the main module, the module map, and the files it runs. */
export interface Plan {
  mainModule: string;
  modules: Record<string, PlanModule>;
  files: Array<{ path: Path; prefix: string }>;
  /** Characters of JavaScript in the map (the shim and harness included). */
  bytes: number;
}

/** The modules a test file reaches through relative imports (itself first), resolved exactly. */
export function closureOf(test: Path, modules: ReadonlyMap<Path, Compiled>): Path[] {
  const files = new Set(modules.keys());
  const seen = new Set<Path>([test]);
  const order: Path[] = [test];
  for (let i = 0; i < order.length; i++) {
    const c = modules.get(order[i]!);
    if (!c) continue;
    for (const spec of c.imports) {
      if (classify(spec).kind !== "relative") continue;
      const target = resolveExact(c.path, spec, files);
      if (target !== null && !seen.has(target)) {
        seen.add(target);
        order.push(target);
      }
    }
  }
  return order;
}

/** The code a module gets in the map: its JavaScript with specifiers rewritten, a throwing stub, or data. */
function moduleFor(c: Compiled): PlanModule {
  if (c.error !== undefined) return { js: `throw new SyntaxError(${JSON.stringify(c.error)});\n` };
  if (c.kind === "json") return { json: c.json ?? null };
  return { js: rewriteSpecifiers(c.code ?? "", relativeSpecifier(c.path, SHIM_MODULE)) };
}

/** Build the module map and harness for one run. */
export function buildPlan(p: PlanInput): Plan {
  const isolate = p.isolate !== false;
  const modules: Record<string, PlanModule> = {};
  const files: Array<{ path: Path; prefix: string }> = [];
  const prepared = new Map<Path, PlanModule>();
  const prep = (path: Path): PlanModule | null => {
    const hit = prepared.get(path);
    if (hit) return hit;
    const c = p.modules.get(path);
    if (!c) return null;
    const m = moduleFor(c);
    prepared.set(path, m);
    return m;
  };
  p.tests.forEach((test, i) => {
    const prefix = isolate ? `t${i}/` : "t0/";
    files.push({ path: test, prefix });
    for (const path of closureOf(test, p.modules)) {
      const m = prep(path);
      if (m) modules[prefix + path] = m;
    }
    modules[prefix + SHIM_MODULE] = { js: NODE_TEST_SHIM };
  });
  modules[MAIN_MODULE] = { js: harnessSource(files, p.config) };
  let bytes = 0;
  for (const m of Object.values(modules)) bytes += "js" in m ? m.js.length : JSON.stringify(m.json ?? null).length;
  return { mainModule: MAIN_MODULE, modules, files, bytes };
}

/** The harness module: runs each file's tests in order and answers one JSON report. */
export function harnessSource(files: Array<{ path: Path; prefix: string }>, config: RunConfig): string {
  const rows = files.map(
    (f) =>
      `  { path: ${JSON.stringify(f.path)}, shim: () => import(${JSON.stringify(`../${f.prefix}${SHIM_MODULE}`)}), main: () => import(${JSON.stringify(`../${f.prefix}${f.path}`)}) },`,
  );
  return `// Trunk certification harness (FireTrident): one Dynamic Worker runs every test file.\nconst FILES = [\n${rows.join("\n")}\n];\nconst CONFIG = ${JSON.stringify(config)};\n${HARNESS_BODY}`;
}

const HARNESS_BODY = String.raw`
function race(p, ms, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), Math.max(0, ms));
    p.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

const unhandled = [];
try {
  addEventListener("unhandledrejection", (event) => {
    if (unhandled.length < 20) unhandled.push(String(event && event.reason && event.reason.message ? event.reason.message : event && event.reason));
    if (event && typeof event.preventDefault === "function") event.preventDefault();
  });
} catch (e) { /* no global event target */ }

export async function runAll() {
  const started = Date.now();
  const deadline = started + CONFIG.budgetMs;
  const out = { runner: "ft-node-test/1", files: [], tests: [], suites: [], diagnostics: [], unhandled, ms: 0 };
  let exhausted = false;
  for (const f of FILES) {
    const t0 = Date.now();
    if (exhausted || t0 >= deadline) {
      out.files.push({ path: f.path, ms: 0, tests: 1, loadError: "not run: the certification ran out of time" });
      out.tests.push({ name: f.path, file: f.path, status: "cancelled", error: "not run: the certification ran out of time" });
      continue;
    }
    let shim;
    try {
      shim = await f.shim();
    } catch (e) {
      out.files.push({ path: f.path, ms: 0, tests: 0, loadError: "runner failed: " + String(e && e.message ? e.message : e) });
      continue;
    }
    shim.__ft.begin({ file: f.path, deadline, timeoutMs: CONFIG.testTimeoutMs });
    let loadError = null;
    try {
      await race(f.main(), deadline - Date.now(), "the test file did not finish loading before the certification ran out of time");
    } catch (e) {
      loadError = e === undefined || e === null ? new Error("the test file failed to load") : e;
    }
    const r = await shim.__ft.finish(loadError);
    if (r.exhausted) exhausted = true;
    out.files.push({ path: f.path, ms: Date.now() - t0, tests: r.tests.length, loadError: r.loadError });
    for (const t of r.tests) out.tests.push(t);
    for (const s of r.suites) out.suites.push(s);
    for (const d of r.diagnostics || []) if (out.diagnostics.length < 50) out.diagnostics.push(d);
  }
  out.ms = Date.now() - started;
  return out;
}

export default {
  async fetch() {
    const out = await runAll();
    return new Response(JSON.stringify(out), { headers: { "content-type": "application/json" } });
  },
};
`;
