import { execFileSync } from "node:child_process";
import { createHash, createPublicKey, verify } from "node:crypto";
// The published CLI ships without @fire_trident/core: answerable.ts is the CLI's copy of core's (test/package.test.ts).
import { answerableLine, landingAnswerable } from "./answerable.ts";
import type { Colors } from "./format.ts";

/**
 * `ft verify` on a stock git clone, with no FireTrident server (only --keys reads the published keys). A landing commit
 * ends with `FT-Note: sha256:<hex>`, the digest of its lineage note under refs/notes/firetrident (the note as the trunk
 * writer writes it: keys sorted at every depth, 2-space indent, one final newline, without `certification`), and, where
 * the deployment signs, `FT-Note-Signature: ed25519 <key id> <sig>` just above it, over
 * "firetrident-note-signature v1\n<note sha256>\n<tree>\n<parents>\n", by a key the keys document lists whose window
 * (`since` to `until`, to the second, both ends included; null is open) covers the commit's committer time: the current
 * key and each retired one. Each such commit also carries a gpgsig header that stock git checks with the deployment's
 * allowed signers (git -c gpg.format=ssh -c gpg.ssh.allowedSignersFile=<file> verify-commit <commit>, the file from
 * /.well-known/firetrident-allowed-signers).
 *
 *   --commit <ref>     one commit's note: intact, altered, missing or no FT-Note trailer (HEAD by default)
 *   --all              trunk's first-parent chain from --from (the branch tip by default), one verdict per landing: the
 *                      note intact, the signature good (with --keys), and the commit changing exactly the files and blob
 *                      ids its note's write sets name (a diff against its first parent, read with stock git)
 *   --tamper           copy the newest note in memory, change one field (a decision's approver, else a read blob id;
 *                      --tamper-field picks another), and require the copy to fail against its commit; nothing is written
 *   --colony <root>    pin the colony by its root commit: a history whose first commit is another fails
 *
 * A note that checks out also says who answers for its landing (core/answerable.ts): a second line after the verdict,
 * "answerable: <who> (<why>)", and with --all the end of the landing's line.
 *
 * scripts/verify_note.mjs repeats this for a stock Node with no dependencies (it is downloaded alone, and carries its
 * own copy of the answerable rules); test/clonecheck-git.test.ts runs both on one repository and holds their output in
 * step.
 */

/** `ft verify` on a clone (see the module comment). */
export interface CloneVerify {
  name: "verify-clone";
  all: boolean;
  /** The commit checked without --all (default HEAD). */
  commit?: string;
  /** Where --all starts (default HEAD, the branch tip). */
  from?: string;
  /** Commits --all walks at most. */
  limit?: number;
  tamper: boolean;
  tamperField?: string;
  /** /.well-known/firetrident-keys.json, as a URL or a file. */
  keys?: string;
  /** The pinned root commit. */
  colonyRoot?: string;
  /** The clone (default the current directory). */
  dir?: string;
}

/** The options `ft verify` takes for a clone (args.ts). */
export const CLONE_OPTIONS = {
  all: { type: "boolean" },
  commit: { type: "string" },
  from: { type: "string" },
  tamper: { type: "boolean" },
  "tamper-field": { type: "string" },
  keys: { type: "string" },
  colony: { type: "string" },
  dir: { type: "string" },
} as const;

/** Commits --all walks at most. */
const LIMIT_MAX = 1_000_000;
const ROOT_PIN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * The clone check `ft verify` was asked for, or null when no clone option was given (then it asks the server), or why
 * the options do not make one.
 */
export function cloneVerify(v: Record<string, unknown>, positionals: string[]): CloneVerify | string | null {
  const given = Object.keys(CLONE_OPTIONS).filter((k) => v[k] !== undefined && v[k] !== false);
  if (given.length === 0) return null;
  const usage = "ft verify --all [--from <ref>] [--limit <n>] | ft verify [--commit <ref>] [--keys <url or file>] [--tamper [--tamper-field <path>]] [--colony <root sha>] [--dir <clone>]";
  if (positionals.length > 0) return `--${given[0]} checks the git clone in the current directory (or --dir) and takes no colony; to check colony ${positionals[0]} through the server, run ft verify ${positionals[0]}. Usage: ${usage}`;
  const text = (k: string): string | undefined => (typeof v[k] === "string" ? (v[k] as string).trim() : undefined);
  const all = v.all === true;
  const cmd: CloneVerify = { name: "verify-clone", all, tamper: v.tamper === true };
  const commit = text("commit");
  if (commit !== undefined) {
    if (all) return "--commit checks one commit and --all the whole chain: give one of them (--all starts at --from)";
    if (!commit) return "--commit needs a commit (a sha or a ref such as HEAD)";
    cmd.commit = commit;
  }
  const from = text("from");
  if (from !== undefined) {
    if (!all) return "--from is where --all starts walking; give --all too, or check one commit with --commit";
    if (!from) return "--from needs a ref";
    cmd.from = from;
  }
  const limit = text("limit");
  if (limit !== undefined) {
    if (!all) return "--limit on a clone counts the commits --all walks; give --all too";
    if (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > LIMIT_MAX) return `--limit must be a whole number from 1 to ${LIMIT_MAX.toLocaleString("en-US")}, got "${limit}"`;
    cmd.limit = Number(limit);
  }
  const field = text("tamper-field");
  if (field !== undefined) {
    if (!cmd.tamper) return "--tamper-field picks the field --tamper changes; give --tamper too";
    if (fieldPath(field) === null) return `--tamper-field must be a field path such as proposals[0].decisions[1].by, got "${field}"`;
    cmd.tamperField = field;
  }
  const keys = text("keys");
  if (keys !== undefined) {
    if (!keys) return "--keys needs the URL or file of a deployment's firetrident-keys.json";
    cmd.keys = keys;
  }
  const root = text("colony");
  if (root !== undefined) {
    if (!ROOT_PIN.test(root.toLowerCase())) return `--colony takes the colony's full root commit (40 hex digits), as ft status and the colony page show it; got "${root}"`;
    cmd.colonyRoot = root.toLowerCase();
  }
  const dir = text("dir");
  if (dir !== undefined) {
    if (!dir) return "--dir needs the path of a git clone";
    cmd.dir = dir;
  }
  return cmd;
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

/** JSON as the trunk writer writes a note: keys sorted at every depth, 2-space indent (serializeNote, without the final newline). */
export function canonicalJson(v: unknown, indent = ""): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  const inner = `${indent}  `;
  const list = Array.isArray(v);
  const items = list
    ? (v as unknown[]).map((x) => canonicalJson(x, inner))
    : Object.keys(v)
        .sort()
        .map((k) => `${JSON.stringify(k)}: ${canonicalJson((v as Record<string, unknown>)[k], inner)}`);
  if (items.length === 0) return list ? "[]" : "{}";
  return `${list ? "[" : "{"}\n${inner}${items.join(`,\n${inner}`)}\n${indent}${list ? "]" : "}"}`;
}

