import type { Path } from "@fire_trident/core";
import { resolveRelative } from "../agents/context.ts";
import { importBindings } from "../decide/mechanical.ts";
import { HARNESS_DIR, MAIN_MODULE, harnessSource, type Plan, type PlanModule } from "./plan.ts";
import { readBounded } from "./report.ts";

/**
 * A module the test runtime cannot compile. The test Worker compiles every module of its map when it starts, so one
 * module with a syntax error, early errors included ("Identifier 'assert' has already been declared"), stops the whole
 * Worker before any test runs, while `node --test` fails only the test files that load it. A module that fails to link
 * (a named import another module does not export) is not this case: the runtime links each test file when the harness
 * imports it, so that already fails the one file.
 *
 * When a run's Worker does not start, its modules are compiled again without running anything: a probe Worker holds a
 * set of them (each once, under its trunk path) beside a main module that imports none of them, so starting it compiles
 * them and runs no code from the repository. Halving the set finds the modules that do not compile. Each is replaced in
 * the run's map by a module that throws its compile error, as a file the transpiler refused already is (plan.ts), and
 * the run starts again: a test file that reaches one fails with that error, and every other file runs as usual. All of
 * it stays within the run's own time limit. When the probes name no module (the Worker failed to start for another
 * reason, or the time or the probe budget ran out), the run's error stands.
 *
 * Every file's tests run in their own module scope (one ES module per file, never one bundle), so a top-level name in
 * one test file never collides with another file's; what they share is the Worker's global object.
 */

/** The probe Worker's main module: it imports nothing, so starting the Worker only compiles the modules beside it. */
export const PROBE_MODULE = `${HARNESS_DIR}/probe.js`;
const PROBE_SOURCE = 'export default {\n  fetch() {\n    return new Response("started");\n  },\n};\n';
/** Probe Workers one failed start may load at most. */
export const MAX_PROBES = 64;
/** Time a probe may take at most. */
const PROBE_MS = 10_000;
/** The run starts again only with at least this much of its time left. */
export const MIN_RERUN_MS = 4_000;
/** Time the harness leaves for its report (as the callers that build plans do). */
const REPORT_MS = 3_000;
/** Characters of a compile error kept. */
const MAX_ERROR = 300;
/** Bytes of a probe's failed answer kept as its error. */
const MAX_ANSWER_BYTES = 1024;

/** One module of a run, by its trunk path, with its JavaScript. */
export interface ProbeModule {
  path: Path;
  js: string;
}

/** Starts a Worker holding `modules` (and nothing that runs them): null when it started, else the runtime's error. */
export type StartProbe = (modules: readonly ProbeModule[], timeoutMs: number) => Promise<string | null>;

/** The modules that do not compile, each with its error, and the probes it took to find them. */
export interface Uncompilable {
  bad: Map<Path, string>;
  probes: number;
}

/** The run's JavaScript modules from the repository, each once under its trunk path (the harness and its shims left out). */
export function probeModules(plan: Pick<Plan, "modules">): ProbeModule[] {
  const out: ProbeModule[] = [];
  const seen = new Set<Path>();
  for (const [key, m] of Object.entries(plan.modules)) {
    if (key === MAIN_MODULE || !("js" in m)) continue;
    const path = key.replace(/^t\d+\//, "");
    if (path.startsWith(`${HARNESS_DIR}/`) || seen.has(path)) continue;
    seen.add(path);
    out.push({ path, js: m.js });
  }
  return out;
}

/**
 * The runtime's compile error as one plain line, with the line it names when it names one in `path`:
 * "Failed to start Worker:\nUncaught SyntaxError: Unexpected token ';'\n  at src/a.ts:3:17" is "Unexpected token ';'" at line 3.
 */
export function startError(message: string, path?: Path): { text: string; line?: number } {
  const lines = String(message)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !/^failed to start worker:?$/i.test(l));
  let line: number | undefined;
  for (const l of lines) {
    const at = /^at\s+(\S+?):(\d+)(?::\d+)?$/.exec(l);
    if (at && path !== undefined && at[1] === path) line = Number(at[2]);
  }
  const first = lines.find((l) => !/^at\s/.test(l)) ?? "the module does not compile";
  let text = first
    .replace(/^failed to start worker:\s*/i, "")
    .replace(/^uncaught\s+/i, "")
    .replace(/^SyntaxError:\s*/, "");
  if (text === "") text = "the module does not compile";
  if (text.length > MAX_ERROR) text = `${text.slice(0, MAX_ERROR - 1)}…`;
  return line !== undefined ? { text, line } : { text };
}

