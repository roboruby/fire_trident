import { importsOf } from "@fire_trident/core";
import type { Path } from "@fire_trident/core";
import { transform } from "sucrase";
import { resolveRelative } from "../agents/context.ts";
import { erasableProblems } from "../agents/create.ts";

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
      const out = transform(text, { transforms: ["typescript"], disableESTransforms: true, keepUnusedImports: true, filePath: path });
      return { path, kind: "js", code: out.code, imports: specifiers(out.code) };
    } catch (e) {
      return { path, kind: "js", code: null, error: `SyntaxError: ${path}: ${errorMessage(e)}`, imports: [] };
    }
  }
  return { path, kind: "js", code: text, imports: specifiers(text) };
}

function specifiers(code: string): string[] {
  return [...new Set(importsOf(code).map((i) => i.specifier))];
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
export function rewriteSpecifiers(code: string, shim: string): string {
  return code.replace(SPECIFIER, (all: string, lead: string, quote: string, spec: string) => {
    if (spec === "node:test") return `${lead}${quote}${shim}${quote}`;
    if (!spec.startsWith("node:") && BUILTINS.has(spec)) return `${lead}${quote}node:${spec}${quote}`;
    return all;
  });
}

/** Does this module import the node:test runner? */
export function usesNodeTest(c: Compiled): boolean {
  return c.imports.includes("node:test");
}
