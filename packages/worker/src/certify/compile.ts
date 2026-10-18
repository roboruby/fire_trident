import { importsOf } from "@fire_trident/core";
import type { Path } from "@fire_trident/core";
import { transform } from "sucrase";
import { resolveRelative } from "../agents/context.ts";
import { erasableProblems } from "../agents/create.ts";
import { VITEST_EXPORTS } from "./vitest.ts";

/**
 * Turning trunk files into modules a Dynamic Worker can run. TypeScript is transpiled with
 * sucrase's typescript transform the way Node runs it (types erased, nothing else): imports that
 * are not `import type` are kept even when only types use them, and TypeScript that type
 * stripping cannot run (enums, namespaces, parameter properties) fails to load, as it does in Node.
 */

/** Test files certification runs: every `*.test.ts` and `*.test.js` file, under test/ or anywhere else. */
export const TEST_FILE = /(^|\/)[^/]+\.test\.(ts|js)$/;
/** Files certification reads: sources and data a test can import. */
export const MODULE_FILE = /\.(ts|js|mjs|json)$/;

/** The test runners certification runs: node:test, and vitest through a layer over the node:test shim (vitest.ts). */
export type Runner = "node:test" | "vitest";

/** A vitest (or vite) configuration file: in a project with one, a test file may use vitest's globals without importing them. */
export const VITEST_CONFIG = /(^|\/)(vitest\.(config|workspace)|vite\.config)\.[cm]?[jt]s$/;

