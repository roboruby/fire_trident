import type { IntentSource, Path } from "@fire_trident/core";
import { globMatch, importsOf } from "@fire_trident/core";
import { diffLines, splitLines } from "./diff.ts";
import { assertionCount, blankComments, isTestPath, sensitiveReason } from "./signals.ts";

/**
 * Danger-pattern recognition: the innate immune system's pattern-recognition receptors. Fixed,
 * deterministic patterns over a change's ADDED lines (every line of a new file counts as added)
 * and its paths flag what must never depend on a model's judgment:
 * - auth: authorization headers, bearer schemes, credential comparisons, admin gates, 401/403
 * - secret: hard-coded credentials, known token formats, private keys, secrets written to logs
 * - capability: process, network or eval capability the intent does not ask for
 * - crypto: cryptographic or security randomness primitives the intent does not ask for
 * - ci, dependency: CI workflows and dependency manifests (by path)
 * - test-weakening: skipped, todo or focused tests (test.skip(), a test context's t.skip() and
 *   t.todo(), { skip } and { todo } options), deleted assertions, deleted test files
 * - test-change: during a trunk-certification repair, any change to a test file beyond its
 *   import lines (a repair never grades its own exam)
 * - governance: what decides on agents (by path): the colony's own memory under .firetrident/
 *   (antibodies, including the tolerating ones the colony loads from trunk) and agent
 *   instructions (AGENTS.md, CLAUDE.md, .claude/)
 * Auth, secret and capability hits must reach a human unless a policy or an antibody explicitly
 * allows them; governance and test-change always reach a human, since no allowance may waive
 * them. The others are danger signals that only a reviewer's approval can clear. Only an intent
 * written by a person, a colony rule or trunk certification can ask for a capability: an agent's
 * own words (an agent-declared intent, a proposal's summary) never waive a hit.
 * Import and export-from lines are never scanned for code patterns: rewriting a specifier
 * (Hono's ./x -> ./x.ts, OpenSpec's 'fs' -> 'node:fs') never adds behavior. Pure: no I/O.
 */

export type DangerClass = "auth" | "secret" | "capability" | "crypto" | "ci" | "dependency" | "test-weakening" | "governance" | "test-change";

/** Classes that must reach a human. */
export const MUST_HUMAN: ReadonlySet<DangerClass> = new Set<DangerClass>(["auth", "secret", "capability", "governance", "test-change"]);

/** Classes no policy, antibody or intent can allow. */
export const UNWAIVABLE: ReadonlySet<DangerClass> = new Set<DangerClass>(["governance", "test-change"]);

/** Who wrote an intent's why: a person, a colony rule, trunk certification, or an agent. */
export type WhyAuthor = "person" | "rule" | "certification" | "agent";

/** Who wrote the why of an intent with this source; anything else (no intent, an unknown source) counts as an agent. */
export function whyAuthor(source: IntentSource | null | undefined): WhyAuthor {
  return source === "human" ? "person" : source === "rule" ? "rule" : source === "certify" ? "certification" : "agent";
}

/** Plain words for who wrote a why ("a person", "an agent"). */
export const WHY_AUTHOR_WORDS: Record<WhyAuthor, string> = { person: "a person", rule: "a colony rule", certification: "trunk certification", agent: "an agent" };

/** What the recognizer reads of the intent a change serves. */
export interface DangerIntent {
  title: string;
  why: string;
  acceptance?: string[] | undefined;
  source: IntentSource;
}

/** Intent sources whose text may ask for a capability: written by a person, a rule or certification. */
const TRUSTED_SOURCES: ReadonlySet<string> = new Set<IntentSource>(["human", "rule", "certify"]);

