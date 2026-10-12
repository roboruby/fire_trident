import type { Path } from "@fire_trident/core";
import { globMatch, importsOf } from "@fire_trident/core";
import { diffLines, splitLines } from "./diff.ts";
import { isTestPath, sensitiveReason } from "./signals.ts";

/**
 * Danger-pattern recognition: the innate immune system's pattern-recognition receptors. Fixed,
 * deterministic patterns over a change's ADDED lines (every line of a new file counts as added)
 * and its paths flag what must never depend on a model's judgment:
 * - auth: authorization headers, bearer schemes, credential comparisons, admin gates, 401/403
 * - secret: hard-coded credentials, known token formats, private keys, secrets written to logs
 * - capability: process, network or eval capability the intent does not ask for
 * - crypto: cryptographic or security randomness primitives the intent does not ask for
 * - ci, dependency: CI workflows and dependency manifests (by path)
 * - test-weakening: skipped or focused tests, deleted assertions, deleted test files
 * Auth, secret and capability hits must reach a human unless a policy or an antibody explicitly
 * allows them; the others are danger signals that only a reviewer's approval can clear.
 * Import and export-from lines are never scanned for code patterns: rewriting a specifier
 * (Hono's ./x -> ./x.ts, OpenSpec's 'fs' -> 'node:fs') never adds behavior. Pure: no I/O.
 */

export type DangerClass = "auth" | "secret" | "capability" | "crypto" | "ci" | "dependency" | "test-weakening";

/** Classes that must reach a human. */
export const MUST_HUMAN: ReadonlySet<DangerClass> = new Set<DangerClass>(["auth", "secret", "capability"]);

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
  { cls: "secret", id: "secret:private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, tests: true, anyFile: true, comments: true },
  {
    cls: "secret",
    id: "secret:token-format",
    re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,}|sk-(?:live-|proj-|ant-)?[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|art_v1_[0-9a-f]{20,}|eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/,
    tests: true,
    anyFile: true,
    comments: true,
  },
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

const ASSERTION = /\bexpect\s*\(|\bassert(?:\.\w+)?\s*\(|\.should\b/g;

function count(re: RegExp, text: string): number {
  re.lastIndex = 0;
  let n = 0;
  while (re.exec(text) !== null) n++;
  re.lastIndex = 0;
  return n;
}

/** The excerpt shown for a hit: trimmed, cut, long secret-looking values masked. */
export function maskExcerpt(line: string, max = 140): string {
  const masked = line.trim().replace(/(['"`])([^'"`\s]{8,})\1/g, (_m, q: string, v: string) => (/[A-Za-z]/.test(v) && /\d/.test(v) && v.length >= 12 ? `${q}${v.slice(0, 4)}…${q}` : `${q}${v}${q}`));
  return masked.length > max ? `${masked.slice(0, max - 1)}…` : masked;
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
 * Recognize danger patterns in a change. `intentText` (title, why, acceptance) decides which
 * capabilities and crypto uses the intent asks for: those hits are marked `requested` and do not
 * count. Auth and secret hits always count.
 */
export function scanDanger(files: readonly DangerFile[], intentText: string): DangerHit[] {
  const hits: DangerHit[] = [];
  const asks = (kind: "process" | "network" | "eval" | "crypto"): boolean => REQUESTS[kind].test(intentText);
  for (const f of files) {
    const reason = sensitiveReason(f.path);
    if (reason === "CI configuration") hits.push({ cls: "ci", pattern: "ci:workflow", path: f.path, line: 0, excerpt: f.after === null ? "deleted" : "changed" });
    if (reason === "dependency manifest") hits.push({ cls: "dependency", pattern: "dependency:manifest", path: f.path, line: 0, excerpt: f.before === null ? "new manifest" : f.after === null ? "deleted" : "changed" });
    const test = isTestPath(f.path);
    if (f.after === null) {
      if (f.deleted && test) hits.push({ cls: "test-weakening", pattern: "test-weakening:deleted-test-file", path: f.path, line: 0, excerpt: "test file deleted" });
      continue;
    }
    const code = CODE.test(f.path);
    const matches = (p: LinePattern, text: string): boolean => {
      if (text.trim() === "") return false;
      if (!p.anyFile && !code) return false;
      if (test && !p.tests) return false;
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
    for (const { line, text } of addedLines(f.before, f.after)) {
      for (const p of LINE_PATTERNS) {
        if (!matches(p, text) || !grew(p)) continue;
        const hit: DangerHit = { cls: p.cls, pattern: p.id, path: f.path, line, excerpt: maskExcerpt(text) };
        if (p.kind && asks(p.kind)) hit.requested = true;
        hits.push(hit);
      }
    }
    // New capability modules (a renamed specifier such as 'child_process' -> 'node:child_process' adds none).
    const had = capabilityImports(f.path, f.before);
    for (const [mod, kind] of capabilityImports(f.path, f.after)) {
      if (had.has(mod)) continue;
      const hit: DangerHit = { cls: "capability", pattern: `capability:import-${kind}`, path: f.path, line: 0, excerpt: `imports ${mod}` };
      if (asks(kind)) hit.requested = true;
      hits.push(hit);
    }
    if (test && f.before !== null && count(ASSERTION, f.after) < count(ASSERTION, f.before)) {
      hits.push({ cls: "test-weakening", pattern: "test-weakening:assertions-removed", path: f.path, line: 0, excerpt: `${count(ASSERTION, f.before)} -> ${count(ASSERTION, f.after)} assertions` });
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

/** Mark hits that an allowance covers (returns new objects; `requested` hits are left alone). */
export function applyAllowances(hits: readonly DangerHit[], allowances: readonly DangerAllowance[]): DangerHit[] {
  return hits.map((h) => {
    if (h.requested) return h;
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
  return `${h.cls} (${h.pattern.split(":")[1]}) at ${where}: ${h.excerpt}${h.allowedBy ? ` [allowed by ${h.allowedBy}]` : ""}${h.requested ? " [asked for by the intent]" : ""}`;
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