const CONFIG_SETTINGS: Array<[RegExp, string]> = [
  [/\bsetupFiles\s*:/, "setup files"],
  [/\bglobalSetup\s*:/, "a global setup"],
  [/\bplugins\s*:/, "plugins"],
  [/\balias\s*:/, "import aliases"],
  [/\bbrowser\s*:/, "a browser"],
  [/\benv\s*:/, "environment variables"],
  [/\benvironment\s*:\s*["'`](?!node["'`])/, "a test environment other than Node"],
  [/\bpool\s*:\s*["'`](?!(forks|threads|vmThreads|vmForks)["'`])/, "a custom pool"],
];

/**
 * What a vitest configuration sets that trunk certification does not apply (setup files, plugins, aliases, an
 * environment other than Node, environment variables), or null. Read from its text: the configuration is never run.
 */
export function configProblem(code: string): string | null {
  const bare = stripComments(code);
  for (const [re, what] of CONFIG_SETTINGS) if (re.test(bare)) return what;
  return null;
}

/**
 * The vitest configuration nearest a test file (the deepest one in its directory or a directory above), or null. In
 * one directory vitest's own configuration wins over vite's, as vitest picks it.
 */
export function nearestConfig(test: Path, configs: readonly Path[]): Path | null {
  const rank = (c: Path): number => {
    const dir = c.includes("/") ? c.slice(0, c.lastIndexOf("/") + 1) : "";
    return dir.length * 2 + (/(^|\/)vitest\.[^/]+$/.test(c) ? 1 : 0);
  };
  let best: Path | null = null;
  for (const c of configs) {
    const dir = c.includes("/") ? c.slice(0, c.lastIndexOf("/") + 1) : "";
    if (test.startsWith(dir) && (best === null || rank(c) > rank(best))) best = c;
  }
  return best;
}

/**
 * Node built-in modules the Dynamic Worker provides (nodejs_compat) and tests may use. A test file
 * whose imports reach another built-in (a file system, processes, sockets) is not run: it would fail
 * for a reason that is not the code's.
 */
export const BUILTINS: ReadonlySet<string> = new Set([
  "assert",
  "assert/strict",
  "async_hooks",
  "buffer",
  "crypto",
  "diagnostics_channel",
  "events",
  "path",
  "path/posix",
  "perf_hooks",
  "process",
  "querystring",
  "stream",
  "stream/promises",
  "stream/web",
  "string_decoder",
  "timers",
  "timers/promises",
  "url",
  "util",
  "util/types",
  "zlib",
]);

/** What an import specifier names. */
export type SpecifierKind = { kind: "relative" } | { kind: "builtin"; name: string } | { kind: "package"; name: string } | { kind: "unsupported"; name: string };

/** Classify an import specifier: a relative path, a usable Node built-in, a package, or a built-in the runner does not provide. */
export function classify(spec: string): SpecifierKind {
  if (spec === "." || spec === ".." || spec.startsWith("./") || spec.startsWith("../") || spec.startsWith("/")) return { kind: "relative" };
  if (spec === "node:test") return { kind: "builtin", name: "test" };
  if (spec === "vitest") return { kind: "builtin", name: "vitest" };
  const bare = spec.startsWith("node:") ? spec.slice(5) : spec;
  if (BUILTINS.has(bare)) return { kind: "builtin", name: bare };
  if (spec.startsWith("node:")) return { kind: "unsupported", name: spec };
  const parts = spec.split("/");
  const name = spec.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? spec);
  return { kind: "package", name };
}

/** One trunk file prepared for the runner. */
export interface Compiled {
  path: Path;
  kind: "js" | "json";
  /** JavaScript (or the parsed JSON), or null when the file cannot load. */
  code: string | null;
  json?: unknown;
  /** Why the file cannot load, phrased as Node would fail it. */
  error?: string;
  /** Every import specifier left after type erasure (static, dynamic, re-exports). */
  imports: string[];
  /**
   * The file compiled as vitest compiles it (compileVitest), for test files vitest runs and the modules they reach;
   * absent until a vitest test file needs it.
   */
  vitest?: Compiled;
  /** Why trunk certification cannot run this file under vitest (a limitation of the runner, not the code's fault): test files that reach it are left out. */
  unsupported?: string;
  /** On a test file in a load's module map: the runner that runs it (load.ts); absent means node:test. */
  runner?: Runner;
}

/**
 * Prepare one file: JSON is parsed, TypeScript is transpiled (types erased only), JavaScript is
 * kept as written. A file that cannot load keeps an `error` and a null `code`.
 */
export function compile(path: Path, text: string): Compiled {
  if (path.endsWith(".json")) {
    try {
      return { path, kind: "json", code: null, json: JSON.parse(text), imports: [] };
    } catch (e) {
      return { path, kind: "json", code: null, error: `SyntaxError: ${path} is not valid JSON (${errorMessage(e)})`, imports: [] };
    }
  }
  if (path.endsWith(".ts")) {
    const strip = erasableProblems(path, text);
    if (strip.length > 0) return { path, kind: "js", code: null, error: `SyntaxError: ${path}: TypeScript that type stripping cannot run: ${strip[0]}`, imports: [] };
    try {
      const code = guardBareFields(text, transform(text, { transforms: ["typescript"], disableESTransforms: true, keepUnusedImports: true, filePath: path }).code);
      return { path, kind: "js", code, imports: specifiers(code) };
    } catch (e) {
      return { path, kind: "js", code: null, error: `SyntaxError: ${path}: ${errorMessage(e)}`, imports: [] };
    }
  }
  return { path, kind: "js", code: text, imports: specifiers(text) };
}

const VITEST_MOCKING = /(^|[^\w$.])(?:vi|vitest)\s*\.\s*(mock|doMock|unmock|doUnmock|importActual|importMock)\s*\(/;

/**
 * Prepare one file as vitest runs it: TypeScript compiled the way vite does for tests (types erased, imports that only
 * types use removed, enums and parameter properties compiled), JSON parsed, JavaScript kept. A file this runner cannot
 * compile (JSX, a namespace with values) or run honestly (module mocking, an export of vitest the shim does not have)
 * carries `unsupported` with the reason; a syntax error is the code's, as in compile().
 */
export function compileVitest(path: Path, text: string): Compiled {
  if (path.endsWith(".json")) return compile(path, text);
  if (/\.[cm]?[jt]sx$/.test(path)) return { path, kind: "js", code: null, error: `${path}: JSX`, imports: [], unsupported: `${path} is JSX, which trunk certification does not compile` };
  let code = text;
  if (/\.[cm]?ts$/.test(path)) {
    const ns = valueNamespace(text);
    if (ns !== null) return { path, kind: "js", code: null, error: `${path}: a namespace with values`, imports: [], unsupported: `${path} declares a namespace with values (line ${ns}), which trunk certification does not compile` };
    try {
      code = dropTypeExports(guardBareFields(text, transform(text, { transforms: ["typescript"], disableESTransforms: true, filePath: path }).code), typeOnlyImports(text));
    } catch (e) {
      return { path, kind: "js", code: null, error: `SyntaxError: ${path}: ${errorMessage(e)}`, imports: [] };
    }
  }
  const out: Compiled = { path, kind: "js", code, imports: specifiers(code) };
  const why = vitestProblem(path, code);
  if (why !== null) out.unsupported = why;
  return out;
}

/** Why vitest code cannot run honestly here (module mocking, a name the vitest shim does not export), or null. */
function vitestProblem(path: Path, code: string): string | null {
  const bare = stripComments(code);
  const mocking = VITEST_MOCKING.exec(bare);
  if (mocking) return `${path} uses vi.${mocking[2]} (module mocking), which trunk certification does not support`;
  if (!code.includes("vitest")) return null;
  for (const m of bare.matchAll(IMPORT_CLAUSE)) {
    if (m[2] !== "vitest") continue;
    const clause = m[1]!;
    if (/^[\w$]+\s*(,|$)/.test(clause) && !clause.startsWith("*")) return `${path} imports the default export of vitest, which has none`;
    const named = /\{([^}]*)\}/.exec(clause);
    for (const part of named ? named[1]!.split(",") : []) {
      const name = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]!.trim();
      if (name !== "" && !VITEST_EXPORTS.has(name)) return `${path} imports ${name} from vitest, which trunk certification does not provide`;
    }
  }
  return null;
}

/** The line of the first namespace declaration with values in its body (types-only namespaces erase), or null. */
function valueNamespace(text: string): number | null {
  const head = /^[ \t]*(?:export[ \t]+)?(?:namespace|module)[ \t]+[A-Za-z_$][\w$.]*[ \t]*\{/gm;
  for (let m = head.exec(text); m !== null; m = head.exec(text)) {
    let depth = 0;
    let end = text.length;
    for (let i = m.index + m[0].length - 1; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}" && --depth === 0) {
        end = i;
        break;
      }
    }
    const body = stripComments(text.slice(m.index + m[0].length, end));
    if (/^[ \t]*(?:export[ \t]+)?(?:const|let|var|function|class|enum|abstract[ \t]+class)\b/m.test(body) || /^[ \t]*export[ \t]+default\b/m.test(body)) return text.slice(0, m.index).split("\n").length;
  }
  return null;
}

/** Text with block and line comments blanked (a coarse pass for detection only: never for code that runs). */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
}