/**
 * Find the modules that stop a Worker from starting, by halves (see the module comment). Null when the whole set starts
 * (nothing here fails to compile), when the probes cannot pin the failure on single modules, or when the time
 * (`deadline`) or the probe budget runs out first.
 */
export async function findUncompilable(
  modules: readonly ProbeModule[],
  start: StartProbe,
  limits: { deadline: number; now: () => number; maxProbes?: number },
): Promise<Uncompilable | null> {
  const max = limits.maxProbes ?? MAX_PROBES;
  let probes = 0;
  /** One probe within the limits: undefined when no probe may start, else what start() said. */
  const probe = async (set: readonly ProbeModule[]): Promise<string | null | undefined> => {
    const left = limits.deadline - limits.now();
    if (probes >= max || left < MIN_RERUN_MS) return undefined;
    probes++;
    return start(set, Math.min(PROBE_MS, left - MIN_RERUN_MS / 2));
  };
  if (modules.length === 0) return null;
  const first = await probe(modules);
  if (first === undefined || first === null) return null;
  const bad = new Map<Path, string>();
  // A set that fails, with the error its probe gave; `inferred` when it was not probed itself (its sibling started).
  const stack: Array<{ set: readonly ProbeModule[]; error: string; inferred: boolean }> = [{ set: modules, error: first, inferred: false }];
  while (stack.length > 0) {
    const { set, error, inferred } = stack.pop()!;
    if (set.length === 1) {
      const only = set[0]!;
      if (!inferred) {
        bad.set(only.path, error);
        continue;
      }
      // Its sibling started, so the failure was this module's; it is confirmed alone before it is named.
      const own = await probe(set);
      if (own === undefined || own === null) return null;
      bad.set(only.path, own);
      continue;
    }
    const half = Math.ceil(set.length / 2);
    const left = set.slice(0, half);
    const right = set.slice(half);
    const l = await probe(left);
    if (l === undefined) return null;
    if (l === null) {
      stack.push({ set: right, error, inferred: true });
      continue;
    }
    stack.push({ set: left, error: l, inferred: false });
    const r = await probe(right);
    if (r === undefined) return null;
    if (r !== null) stack.push({ set: right, error: r, inferred: false });
  }
  return bad.size > 0 ? { bad, probes } : null;
}

/**
 * A module that throws its compile error when it is evaluated, naming the file (and the line, when known). It exports
 * the names its importers take from it (`names`), so they link and the error, not a missing export, is what they see.
 */
function throwing(path: Path, error: string, names: ReadonlySet<string>): PlanModule {
  const { text, line } = startError(error, path);
  const message = `${path}${line !== undefined ? `:${line}` : ""}: ${text}`;
  const list = [...names];
  const exports =
    list.length > 0 ? `let ${list.map((_, i) => `__ft_${i}`).join(", ")};\nexport { ${list.map((n, i) => `__ft_${i} as ${JSON.stringify(n)}`).join(", ")} };\n` : "";
  // The stack names no line of this stand-in, so the failure points at the file, not at line 1 of a stub.
  return { js: `const error = new SyntaxError(${JSON.stringify(message)});\nerror.stack = "SyntaxError: " + error.message;\nthrow error;\n${exports}` };
}

/** Per module key of `targets`: the names the map's other modules import from it by a relative specifier. */
function namesImported(modules: Record<string, PlanModule>, targets: ReadonlySet<string>): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const key of targets) out.set(key, new Set());
  for (const [key, m] of Object.entries(modules)) {
    if (!("js" in m) || targets.has(key)) continue;
    for (const b of importBindings(m.js)) {
      const target = b.names ? resolveRelative(key, b.specifier) : null;
      const set = target !== null ? out.get(target) : undefined;
      if (set) for (const n of b.names!) set.add(n);
    }
  }
  return out;
}

/**
 * The plan with each module of `bad` (by trunk path) replaced, in every test file's copy, by one that throws its compile
 * error. The harness is rebuilt to finish within `budgetMs` when the plan carries its limits.
 */
