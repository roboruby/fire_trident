import type { Path } from "@fire_trident/core";
import { globMatch, importsOf } from "@fire_trident/core";
import { foldPath } from "./pathfold.ts";

/**
 * Damage and capability signals: deterministic facts about what a change could do if it landed.
 * They never decide alone; the gate pairs them with a detector hit before a human is paged.
 * Pure: no I/O.
 */

/** A path a change writes that guards secrets, auth, CI, dependencies, or FireTrident itself. */
export interface SensitivePath {
  path: Path;
  why: string;
}

/** A capability the new text has more of than the old text. */
export interface CapabilityHit {
  id: string;
  label: string;
  path: Path;
}

/** Everything the gate treats as potential damage. */
export interface DamageSignals {
  sensitivePaths: SensitivePath[];
  /** Paths written outside the intent's declared footprint. */
  residual: Path[];
  capabilities: CapabilityHit[];
}

const SENSITIVE: Array<{ re: RegExp; why: string }> = [
  { re: /(^|\/)\.firetrident\//, why: "FireTrident colony memory (antibodies)" },
  { re: /(^|\/)(\.env(\..*)?|\.npmrc|\.pypirc|\.netrc|id_rsa[^/]*|[^/]*\.(pem|key|p12|pfx))$/i, why: "secrets file" },
  { re: /(^|\/)(secrets?|credentials?)(\/|\.|$)/i, why: "secrets" },
  { re: /(^|\/)(auth|authn|authz|oauth|sso)(\/|\.|-|_)/i, why: "authentication" },
  { re: /(^|\/)(\.github|\.circleci|\.buildkite|\.gitlab)\//, why: "CI configuration" },
  { re: /(^|\/)(\.gitlab-ci\.yml|azure-pipelines\.ya?ml|Jenkinsfile|\.travis\.yml|bitbucket-pipelines\.yml)$/i, why: "CI configuration" },
  {
    re: /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|yarn\.lock|bun\.lockb?|deno\.jsonc?|jsr\.json|Gemfile(\.lock)?|requirements[^/]*\.txt|pyproject\.toml|poetry\.lock|go\.(mod|sum)|Cargo\.(toml|lock))$/i,
    why: "dependency manifest",
  },
  { re: /(^|\/)(\.husky\/|Dockerfile$|wrangler\.(jsonc?|toml)$|\.gitattributes$|CODEOWNERS$)/i, why: "build or platform configuration" },
];

/** Why writing `path` is sensitive, or null. Tested on the folded path (decide/pathfold.ts), so `Package.JSON` is a manifest too. */
export function sensitiveReason(path: Path): string | null {
  const folded = foldPath(path);
  for (const s of SENSITIVE) if (s.re.test(folded)) return s.why;
  return null;
}

/** A path a change writes, deletes or renames that the colony's policy protects, with the glob that protects it. */
export interface ProtectedHit {
  path: Path;
  glob: string;
}

/** Does `glob` cover `path` (both folded): match it, or match a directory it is under ("src/auth" covers src/auth/login.ts)? */
function covers(glob: string, path: Path): boolean {
  if (globMatch(glob, path)) return true;
  for (let k = path.indexOf("/"); k !== -1; k = path.indexOf("/", k + 1)) if (globMatch(glob, path.slice(0, k))) return true;
  return false;
}

/**
 * The paths of a change that the colony's protected globs (DecidePolicy.protectedPaths) cover, each once
 * with the first glob that covers it. A proposal's write set lists deleted paths too, and a rename is a
 * deletion plus a write, so writing, deleting or renaming into or out of a protected path all count. Globs and paths
 * match in their folded form (decide/pathfold.ts): `SRC/Auth/x.ts` is under `src/auth` on a case-insensitive checkout.
 */
export function protectedHits(paths: readonly Path[], globs: readonly string[]): ProtectedHit[] {
  if (globs.length === 0) return [];
  const folded = globs.map((g) => foldPath(g));
  const out: ProtectedHit[] = [];
  for (const path of new Set(paths)) {
    const p = foldPath(path);
    const k = folded.findIndex((g) => covers(g, p));
    if (k !== -1) out.push({ path, glob: globs[k]! });
  }
  return out;
}

/** Is `path` a test file (by directory or name)? */
export function isTestPath(path: Path): boolean {
  return /(^|\/)(test|tests|__tests__|spec)\//.test(path) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(path);
}

/** Capability patterns counted in old and new text; a rise is a signal. `tests` limits one to test files. */
export const CAPABILITY_PATTERNS: ReadonlyArray<{ id: string; label: string; re: RegExp; tests?: boolean }> = [
  { id: "env", label: "reads environment variables or secret names", re: /\bprocess\.env\b|\bDeno\.env\b|\bimport\.meta\.env\b|\b[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|ACCESS_KEY)\b/g },
  { id: "process", label: "spawns processes", re: /\bchild_process\b|\bexecSync\s*\(|\bexecFileSync\s*\(|\bspawnSync\s*\(|\bspawn\s*\(|\bexecFile\s*\(|\bexec\s*\(\s*['"`]/g },
  { id: "network", label: "opens network connections", re: /\bfetch\s*\(|\bhttps?\.(?:request|get)\s*\(|\bnet\.(?:connect|createConnection)\s*\(|\bnew\s+WebSocket\s*\(|\bXMLHttpRequest\b|\bdgram\b/g },
  { id: "eval", label: "evaluates code at runtime", re: /\beval\s*\(|\bnew\s+Function\s*\(|\bvm\.run\w*\s*\(/g },
  { id: "test-skip", label: "skips or narrows tests", re: /\b(?:it|test|describe|suite)\.(?:skip|todo|only)\s*\(|\bx(?:it|test|describe)\s*\(|\bf(?:it|describe)\s*\(/g, tests: true },
];

/** Built-in modules that grant process, network or code-execution capability. */
const CAPABILITY_MODULES = new Set(["child_process", "net", "dgram", "http", "https", "http2", "tls", "vm", "worker_threads", "cluster", "inspector"]);

function count(re: RegExp, text: string): number {
  re.lastIndex = 0;
  let n = 0;
  while (re.exec(text) !== null) n++;
  re.lastIndex = 0;
  return n;
}

/** Imported capability modules (node: prefix removed). */
function capabilityImports(path: Path, text: string): Set<string> {
  const out = new Set<string>();
  if (!/\.[cm]?[jt]sx?$/i.test(path)) return out;
  for (const { specifier } of importsOf(text)) {
    const m = specifier.replace(/^node:/, "").split("/")[0] ?? "";
    if (CAPABILITY_MODULES.has(m)) out.add(m);
  }
  return out;
}

const LOGGING = /\bconsole\.(?:log|info|warn|error|debug|trace)\s*\(|\blogger\.\w+\s*\(|\bprint(?:ln)?\s*\(/;
const SECRETISH = /\bprocess\.env\b|\bDeno\.env\b|\bimport\.meta\.env\b|\b[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|ACCESS_KEY)\b|\b(?:token|secret|password|apiKey|api_key|credentials?)\b/i;
const ASSERTION = /\bexpect\s*\(|\bassert(?:\.\w+)?\s*\(|\.should\b/g;
const SCRIPT = /\.[cm]?[jt]sx?$/i;
/** Comment lines outside JavaScript and TypeScript (`#`, SQL and HTML comments). */
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*|#(?!!)|<!--|--\s)/;
/** Characters that can start a comment or a string. */
const SPECIAL = /[/'"`]/g;

/**
 * `text` with every JavaScript or TypeScript comment blanked to spaces (line breaks kept), so
 * offsets and line numbers stay put. Strings and template literals are skipped over; a regex
 * literal is read as code, so a `//` inside one blanks the rest of its line.
 */
export function blankComments(text: string): string {
  const blank = (s: string): string => s.replace(/[^\r\n]/g, " ");
  const parts: string[] = [];
  let i = 0;
  while (i < text.length) {
    SPECIAL.lastIndex = i;
    const m = SPECIAL.exec(text);
    if (!m) {
      parts.push(text.slice(i));
      break;
    }
    const k = m.index;
    parts.push(text.slice(i, k));
    const c = text[k]!;
    if (c === "/") {
      const next = text[k + 1];
      if (next === "/") {
        let j = k + 2;
        while (j < text.length && text[j] !== "\n" && text[j] !== "\r") j++;
        parts.push(blank(text.slice(k, j)));
        i = j;
      } else if (next === "*") {
        const close = text.indexOf("*/", k + 2);
        const j = close < 0 ? text.length : close + 2;
        parts.push(blank(text.slice(k, j)));
        i = j;
      } else {
        parts.push(c);
        i = k + 1;
      }
      continue;
    }
    // A string: to its closing quote; a quote left open ends at the line break (templates span lines).
    let j = k + 1;
    while (j < text.length && text[j] !== c) {
      if (text[j] === "\\") j += 2;
      else if (c !== "`" && (text[j] === "\n" || text[j] === "\r")) break;
      else j++;
    }
    const end = j < text.length && text[j] === c ? j + 1 : Math.min(j, text.length);
    parts.push(text.slice(k, end));
    i = end;
  }
  return parts.join("");
}

/** Assertions in a file's code (`expect(`, `assert(`, `assert.x(`, `.should`); commented-out ones do not count. */
export function assertionCount(path: Path, text: string): number {
  const code = SCRIPT.test(path) ? blankComments(text) : text.split(/\r\n|\r|\n/).filter((l) => !COMMENT_LINE.test(l)).join("\n");
  return count(ASSERTION, code);
}

/**
 * Capabilities `after` has more of than `before` for one file (a rename such as 'fs' → 'node:fs'
 * adds none). `added` are the file's added lines: a line that both logs and touches a secret is
 * its own signal, as is a test file that loses assertions.
 */
export function capabilityDelta(path: Path, before: string | null, after: string | null, added: readonly string[]): CapabilityHit[] {
  if (after === null) return [];
  const old = before ?? "";
  const hits: CapabilityHit[] = [];
  const test = isTestPath(path);
  for (const c of CAPABILITY_PATTERNS) {
    if (c.tests && !test) continue;
    if (count(c.re, after) > count(c.re, old)) hits.push({ id: c.id, label: c.label, path });
  }
  const was = capabilityImports(path, old);
  const now = [...capabilityImports(path, after)].filter((m) => !was.has(m));
  if (now.length > 0) hits.push({ id: "import", label: `imports ${now.join(", ")}`, path });
  if (added.some((l) => LOGGING.test(l) && SECRETISH.test(l))) hits.push({ id: "secret-log", label: "logs a secret or credential", path });
  if (test && assertionCount(path, after) < assertionCount(path, old)) hits.push({ id: "assertions", label: "removes test assertions", path });
  return hits;
}

/** One changed file as the damage scan sees it. */
export interface ChangedText {
  path: Path;
  before: string | null;
  after: string | null;
  added: readonly string[];
}

/** Damage signals of a whole change: sensitive paths written, residual, and capabilities added. */
export function damageSignals(files: readonly ChangedText[], residual: readonly Path[]): DamageSignals {
  const sensitivePaths: SensitivePath[] = [];
  const capabilities: CapabilityHit[] = [];
  for (const f of files) {
    const why = sensitiveReason(f.path);
    if (why) sensitivePaths.push({ path: f.path, why });
    capabilities.push(...capabilityDelta(f.path, f.before, f.after, f.added));
  }
  return { sensitivePaths, residual: [...residual], capabilities };
}

/** Short labels of every damage signal, for reasons and decision records. */
export function damageLabels(d: DamageSignals): string[] {
  return [
    ...d.sensitivePaths.map((s) => `${s.why}: ${s.path}`),
    ...(d.residual.length > 0 ? [`outside the footprint: ${d.residual.slice(0, 5).join(", ")}${d.residual.length > 5 ? ` and ${d.residual.length - 5} more` : ""}`] : []),
    ...d.capabilities.map((c) => `${c.label} (${c.path})`),
  ];
}