/** What a test file's text says about the runner it was written for. */
export interface RunnerHints {
  /** It imports vitest (types included). */
  vitest: boolean;
  /** It calls describe / it / test / expect without importing them from anywhere (vitest's globals). */
  globals: boolean;
}

/** One import declaration's clause and specifier (default, named and namespace forms; code without semicolons too). */
const IMPORT_CLAUSE = /\bimport\s+((?:type\s+)?(?:[\w$]+\s*,\s*)?(?:\{[^}]*\}|\*\s*as\s+[\w$]+)|(?:type\s+)?[\w$]+)\s*from\s*["']([^"'\n]+)["']/g;
const RUNNER_NAMES = new Set(["describe", "it", "test", "suite", "expect"]);

/** Does the code import a name describe / it / test / suite / expect binds (from another runner, or a helper)? */
function bindsRunnerName(bare: string): boolean {
  for (const m of bare.matchAll(IMPORT_CLAUSE)) {
    const named = /\{([^}]*)\}/.exec(m[1]!);
    for (const part of named ? named[1]!.split(",") : []) {
      const local = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/).pop()!.trim();
      if (RUNNER_NAMES.has(local)) return true;
    }
  }
  return false;
}

const RUNNER_CALL = /(^|[^\w$.])(describe|it|test|suite|expect)\s*(\.\s*(skip|only|todo|each|concurrent|sequential|skipIf|runIf|fails|for)\b[\s\S]{0,40}?)?\(/m;

/** Read a test file's text for the runner it was written for (importsOf skips comments and strings). */
export function runnerHints(text: string): RunnerHints {
  const vitest = importsOf(text).some((i) => i.specifier === "vitest");
  const bare = stripComments(text);
  return { vitest, globals: RUNNER_CALL.test(bare) && !bindsRunnerName(bare) };
}

const VITE_EXTS = [".mjs", ".js", ".mts", ".ts", ".jsx", ".tsx", ".json"];
const TS_TWINS: Array<[string, string[]]> = [
  [".js", [".ts", ".tsx"]],
  [".jsx", [".tsx"]],
  [".mjs", [".mts"]],
  [".cjs", [".cts"]],
];

/**
 * The file a relative specifier names as vite resolves it for vitest: the path as written, a TypeScript file's ".js"
 * import of its ".ts" twin, the path plus an extension, then the directory's index file. Null when none is in `files`.
 */
export function resolveVite(from: Path, spec: string, files: ReadonlySet<Path>): Path | null {
  if (spec.startsWith("/")) return null;
  const target = resolveRelative(from, spec.replace(/[?#].*$/, ""));
  if (target === null) return null;
  if (target !== "") {
    if (files.has(target)) return target;
    if (/\.[cm]?tsx?$/.test(from)) {
      for (const [js, twins] of TS_TWINS) {
        if (!target.endsWith(js)) continue;
        for (const t of twins) if (files.has(target.slice(0, -js.length) + t)) return target.slice(0, -js.length) + t;
      }
    }
    for (const e of VITE_EXTS) if (files.has(target + e)) return target + e;
  }
  const base = target === "" ? "index" : `${target}/index`;
  for (const e of VITE_EXTS) if (files.has(base + e)) return base + e;
  return null;
}

/**
 * The files vite may resolve a relative specifier to, in its order, among the file types the trunk index lists: what
 * to ask an older commit for when reading a vitest test file's imports without its full listing (bisect.ts).
 */
export function viteCandidates(from: Path, spec: string): Path[] {
  const target = resolveRelative(from, spec.replace(/[?#].*$/, ""));
  if (target === null) return [];
  const out: Path[] = [];
  if (target !== "") {
    out.push(target);
    if (/\.[cm]?tsx?$/.test(from)) for (const [js, twins] of TS_TWINS) if (target.endsWith(js)) for (const t of twins) out.push(target.slice(0, -js.length) + t);
    for (const e of VITE_EXTS) out.push(target + e);
  }
  const base = target === "" ? "index" : `${target}/index`;
  for (const e of VITE_EXTS) out.push(base + e);
  return [...new Set(out)].filter((p) => MODULE_FILE.test(p));
}

/** The vitest configuration files that could govern `files` (each name in each directory above them), for reading an older commit. */
export function configCandidates(files: readonly Path[]): Path[] {
  const out = new Set<Path>();
  for (const f of files) {
    const parts = f.split("/").slice(0, -1);
    for (let i = 0; i <= parts.length; i++) {
      const dir = parts.slice(0, i).join("/");
      for (const name of ["vitest.config", "vite.config", "vitest.workspace"]) for (const ext of [".ts", ".js", ".mjs"]) out.add(dir === "" ? name + ext : `${dir}/${name}${ext}`);
    }
  }
  return [...out];
}

/** The file a relative specifier names for a runner: exactly as written for node:test, as vite resolves it for vitest. */
export function resolveFor(runner: Runner, from: Path, spec: string, files: ReadonlySet<Path>): Path | null {
  return runner === "vitest" ? resolveVite(from, spec, files) : resolveExact(from, spec, files);
}

/** The import specifiers of a module as a runner loads it (vitest loads its own compilation when there is one). */
export function importsFor(c: Compiled, runner: Runner): string[] {
  return runner === "vitest" && c.vitest ? c.vitest.imports : c.imports;
}

function specifiers(code: string): string[] {
  return [...new Set(importsOf(code).map((i) => i.specifier))];
}

const BARE_FIELD = /^[ \t]*(get|set|static|async|accessor)[ \t]*$/;
const TYPED_FIELD = /^[ \t]*(?:(?:public|private|protected|readonly|declare|override)[ \t]+)*(get|set|static|async|accessor)[ \t]*[!?]?[ \t]*:/;

/**
 * Type erasure can leave a class field named get, set, static, async or accessor alone on its line (`get!: Handler`
 * becomes `get`; `set: Setter<...> = fn` becomes `set`, blank lines, `= fn`), which JavaScript then reads together
 * with what follows as a getter, a setter or a modifier. Such a name is quoted ("get"), which declares the same field
 * and cannot combine. (The transpiler keeps line numbers, so lines match one to one.)
 */
function guardBareFields(source: string, code: string): string {
  if (!/\b(get|set|static|async|accessor)[ \t]*[!?]?[ \t]*:/.test(source)) return code;
  const src = source.split("\n");
  const out = code.split("\n");
  if (src.length !== out.length) return code;
  for (let i = 0; i < out.length; i++) if (BARE_FIELD.test(out[i]!) && TYPED_FIELD.test(src[i]!)) out[i] = out[i]!.replace(/(get|set|static|async|accessor)/, '"$1"');
  return out.join("\n");
}

/** Names a TypeScript file imports only as types (`import type { A }`, `import type B from`, `import type * as C`). */
function typeOnlyImports(source: string): Set<string> {
  const out = new Set<string>();
  for (const m of stripComments(source).matchAll(/\bimport\s+type\s+(?:\{([^}]*)\}|\*\s*as\s+([\w$]+)|([\w$]+))/g)) {
    if (m[2]) out.add(m[2]);
    if (m[3]) out.add(m[3]);
    for (const part of m[1] ? m[1].split(",") : []) {
      const local = part.trim().split(/\s+as\s+/).pop()!.trim();
      if (local !== "") out.add(local);
    }
  }
  return out;
}

/**
 * Drop names imported only as types from the module's own export lists (`export { DOMAttributes }`), as vite's
 * compiler does; the transpiler keeps them, and an export of a binding that no longer exists does not link.
 */
function dropTypeExports(code: string, types: ReadonlySet<string>): string {
  if (types.size === 0) return code;
  return code.replace(/\bexport\s*\{([^}]*)\}(?!\s*from\b)/g, (all: string, list: string) => {
    const kept: string[] = [];
    let lines = 0;
    for (const part of list.split(",")) {
      const local = part.trim().split(/\s+as\s+/)[0]!.trim();
      if (local !== "" && types.has(local)) {
        lines += part.split("\n").length - 1;
        continue;
      }
      kept.push(lines > 0 ? "\n".repeat(lines) + part : part);
      lines = 0;
    }
    return `export {${kept.join(",")}${"\n".repeat(lines)}}`;
  });
}

function errorMessage(e: unknown): string {
  const first = e instanceof Error ? (e.message.split("\n")[0] ?? e.message) : String(e);
  return first.replace(/^Error transforming [^:]+: /, "");
}

/**
 * The file a relative specifier names, resolved exactly as Node resolves it: the path as written
 * (no extension guessing, no index files), and only when it is one of `files`. Null otherwise
 * (the import then fails at load time, as it would under `node --test`).
 */
export function resolveExact(from: Path, spec: string, files: ReadonlySet<Path>): Path | null {
  if (spec.startsWith("/")) return null;
  const target = resolveRelative(from, spec);
  return target !== null && target !== "" && files.has(target) ? target : null;
}

const SPECIFIER = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)(["'])([^"'\n]+)\2/g;

/**
 * Rewrite import specifiers for the runner: `node:test` becomes the certification shim (`shim`,
 * a relative specifier from this module), and a bare built-in such as "assert" gets its `node:`
 * prefix. Everything else is left as written.
 */
export function rewriteSpecifiers(code: string, shim: string, vitestShim?: string): string {
  return code.replace(SPECIFIER, (all: string, lead: string, quote: string, spec: string) => {
    if (spec === "node:test") return `${lead}${quote}${shim}${quote}`;
    if (spec === "vitest" && vitestShim !== undefined) return `${lead}${quote}${vitestShim}${quote}`;
    if (!spec.startsWith("node:") && BUILTINS.has(spec)) return `${lead}${quote}node:${spec}${quote}`;
    return all;
  });
}

/**
 * rewriteSpecifiers for a module vitest runs, plus the relative specifiers vite resolves to another file (an
 * extensionless import, a ".js" import of a ".ts" file, a directory): each becomes the relative path of that file,
 * only on the lines where the module imports it (so text in strings and comments stays as written).
 */
export function rewriteVitest(code: string, shim: string, vitestShim: string, paths: ReadonlyMap<string, string>): string {
  const lines = new Set(importsOf(code).filter((i) => paths.has(i.specifier)).map((i) => i.line));
  if (lines.size === 0) return rewriteSpecifiers(code, shim, vitestShim);
  return code
    .split("\n")
    .map((line, i) => {
      const own = lines.has(i + 1);
      return line.replace(SPECIFIER, (all: string, lead: string, quote: string, spec: string) => {
        if (spec === "node:test") return `${lead}${quote}${shim}${quote}`;
        if (spec === "vitest") return `${lead}${quote}${vitestShim}${quote}`;
        if (!spec.startsWith("node:") && BUILTINS.has(spec)) return `${lead}${quote}node:${spec}${quote}`;
        const to = own ? paths.get(spec) : undefined;
        return to === undefined ? all : `${lead}${quote}${to}${quote}`;
      });
    })
    .join("\n");
}

/** Does this module import the node:test runner? */
export function usesNodeTest(c: Compiled): boolean {
  return c.imports.includes("node:test");
}