/** The SHA-256 a note's FT-Note trailer carries: of its canonical text without `certification` (added after landing). */
export function noteDigest(note: Record<string, unknown>): string {
  const { certification: _added, ...rest } = note;
  return createHash("sha256").update(`${canonicalJson(rest)}\n`).digest("hex");
}

/** A note's bytes against its commit's digest: intact, altered (rewritten, or not what the digest covers) or missing. */
export function noteState(raw: string | null, digest: string): "intact" | "altered" | "missing" {
  if (raw === null) return "missing";
  let note: unknown;
  try {
    note = JSON.parse(raw);
  } catch {
    return "altered";
  }
  if (!note || typeof note !== "object" || Array.isArray(note) || `${canonicalJson(note)}\n` !== raw) return "altered";
  return noteDigest(note as Record<string, unknown>) === digest ? "intact" : "altered";
}

/** Who answers for the landing of a note that checks out (core/answerable.ts), as the answerable line says it; null when its bytes are not a JSON object. */
export function answerableOf(raw: string | null): string | null {
  let note: unknown = null;
  try {
    note = raw === null ? null : JSON.parse(raw);
  } catch {
    return null;
  }
  return isRecord(note) ? answerableLine(landingAnswerable(note)) : null;
}

/** The digest a commit message's last line carries as its FT-Note trailer, or null. */
export function trailerOf(message: string): string | null {
  const lines = message.trimEnd().split("\n");
  return /^FT-Note: sha256:([0-9a-f]{64})$/.exec(lines[lines.length - 1] ?? "")?.[1] ?? null;
}

/** Whether a commit message carries an FT-Landing trailer (a landing or a system commit). */
export function isLandingMessage(message: string): boolean {
  return /(^|\n)FT-Landing: \S/.test(message);
}

// ---------------------------------------------------------------------------
// Signatures
// ---------------------------------------------------------------------------

/**
 * A commit's signature against the published keys: signed by a key, bad (`why` when the key is listed but was not
 * signing at the commit's `time`, Unix seconds), or unsigned (landed before signing).
 */
export function signatureState(p: { message: string; digest: string; tree: string; parents: string; keys: unknown; time?: number | null }): { status: "signed"; keyId: string } | { status: "bad"; why?: string } | { status: "unsigned" } {
  const lines = p.message.trimEnd().split("\n");
  const above = lines.length > 1 ? (lines[lines.length - 2] ?? "") : "";
  if (!above.startsWith("FT-Note-Signature:")) return { status: "unsigned" };
  const sig = /^FT-Note-Signature: ed25519 ([0-9a-f]{16}) ([A-Za-z0-9_-]{86})$/.exec(above);
  if (!sig) return { status: "bad" };
  const list = p.keys && typeof p.keys === "object" && Array.isArray((p.keys as { keys?: unknown }).keys) ? ((p.keys as { keys: unknown[] }).keys as Array<Record<string, unknown>>) : [];
  // A key counts only under its own id, recomputed from its bytes.
  const idOf = (k: string): string => createHash("sha256").update(Buffer.from(k, "base64url")).digest("hex").slice(0, 16);
  const key = list.find((k) => k?.alg === "Ed25519" && k.id === sig[1] && typeof k.publicKey === "string" && idOf(k.publicKey) === sig[1]);
  if (!key) return { status: "bad" };
  try {
    const publicKey = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: key.publicKey as string }, format: "jwk" });
    const text = `firetrident-note-signature v1\n${p.digest}\n${p.tree}\n${p.parents}\n`;
    if (!verify(null, Buffer.from(text), publicKey, Buffer.from(sig[2]!, "base64url"))) return { status: "bad" };
  } catch {
    // A key or signature that cannot be read does not verify.
    return { status: "bad" };
  }
  const outside = windowWhy(sig[1]!, key.since, key.until, p.time);
  return outside === null ? { status: "signed", keyId: sig[1]! } : { status: "bad", why: outside };
}