export function withoutUncompilable(plan: Plan, bad: ReadonlyMap<Path, string>, budgetMs: number): Plan {
  const keys = new Set(Object.keys(plan.modules).filter((key) => key !== MAIN_MODULE && bad.has(key.replace(/^t\d+\//, ""))));
  const names = namesImported(plan.modules, keys);
  const modules: Record<string, PlanModule> = {};
  for (const [key, m] of Object.entries(plan.modules)) {
    const path = key.replace(/^t\d+\//, "");
    modules[key] = keys.has(key) ? throwing(path, bad.get(path)!, names.get(key) ?? new Set()) : m;
  }
  let config = plan.config;
  if (config) {
    config = { ...config, budgetMs: Math.max(1_000, Math.min(config.budgetMs, budgetMs - REPORT_MS)) };
    modules[MAIN_MODULE] = { js: harnessSource(plan.files, config) };
  }
  let bytes = 0;
  for (const m of Object.values(modules)) bytes += "js" in m ? m.js.length : JSON.stringify(m.json ?? null).length;
  return { ...plan, modules, bytes, ...(config ? { config } : {}) };
}

/** The probe Worker's code for `modules`: each under its trunk path, beside a main module that imports none of them. */
export function probeCode(modules: readonly ProbeModule[]): { mainModule: string; modules: Record<string, PlanModule> } {
  const map: Record<string, PlanModule> = {};
  for (const m of modules) map[m.path] = { js: m.js };
  map[PROBE_MODULE] = { js: PROBE_SOURCE };
  return { mainModule: PROBE_MODULE, modules: map };
}

/** How a probe Worker is loaded: the test Worker's compatibility date and its CPU limit. */
export interface ProbeLimits {
  compatibilityDate: string;
  maxCpuMs: number;
}

/** A probe that did not answer in time: it says nothing about the modules, so the search stops. */
class ProbeLate extends Error {}

/**
 * Start a probe Worker holding `modules` and running none of them (probeCode): null when it started, else the
 * runtime's error. Throws when it does not answer within `timeoutMs`.
 */
export async function probeStart(loader: WorkerLoader, modules: readonly ProbeModule[], timeoutMs: number, limits: ProbeLimits): Promise<string | null> {
  const code = probeCode(modules);
  let answer: Promise<Response | string>;
  try {
    const worker = loader.load({
      compatibilityDate: limits.compatibilityDate,
      compatibilityFlags: ["nodejs_compat"],
      mainModule: code.mainModule,
      modules: code.modules as Record<string, WorkerLoaderModule>,
      globalOutbound: null,
      limits: { cpuMs: Math.min(limits.maxCpuMs, timeoutMs) },
    });
    answer = worker
      .getEntrypoint()
      .fetch("https://certify.invalid/probe")
      .catch((err: unknown) => errorText(err));
  } catch (err) {
    return errorText(err);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ProbeLate("a probe of the test Worker's modules did not answer in time")), timeoutMs);
  });
  let res: Response | string;
  try {
    res = await Promise.race([answer, late]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  if (typeof res === "string") return res;
  if (res.ok) {
    await res.body?.cancel().catch(() => undefined);
    return null;
  }
  // The probe's own main module always answers 200: anything else is the runtime's.
  const head = await readBounded(res.body, MAX_ANSWER_BYTES, Date.now() + Math.min(timeoutMs, 2_000));
  return head.text.trim() || `the probe Worker answered ${res.status}`;
}

/**
 * After a run's Worker failed to start (an error from the runtime, not one the run raised itself): the plan with the
 * modules that do not compile replaced, found with probe Workers before `deadline`; null when none is found in time.
 */
export async function afterFailedStart(plan: Plan, loader: WorkerLoader, opts: ProbeLimits & { deadline: number; now?: () => number }): Promise<Plan | null> {
  const now = opts.now ?? Date.now;
  try {
    const found = await findUncompilable(probeModules(plan), (modules, ms) => probeStart(loader, modules, ms, opts), { deadline: opts.deadline, now });
    const left = opts.deadline - now();
    if (!found || left < MIN_RERUN_MS) return null;
    console.log(`certification: ${found.bad.size} module(s) do not compile (${[...found.bad.keys()].slice(0, 3).join(", ")}), found with ${found.probes} probe(s); the run starts again without them`);
    return withoutUncompilable(plan, found.bad, left);
  } catch (err) {
    console.warn(`certification: the module that stopped the test Worker was not found: ${errorText(err)}`);
    return null;
  }
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