/** Paths that decide on agents: the colony's memory and agent instructions, anywhere in the tree. */
const GOVERNANCE: ReadonlyArray<{ id: string; re: RegExp }> = [
  { id: "colony-memory", re: /(^|\/)\.firetrident\// },
  { id: "agent-instructions", re: /(^|\/)(?:(?:AGENTS|CLAUDE)\.md$|\.claude\/)/i },
];

/** One recognized danger pattern. */
export interface DangerHit {
  cls: DangerClass;
  /** Stable pattern id, e.g. "auth:authorization-header". */
  pattern: string;
  path: Path;
  /** 1-based line in the new text (0 for a path-level hit). */
  line: number;
  /** The added line, trimmed and cut, with secret-looking values masked. */
  excerpt: string;
  /** The intent asks for this capability: recorded, not counted. */
  requested?: boolean;
  /** Who wrote the intent that asked for it (never an agent). */
  requestedBy?: Exclude<WhyAuthor, "agent">;
  /** Allowed by a policy entry or an antibody: a danger signal, no longer a human gate. */
  allowedBy?: string;
}

/** One written file as the recognizer sees it (`after` null: deleted, binary or unreadable). */
export interface DangerFile {
  path: Path;
  before: string | null;
  after: string | null;
  /** The change deletes the file. */
  deleted?: boolean;
}

const CODE = /\.(?:[cm]?[jt]sx?|py|rb|go|rs|java|kt|kts|php|cs|swift|scala|sh|bash|zsh|ps1|lua|exs?|vue|svelte|astro)$/i;
/** Comment lines; `#` only outside JavaScript and TypeScript, where it starts private fields. */
const COMMENT_JS = /^\s*(?:\/\/|\/\*|\*)/;
const COMMENT_OTHER = /^\s*(?:\/\/|\/\*|\*|#(?!!)|<!--|--\s)/;
const SCRIPT = /\.[cm]?[jt]sx?$/i;
const IMPORT = /^\s*(?:import[\s{*'"`]|import$|export\s+(?:type\s+)?(?:\*|\{[^}]*\})\s*from\s|\}\s*from\s|(?:const|let|var)\s+[\w{}\s,]+=\s*require\(\s*['"`][^'"`]+['"`]\s*\)\s*;?\s*$)/;

interface LinePattern {
  cls: DangerClass;
  id: string;
  re: RegExp;
  /** Kind of capability or crypto, for "does the intent ask for it". */
  kind?: "process" | "network" | "eval" | "crypto";
  /** Applies to test files too (default: production code only). */
  tests?: boolean;
  /** Applies to test files only. */
  testsOnly?: boolean;
  /** Applies to every text file, not only code. */
  anyFile?: boolean;
  /** Applies to comment lines too. */
  comments?: boolean;
  /** Extra condition on the line. */
  when?: (line: string) => boolean;
}

const CREDENTIAL = /\b\w*(?:secret|passw(?:or)?d|api[_-]?key|apikey|credential|private[_-]?key|(?:auth|access|admin|bearer|session|csrf|refresh|id|jwt|api)[_-]?token)\w*\b/i;
const COMPARE = /[!=]==?|\btimingSafeEqual\s*\(/;
const SECRETISH = /\bprocess\.env\b|\bDeno\.env\b|\bimport\.meta\.env\b|\benv\.[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|KEY)\b|\b[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|ACCESS_KEY)\b|\b(?:secret|password|apiKey|api_key|credentials?|adminToken|authToken|accessToken)\b/;
const LOGGING = /\bconsole\.(?:log|info|warn|error|debug|trace)\s*\(|\blogger\.\w+\s*\(|\bprint(?:ln)?\s*\(/;
/** A fetch( that defines or declares a method (export default { fetch(request, env) { ... } }, fetch(input: RequestInfo): Promise<Response>) rather than calling one. */
const FETCH_DEFINITION = /(?:^|[{,;(])\s*(?:async\s+)?fetch\s*\([^)]*\)\s*(?:(?::\s*[^={;]+)?\{|:\s*[^={;]+;?\s*$)/;
/** `typeof x === 'string'` checks a type, not a credential. */
const TYPEOF_CHECK = /typeof\s+[\w.$]+\s*[!=]==?\s*['"`]\w+['"`]|['"`]\w+['"`]\s*[!=]==?\s*typeof\s+[\w.$]+/g;
/** A credential-named key or variable set to a whole string literal (`API_KEY = "..."`, `"token": "..."`). */
const HARDCODED = /\b\w*(?:secret|passw(?:or)?d|api[_-]?key|apikey|private[_-]?key|client[_-]?secret|access[_-]?key|token)\w*["']?\s*[:=]\s*['"`]([^'"`\s]{8,})['"`]\s*(?:[;,)}\]]|$)/i;
/** A comparison with an empty string, null or undefined: a presence check. */
const PRESENCE_CHECK = /[!=]==?\s*(?:""|''|``|null|undefined)(?![\w$])|(?<![\w$])(?:""|''|``|null|undefined)\s*[!=]==?/g;
/** A member of a string-literal union type (`| 'Authorization'`): a name, not a use. */
const UNION_MEMBER = /^\s*\|\s*['"`][\w-]+['"`]\s*;?\s*$/;
const PLACEHOLDER = /^(?:<[^>]*>|\$\{[^}]*\}|x+|\*+|\.+|change[-_]?me|replace[-_]?me|your[-_].*|example.*|placeholder|todo|tbd|redacted|dummy|sample.*|test.*|fake.*|none|null|undefined|string|secret|password|token)$/i;
const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const TOKEN_FORMAT_SOURCE = String.raw`\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,}|sk-(?:live-|proj-|ant-)?[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|art_v1_[0-9a-f]{20,}|eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})`;
/** Known token formats: code-host and model-API tokens, chat-app and cloud keys, Artifacts tokens, JWTs. */
const TOKEN_FORMAT = new RegExp(TOKEN_FORMAT_SOURCE);
/** A credential-named key set to a bare (unquoted) literal that looks like a secret (`api_key: s3cr3tv4lu3x`, `TOKEN=ab12…`). */
const UNQUOTED_CREDENTIAL = /\b\w*(?:secret|passw(?:or)?d|api[_-]?key|apikey|private[_-]?key|access[_-]?key|token)\w*["']?\s*[:=]\s*(?=[A-Za-z0-9_\-+/=]*\d)(?=[A-Za-z0-9_\-+/=]*[A-Za-z])[A-Za-z0-9_\-+/=]{12,}\s*,?\s*$/i;

const LINE_PATTERNS: readonly LinePattern[] = [
  // auth
  {
    cls: "auth",
    id: "auth:authorization-header",
    // The header in use: a quoted name, a `name:` key or header line, or `.authorization`; not the word in prose.
    re: /['"`](?:proxy-)?authorization['"`]|['"`]www-authenticate['"`]|\b(?:proxy-)?authorization\s*:|\bwww-authenticate\s*:|\.authorization\b/i,
    when: (l) => !UNION_MEMBER.test(l),
  },
  { cls: "auth", id: "auth:bearer-scheme", re: /\bbearer\b/i, when: (l) => !UNION_MEMBER.test(l) },
  {
    cls: "auth",
    id: "auth:credential-compare",
    re: COMPARE,
    when: (l) => {
      // Type checks and presence checks (`password !== ""`, `token === null`) compare no credential.
      const s = l.replace(TYPEOF_CHECK, "").replace(PRESENCE_CHECK, "");
      return COMPARE.test(s) && CREDENTIAL.test(s);
    },
  },
  { cls: "auth", id: "auth:constant-time-compare", re: /\btimingSafeEqual\s*\(/ },
  { cls: "auth", id: "auth:admin-gate", re: /\b(?:isAdmin|requireAdmin|adminOnly|isAuthenticated|requireAuth|checkAuth|verifyToken|verifyJwt|authenticate|authorize)\s*\(|\brole\s*[!=]==?\s*['"`]admin['"`]|['"`]admin['"`]\s*[!=]==?/i },
  // A denial actually sent: return/throw with 401 or 403, a 401/403 status, or a 401/403 response.
  { cls: "auth", id: "auth:unauthorized", re: /\b(?:return|throw)\b[^\n]*\b(?:401|403)\b|\bstatus(?:Code)?\s*[:=]\s*(?:401|403)\b|\bnew\s+(?:Response|HTTPException)\s*\([^\n]*\b(?:401|403)\b/ },
  { cls: "auth", id: "auth:jwt", re: /\bjwt\.(?:verify|sign|decode)\s*\(|\bjsonwebtoken\b|\bjwtVerify\s*\(/ },
  // secret
  { cls: "secret", id: "secret:private-key", re: PRIVATE_KEY, tests: true, anyFile: true, comments: true },
  { cls: "secret", id: "secret:token-format", re: TOKEN_FORMAT, tests: true, anyFile: true, comments: true },
  {
    cls: "secret",
    id: "secret:hardcoded",
    re: HARDCODED,
    anyFile: true,
    when: (l) => {
      const m = HARDCODED.exec(l);
      // A whole literal value in a credential-like charset, with a digit or long enough: not a regex source, not a word.
      return !!m && !PLACEHOLDER.test(m[1]!) && /^[A-Za-z0-9_\-.+/=:@]+$/.test(m[1]!) && (/\d/.test(m[1]!) || m[1]!.length >= 16);
    },
  },
  { cls: "secret", id: "secret:logged", re: LOGGING, when: (l) => SECRETISH.test(l) },
  // capability
  { cls: "capability", id: "capability:process", kind: "process", re: /\b(?:child_process|execSync|execFileSync|spawnSync)\b|\b(?:spawn|execFile)\s*\(|\bexec\s*\(\s*['"`]|\bDeno\.(?:run|Command)\b|\bBun\.spawn\b/, tests: true },
  { cls: "capability", id: "capability:network", kind: "network", re: /(?<![\w.$])fetch\s*\(|\bnew\s+(?:WebSocket|EventSource)\s*\(|\bXMLHttpRequest\b|\b(?:http|https|http2)\.(?:request|get)\s*\(|\bnet\.(?:connect|createConnection)\s*\(|\bnavigator\.sendBeacon\s*\(/, tests: true, when: (l) => !FETCH_DEFINITION.test(l) || /(?<![\w.$])fetch\s*\(\s*['"`]/.test(l) },
  { cls: "capability", id: "capability:eval", kind: "eval", re: /\beval\s*\(|\bnew\s+Function\s*\(|\bvm\.(?:runIn\w*|Script)\b|\bset(?:Timeout|Interval)\s*\(\s*['"`]/, tests: true },
  // crypto
  { cls: "crypto", id: "crypto:primitive", kind: "crypto", re: /\bcrypto\.subtle\b|\bcreate(?:Hash|Hmac|Cipheriv|Decipheriv|Sign|Verify)\s*\(|\b(?:randomBytes|getRandomValues|randomUUID|timingSafeEqual|pbkdf2|scrypt|bcrypt|argon2)\b/ },
  { cls: "crypto", id: "crypto:weak", kind: "crypto", re: /['"`](?:md5|sha1)['"`]|\bmd5\s*\(|\bsha1\s*\(/i },
  { cls: "crypto", id: "crypto:weak-random", kind: "crypto", re: /\bMath\.random\s*\(/, when: (l) => /token|secret|passw|session|nonce|salt|otp|key/i.test(l) },
  // test weakening
  { cls: "test-weakening", id: "test-weakening:skip-or-only", re: /\b(?:it|test|describe|suite|context)\.(?:skip|only|todo)\s*\(|\bx(?:it|test|describe)\s*\(|\bf(?:it|describe)\s*\(/, tests: true },
  // A test context skipping or marking its own test: node:test's t.skip() and t.todo("later"), a runner's this.skip().
  { cls: "test-weakening", id: "test-weakening:context-skip", re: /(?<!\b(?:it|test|describe|suite|context))\.(?:skip|todo)\s*\(\s*(?:\)|['"`])/, tests: true, testsOnly: true },
];

/** Built-in modules that grant process, network or code-execution capability. */
const CAPABILITY_MODULES: Record<string, "process" | "network" | "eval"> = {
  child_process: "process",
  cluster: "process",
  worker_threads: "process",
  net: "network",
  dgram: "network",
  http: "network",
  https: "network",
  http2: "network",
  tls: "network",
  vm: "eval",
  inspector: "eval",
};

/** What in an intent's text asks for each capability. */
const REQUESTS: Record<"process" | "network" | "eval" | "crypto", RegExp> = {
  process: /\b(?:spawn\w*|exec(?:ute)?s?|child[ _-]?process(?:es)?|subprocess(?:es)?|shell|command[- ]line)\b/i,
  network: /\b(?:fetch(?:es|ing)?|outbound|network|webhooks?|websockets?|download\w*|upload\w*|remote (?:api|server|service)|external (?:api|service)s?|http client|proxy|sendBeacon)\b/i,
  eval: /\b(?:eval|dynamic code|code generation|interpreter|sandbox)\b/i,
  crypto: /\b(?:crypto\w*|random\w*|hash\w*|hmac|uuid|signature|sign(?:ed|ing)?|encrypt\w*|decrypt\w*|cipher|getRandomValues|nonce|salt)\b/i,
};

/** The excerpt shown for a hit: trimmed, cut, long secret-looking values (quoted, or in a known token format) masked. */
export function maskExcerpt(line: string, max = 140): string {
  const masked = line
    .trim()
    .replace(/(['"`])([^'"`\s]{8,})\1/g, (_m, q: string, v: string) => (/[A-Za-z]/.test(v) && /\d/.test(v) && v.length >= 12 ? `${q}${v.slice(0, 4)}…${q}` : `${q}${v}${q}`))
    .replace(new RegExp(TOKEN_FORMAT_SOURCE, "g"), (t) => `${t.slice(0, 4)}…`);
  return masked.length > max ? `${masked.slice(0, max - 1)}…` : masked;
}

/**
 * Does this line hold what a secret pattern matches: a private key, a known token format, a
 * credential-named value (quoted or bare), or a secret written to a log? Used to mask what is
 * published; it errs toward masking.
 */
export function looksLikeSecret(line: string): boolean {
  return PRIVATE_KEY.test(line) || TOKEN_FORMAT.test(line) || HARDCODED.test(line) || UNQUOTED_CREDENTIAL.test(line) || (LOGGING.test(line) && SECRETISH.test(line));
}

/** The first and last line of a PEM private key block (what lies between is key material). */
export const PRIVATE_KEY_BEGIN = PRIVATE_KEY;
export const PRIVATE_KEY_END = /-----END [A-Z ]*PRIVATE KEY-----/;

/** Calls that take node:test options as their first or second argument (a context's t.test included). */
const TEST_CALL = /(?<![\w$])(?:it|test|describe|suite)\s*\(/g;
/** Characters of an options object read at most. */
const OPTION_SPAN = 4_000;
/** Values that leave `skip` or `todo` off. */
const UNSET = /^(?:false|undefined|null|0|''|""|``|void 0)$/;

/** Index just past the string literal opening at `i` (a quote left open ends at the line break). */
function stringEnd(text: string, i: number): number {
  const q = text[i];
  let j = i + 1;
  while (j < text.length && text[j] !== q) {
    if (text[j] === "\\") j += 2;
    else if (q !== "`" && (text[j] === "\n" || text[j] === "\r")) return j;
    else j++;
  }
  return Math.min(text.length, j + 1);
}

function skipBlank(text: string, i: number): number {
  while (i < text.length && /\s/.test(text[i]!)) i++;
  return i;
}

/** Offsets where each line starts (\n, \r\n and \r end a line, as in splitLines). */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\n" || (c === "\r" && text[i + 1] !== "\n")) starts.push(i + 1);
  }
  return starts;
}

/** 1-based line of an offset. */
function lineOf(starts: readonly number[], at: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= at) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/** Top-level `key: value` pairs of the object literal opening at `open` (values as written, trimmed). */
function objectKeys(text: string, open: number): Array<{ name: string; value: string; at: number }> {
  const keys: Array<{ name: string; value: string; at: number }> = [];
  const limit = Math.min(text.length, open + OPTION_SPAN);
  let depth = 0;
  let expectKey = true;
  let current: { name: string; at: number; from: number } | null = null;
  const finish = (end: number): void => {
    if (current) keys.push({ name: current.name, at: current.at, value: text.slice(current.from, end).trim() });
    current = null;
  };
  let i = open + 1;
  while (i < limit) {
    const c = text[i]!;
    if (c === "'" || c === '"' || c === "`") {
      const end = stringEnd(text, i);
      const colon = skipBlank(text, end);
      if (depth === 0 && expectKey && c !== "`" && text[colon] === ":") {
        current = { name: text.slice(i + 1, end - 1), at: i, from: colon + 1 };
        expectKey = false;
        i = colon + 1;
      } else i = end;
      continue;
    }
    if (c === "{" || c === "[" || c === "(") depth++;
    else if (c === "}" || c === "]" || c === ")") {
      if (depth === 0) {
        finish(i);
        return keys;
      }
      depth--;
    } else if (depth === 0 && c === ",") {
      finish(i);
      expectKey = true;
    } else if (depth === 0 && expectKey && /[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < limit && /[\w$]/.test(text[j]!)) j++;
      const colon = skipBlank(text, j);
      expectKey = false;
      if (text[colon] === ":") {
        current = { name: text.slice(i, j), at: i, from: colon + 1 };
        i = colon + 1;
      } else i = j;
      continue;
    }
    i++;
  }
  finish(i);
  return keys;
}

/**
 * 1-based lines where a test call's options object turns on `skip` or `todo`:
 * `test("x", { skip: true }, fn)`, `describe("y", { todo: "later" })`, `t.test({ skip: why }, fn)`,
 * across lines too. A value of false, null, undefined, 0 or "" leaves it off. Comments are ignored.
 */
export function skipOptionLines(source: string): number[] {
  const text = blankComments(source);
  const starts = lineStarts(text);
  const out: number[] = [];
  TEST_CALL.lastIndex = 0;
  for (let m = TEST_CALL.exec(text); m !== null; m = TEST_CALL.exec(text)) {
    let i = skipBlank(text, m.index + m[0].length);
    const q = text[i];
    // An optional name first: a string literal, then a comma.
    if (q === "'" || q === '"' || q === "`") {
      i = skipBlank(text, stringEnd(text, i));
      if (text[i] !== ",") continue;
      i = skipBlank(text, i + 1);
    }
    if (text[i] !== "{") continue;
    for (const key of objectKeys(text, i)) {
      if ((key.name === "skip" || key.name === "todo") && !UNSET.test(key.value)) out.push(lineOf(starts, key.at));
    }
  }
  return out;
}

/** A line inside a multi-line import clause: names, `type` and `as`, braces and commas only. */
const CLAUSE_LINE = /^\s*(?:(?:type\s+)?[\w$]+(?:\s+as\s+[\w$]+)?\s*,?|\*\s+as\s+[\w$]+\s*,?|[{}]\s*,?)?\s*$/;
/** The line that opens a multi-line import, re-export or require clause. */
const CLAUSE_OPEN = /^\s*(?:import\b(?!\s*\()|export\s+(?:type\s+)?[{*]|(?:const|let|var)\s+\{)/;

/** 1-based lines of a script that belong to import, re-export or require statements, multi-line clauses included. */
export function importLines(path: Path, text: string): Set<number> {
  const out = new Set<number>();
  if (!SCRIPT.test(path)) return out;
  const lines = splitLines(text);
  lines.forEach((l, i) => {
    if (IMPORT.test(l)) out.add(i + 1);
  });
  for (const { line } of importsOf(text)) {
    const at = line - 1;
    const spec = lines[at] ?? "";
    // A dynamic import() inside code is code, not an import line.
    if (!IMPORT.test(spec) && !/\brequire\s*\(/.test(spec)) continue;
    out.add(line);
    // Walk back over the clause to the line that opens the statement.
    for (let i = at - 1; i >= 0 && at - i <= 200; i--) {
      const l = lines[i]!;
      if (CLAUSE_OPEN.test(l)) {
        for (let k = i; k < at; k++) out.add(k + 1);
        break;
      }
      if (!CLAUSE_LINE.test(l)) break;
    }
  }
  return out;
}

/** Packages a script imports (anything not relative or absolute; node: prefix removed). */
function packageImports(path: Path, text: string | null): Set<string> {
  const out = new Set<string>();
  if (text === null || !SCRIPT.test(path)) return out;
  for (const { specifier } of importsOf(text)) if (!specifier.startsWith(".") && !specifier.startsWith("/")) out.add(specifier.replace(/^node:/, ""));
  return out;
}

/**
 * A trunk-certification repair's change to a test file: anything beyond its import lines (blank
 * lines aside) is an edit of the exam the repair must pass, and a package import added or dropped
 * can take the file out of the certification run. Empty when only import lines changed.
 */
function repairTestChange(f: DangerFile): DangerHit[] {
  const base = { cls: "test-change" as const, path: f.path };
  if (f.after === null) return [{ ...base, pattern: "test-change:edited", line: 0, excerpt: f.deleted ? "test file deleted during a repair" : "test file changed during a repair (not readable as text)" }];
  const oldImports = f.before === null ? new Set<number>() : importLines(f.path, f.before);
  const newImports = importLines(f.path, f.after);
  let changed = 0;
  let added: { line: number; text: string } | null = null;
  let removed: string | null = null;
  for (const op of diffLines(f.before === null ? [] : splitLines(f.before), splitLines(f.after))) {
    if (op.kind === "=" || op.text.trim() === "") continue;
    if (op.kind === "+" ? newImports.has(op.b + 1) : oldImports.has(op.a + 1)) continue;
    changed++;
    if (op.kind === "+") added ??= { line: op.b + 1, text: op.text };
    else removed ??= op.text;
  }
  const hits: DangerHit[] = [];
  if (changed > 0) {
    const what = f.before === null ? "new test file during a repair" : "test file edited during a repair";
    const first = added ? `+${added.text.trim()}` : `-${(removed ?? "").trim()}`;
    hits.push({ ...base, pattern: "test-change:edited", line: added?.line ?? 0, excerpt: maskExcerpt(`${what}: ${changed} line${changed === 1 ? "" : "s"} beyond imports, first ${first}`) });
  }
  if (f.before !== null) {
    const was = packageImports(f.path, f.before);
    const now = packageImports(f.path, f.after);
    const moved = [...[...now].filter((s) => !was.has(s)).map((s) => `+${s}`), ...[...was].filter((s) => !now.has(s)).map((s) => `-${s}`)];
    if (moved.length > 0) hits.push({ ...base, pattern: "test-change:package-imports", line: 0, excerpt: maskExcerpt(`package imports changed during a repair (${moved.join(", ")}): the file can drop out of the certification run`) });
  }
  return hits;
}

/** Lines `after` adds over `before` (all of them for a new file), with their 1-based line numbers. */
export function addedLines(before: string | null, after: string): Array<{ line: number; text: string }> {
  const b = splitLines(after);
  if (before === null) return b.map((text, i) => ({ line: i + 1, text }));
  return diffLines(splitLines(before), b)
    .filter((op) => op.kind === "+")
    .map((op) => ({ line: op.b + 1, text: op.text }));
}

/** Capability modules a file imports (node: prefix removed). */
function capabilityImports(path: Path, text: string | null): Map<string, "process" | "network" | "eval"> {
  const out = new Map<string, "process" | "network" | "eval">();
  if (text === null || !/\.[cm]?[jt]sx?$/i.test(path)) return out;
  for (const { specifier } of importsOf(text)) {
    const m = specifier.replace(/^node:/, "").split("/")[0] ?? "";
    const kind = CAPABILITY_MODULES[m];
    if (kind) out.set(m, kind);
  }
  return out;
}

/**
 * Recognize danger patterns in a change. The intent's title, why and acceptance decide which
 * capabilities and crypto uses it asks for (those hits are marked `requested` and do not count),
 * but only when a person, a rule or trunk certification wrote it: with no intent, or an intent an
 * agent declared, nothing is requested. Auth and secret hits always count. During a repair
 * (an intent from certification), any change to a test file beyond its imports is a test-change hit.
 */
export function scanDanger(files: readonly DangerFile[], intent: DangerIntent | null): DangerHit[] {
  const hits: DangerHit[] = [];
  const by = intent && TRUSTED_SOURCES.has(intent.source) ? (whyAuthor(intent.source) as Exclude<WhyAuthor, "agent">) : null;
  const asking = by && intent ? [intent.title, intent.why, ...(intent.acceptance ?? [])].join("\n") : "";
  const asks = (kind: "process" | "network" | "eval" | "crypto"): boolean => by !== null && REQUESTS[kind].test(asking);
  const repair = intent?.source === "certify";
  for (const f of files) {
    const reason = sensitiveReason(f.path);
    if (reason === "CI configuration") hits.push({ cls: "ci", pattern: "ci:workflow", path: f.path, line: 0, excerpt: f.after === null ? "deleted" : "changed" });
    if (reason === "dependency manifest") hits.push({ cls: "dependency", pattern: "dependency:manifest", path: f.path, line: 0, excerpt: f.before === null ? "new manifest" : f.after === null ? "deleted" : "changed" });
    // Before the deleted-file exit: removing an antibody weakens the colony as much as adding one.
    const gov = GOVERNANCE.find((g) => g.re.test(f.path));
    if (gov) hits.push({ cls: "governance", pattern: `governance:${gov.id}`, path: f.path, line: 0, excerpt: f.deleted ? "deleted" : f.before === null ? "new file" : "changed" });
    const test = isTestPath(f.path);
    // A repair never grades its own exam: its test-file changes beyond imports reach a person.
    if (repair && test) hits.push(...repairTestChange(f));
    if (f.after === null) {
      if (f.deleted && test) hits.push({ cls: "test-weakening", pattern: "test-weakening:deleted-test-file", path: f.path, line: 0, excerpt: "test file deleted" });
      continue;
    }
    const code = CODE.test(f.path);
    const matches = (p: LinePattern, text: string): boolean => {
      if (text.trim() === "") return false;
      if (!p.anyFile && !code) return false;
      if (test && !p.tests) return false;
      if (p.testsOnly && !test) return false;
      if (!p.comments && (SCRIPT.test(f.path) ? COMMENT_JS : COMMENT_OTHER).test(text)) return false;
      if (!p.anyFile && code && IMPORT.test(text)) return false;
      p.re.lastIndex = 0;
      if (!p.re.test(text)) return false;
      return !p.when || p.when(text);
    };
    // A pattern counts only when the new text has more lines with it than the old one: a line that was
    // only edited around it (a specifier renamed inside `typeof import('child_process')`) adds nothing.
    const counts = new Map<LinePattern, boolean>();
    const grew = (p: LinePattern): boolean => {
      let g = counts.get(p);
      if (g === undefined) {
        const n = (t: string | null): number => (t === null ? 0 : splitLines(t).filter((l) => matches(p, l)).length);
        g = n(f.after) > n(f.before);
        counts.set(p, g);
      }
      return g;
    };
    const added = addedLines(f.before, f.after);
    for (const { line, text } of added) {
      for (const p of LINE_PATTERNS) {
        if (!matches(p, text) || !grew(p)) continue;
        const hit: DangerHit = { cls: p.cls, pattern: p.id, path: f.path, line, excerpt: maskExcerpt(text) };
        if (p.kind && asks(p.kind)) {
          hit.requested = true;
          hit.requestedBy = by!;
        }
        hits.push(hit);
      }
    }
    // New capability modules (a renamed specifier such as 'child_process' -> 'node:child_process' adds none).
    const had = capabilityImports(f.path, f.before);
    for (const [mod, kind] of capabilityImports(f.path, f.after)) {
      if (had.has(mod)) continue;
      const hit: DangerHit = { cls: "capability", pattern: `capability:import-${kind}`, path: f.path, line: 0, excerpt: `imports ${mod}` };
      if (asks(kind)) {
        hit.requested = true;
        hit.requestedBy = by!;
      }
      hits.push(hit);
    }
    if (test && SCRIPT.test(f.path)) {
      // node:test options that skip or mark a test, counted like the line patterns: only more of them than before is a hit.
      const now = skipOptionLines(f.after);
      if (now.length > (f.before === null ? 0 : skipOptionLines(f.before).length)) {
        const fresh = new Set(added.map((a) => a.line));
        const lines = splitLines(f.after);
        const at = now.filter((l) => fresh.has(l));
        for (const line of at.length > 0 ? at : [now[now.length - 1]!]) {
          hits.push({ cls: "test-weakening", pattern: "test-weakening:skip-option", path: f.path, line, excerpt: maskExcerpt(lines[line - 1] ?? "") });
        }
      }
    }
    if (test && f.before !== null) {
      // Commented-out assertions do not count: `// expect(x)` is a removed assertion.
      const was = assertionCount(f.path, f.before);
      const now = assertionCount(f.path, f.after);
      if (now < was) hits.push({ cls: "test-weakening", pattern: "test-weakening:assertions-removed", path: f.path, line: 0, excerpt: `${was} -> ${now} assertions` });
    }
  }
  return hits;
}

/** An explicit allowance: a danger class, optionally limited to paths (globs). */
export interface DangerAllowance {
  cls: DangerClass;
  paths?: string[];
  /** Who or what allows it (policy, antibody id). */
  by: string;
}

/** Mark hits that an allowance covers (returns new objects; `requested` and unwaivable hits are left alone). */
export function applyAllowances(hits: readonly DangerHit[], allowances: readonly DangerAllowance[]): DangerHit[] {
  return hits.map((h) => {
    if (h.requested || UNWAIVABLE.has(h.cls)) return h;
    const a = allowances.find((x) => x.cls === h.cls && (!x.paths || x.paths.length === 0 || x.paths.some((g) => g === h.path || globMatch(g, h.path))));
    return a ? { ...h, allowedBy: a.by } : h;
  });
}

/** Hits split by what they do: force a human, act as danger signals, or only get recorded. */
export function triageDanger(hits: readonly DangerHit[]): { mustHuman: DangerHit[]; signals: DangerHit[]; recorded: DangerHit[] } {
  const mustHuman: DangerHit[] = [];
  const signals: DangerHit[] = [];
  const recorded: DangerHit[] = [];
  for (const h of hits) {
    if (h.requested) recorded.push(h);
    else if (MUST_HUMAN.has(h.cls) && !h.allowedBy) mustHuman.push(h);
    else signals.push(h);
  }
  return { mustHuman, signals, recorded };
}

/** One readable line for a hit. */
export function dangerLabel(h: DangerHit): string {
  const where = h.line > 0 ? `${h.path}:${h.line}` : h.path;
  const asked = h.requested ? ` [asked for by the intent${h.requestedBy ? `, written by ${WHY_AUTHOR_WORDS[h.requestedBy]}` : ""}]` : "";
  return `${h.cls} (${h.pattern.split(":")[1]}) at ${where}: ${h.excerpt}${h.allowedBy ? ` [allowed by ${h.allowedBy}]` : ""}${asked}`;
}

/** Distinct labels, grouped per class and path (several patterns on one line read as one). */
export function dangerLabels(hits: readonly DangerHit[], max = 8): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const h of hits) {
    const key = `${h.cls}|${h.path}|${h.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(dangerLabel(h));
  }
  return out.length > max ? [...out.slice(0, max), `and ${out.length - max} more`] : out;
}