/**
 * Why key `id`, listed with `since` and `until`, was not signing at `time` (Unix seconds), or null when its window covers
 * it. A key with neither covers any commit; a window that cannot be read, or a commit whose time is not known, does not.
 */
function windowWhy(id: string, since: unknown, until: unknown, time: number | null | undefined): string | null {
  const edge = (v: unknown): number | null | undefined => (v === undefined || v === null ? null : typeof v === "string" && Number.isFinite(Date.parse(v)) ? Math.floor(Date.parse(v) / 1000) : undefined);
  const from = edge(since);
  const to = edge(until);
  if (from === null && to === null) return null;
  const span = `it signed from ${typeof since === "string" ? since : "its first commit"} until ${typeof until === "string" ? until : "now"}`;
  if (from === undefined || to === undefined) return `key ${id} is listed with a window that cannot be read`;
  if (typeof time !== "number" || !Number.isFinite(time)) return `key ${id} has a window, and this commit's time is not known`;
  if ((from !== null && time < from) || (to !== null && time > to)) return `key ${id} was not signing on ${new Date(time * 1000).toISOString()}: ${span}`;
  return null;
}

/** What a signature state reads as, as the single-commit check has always printed it (with why, for a key outside its window). */
export function signatureWords(s: ReturnType<typeof signatureState>): string {
  return s.status === "signed" ? `signed by ${s.keyId}` : s.status === "bad" ? (s.why ? `bad signature (${s.why})` : "bad signature") : "unsigned (landed before signing)";
}

// ---------------------------------------------------------------------------
// Tamper
// ---------------------------------------------------------------------------

/** A field of a note as a path of keys and indexes, from "proposals[0].decisions[1].by" or "proposals.0.decisions.1.by"; null when it is not one. */
export function fieldPath(text: string): Array<string | number> | null {
  const out: Array<string | number> = [];
  for (const part of text.trim().split(".")) {
    const m = /^([^[\]]*)((?:\[\d+\])*)$/.exec(part);
    if (!m || (m[1] === "" && m[2] === "")) return null;
    if (m[1] !== "") out.push(/^\d+$/.test(m[1]!) ? Number(m[1]) : m[1]!);
    for (const i of m[2]!.matchAll(/\[(\d+)\]/g)) out.push(Number(i[1]));
  }
  return out.length > 0 ? out : null;
}

/** A field path as it is printed: proposals[0].decisions[1].by. */
export function fieldText(path: ReadonlyArray<string | number>): string {
  return path.map((k, i) => (typeof k === "number" ? `[${k}]` : i === 0 ? k : `.${k}`)).join("");
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** The field --tamper changes by default: a decision's approver (a person's first), else a blob id the change read, else one it wrote, else the landing id. */
export function defaultTamperField(note: Record<string, unknown>): Array<string | number> | null {
  const proposals = list(note.proposals);
  const decided = (human: boolean): Array<string | number> | null => {
    for (const [i, p] of proposals.entries()) {
      for (const [j, d] of list(isRecord(p) ? p.decisions : undefined).entries()) {
        if (isRecord(d) && typeof d.by === "string" && d.by !== "" && (!human || d.layer === "human")) return ["proposals", i, "decisions", j, "by"];
      }
    }
    return null;
  };
  const blob = (set: string): Array<string | number> | null => {
    for (const [i, p] of proposals.entries()) {
      for (const [j, f] of list(isRecord(p) ? p[set] : undefined).entries()) if (isRecord(f) && typeof f.blob === "string") return ["proposals", i, set, j, "blob"];
    }
    return null;
  };
  return decided(true) ?? decided(false) ?? blob("readSet") ?? blob("writeSet") ?? (typeof note.landingId === "string" ? ["landingId"] : null);
}

/** The value a tampered copy holds instead of `v`: a blob id with its last digit changed, another name, the next number, the other boolean. */
export function tamperValue(v: string | number | boolean | null): string | number | boolean {
  if (typeof v === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(v)) return `${v.slice(0, -1)}${(parseInt(v.slice(-1), 16) ^ 1).toString(16)}`;
  if (typeof v === "string") return v === "mallory" ? "trent" : "mallory";
  if (typeof v === "number") return v + 1;
  if (typeof v === "boolean") return !v;
  return "mallory";
}

/** A value as the tamper line prints it, on one line. */
function shown(v: unknown): string {
  const s = typeof v === "string" ? (v === "" ? '""' : v.replace(/[\u0000-\u001f\u007f]+/g, " ")) : JSON.stringify(v);
  return s.length > 80 ? `${s.slice(0, 79)}…` : s;
}

/** The tamper check: the copy's field, its value before and after, and whether the copy still matched its commit. */
export type TamperResult = { ok: true; field: string; from: unknown; to: unknown; caught: boolean } | { ok: false; reason: string };

/**
 * Copy a note in memory, change one field (`field`, or defaultTamperField), and check the copy, written as the trunk
 * writer writes it, against `digest`. Nothing is written anywhere.
 */
