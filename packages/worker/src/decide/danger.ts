import type { IntentSource, Path } from "@fire_trident/core";
import { globMatch, importsOf } from "@fire_trident/core";
import { diffLines, splitLines } from "./diff.ts";
import { handoffMatches } from "./handoff.ts";
import { foldPath } from "./pathfold.ts";
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
 * - handoff: files another tool runs or obeys (by path, decide/handoff.ts): agent-client and editor
 *   configuration such as .mcp.json and .vscode/, dev containers, .envrc, git hooks, .gitmodules, nested
 *   .git, virtual environments, other coding agents' instruction files, and the .gitattributes lines
 *   that select a filter, diff or merge driver
 * - loosened-guard: a check a modified script deletes or weakens (a deleted throw or 401/403
 *   denial, a security condition made weaker, verify swapped for decode, a dropped constant-time
 *   compare, a deleted expiry or limit check). It reads removed lines too, so it sees what a
 *   change takes away; it is heuristic, so it is a signal, never a human gate
 * Auth, secret and capability hits must reach a human unless a policy or an antibody explicitly
 * allows them; governance, handoff and test-change always reach a human, since no allowance may waive
 * them. The others are danger signals that only a reviewer's approval can clear; no allowance
 * or intent clears a loosened guard. Only an intent written by a person, a colony rule or trunk
 * certification can ask for a capability: an agent's own words (an agent-declared intent, a
 * proposal's summary) never waive a hit.
 * Import and export-from lines are never scanned for code patterns: rewriting a specifier
 * (Hono's ./x -> ./x.ts, OpenSpec's 'fs' -> 'node:fs') never adds behavior. Paths match in their folded
 * form (decide/pathfold.ts: NFC, case-folded), so `.Firetrident/` and `claude.md` hit too. Pure: no I/O.
 */

export type DangerClass = "auth" | "secret" | "capability" | "crypto" | "ci" | "dependency" | "test-weakening" | "governance" | "handoff" | "test-change" | "loosened-guard";

/** Classes that must reach a human. */
export const MUST_HUMAN: ReadonlySet<DangerClass> = new Set<DangerClass>(["auth", "secret", "capability", "governance", "handoff", "test-change"]);

/** Classes no policy, antibody or intent can allow. */
export const UNWAIVABLE: ReadonlySet<DangerClass> = new Set<DangerClass>(["governance", "handoff", "test-change", "loosened-guard"]);

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

/**
 * Intent sources whose text may ask for a capability: written by a person or a rule. A repair
 * intent from certification quotes test names and errors from the repository, which agents write,
 * so its text never waives a gate either.
 */
const TRUSTED_SOURCES: ReadonlySet<string> = new Set<IntentSource>(["human", "rule"]);

/** Paths that decide on agents: the colony's memory and agent instructions, anywhere in the tree (tested on the folded path). */
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
  /** The new text could not be read (binary, too large or unreadable), so `after` is not what the file holds. */
  opaque?: boolean;
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

// ---------------------------------------------------------------------------
// Loosened guards: checks a modified script deletes or weakens
// ---------------------------------------------------------------------------

/** Words that make a condition a security check: auth, tokens, sessions, roles, signatures and the like. */
const GUARD_SOURCE = String.raw`auth(?!or)|token|verif|session|permission|\bperms?\b|\broles?\b|admin|signature|jwt|csrf|passw|credential|secret|\bscopes?\b|\bowner|tenant`;
/** Words of an expiry check: a token's exp and nbf, expiresAt, a TTL or a max age. */
const EXPIRY_SOURCE = String.raw`\bexp\b|expir|\bnbf\b|notBefore|notAfter|\bttl\b|maxAge|max_age`;
/** Words of a rate or limit check. */
const LIMIT_SOURCE = String.raw`limit|quota|throttl|attempts\b|tooMany|too_many|\bretries\b`;
const GUARD_WORDS = new RegExp(GUARD_SOURCE, "i");
const EXPIRY_WORDS = new RegExp(EXPIRY_SOURCE, "i");
const LIMIT_WORDS = new RegExp(LIMIT_SOURCE, "i");
/** All of them at once: a guard on any of these words is a security check. */
const CHECK_WORDS = new RegExp(`${GUARD_SOURCE}|${EXPIRY_SOURCE}|${LIMIT_SOURCE}`, "i");
const CHECK_WORDS_ALL = new RegExp(CHECK_WORDS.source, "gi");