export function tamperNote(raw: string | null, digest: string, field?: string): TamperResult {
  if (raw === null) return { ok: false, reason: "the commit has no note to copy" };
  let note: unknown;
  try {
    note = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "the note is not JSON" };
  }
  if (!isRecord(note)) return { ok: false, reason: "the note is not a JSON object" };
  const path = field !== undefined ? fieldPath(field) : defaultTamperField(note);
  if (path === null) return { ok: false, reason: field !== undefined ? `"${field}" is not a field path` : "the note has no field to change" };
  const copy = JSON.parse(raw) as Record<string, unknown>;
  let at: unknown = copy;
  for (const k of path.slice(0, -1)) at = isRecord(at) || Array.isArray(at) ? (at as Record<string | number, unknown>)[k] : undefined;
  const last = path[path.length - 1]!;
  const holder = isRecord(at) || Array.isArray(at) ? (at as Record<string | number, unknown>) : null;
  const has = holder !== null && (Array.isArray(holder) ? typeof last === "number" && last < holder.length : typeof last === "string" && Object.hasOwn(holder, last));
  if (!holder || !has) return { ok: false, reason: `the note has no field ${fieldText(path)}` };
  const from = holder[last];
  if (from !== null && typeof from === "object") return { ok: false, reason: `${fieldText(path)} holds ${Array.isArray(from) ? "a list" : "an object"}; pick a field that holds one value` };
  const to = tamperValue(from as string | number | boolean | null);
  holder[last] = to;
  return { ok: true, field: fieldText(path), from, to, caught: noteDigest(copy) !== digest };
}

/** The tamper line: the copy caught (as it must be), or not. */
export function tamperLine(t: TamperResult): string {
  if (!t.ok) return `tampered copy: none (${t.reason})`;
  const change = `${t.field} changed from ${shown(t.from)} to ${shown(t.to)}`;
  return t.caught
    ? `tampered copy: altered (${change}): the digest no longer matches`
    : `tampered copy: intact (${change}): the digest still matches, so this check cannot see that change`;
}

// ---------------------------------------------------------------------------
// Write sets
// ---------------------------------------------------------------------------

/** One changed path of a commit against its first parent (git diff-tree -r -z, raw). A null blob is an absent file. */
export interface DiffEntry {
  path: string;
  oldMode: string;
  newMode: string;
  oldBlob: string | null;
  newBlob: string | null;
}

/** `git diff-tree -r -z --no-renames` raw output as entries. */
export function parseRawDiff(out: string): DiffEntry[] {
  const parts = out.split("\0");
  const entries: DiffEntry[] = [];
  const blob = (b: string): string | null => (/^0+$/.test(b) ? null : b);
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const m = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) [A-Z]\d*$/.exec(parts[i]!);
    if (m) entries.push({ path: parts[i + 1]!, oldMode: m[1]!, newMode: m[2]!, oldBlob: blob(m[3]!), newBlob: blob(m[4]!) });
  }
  return entries;
}

/** What a landing's note says it wrote: each path of the proposals' write sets with its blob (null: deleted), a later proposal's entry over an earlier one's. */
export function noteWrites(note: Record<string, unknown>): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const p of list(note.proposals)) {
    for (const w of list(isRecord(p) ? p.writeSet : undefined)) if (isRecord(w) && typeof w.path === "string") out.set(w.path, typeof w.blob === "string" ? w.blob : null);
  }
  return out;
}

const short = (sha: string): string => sha.slice(0, 12);
const wrote = (blob: string | null): string => (blob === null ? "deletes it" : `writes ${short(blob)}`);
const said = (blob: string | null): string => (blob === null ? "it deleted it" : `it wrote ${short(blob)}`);

/** A mode the trunk writer never writes: an existing file's mode changed, or a file added with another mode than 100644. */
function modeProblem(d: DiffEntry): string | null {
  if (d.oldMode !== "000000" && d.newMode !== "000000" && d.oldMode !== d.newMode) return `${d.path}: its mode changed from ${d.oldMode} to ${d.newMode}, which a landing never does`;
  if (d.oldMode === "000000" && d.newMode !== "100644") return `${d.path}: added with mode ${d.newMode}, where a landing adds files as 100644`;
  return null;
}

/**
 * Where a landing commit's change (`diff`, against its first parent) differs from what its note says it wrote
 * (`expected`, noteWrites): a path no write set names, a blob other than the note's, a deletion either way, a mode the
 * trunk writer never writes. A write set entry the commit does not change must name the blob the commit holds there
 * (`held`, null: absent), as a write of unchanged content does. Empty when they match.
 */
export function writeProblems(expected: ReadonlyMap<string, string | null>, diff: readonly DiffEntry[], held: ReadonlyMap<string, string | null>): string[] {
  const problems: string[] = [];
  const changed = new Set<string>();
  for (const d of diff) {
    changed.add(d.path);
    const mode = modeProblem(d);
    if (mode) problems.push(mode);
    if (!expected.has(d.path)) problems.push(`${d.path}: the commit ${wrote(d.newBlob)}, and no write set in the note names it`);
    else if ((expected.get(d.path) ?? null) !== d.newBlob) problems.push(`${d.path}: the commit ${wrote(d.newBlob)}, the note says ${said(expected.get(d.path) ?? null)}`);
  }
  for (const [path, blob] of expected) {
    if (changed.has(path)) continue;
    const has = held.get(path) ?? null;
    if (has !== blob) problems.push(`${path}: the commit leaves it ${has === null ? "absent" : `at ${short(has)}`}, the note says ${said(blob)}`);
  }
  return problems;
}

/** An antibody commit (TrunkDO.systemCommit) against its note: it changes exactly the antibody file the note names (its blob is not in the note). */
export function antibodyProblems(path: string, diff: readonly DiffEntry[]): string[] {
  const problems: string[] = [];
  for (const d of diff) {
    const mode = modeProblem(d);
    if (mode) problems.push(mode);
    if (d.path !== path) problems.push(`${d.path}: the commit ${wrote(d.newBlob)}, and the antibody note names only ${path}`);
    else if (d.newBlob === null) problems.push(`${path}: the commit deletes it, the antibody note says it wrote it`);
  }
  if (!diff.some((d) => d.path === path)) problems.push(`${path}: the antibody note names it, and the commit does not change it`);
  return problems;
}

/**
 * A revert commit (`ft revert`, a system commit) against the commit it reverts (`target`, that commit's own diff): every
 * file it changes goes back to the blob it had before the target; a whole-landing revert puts back every file the
 * target changed.
 */
export function revertProblems(diff: readonly DiffEntry[], target: readonly DiffEntry[], targetSha: string, whole: boolean): string[] {
  const before = new Map(target.map((t) => [t.path, t.oldBlob]));
  const problems: string[] = [];
  for (const d of diff) {
    const mode = modeProblem(d);
    if (mode) problems.push(mode);
    if (!before.has(d.path)) problems.push(`${d.path}: the commit ${wrote(d.newBlob)}, and ${short(targetSha)}, the commit it reverts, did not change it`);
    else if ((before.get(d.path) ?? null) !== d.newBlob) {
      const was = before.get(d.path) ?? null;
      problems.push(`${d.path}: the commit ${wrote(d.newBlob)}, and before ${short(targetSha)} it was ${was === null ? "absent" : short(was)}`);
    }
  }
  if (whole) for (const t of target) if (!diff.some((d) => d.path === t.path)) problems.push(`${t.path}: ${short(targetSha)} changed it, and the revert does not put it back`);
  return problems;
}

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------

/** Run git in the clone: its arguments and optional stdin; stdout's bytes; throws with git's own words on a non-zero exit. */
export type Git = (args: string[], input?: string) => Buffer;