/** A `throw` statement (not a method, nor a name that starts with "throw"). */
const THROW = /(?<![\w$.])throw\b/;
/** A 401 or 403, or the words for them. */
const AUTH_DENIAL = /\b40[13]\b|unauthori[sz]ed|forbidden/i;
/** What makes a 401 or 403 a response: returned, thrown, set as a status, or passed to an error helper. */
const DENIAL_CONTEXT =
  /(?<![\w$.])(?:return|throw)\b|\bstatus(?:Code)?\b|\.code\s*\(|\bnew\s+Response\s*\(|(?<![\w$])\w*(?:throw|deny|denied|reject|abort|unauthori[sz]ed|forbidden|exception|error)\w*\s*\(|\b(?:sendStatus|writeHead)\s*\(/i;
/** A 401 or 403 that is compared (a client reading a response), not sent. */
const STATUS_TEST = /[!=]==?\s*['"`]?40[13]\b|\b40[13]['"`]?\s*[!=]==?|\bcase\s+['"`]?40[13]\b/g;
/** Log calls: a message that says "Unauthorized" denies nothing. */
const LOG_CALL = /(?<![\w$])(?:console|logger|log)\s*\.\s*\w+\s*\([^)]*\)?/g;
/** A stub's throw (code about to be written), not a check. */
const PLACEHOLDER_THROW = /not\s+(?:yet\s+)?implemented|unimplemented|unreachable|\btodo\b/i;
/** A consequent that denies without a 401/403 or a throw, or one that lets the request through. */
const DENIES = /\breturn\s+false\b|\bredirect\s*\(|\b429\b|too\s*many/i;
const ALLOWS = /(?<![\w$.])next\s*\(|\breturn\s+true\b/;
/** A consequent that leaves the code path: it returns, throws, or skips a loop turn. */
const EXITS = /(?<![\w$.])(?:return|throw|continue|break)\b/;
/** Calls that verify a token or signature, calls that only decode or parse one, and constant-time compares. */
const VERIFY_CALL = /(?<![\w$])(?:[\w$]+\s*\.\s*)*[\w$]*verif\w*\s*\(/gi;
const VERIFY_CONTEXT = /jwt|jws|jose|token|signature|\bsig\b|secret|\bkey\b|publicKey|cert/i;
const DECODE_CALL = /(?<![\w$])(?:[\w$]+\s*\.\s*)*[\w$]*(?:decode|parse)\w*\s*\(/i;
const DECODE_CONTEXT = /jwt|jws|jose|token|payload|claims?\b|signature|header/i;
const CONSTANT_TIME = /\b(?:timingSafeEqual|timingSafeCompare|constantTimeEqual|constantTimeCompare|safeCompare|secureCompare|safeEqual)\s*\(/g;
/** A line that declares a function, method or class: a guard deleted with it was dead code, not loosened. */
const DECLARATION =
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\b|class\b)|^\s*(?:export\s+)?(?:const|let|var)\s+[\w$]+\s*(?::[^=]*)?=\s*(?:async\s*)?(?:function\b|\(|[\w$]+\s*=>)|^\s*(?:(?:public|private|protected|static|readonly|override|async|get|set)\s+)*(?!(?:if|for|while|switch|catch|with|return|else|do|try|function)\b)[\w$]+\s*(?:<[^>]*>)?\s*\(.*\)\s*(?::\s*[^{=]+)?\{\s*$/;
/** A consequent longer than this is a code path, not a check. */
const GUARD_BODY_LINES = 12;
/** Loosened-guard hits kept per file. */
const MAX_LOOSENED = 6;
/** Generated or vendored code, and minified bundles: no one writes a check there by hand. */
const GENERATED = /(^|\/)(?:dist|build|vendor|node_modules|coverage)\/|\.min\.[cm]?js$/;
/** A line this long means minified or generated code. */
const MINIFIED_LINE = 1_000;
const IF = /(?<![\w$.])if\s*\(/g;
const QUOTE = /['"`]/g;
/** A line that opens a function or control block: a statement ends there, it does not run on through the body. */
const OPENS_BLOCK = /(?:=>|\))\s*\{\s*$/;

/** Whitespace collapsed to single spaces, none just inside brackets: how code is quoted in a hit. */
const collapse = (s: string): string =>
  s
    .replace(/\s+/g, " ")
    .replace(/([([{]) /g, "$1")
    .replace(/ ([)\]}])/g, "$1")
    .trim();
const NULLISH = /^(?:null|undefined|''|void 0)$/;
/** A type check (`typeof x !== 'string'`, `x instanceof Y`): dropping one is a type change, not a loosened check. */
const TYPE_CHECK = /^(?:! )*typeof\b|\binstanceof\b/;

/** What a statement denies: a 401 or 403 response (`status`) and whether it throws; null when it denies nothing. */
interface Denial {
  status: "401" | "403" | null;
  thrown: boolean;
}

/** The denial in a statement's code: a 401/403 sent, or a throw (a stub's throw is none). */
function denialIn(text: string): Denial | null {
  const t = text.replace(LOG_CALL, " ").replace(STATUS_TEST, " ");
  const thrown = THROW.test(t) && !PLACEHOLDER_THROW.test(t);
  if (AUTH_DENIAL.test(t) && DENIAL_CONTEXT.test(t)) return { status: /\b401\b|unauthori[sz]ed/i.test(t) ? "401" : "403", thrown };
  return thrown ? { status: null, thrown } : null;
}

/** What a throw statement throws, by name (`JwtTokenExpired` in `throw new JwtTokenExpired(token)`); its message does not count. */
function thrownName(text: string): string {
  return /(?<![\w$.])throw\s+(?:new\s+)?([\w$.]+)/.exec(text)?.[1] ?? "";
}

/** What an if's consequent does: deny (throw, a 401/403, return false, a redirect, a 429), allow (next(), return true) or neither. */
type GuardKind = "deny" | "allow" | "other";

function guardKind(body: string, lines: number): GuardKind {
  if (lines > GUARD_BODY_LINES) return "other";
  const deny = denialIn(body) !== null || DENIES.test(body);
  const allow = ALLOWS.test(body.replace(LOG_CALL, " "));
  return deny === allow ? "other" : deny ? "deny" : "allow";
}

/** A token of code: a string literal's content (`s`), or a word, a number or an operator; `at`..`end` is where it stands. */
interface Tok {
  t: string;
  s?: true;
  at: number;
  end: number;
}

const WORD = /[\w$]+/y;
const OPERATORS = ["===", "!==", "...", "&&", "||", "??", "?.", "==", "!=", "<=", ">=", "=>"];
const OPENERS = new Set(["(", "[", "{"]);
const CLOSERS = new Set([")", "]", "}"]);
const COMPARISONS = new Set(["===", "!==", "==", "!=", "<", ">", "<=", ">="]);
const KEYWORDS = new Set(["typeof", "instanceof", "in", "of", "new", "await", "void", "delete", "true", "false", "null", "undefined", "this", "super", "as", "satisfies"]);

function tokenize(text: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v") {
      i++;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      const end = stringEnd(text, i);
      out.push({ t: text.slice(i + 1, end > i + 1 && text[end - 1] === c ? end - 1 : end), s: true, at: i, end });
      i = end;
      continue;
    }
    WORD.lastIndex = i;
    const w = WORD.exec(text);
    const t = w ? w[0] : (OPERATORS.find((o) => text.startsWith(o, i)) ?? c);
    out.push({ t, at: i, end: i + t.length });
    i += t.length;
  }
  return out;
}

const isOp = (k: Tok | undefined, t: string): boolean => k !== undefined && !k.s && k.t === t;

/** A comparison key: layout, semicolons, trailing commas and the quote style do not count. */
function keyOf(toks: readonly Tok[]): string {
  const out: string[] = [];
  toks.forEach((k, i) => {
    if (k.s) out.push(`'${k.t}'`);
    else if (k.t === ";" || (k.t === "," && toks[i + 1] !== undefined && !toks[i + 1]!.s && CLOSERS.has(toks[i + 1]!.t))) return;
    else out.push(k.t);
  });
  return out.join(" ");
}

/** Tokens without the parentheses that wrap all of them. */
function unwrap(toks: Tok[]): Tok[] {
  let x = toks;
  while (x.length >= 2 && isOp(x[0], "(") && isOp(x[x.length - 1], ")")) {
    let depth = 0;
    let closes = -1;
    for (let i = 0; i < x.length && closes < 0; i++) {
      const k = x[i]!;
      if (k.s) continue;
      if (OPENERS.has(k.t)) depth++;
      else if (CLOSERS.has(k.t) && --depth === 0) closes = i;
    }
    if (closes !== x.length - 1) break;
    x = x.slice(1, -1);
  }
  return x;
}

/** Tokens split where `op` stands outside every bracket. */
function splitTop(toks: Tok[], op: string): Tok[][] {
  const parts: Tok[][] = [[]];
  let depth = 0;
  for (const k of toks) {
    if (!k.s && OPENERS.has(k.t)) depth++;
    else if (!k.s && CLOSERS.has(k.t)) depth--;
    if (depth === 0 && isOp(k, op)) parts.push([]);
    else parts[parts.length - 1]!.push(k);
  }
  return parts;
}

/** One operand of a condition: its key, whether it is negated, and the comparison it makes. */
interface Operand {
  key: string;
  /** As written in the condition. */
  text: string;
  neg: boolean;
  /** The key without its negation. */
  base: string;
  cmp: { l: string; op: string; r: string } | null;
  /** The constant a comparison checks against (not null, undefined or ""). */
  lit: string | null;
}

function operandOf(toks: Tok[], src: string): Operand {
  const all = unwrap(toks);
  const text = all.length > 0 ? collapse(src.slice(all[0]!.at, all[all.length - 1]!.end)) : "";
  let x = all;
  let neg = false;
  while (isOp(x[0], "!")) {
    neg = !neg;
    x = unwrap(x.slice(1));
  }
  let depth = 0;
  let at = -1;
  for (let i = 0; i < x.length && at < 0; i++) {
    const k = x[i]!;
    if (k.s) continue;
    if (OPENERS.has(k.t)) depth++;
    else if (CLOSERS.has(k.t)) depth--;
    else if (depth === 0 && COMPARISONS.has(k.t)) at = i;
  }
  let cmp: Operand["cmp"] = null;
  let lit: string | null = null;
  if (at > 0 && !neg) {
    const l = x.slice(0, at);
    const r = x.slice(at + 1);
    cmp = { l: keyOf(l), op: x[at]!.t, r: keyOf(r) };
    const constant = (side: Tok[]): string | null => (side.length === 1 && (side[0]!.s || /^(?:\d|true$|false$)/.test(side[0]!.t)) ? keyOf(side) : null);
    lit = constant(r) ?? constant(l);
    if (lit !== null && NULLISH.test(lit)) lit = null;
  }
  return { key: keyOf(all), text, neg, base: keyOf(x), cmp, lit };
}

/** A condition read for comparison: its operands (disjuncts of conjuncts), its shape with local names numbered, its names. */
interface Cond {
  key: string;
  or: Operand[][];
  flat: Operand[];
  shape: string;
  ids: Set<string>;
}

function conditionOf(text: string): Cond {
  const toks = unwrap(tokenize(text));
  let depth = 0;
  let ternary = false;
  for (const k of toks) {
    if (!k.s && OPENERS.has(k.t)) depth++;
    else if (!k.s && CLOSERS.has(k.t)) depth--;
    else if (depth === 0 && isOp(k, "?")) ternary = true;
  }
  const or = ternary ? [[operandOf(toks, text)]] : splitTop(toks, "||").map((d) => splitTop(unwrap(d), "&&").map((c) => operandOf(c, text)));
  // Local names (not a property, not a call) are numbered in order, so a renamed variable keeps the shape.
  const names = new Map<string, string>();
  const ids = new Set<string>();
  const shaped = toks.map((k, i): Tok => {
    if (k.s || !/^[A-Za-z_$][\w$]*$/.test(k.t) || KEYWORDS.has(k.t)) return k;
    ids.add(k.t);
    const prev = toks[i - 1];
    if (isOp(prev, ".") || isOp(prev, "?.") || isOp(toks[i + 1], "(")) return k;
    let n = names.get(k.t);
    if (n === undefined) {
      n = `#${names.size}`;
      names.set(k.t, n);
    }
    return { t: n, at: k.at, end: k.end };
  });
  return { key: keyOf(toks), or, flat: or.flat(), shape: keyOf(shaped), ids };
}

/** The security, expiry and limit words an operand checks. */
function checkWords(o: Operand): Set<string> {
  return new Set((o.key.match(CHECK_WORDS_ALL) ?? []).map((w) => w.toLowerCase()));
}

/** Does an added operand check what a removed one did (the same word, the same compared side, the same constant)? */
function covers(n: Operand, o: Operand): boolean {
  const words = checkWords(o);
  if ([...checkWords(n)].some((w) => words.has(w))) return true;
  if (o.cmp && n.cmp && (o.cmp.l === n.cmp.l || o.cmp.r === n.cmp.r)) return true;
  return o.lit !== null && n.key.toLowerCase().includes(o.lit.replace(/^'|'$/g, "").toLowerCase());
}

/** The id for removed operands: an expiry or limit check, or a comparison against a constant. */
function removalId(ops: readonly Operand[]): string | null {
  if (ops.some((o) => EXPIRY_WORDS.test(o.key))) return "removed-expiry-check";
  if (ops.some((o) => LIMIT_WORDS.test(o.key))) return "removed-limit-check";
  if (ops.some((o) => o.lit !== null)) return "removed-constant-comparison";
  return null;
}

/** What made a condition weaker: the pattern id and, in a few words, how. */
interface Weaker {
  id: string;
  how: string;
}

/**
 * How an if's condition got weaker from `g` to `t`, or null when it is equal, only renamed,
 * stricter or unrelated. What the consequents do decides the direction: a denial that fires less
 * often, or an allowance that fires more often, is weaker. `split` holds the operands the same edit
 * checks in an if of their own (a guard split in two): those are moved, not removed.
 */
function weakerCondition(g: Guard, t: Guard, split: ReadonlySet<string> = new Set()): Weaker | null {
  const [a, b, ka, kb] = [g.cond, t.cond, g.kind, t.kind];
  if (a.key === b.key || a.shape === b.shape) return null;
  // `===` turned into `==` (or `!==` into `!=`), except against null or undefined.
  for (const o of a.flat) {
    const c = o.cmp;
    if (!c || (c.op !== "===" && c.op !== "!==") || NULLISH.test(c.l) || NULLISH.test(c.r) || TYPE_CHECK.test(o.key)) continue;
    const loose = b.flat.find((n) => n.cmp && n.cmp.op === c.op.slice(0, 2) && ((n.cmp.l === c.l && n.cmp.r === c.r) || (n.cmp.l === c.r && n.cmp.r === c.l)));
    if (loose) return { id: "loose-equality", how: `${o.text} became ${loose.text}` };
  }
  const inA = new Set(a.flat.map((o) => o.key));
  const inB = new Set(b.flat.map((o) => o.key));
  const removed = a.flat.filter((o) => !inB.has(o.key) && !TYPE_CHECK.test(o.key) && !split.has(o.key));
  const added = b.flat.filter((n) => !inA.has(n.key) && !TYPE_CHECK.test(n.key));
  const lost = (ops: readonly Operand[]): Weaker => ({ id: removalId(ops) ?? "weakened-condition", how: `dropped ${ops.map((o) => o.text).join(", ")}` });
  const gained: Weaker = { id: "weakened-condition", how: `gained ${added.filter((n) => n.key !== a.key).map((n) => n.text).join(", ")}` };
  // One negation removed or added, or one comparison turned around, with the same consequent: the check is inverted.
  // (A consequent that changed too is a restructure, such as an early return in place of an else.)
  if (g.bodyKey === t.bodyKey && removed.length === 1 && added.length === 1) {
    const [o, n] = [removed[0]!, added[0]!];
    const opposite: Record<string, string> = { "===": "!==", "!==": "===", "==": "!=", "!=": "==" };
    if ((o.base === n.base && o.neg !== n.neg) || (o.cmp && n.cmp && o.cmp.l === n.cmp.l && o.cmp.r === n.cmp.r && opposite[o.cmp.op] === n.cmp.op)) {
      return { id: "inverted-condition", how: `${o.text} became ${n.text}` };
    }
  }
  const kind = ka === kb ? ka : "other";
  const conj = (c: Cond): boolean => c.or.length === 1;
  const disj = (c: Cond): boolean => c.or.every((d) => d.length === 1);
  const onlyAdded = added.length > 0 && removed.length === 0;
  const onlyRemoved = removed.length > 0 && added.length === 0;
  // The old condition kept whole as one operand of the new one: `(old) && x`, or `(old) || x`.
  const wraps = (op: "&&" | "||"): boolean => (op === "&&" ? conj(b) && b.flat.length > 1 && b.or[0]!.some((n) => n.key === a.key) : b.or.length > 1 && b.or.some((d) => d.length === 1 && d[0]!.key === a.key));
  if (kind === "deny") {
    // A denial that fires less often: a condition added to it, or a reason for it removed.
    if ((onlyAdded && conj(a) && conj(b)) || wraps("&&")) return gained;
    if (onlyRemoved && disj(a) && disj(b)) return lost(removed);
    if ((onlyRemoved && conj(a) && conj(b)) || (onlyAdded && disj(a) && disj(b))) return null;
  } else if (kind === "allow") {
    // An allowance that fires more often: another way in, or a condition of it removed.
    if ((onlyAdded && disj(a) && disj(b)) || wraps("||")) return gained;
    if (onlyRemoved && conj(a) && conj(b)) return lost(removed);
    if ((onlyAdded && conj(a) && conj(b)) || (onlyRemoved && disj(a) && disj(b))) return null;
  }
  // A security check dropped: a removed operand on a security word or a constant, with nothing added that checks the
  // same, from an if that guards something (it denies, allows, returns, throws or skips; not one that sets a header).
  if (kind === "other" && !(g.bodyTo - g.bodyFrom < GUARD_BODY_LINES && EXITS.test(g.body))) return null;
  const dropped = removed.filter((o) => (checkWords(o).size > 0 || (o.lit !== null && kind !== "other")) && !added.some((n) => covers(n, o)));
  return dropped.length > 0 ? lost(dropped) : null;
}

/** Text without a throw, a 401/403 or the words for them denies nothing: no need to read it closer. */
const DENIAL_HINT = /throw|40[13]|unauthori[sz]ed|forbidden/i;

/** A statement: lines `start`..`end` (0-based), joined while a parenthesis or bracket stays open. */
class Unit {
  private k: string | null = null;
  /** What it denies, or null. */
  readonly deny: Denial | null;
  constructor(
    readonly start: number,
    readonly end: number,
    readonly text: string,
  ) {
    // A declaration (`function forbidden(): Response {`) names a denial; it does not send one.
    this.deny = DENIAL_HINT.test(text) && !DECLARATION.test(text.split(/\r\n|\r|\n/, 1)[0] ?? "") ? denialIn(text) : null;
  }
  /** Its comparison key, read only when asked: most statements are never compared. */
  get key(): string {
    return (this.k ??= keyOf(tokenize(this.text)));
  }
  /** Does it deny or exit? Only those are counted to tell a moved check from a deleted one. */
  get counted(): boolean {
    return this.deny !== null || DENIES.test(this.text) || EXITS.test(this.text);
  }
}

/** An if statement: its condition, what its consequent does, and the lines it spans (else branches included). */
class Guard {
  private c: Cond | null = null;
  private k: string | null = null;
  constructor(
    readonly line: number,
    readonly endLine: number,
    /** The condition's code (comments blanked), as written. */
    readonly raw: string,
    readonly body: string,
    readonly bodyFrom: number,
    readonly bodyTo: number,
    readonly kind: GuardKind,
    /** The consequent is a block in braces. */
    readonly block: boolean,
  ) {}
  /** The condition read for comparison (tokenized only when asked). */
  get cond(): Cond {
    return (this.c ??= conditionOf(this.raw));
  }
  /** The condition as written, layout collapsed. */
  get text(): string {
    return collapse(this.raw);
  }
  /** How an excerpt names it: `if (condition)`, a long condition cut. */
  get head(): string {
    const t = this.text;
    return `if (${t.length > 80 ? `${t.slice(0, 79)}…` : t})${this.block ? " {" : ""}`;
  }
  /** The consequent's key. */
  get bodyKey(): string {
    return (this.k ??= keyOf(tokenize(this.body.slice(0, 2_000))));
  }
  /** Condition and consequent: tells a guard moved elsewhere in the file from one deleted. */
  get full(): string {
    return `${this.cond.key} => ${this.bodyKey}`;
  }
}

/** One side of a modified script, read for structure: its code lines (comments and import lines blanked), statements and ifs. */
interface Side {
  lines: string[];
  units: Unit[];
  guards: Guard[];
}

/** Code with string contents blanked (`skel`), so brackets inside strings do not count, and each opening bracket's match (-1: none). */
interface Skeleton {
  skel: string;
  match: Int32Array;
}

/** A line's diff key: layout, a trailing semicolon or comma and the quote style do not count. */
const lineKey = (l: string): string => l.replace(/\s+/g, "").replace(/[;,]+$/, "").replace(/["`]/g, "'");

/** A script's code: comments and import lines blanked (line breaks kept, so offsets and lines stay put). */
function codeOf(path: Path, text: string): string {
  const code = blankComments(text);
  const imports = [...importLines(path, text)].sort((x, y) => x - y);
  if (imports.length === 0) return code;
  const starts = lineStarts(code);
  const parts: string[] = [];
  let at = 0;
  for (const l of imports) {
    const from = starts[l - 1];
    if (from === undefined || from < at) continue;
    let to = starts[l] ?? code.length;
    while (to > from && (code[to - 1] === "\n" || code[to - 1] === "\r")) to--;
    parts.push(code.slice(at, from), " ".repeat(to - from));
    at = to;
  }
  parts.push(code.slice(at));
  return parts.join("");
}

/**
 * `code` with every string literal's content blanked (quotes and line breaks kept). A ' or "
 * that does not close on its line starts no string (a quote inside a regex literal or JSX text),
 * so it cannot hide the brackets after it.
 */
function blankStrings(code: string): string {
  const parts: string[] = [];
  let i = 0;
  let from = 0;
  for (;;) {
    QUOTE.lastIndex = from;
    const m = QUOTE.exec(code);
    if (!m) {
      parts.push(code.slice(i));
      break;
    }
    const k = m.index;
    const end = stringEnd(code, k);
    const closed = end > k + 1 && code[end - 1] === code[k];
    if (!closed && code[k] !== "`") {
      from = k + 1;
      continue;
    }
    parts.push(code.slice(i, k + 1), code.slice(k + 1, closed ? end - 1 : end).replace(/[^\r\n]/g, " "), code.slice(closed ? end - 1 : end, end));
    i = from = end;
  }
  return parts.join("");
}

/** For each opening bracket, its closing one; a stray closer is skipped, an opener left open gets -1. */
function matchBrackets(skel: string): Int32Array {
  const match = new Int32Array(skel.length).fill(-1);
  const stack: number[] = [];
  for (let i = 0; i < skel.length; i++) {
    const c = skel[i];
    if (c === "(" || c === "[" || c === "{") stack.push(i);
    else if (c === ")" || c === "]" || c === "}") {
      const open = c === ")" ? "(" : c === "]" ? "[" : "{";
      for (let k = stack.length - 1; k >= 0 && stack.length - k <= 64; k--) {
        if (skel[stack[k]!] !== open) continue;
        match[stack[k]!] = i;
        stack.length = k;
        break;
      }
    }
  }
  return match;
}

function lineEndAt(text: string, i: number): number {
  while (i < text.length && text[i] !== "\n" && text[i] !== "\r") i++;
  return i;
}

/** The block or single statement that starts at `from` (after blanks): its code span and where it ends. */
function branchAt(s: Skeleton, from: number): { from: number; to: number; end: number; block: boolean } | null {
  const k = skipBlank(s.skel, from);
  if (k >= s.skel.length) return null;
  if (s.skel[k] === "{") {
    const close = s.match[k]!;
    return close < 0 ? null : { from: k + 1, to: close, end: close + 1, block: true };
  }
  // One statement: to the end of its line, and on past any bracket it leaves open.
  let e = lineEndAt(s.skel, k);
  for (let j = k; j < e; j++) {
    const c = s.skel[j];
    if ((c === "(" || c === "[" || c === "{") && s.match[j]! > e) e = lineEndAt(s.skel, s.match[j]!);
  }
  return { from: k, to: e, end: e, block: false };
}

/** Net parentheses and brackets a line opens. */
function bracketNet(line: string): number {
  let n = 0;
  for (const c of line) {
    if (c === "(" || c === "[") n++;
    else if (c === ")" || c === "]") n--;
  }
  return n;
}

/** Read one side of a modified script: statements, if statements and their consequents. */
function sideOf(code: string, lines: string[]): Side {
  const skel = blankStrings(code);
  const starts = lineStarts(code);
  const match = matchBrackets(skel);
  const skelLines = splitLines(skel);
  const units: Unit[] = [];
  for (let i = 0; i < skelLines.length; ) {
    if (skelLines[i]!.trim() === "") {
      i++;
      continue;
    }
    let depth = bracketNet(skelLines[i]!);
    let j = i;
    while (depth > 0 && j + 1 < skelLines.length && j - i < 40 && !OPENS_BLOCK.test(skelLines[j]!)) depth += bracketNet(skelLines[++j]!);
    units.push(new Unit(i, j, lines.slice(i, j + 1).join("\n")));
    i = j + 1;
  }
  const guards: Guard[] = [];
  IF.lastIndex = 0;
  for (let m = IF.exec(skel); m !== null; m = IF.exec(skel)) {
    const open = m.index + m[0].length - 1;
    const close = match[open]!;
    const then = close < 0 ? null : branchAt({ skel, match }, close + 1);
    if (!then) continue;
    let end = then.end;
    for (let k = 0; k < 64; k++) {
      const e = skipBlank(skel, end);
      if (!skel.startsWith("else", e) || /[\w$]/.test(skel[e + 4] ?? "")) break;
      const at = skipBlank(skel, e + 4);
      const elif = /^if\s*\(/.exec(skel.slice(at, at + 64));
      const p = elif ? at + elif[0].length - 1 : -1;
      const b = elif ? (match[p]! < 0 ? null : branchAt({ skel, match }, match[p]! + 1)) : branchAt({ skel, match }, at);
      if (!b) break;
      end = b.end;
      if (!elif) break;
    }
    const body = code.slice(then.from, then.to);
    const bodyFrom = lineOf(starts, then.from) - 1;
    const bodyTo = lineOf(starts, Math.max(then.from, then.to - 1)) - 1;
    const line = lineOf(starts, m.index) - 1;
    guards.push(new Guard(line, lineOf(starts, Math.max(m.index, end - 1)) - 1, code.slice(open + 1, close), body, bodyFrom, bodyTo, guardKind(body, bodyTo - bodyFrom + 1), then.block));
  }
  return { lines, units, guards };
}

/** Length of the longest line. */
function longestLine(text: string): number {
  let longest = 0;
  let from = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || text[i] === "\n" || text[i] === "\r") {
      longest = Math.max(longest, i - from);
      from = i + 1;
    }
  }
  return longest;
}

/** How many times each key occurs. */
function tally(keys: Iterable<string>): Map<string, number> {
  const out = new Map<string, number>();
  for (const k of keys) out.set(k, (out.get(k) ?? 0) + 1);
  return out;
}

function count(re: RegExp, text: string): number {
  re.lastIndex = 0;
  return text.match(re)?.length ?? 0;
}

/**
 * Is the nearest declaration (function, method or class) around `line` deleted too? Then a check
 * inside it went away with dead code, not loosened. Indentation tells what encloses what.
 */
function declarationRemoved(lines: readonly string[], removed: (line: number) => boolean, line: number): boolean {
  const indent = (l: string): number => /^\s*/.exec(l)![0].length;
  let level = indent(lines[line] ?? "");
  for (let i = line - 1; i >= 0 && line - i <= 2_000; i--) {
    const l = lines[i]!;
    if (l.trim() === "") continue;
    const at = indent(l);
    if (at >= level) continue;
    level = at;
    if (DECLARATION.test(l)) return removed(i);
    if (at === 0) return false;
  }
  return false;
}

/**
 * Checks a modified script deletes or weakens: the loosened-guard danger signal. Narrow on
 * purpose (it must rarely fire on an ordinary refactor), so it reads what the change takes away:
 * - a deleted 401/403 response (returned, thrown or set as a status, or "Unauthorized" and
 *   "Forbidden"), or a deleted throw inside an if on a security word (in its condition or in what
 *   it throws), unless the same statement still stands elsewhere in the file (moved) or the same
 *   edit puts a denial of its kind back (reworded);
 * - an if condition on a security word (auth, token, verify, session, permission, role, admin,
 *   signature and the like) or guarding a 401/403 that got weaker: a denial that fires less often
 *   (an operand added with &&, or one removed from ||), an allowance that fires more often, a
 *   negation removed or a comparison inverted, === turned into ==, or a checked word or constant
 *   dropped. Renamed variables, type checks, a guard split in two and stricter conditions do not
 *   count;
 * - verify swapped for decode or parse on a token or signature, or a constant-time compare dropped;
 * - a deleted if that checks an expiry, a rate or a limit, or a deleted security if that denies.
 * Comments, import lines, layout, quotes and semicolons are ignored. Test files, new and deleted
 * files, generated or minified code are not read, and a check deleted together with its whole
 * function is dead code. Each hit is anchored at a line of the new text: where the check was
 * edited, or the line before the place it was removed from (the deleted lines follow it in the
 * diff). Pure: no I/O.
 */
export function loosenedGuards(path: Path, before: string, after: string): DangerHit[] {
  if (!SCRIPT.test(path) || isTestPath(path) || GENERATED.test(path) || before.trim() === "" || after.trim() === "") return [];
  if (longestLine(before) > MINIFIED_LINE || longestLine(after) > MINIFIED_LINE) return [];
  try {
    return findLoosened(path, before, after);
  } catch {
    // A heuristic never stops the review of a change.
    return [];
  }
}

function findLoosened(path: Path, before: string, after: string): DangerHit[] {
  const codeA = codeOf(path, before);
  const codeB = codeOf(path, after);
  const linesA = splitLines(codeA);
  const linesB = splitLines(codeB);
  const ops = diffLines(linesA.map(lineKey), linesB.map(lineKey));
  // Runs of changed lines, and where each old line went.
  const runs: Array<{ added: number[]; at: number }> = [];
  const runOfA = new Int32Array(linesA.length).fill(-1);
  const runOfB = new Int32Array(linesB.length).fill(-1);
  const toB = new Int32Array(linesA.length).fill(-1);
  let open = false;
  for (const op of ops) {
    if (op.kind === "=") {
      toB[op.a] = op.b;
      open = false;
      continue;
    }
    if (!open) runs.push({ added: [], at: op.b });
    open = true;
    if (op.kind === "-") runOfA[op.a] = runs.length - 1;
    else {
      runs[runs.length - 1]!.added.push(op.b);
      runOfB[op.b] = runs.length - 1;
    }
  }
  if (runs.length === 0) return [];
  const a = sideOf(codeA, linesA);
  const b = sideOf(codeB, linesB);
  const removedA = (line: number): boolean => (runOfA[line] ?? -1) >= 0;
  // A deleted line's place in the new text: the first line the run adds, else the line before the deletion.
  const anchor = (r: number): number => {
    const run = runs[r]!;
    return run.added.length > 0 ? run.added[0]! + 1 : Math.max(1, run.at);
  };
  const touched = (u: Unit, runOf: Int32Array): number => {
    for (let i = u.start; i <= u.end; i++) if ((runOf[i] ?? -1) >= 0) return runOf[i]!;
    return -1;
  };
  const group = <T>(items: readonly T[], runOf: (x: T) => number): Map<number, T[]> => {
    const out = new Map<number, T[]>();
    for (const x of items) {
      const r = runOf(x);
      if (r < 0) continue;
      const list = out.get(r);
      if (list) list.push(x);
      else out.set(r, [x]);
    }
    return out;
  };
  // What each run touches: statements on both sides, and the if statements whose first line it removes or adds.
  const goneIn = group(a.units, (u) => touched(u, runOfA));
  const putIn = group(b.units, (u) => touched(u, runOfB));
  const guardsOut = group(a.guards, (g) => runOfA[g.line] ?? -1);
  const guardsIn = group(b.guards, (g) => runOfB[g.line] ?? -1);
  // The innermost if around each old line, and the statement that starts on it.
  const guardAt: Array<Guard | undefined> = new Array(linesA.length);
  for (const g of a.guards) for (let l = g.line; l <= g.endLine && l < linesA.length; l++) guardAt[l] = g;
  const unitAt: Array<Unit | undefined> = new Array(linesA.length);
  for (const u of a.units) unitAt[u.start] = u;
  const keysA = tally(a.units.filter((u) => u.counted).map((u) => u.key));
  const keysB = tally(b.units.filter((u) => u.counted).map((u) => u.key));
  const statement = (u: Unit): string => collapse(u.text);
  const found = new Map<number, { id: string; excerpt: string; rank: number }>();
  const add = (line: number, id: string, excerpt: string, rank: number): void => {
    const cur = found.get(line);
    if (!cur || rank > cur.rank) found.set(line, { id, excerpt, rank });
  };
  /** Enough found: what is past it is not reported anyway, and a huge rewrite must stay cheap. */
  const full = (): boolean => found.size >= MAX_LOOSENED * 4;

  // Deleted denials: a 401/403 response, or a throw inside an if on a security word, gone from the file and not
  // reworded in place. (A plain validation throw that moves into a helper is an ordinary refactor.)
  const deficit = new Map([...keysA].map(([k, n]) => [k, n - (keysB.get(k) ?? 0)]));
  for (const [run, gone] of goneIn) {
    const put = putIn.get(run) ?? [];
    const putDenial = put.some((x) => x.deny !== null);
    const putAuthDenial = put.some((x) => x.deny?.status != null);
    for (const u of gone) {
      if (!u.deny || full()) continue;
      const left = deficit.get(u.key) ?? 0;
      if (left <= 0) continue;
      deficit.set(u.key, left - 1);
      const d = u.deny;
      if (d.status !== null ? putAuthDenial : putDenial) continue;
      const guard = guardAt[u.start];
      if (d.status === null && (!guard || !(CHECK_WORDS.test(guard.raw) || CHECK_WORDS.test(thrownName(u.text))))) continue;
      if (declarationRemoved(a.lines, removedA, u.start)) continue;
      const id = d.status === null ? "deleted-throw" : `deleted-${d.status}-${d.thrown ? "throw" : "return"}`;
      const head = guard && guard.line < u.start ? `${guard.head} ` : "";
      add(anchor(run), id, `removed: ${head}${statement(u)}`, d.status === null ? 2 : 3);
    }
  }

  // If statements: pair each old one with its new self: the same line kept, or the closest one the same edit adds,
  // looked for among the ifs at about the same place in the run (pairing stays linear on a whole-file rewrite).
  const pairs = new Map<Guard, Guard>();
  const taken = new Set<Guard>();
  const firstOn = new Map<number, Guard>();
  for (const g of [...b.guards].reverse()) firstOn.set(g.line, g);
  for (const g of a.guards) {
    const nl = toB[g.line] ?? -1;
    const t = nl < 0 ? undefined : firstOn.get(nl);
    if (t && !taken.has(t)) {
      pairs.set(g, t);
      taken.add(t);
    }
  }
  const WINDOW = 8;
  for (const [run, olds] of guardsOut) {
    const news = guardsIn.get(run) ?? [];
    olds.forEach((g, k) => {
      let best: Guard | null = null;
      let score = 0;
      for (let j = Math.max(0, k - WINDOW); j < Math.min(news.length, k + WINDOW + 1); j++) {
        const t = news[j]!;
        if (taken.has(t)) continue;
        let shared = 0;
        for (const x of g.cond.ids) if (t.cond.ids.has(x)) shared++;
        const s = shared / (g.cond.ids.size + t.cond.ids.size - shared || 1) + (g.bodyKey === t.bodyKey ? 1 : 0);
        if (s > score) [best, score] = [t, s];
      }
      if (best) {
        pairs.set(g, best);
        taken.add(best);
      }
    });
  }

  // Weakened conditions on security checks.
  const authDenial = (g: Guard): boolean => g.kind === "deny" && (denialIn(g.body)?.status ?? null) !== null;
  const place = new Map<Guard, number>();
  for (const list of guardsIn.values()) list.forEach((g, i) => place.set(g, i));
  const squash = (s: string): string => s.replace(/\s+/g, "");
  for (const [g, t] of pairs) {
    if (squash(g.raw) === squash(t.raw) || full()) continue;
    if (!CHECK_WORDS.test(g.raw) && !CHECK_WORDS.test(t.raw) && !authDenial(g) && !authDenial(t)) continue;
    // Operands the same edit checks in another if near this one that exits: a guard split in two keeps them.
    const run = runOfB[t.line] ?? -1;
    const at = place.get(t) ?? 0;
    const near = run < 0 ? [] : (guardsIn.get(run) ?? []).slice(Math.max(0, at - WINDOW), at + WINDOW + 1);
    const split = new Set(near.filter((x) => x !== t && (x.kind === "deny" || EXITS.test(x.body))).flatMap((x) => x.cond.flat.map((o) => o.key)));
    const w = weakerCondition(g, t, split);
    if (!w) continue;
    // The whole edit when it fits in an excerpt, else the old condition and how it changed.
    const whole = `if (${g.text}) -> if (${t.text})`;
    add(t.line + 1, w.id, whole.length <= 140 ? whole : `if (${g.text.length > 60 ? `${g.text.slice(0, 59)}…` : g.text}) ${w.how}`, 3);
  }

  // Deleted checks: an if on an expiry, a rate or a limit that exits, or a security if that denies.
  let fullB: Map<string, number> | null = null;
  for (const [run, olds] of guardsOut) {
    for (const g of olds) {
      if (pairs.has(g) || full()) continue;
      const expiry = EXPIRY_WORDS.test(g.raw);
      const limit = !expiry && LIMIT_WORDS.test(g.raw);
      const exits = g.kind === "deny" || (g.kind === "other" && g.bodyTo - g.bodyFrom < GUARD_BODY_LINES && EXITS.test(g.body));
      if (!(((expiry || limit) && exits) || (g.kind === "deny" && GUARD_WORDS.test(g.raw)))) continue;
      // Moved: the same check still stands elsewhere in the file.
      fullB ??= tally(b.guards.map((x) => x.full));
      const left = fullB.get(g.full) ?? 0;
      if (left > 0) {
        fullB.set(g.full, left - 1);
        continue;
      }
      if (declarationRemoved(a.lines, removedA, g.line)) continue;
      // Its consequent must be gone too, else the check was restructured: a statement of it that denies (or, for an
      // expiry or limit check, one that exits) is no longer in the file.
      let gone = false;
      for (let l = g.bodyFrom; l <= g.bodyTo && !gone; l++) {
        const u = unitAt[l];
        gone = !!u && (u.deny !== null || DENIES.test(u.text) || ((expiry || limit) && EXITS.test(u.text))) && (keysB.get(u.key) ?? 0) < (keysA.get(u.key) ?? 0);
      }
      if (!gone) continue;
      const head = `removed: ${g.head}`;
      if (exits && expiry) add(anchor(run), "deleted-expiry-check", head, 4);
      else if (exits && limit) add(anchor(run), "deleted-limit-check", head, 4);
      else add(anchor(run), "deleted-guard", head, 1);
    }
  }

  // Verify swapped for decode, and constant-time compares dropped.
  const verifies = (t: string): boolean => {
    VERIFY_CALL.lastIndex = 0;
    return VERIFY_CALL.test(t) && VERIFY_CONTEXT.test(t);
  };
  const decodes = (t: string): boolean => DECODE_CALL.test(t) && DECODE_CONTEXT.test(t);
  const counts = new Map<RegExp, boolean>();
  const fewer = (re: RegExp): boolean => {
    if (!counts.has(re)) counts.set(re, count(re, codeA) > count(re, codeB));
    return counts.get(re)!;
  };
  for (const [r, gone] of goneIn) {
    if (full()) break;
    const put = putIn.get(r) ?? [];
    const verify = gone.find((u) => verifies(u.text));
    const decode = verify ? put.find((u) => decodes(u.text)) : undefined;
    if (verify && decode && fewer(VERIFY_CALL)) add(decode.start + 1, "verify-to-decode", `${statement(verify)} -> ${statement(decode)}`, 4);
    const compare = gone.find((u) => count(CONSTANT_TIME, u.text) > 0);
    if (compare && fewer(CONSTANT_TIME)) {
      const instead = put.find((u) => /[!=]==?/.test(u.text)) ?? put[0];
      add(instead ? instead.start + 1 : anchor(r), "constant-time-compare-removed", instead ? `${statement(compare)} -> ${statement(instead)}` : `removed: ${statement(compare)}`, 4);
    }
  }

  return [...found.entries()]
    .sort((x, y) => x[0] - y[0])
    .slice(0, MAX_LOOSENED)
    .map(([line, h]): DangerHit => ({ cls: "loosened-guard", pattern: `loosened-guard:${h.id}`, path, line, excerpt: maskExcerpt(h.excerpt) }));
}

/**
 * Recognize danger patterns in a change. The intent's title, why and acceptance decide which
 * capabilities and crypto uses it asks for (those hits are marked `requested` and do not count),
 * but only when a person, a rule or trunk certification wrote it: with no intent, or an intent an
 * agent declared, nothing is requested. Auth and secret hits always count. During a repair
 * (an intent from certification), any change to a test file beyond its imports is a test-change hit.
 * A modified script's deleted or weakened checks are loosened-guard hits (loosenedGuards), which no
 * intent asks for.
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
    const gov = GOVERNANCE.find((g) => g.re.test(foldPath(f.path)));
    if (gov) hits.push({ cls: "governance", pattern: `governance:${gov.id}`, path: f.path, line: 0, excerpt: f.deleted ? "deleted" : f.before === null ? "new file" : "changed" });
    // Files another tool runs or obeys (decide/handoff.ts): a person decides, as for governance, deleted ones too.
    for (const m of handoffMatches(f)) {
      const said = m.text === undefined ? `${f.deleted ? "deleted" : f.before === null ? "new file" : "changed"}: another tool runs or obeys this file` : maskExcerpt(m.text, 100);
      hits.push({ cls: "handoff", pattern: `handoff:${m.id}`, path: f.path, line: m.line, excerpt: `${said} (${m.why})` });
    }
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
    // Checks a modified script deletes or weakens: read from the removed lines, whoever wrote the intent.
    if (f.before !== null) hits.push(...loosenedGuards(f.path, f.before, f.after));
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