/** Stock git in `dir`. */
export function nodeGit(dir: string): Git {
  return (args, input) => {
    try {
      return execFileSync("git", args, { cwd: dir, input, maxBuffer: 1 << 30, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    } catch (e) {
      const said = (e as { stderr?: Buffer }).stderr?.toString("utf8").trim().split("\n")[0] ?? "";
      throw new Error(said || `git ${args[0]} failed`);
    }
  };
}

/** One commit of the walk: its parents as its commit object names them, space-separated (a shallow clone hides the oldest), and its committer time. */
interface Walked {
  sha: string;
  tree: string;
  parents: string;
  message: string;
  /** The committer time in Unix seconds, or null when the object does not say. */
  time: number | null;
}

/** Commits on the first-parent chain from `from`, newest first (at most `limit`). */
function walk(git: Git, from: string, limit?: number): Walked[] {
  let out: string;
  try {
    out = git(["log", "--first-parent", "--no-show-signature", "--format=%x1e%H%x00%T%x00%B", ...(limit !== undefined ? [`--max-count=${limit}`] : []), from, "--"]).toString("utf8");
  } catch {
    throw new Error(`${from} is not a commit in this clone`);
  }
  const commits = out
    .split("\x1e")
    .slice(1)
    .map((rec) => {
      const [sha = "", tree = "", ...rest] = rec.split("\0");
      return { sha, tree, message: rest.join("\0") };
    });
  // The parents a commit was built and signed with, from the object itself: git log shows none past a shallow boundary.
  const objects = readObjects(git, commits.map((c) => c.sha));
  return commits.map((c) => ({ ...c, parents: parentsIn(objects.get(c.sha) ?? ""), time: committedIn(objects.get(c.sha) ?? "") }));
}

/** The committer time a raw commit object names, in Unix seconds, or null. */
function committedIn(raw: string): number | null {
  const line = (raw.split("\n\n")[0] ?? "").split("\n").find((l) => l.startsWith("committer "));
  const m = line ? / (\d+) [+-]\d{4}$/.exec(line) : null;
  return m ? Number(m[1]) : null;
}

/** The parents a raw commit object names, space-separated. */
function parentsIn(raw: string): string {
  const head = raw.split("\n\n")[0] ?? "";
  return head
    .split("\n")
    .flatMap((l) => (l.startsWith("parent ") ? [l.slice(7).trim()] : []))
    .join(" ");
}

/** The notes under refs/notes/firetrident, by the commit each annotates (note blob ids); none when the clone has no notes. */
function notesList(git: Git): Map<string, string> {
  let out: string;
  try {
    out = git(["notes", "--ref=firetrident", "list"]).toString("utf8");
  } catch {
    return new Map();
  }
  const map = new Map<string, string>();
  for (const line of out.split("\n")) {
    const [blob, commit] = line.trim().split(/\s+/);
    if (blob && commit) map.set(commit, blob);
  }
  return map;
}

/** Objects by id, read in one `git cat-file --batch` (as text); an id the clone does not have is left out. */
function readObjects(git: Git, ids: string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const buf = git(["cat-file", "--batch"], `${ids.join("\n")}\n`);
  let at = 0;
  for (const id of ids) {
    const nl = buf.indexOf(10, at);
    if (nl < 0) break;
    const head = buf.toString("utf8", at, nl).split(" ");
    at = nl + 1;
    if (head[1] === "missing" || head.length < 3) continue;
    const size = Number(head[2]);
    out.set(id, buf.toString("utf8", at, at + size));
    at += size + 1;
  }
  return out;
}

/** A commit's change against its first parent (`--root` for a commit with none). */
function diffOf(git: Git, sha: string, parents: string): DiffEntry[] {
  const parent = parents.split(" ").filter(Boolean)[0];
  const args = parent ? ["diff-tree", "-r", "-z", "--no-commit-id", "--no-renames", parent, sha] : ["diff-tree", "-r", "-z", "--no-commit-id", "--no-renames", "--root", sha];
  return parseRawDiff(git(args).toString("utf8"));
}

/** The blob each of `paths` holds in commit `sha` (absent paths left out). */
function heldAt(git: Git, sha: string, paths: string[]): Map<string, string | null> {
  const out = new Map<string, string | null>();
  if (paths.length === 0) return out;
  const listed = git(["--literal-pathspecs", "ls-tree", "-r", "-z", sha, "--", ...paths]).toString("utf8");
  for (const entry of listed.split("\0")) {
    const m = /^\d{6} \w+ ([0-9a-f]+)\t(.*)$/s.exec(entry);
    if (m) out.set(m[2]!, m[1]!);
  }
  return out;
}

/** The root of the first-parent chain from `from`, and whether the clone is shallow. */
function rootOf(git: Git, from: string): { root: string; shallow: boolean } {
  const chain = git(["rev-list", "--first-parent", from, "--"]).toString("utf8").trim().split("\n");
  let shallow = false;
  try {
    shallow = git(["rev-parse", "--is-shallow-repository"]).toString("utf8").trim() === "true";
  } catch {
    // An old git without the flag: the line below just does not mention shallowness.
  }
  return { root: chain[chain.length - 1] ?? "", shallow };
}

/** The root line, and whether it fails the pin. */
function rootLine(git: Git, from: string, pinned: string): { text: string; failed: boolean } {
  const { root, shallow } = rootOf(git, from);
  if (root === pinned) return { text: `root ${root} matches the pinned colony`, failed: false };
  const why = shallow ? " (this clone is shallow: a clone made with --depth stops before the root; clone without --depth)" : "";
  return { text: `this history's root is ${root}, not the pinned ${pinned}${why}`, failed: true };
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

/** One printed line and how it reads: passed, failed, or skipped. */
export interface CheckLine {
  text: string;
  tone: "ok" | "fail" | "skip";
}

/** What a clone check printed and whether it failed. */
export interface CloneReport {
  lines: CheckLine[];
  failed: boolean;
}

/** A landing commit's change against its note, as its verdict line ends: paths match, do not match, or not compared. */
function pathsVerdict(git: Git, c: Walked, note: Record<string, unknown>): { text: string; matched: boolean | null } {
  let diff: DiffEntry[];
  try {
    diff = diffOf(git, c.sha, c.parents);
  } catch {
    return { text: "paths not compared: its parent is not in this clone (a shallow clone)", matched: null };
  }
  const files = (n: number): string => `${n.toLocaleString("en-US")} file${n === 1 ? "" : "s"}`;
  const verdict = (problems: string[], what: string): { text: string; matched: boolean } =>
    problems.length === 0
      ? { text: `paths match (${what})`, matched: true }
      : { text: `paths do not match: ${problems.slice(0, 3).join("; ")}${problems.length > 3 ? `; and ${problems.length - 3} more` : ""}`, matched: false };
  const system = note.system;
  if (system !== undefined) {
    // An antibody commit (decide/engine.ts): its note carries the rejected proposal, whose writes never landed.
    if (isRecord(system) && system.kind === "antibody" && typeof system.path === "string") return verdict(antibodyProblems(system.path, diff), `antibody file ${system.path}; the note does not record its blob`);
    return { text: `paths not compared: a system commit of kind ${shown(isRecord(system) ? system.kind : system)}, which this check does not know`, matched: null };
  }
  const revert = note.revert;
  if (revert !== undefined) {
    const target = isRecord(revert) && typeof revert.commit === "string" && /^[0-9a-f]{40,64}$/.test(revert.commit) ? revert.commit : null;
    if (target === null) return { text: "paths not compared: the revert note does not name the commit it reverts", matched: null };
    let targetDiff: DiffEntry[];
    try {
      const raw = readObjects(git, [target]).get(target);
      if (raw === undefined) throw new Error("not in this clone");
      targetDiff = diffOf(git, target, parentsIn(raw));
    } catch {
      return { text: `paths not compared: ${short(target)}, the commit it reverts, is not in this clone`, matched: null };
    }
    return verdict(revertProblems(diff, targetDiff, target, !(isRecord(revert) && typeof revert.proposal === "string")), `revert of ${short(target)}: ${files(diff.length)} put back`);
  }
  const expected = noteWrites(note);
  const unchanged = [...expected.keys()].filter((p) => !diff.some((d) => d.path === p));
  let held: Map<string, string | null>;
  try {
    held = heldAt(git, c.sha, unchanged);
  } catch {
    return { text: "paths not compared: the commit's files could not be listed", matched: null };
  }
  return verdict(writeProblems(expected, diff, held), files(diff.length));
}

/** Reads the keys document --keys names (a URL or a file); throws with why it could not be read. */
export type KeysReader = (from: string) => Promise<unknown>;

/** Run the clone check (`ft verify --all`, `--commit`, `--tamper`, `--colony`) and say what it found, line by line. */
export async function checkClone(cmd: CloneVerify, git: Git, readKeys: KeysReader): Promise<CloneReport> {
  try {
    git(["rev-parse", "--git-dir"]);
  } catch {
    throw new Error(`${cmd.dir ?? "the current directory"} is not a git clone: run ft verify inside a clone of the colony, or give --dir`);
  }
  const keys = cmd.keys !== undefined ? await readKeys(cmd.keys) : undefined;
  return cmd.all ? checkAll(cmd, git, keys) : checkOne(cmd, git, keys);
}

/** One commit: its verdict as scripts/verify_note.mjs has always printed it, then the tampered copy and the root. */
function checkOne(cmd: CloneVerify, git: Git, keys: unknown): CloneReport {
  const ref = cmd.commit ?? "HEAD";
  const c = walk(git, ref, 1)[0];
  if (!c) throw new Error(`${ref} is not a commit in this clone`);
  const digest = trailerOf(c.message);
  const blob = notesList(git).get(c.sha);
  const raw = blob !== undefined ? (readObjects(git, [blob]).get(blob) ?? null) : null;
  let verdict: string = digest === null ? "no FT-Note trailer" : noteState(raw, digest);
  if (keys !== undefined && verdict === "intact" && digest !== null) {
    const s = signatureState({ message: c.message, digest, tree: c.tree, parents: c.parents, keys, time: c.time });
    verdict = s.status === "signed" ? `intact, ${signatureWords(s)}` : signatureWords(s);
  }
  const ok = verdict === "intact" || verdict.startsWith("intact, signed by ");
  const lines: CheckLine[] = [{ text: verdict, tone: ok ? "ok" : "fail" }];
  let failed = !ok;
  // A note that checks out (signed, or landed before signing): who answers for its landing.
  const who = ok || verdict.startsWith("unsigned") ? answerableOf(raw) : null;
  if (who !== null) lines.push({ text: `answerable: ${who}`, tone: "ok" });
  if (cmd.tamper) {
    const t = digest === null ? ({ ok: false, reason: "the commit carries no FT-Note trailer to check a copy against" } as TamperResult) : tamperNote(raw, digest, cmd.tamperField);
    const caught = t.ok && t.caught;
    lines.push({ text: tamperLine(t), tone: caught ? "ok" : "fail" });
    failed ||= !caught;
  }
  if (cmd.colonyRoot !== undefined) {
    const r = rootLine(git, c.sha, cmd.colonyRoot);
    lines.push({ text: r.text, tone: r.failed ? "fail" : "ok" });
    failed ||= r.failed;
  }
  return { lines, failed };
}

/** What one walked commit is: skipped (not a landing, or landed before sealing), or a landing with its checks. */
type Verdict =
  | { kind: "skip"; sha: string; unsealed: boolean }
  | { kind: "landing"; sha: string; note: "intact" | "altered" | "missing"; signature: ReturnType<typeof signatureState> | null; paths: { text: string; matched: boolean | null } | null; who: string | null };

/** The whole first-parent chain: one line per landing, runs of other commits on one line, then the root, the tamper check and a summary. */
function checkAll(cmd: CloneVerify, git: Git, keys: unknown): CloneReport {
  const from = cmd.from ?? "HEAD";
  const commits = walk(git, from, cmd.limit);
  if (commits.length === 0) throw new Error(`${from} is not a commit in this clone`);
  const notes = notesList(git);
  const sealed = commits.filter((c) => trailerOf(c.message) !== null);
  const blobs = readObjects(git, [...new Set(sealed.map((c) => notes.get(c.sha)).filter((b): b is string => b !== undefined))]);
  const rawOf = (sha: string): string | null => {
    const b = notes.get(sha);
    return b === undefined ? null : (blobs.get(b) ?? null);
  };
  const verdicts: Verdict[] = commits.map((c) => {
    const digest = trailerOf(c.message);
    if (digest === null) return { kind: "skip", sha: c.sha, unsealed: isLandingMessage(c.message) };
    const raw = rawOf(c.sha);
    const state = noteState(raw, digest);
    const signature = keys !== undefined && state === "intact" ? signatureState({ message: c.message, digest, tree: c.tree, parents: c.parents, keys, time: c.time }) : null;
    const paths = state === "intact" ? pathsVerdict(git, c, JSON.parse(raw as string) as Record<string, unknown>) : null;
    const who = state === "intact" && signature?.status !== "bad" ? answerableOf(raw) : null;
    return { kind: "landing", sha: c.sha, note: state, signature, paths, who };
  });
  // An unsigned landing newer than a signed one was not built by a trunk writer that signs: it fails.
  const lateUnsigned = new Set<string>();
  let signedBelow = false;
  for (let i = verdicts.length - 1; i >= 0; i--) {
    const v = verdicts[i]!;
    if (v.kind !== "landing" || !v.signature) continue;
    if (v.signature.status === "signed") signedBelow = true;
    else if (v.signature.status === "unsigned" && signedBelow) lateUnsigned.add(v.sha);
  }
  const lines: CheckLine[] = [];
  const count = { landings: 0, intact: 0, signed: 0, matched: 0, failures: 0, skipped: 0, unsealed: 0 };
  for (let i = 0; i < verdicts.length; i++) {
    const v = verdicts[i]!;
    if (v.kind === "skip") {
      let j = i;
      while (j + 1 < verdicts.length && verdicts[j + 1]!.kind === "skip" && (verdicts[j + 1] as { unsealed: boolean }).unsealed === v.unsealed) j++;
      const n = j - i + 1;
      const what = v.unsealed ? "landed before notes were sealed (no FT-Note trailer)" : "not a landing (no FT-Note trailer)";
      const run = n === 1 ? `${short(v.sha)}  ${what}` : `${short(v.sha)}..${short(verdicts[j]!.sha)}  ${n.toLocaleString("en-US")} commits ${v.unsealed ? "that " : ""}${what.replace(/^not a landing/, "that are not landings")}`;
      lines.push({ text: run, tone: "skip" });
      if (v.unsealed) count.unsealed += n;
      else count.skipped += n;
      i = j;
      continue;
    }
    count.landings++;
    const parts: string[] = [v.note];
    let failed = v.note !== "intact";
    if (v.note === "intact") count.intact++;
    if (v.signature) {
      if (v.signature.status === "signed") count.signed++;
      if (v.signature.status === "bad") failed = true;
      parts.push(lateUnsigned.has(v.sha) ? "unsigned, though an older landing is signed" : signatureWords(v.signature));
      if (lateUnsigned.has(v.sha)) failed = true;
    }
    if (v.paths) {
      parts.push(v.paths.text);
      if (v.paths.matched === true) count.matched++;
      if (v.paths.matched === false) failed = true;
    }
    if (v.who !== null) parts.push(`answerable: ${v.who}`);
    if (failed) count.failures++;
    lines.push({ text: `${short(v.sha)}  ${parts.join(", ")}`, tone: failed ? "fail" : "ok" });
  }
  let failed = count.failures > 0;
  if (sealed.length > 0 && notes.size === 0) {
    lines.push({ text: "this clone has no lineage notes: fetch them with git fetch origin refs/notes/firetrident:refs/notes/firetrident, then check again", tone: "fail" });
    failed = true;
  }
  if (cmd.colonyRoot !== undefined) {
    const r = rootLine(git, from, cmd.colonyRoot);
    lines.push({ text: r.text, tone: r.failed ? "fail" : "ok" });
    failed ||= r.failed;
  }
  if (cmd.tamper) {
    const newest = sealed[0];
    const t: TamperResult = newest ? tamperNote(rawOf(newest.sha), trailerOf(newest.message)!, cmd.tamperField) : { ok: false, reason: "no commit in this history carries a sealed note to copy" };
    const caught = t.ok && t.caught;
    lines.push({ text: newest ? `${short(newest.sha)}  ${tamperLine(t)}` : tamperLine(t), tone: caught ? "ok" : "fail" });
    failed ||= !caught;
  }
  const n = (x: number): string => x.toLocaleString("en-US");
  const signed = keys !== undefined ? `${n(count.signed)} signed` : "signatures not checked (give --keys)";
  const skipped = [count.skipped > 0 ? `${n(count.skipped)} ${count.skipped === 1 ? "not a landing" : "not landings"}` : "", count.unsealed > 0 ? `${n(count.unsealed)} landed before notes were sealed` : ""].filter(Boolean).join(", ");
  lines.push({
    text: `checked ${n(count.landings)} landing${count.landings === 1 ? "" : "s"} in ${n(commits.length)} commit${commits.length === 1 ? "" : "s"}: ${n(count.intact)} intact, ${signed}, ${n(count.matched)} paths match, ${n(count.failures)} failure${count.failures === 1 ? "" : "s"}${skipped ? ` (skipped: ${skipped})` : ""}`,
    tone: failed ? "fail" : "ok",
  });
  return { lines, failed };
}

/** A check's lines in color: failures red, skipped commits dim. */
export function colorLines(report: CloneReport, c: Colors): string[] {
  return report.lines.map((l) => (l.tone === "fail" ? c.red(l.text) : l.tone === "skip" ? c.dim(l.text) : l.text));
}

/** The keys document at a URL (`fetchFn`) or in a file (`readFile`); throws with why it could not be read. */
export function keysReader(fetchFn: typeof fetch, readFile: (path: string) => Promise<string>): KeysReader {
  return async (from) => {
    try {
      if (/^https?:\/\//.test(from)) {
        const res = await fetchFn(from);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
      }
      return JSON.parse(await readFile(from));
    } catch (e) {
      throw new Error(`the keys at ${from} could not be read: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
}

/** `ft status`'s root row: the colony's root commit (GET /api/colonies/:id/root), or null when the server gave none. */
export function rootRow(answer: unknown, c: Colors): string | null {
  const a = isRecord(answer) ? answer : null;
  const sha = a && typeof a.rootSha === "string" && ROOT_PIN.test(a.rootSha) ? a.rootSha : null;
  if (!sha) return null;
  return `${c.dim("root".padEnd(11))}${sha}${c.dim(a?.shallow === true ? " · the oldest commit the import kept; pin a clone with ft verify --all --colony" : " · the first commit of trunk; pin a clone with ft verify --all --colony")}`;
}
