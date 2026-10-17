import type { Colors } from "./format.ts";

/**
 * `ft census`: who wrote a repository, read offline from any stock clone. Every commit reachable from HEAD goes to a
 * coding agent, a bot, or nobody (people), at one of three confidences:
 *
 * - `sealed`: a FireTrident landing whose lineage note on refs/notes/firetrident hashes to its commit's FT-Note trailer
 *   (clonecheck.ts, the check `ft verify` runs) and names every file the commit changed. Each file's lines go to the
 *   change whose write set names it, with the agent and model the note records.
 * - `claimed`: the commit's author or committer is a known agent identity, or a trailer in the message's final trailer
 *   block names one (Co-authored-by, FireTrident's FT-Agent). A mention anywhere else in a message never counts: not in
 *   prose, not in a code fence, not in the subject. A bot counts only as the commit's author: a bot named in a co-author
 *   trailer pushed a fix to someone's branch before a squash, and the rest of the commit is theirs.
 * - `inferred`: the commit came in through a merge of a branch named the way an agent tool (or a bot) names the branches
 *   it pushes (SIGNATURES lists the prefixes). The merge commit itself is a person's act and stays theirs.
 *
 * A commit that names several agents counts for the first one: its author, its committer, then its trailers in order.
 * Lines added are `git log --numstat` per commit (renames followed); lines alive are `git blame --line-porcelain HEAD`
 * over the files agents and bots touched, under their names at HEAD (censusgit.ts, bounded there). This module is pure:
 * no I/O, so the git side can be tested apart.
 */

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

/** `ft census [<dir>] [--since <date>]`; --json is global. */
export interface CensusCommand {
  name: "census";
  /** The repository (default the current directory). */
  dir?: string;
  /** Count only commits made since this date (ISO 8601; a bare date is midnight UTC). */
  since?: string;
}

/** The options `ft census` takes (args.ts). */
export const CENSUS_OPTIONS = { since: { type: "string" } } as const;

const USAGE = "ft census [<dir>] [--since <date>] [--json]";
/** A bare date (midnight UTC), or a date and time with its zone: a time without one would be read in local time. */
const DATE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2}))?$/;

/** Whether a --since date names a real day (Date.parse would roll February 30 over into March). */
function realDay(since: string): boolean {
  const m = DATE.exec(since);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return mo >= 1 && mo <= 12 && d >= 1 && d <= new Date(Date.UTC(y, mo, 0)).getUTCDate() && Number.isFinite(Date.parse(since));
}

/** The census `ft census` was asked for, or why the arguments do not make one. */
export function parseCensusCommand(v: Record<string, unknown>, p: string[]): CensusCommand | string {
  if (p.length > 1) return `unexpected argument "${p[1]}": ft census reads one repository. Usage: ${USAGE}`;
  const cmd: CensusCommand = { name: "census" };
  const dir = p[0]?.trim();
  if (dir) cmd.dir = dir;
  if (v.since !== undefined) {
    const since = String(v.since).trim();
    if (!realDay(since)) return `--since takes a date such as 2025-01-01 (midnight UTC) or 2025-01-01T12:00:00Z, got "${since}"`;
    cmd.since = since;
  }
  return cmd;
}

/** The --since date as Unix seconds, for git's `--since=@<seconds>` (a bare date is midnight UTC, not git's time of day). */
export function sinceSeconds(since: string): number {
  return Math.floor(Date.parse(since) / 1000);
}

// ---------------------------------------------------------------------------
// Signatures
// ---------------------------------------------------------------------------

/** How sure a census is of who wrote a commit. */
export type Confidence = "sealed" | "claimed" | "inferred";

/** The confidences, strongest first. */
export const CONFIDENCES: readonly Confidence[] = ["sealed", "claimed", "inferred"];

/** A coding agent, or a bot (dependency updates, CI fixes, release automation), which a census counts apart. */
export type OwnerKind = "agent" | "bot";

/** One known signature: the marks one tool or bot leaves in git by itself. */
export interface Signature {
  owner: string;
  kind: OwnerKind;
  /** Exact addresses a co-author trailer or a commit identity carries (lowercase). */
  addresses?: readonly string[];
  /** Address domains whose local part names the identity within the owner (FireTrident's agent ids). */
  domains?: readonly string[];
  /** GitHub logins (lowercase), read from a <id>+<login>@users.noreply.github.com address or a "<login>[bot]" name. */
  logins?: readonly string[];
  /** A suffix the tool adds to a person's name in the identity it commits with (lowercase). */
  nameSuffix?: string;
  /** Prefixes of the branches the tool pushes, as a merge commit's subject names them (lowercase). */
  branches?: readonly string[];
  /** The model an identity's name carries: the first group, or the whole match. */
  model?: RegExp;
}

/**
 * The public commit signatures of coding agents and bots, kept in this one table as data. Each row is what one tool
 * writes into git on its own, as public histories show it: its co-author trailer address, its commit identity or GitHub
 * login, a suffix it adds to its user's name, the branch prefix it pushes, and the model its trailer's name carries.
 * A census reads these and names no tool anywhere else. Any other "<login>[bot]" author counts as a bot under its login.
 */
export const SIGNATURES: readonly Signature[] = [
  // FireTrident's credit trailers (worker trunk/credits.ts): <agent id>@<colony>.noreply.firetrident.dev. FT-Agent
  // trailers name the agent too (core lineage.ts landingMessage).
  { owner: "FireTrident", kind: "agent", domains: ["noreply.firetrident.dev"] },
  { owner: "Claude Code", kind: "agent", addresses: ["noreply@anthropic.com"], logins: ["claude[bot]"], branches: ["claude/"], model: /^Claude\s+\S.*$/ },
  { owner: "GitHub Copilot", kind: "agent", logins: ["copilot", "copilot-swe-agent[bot]"], branches: ["copilot/"] },
  { owner: "Codex", kind: "agent", logins: ["chatgpt-codex-connector[bot]"], branches: ["codex/"] },
  { owner: "Cursor", kind: "agent", addresses: ["cursoragent@cursor.com"], logins: ["cursor[bot]"], branches: ["cursor/"] },
  { owner: "Devin", kind: "agent", logins: ["devin-ai-integration[bot]"], branches: ["devin/"] },
  { owner: "Jules", kind: "agent", logins: ["google-labs-jules[bot]"] },
  { owner: "Aider", kind: "agent", addresses: ["noreply@aider.chat"], nameSuffix: " (aider)", model: /^aider \((.+)\)$/i },
  { owner: "OpenHands", kind: "agent", addresses: ["openhands@all-hands.dev"] },
  { owner: "Amp", kind: "agent", addresses: ["amp@ampcode.com"] },
  // The FireTrident trunk writer's own commits (antibodies, reverts, recipe batches) when no note or FT-Agent names an agent.
  { owner: "FireTrident trunk writer", kind: "bot", addresses: ["lanes@firetrident.dev"] },
  { owner: "dependabot[bot]", kind: "bot", logins: ["dependabot[bot]", "dependabot-preview[bot]"], branches: ["dependabot/"] },
  { owner: "renovate[bot]", kind: "bot", logins: ["renovate[bot]", "renovate-bot"], branches: ["renovate/"] },
  { owner: "github-actions[bot]", kind: "bot", logins: ["github-actions[bot]"] },
];

/** Who a commit's lines go to, and how sure the census is. */
export interface Credit {
  /** The tool or bot (a SIGNATURES owner, or another bot's login). */
  owner: string;
  /** The agent within the owner (a FireTrident agent id; the trunk writer's commit kind), or null. */
  identity: string | null;
  kind: OwnerKind;
  /** The model a note or trailer names, or null. */
  model: string | null;
  confidence: Confidence;
  /** FireTrident notes: the agent's kind (internal, external, synthetic). */
  agentKind?: string;
}

/** The GitHub login an address or a name carries (lowercase): <id>+<login>@users.noreply.github.com, or a "<login>[bot]" name. */
function loginOf(name: string, address: string): string | null {
  const m = /^(?:\d+\+)?([^@\s]+)@users\.noreply\.github\.com$/.exec(address);
  if (m) return m[1]!;
  const n = name.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._-]*\[bot\]$/.test(n) ? n : null;
}

/** The model a signature reads from a name, or null. */
function modelIn(s: Signature, name: string): string | null {
  const m = s.model?.exec(name.trim());
  return m ? (m[1] ?? m[0]).trim() || null : null;
}

/** What an identity (a name and an address) is: a known agent or bot, any other "[bot]" login as a bot, or null. */
export function identityCredit(name: string, email: string, confidence: Confidence = "claimed"): Credit | null {
  const address = email.trim().toLowerCase();
  const login = loginOf(name, address);
  const lowered = name.trim().toLowerCase();
  for (const s of SIGNATURES) {
    if (s.domains?.some((d) => address.endsWith(`.${d}`) || address.endsWith(`@${d}`))) {
      return { owner: s.owner, identity: address.slice(0, address.indexOf("@")) || null, kind: s.kind, model: null, confidence };
    }
    const named = s.nameSuffix !== undefined && lowered.endsWith(s.nameSuffix) && lowered.length > s.nameSuffix.length;
    if (s.addresses?.includes(address) || (login !== null && s.logins?.includes(login)) || named) {
      return { owner: s.owner, identity: null, kind: s.kind, model: modelIn(s, name), confidence };
    }
  }
  return login?.endsWith("[bot]") ? { owner: login, identity: null, kind: "bot", model: null, confidence } : null;
}

/** The owner a merged branch's name points to (inferred), or null. */
export function branchCredit(branch: string): Credit | null {
  const b = branch.trim().toLowerCase();
  const s = SIGNATURES.find((x) => x.branches?.some((prefix) => b.startsWith(prefix) && b.length > prefix.length));
  return s ? { owner: s.owner, identity: null, kind: s.kind, model: null, confidence: "inferred" } : null;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** One trailer of a message's final trailer block. */
export interface Trailer {
  key: string;
  value: string;
}

const TRAILER = /^([A-Za-z0-9][A-Za-z0-9-]*):[ \t]+(\S.*)$/;
const CHERRY_PICK = /^\(cherry picked from commit [0-9a-f]{7,64}\)$/;
const FENCE = /^ {0,3}(?:```|~~~)/;

/**
 * The trailers of a commit message: its last paragraph, when that is not the subject's paragraph, every line of it
 * reads "Key: value" (a line indented under one continues it; git's cherry-pick line is skipped), and it does not sit
 * inside a code fence left open above it. Anything else is prose, and an empty list.
 */
export function messageTrailers(message: string): Trailer[] {
  const lines = message.replace(/\r\n?/g, "\n").replace(/\s+$/, "").split("\n");
  let start = lines.length;
  while (start > 0 && lines[start - 1]!.trim() !== "") start--;
  if (start === 0) return [];
  if (lines.slice(0, start).filter((l) => FENCE.test(l)).length % 2 === 1) return [];
  const out: Trailer[] = [];
  for (const line of lines.slice(start)) {
    if (CHERRY_PICK.test(line)) continue;
    const last = out[out.length - 1];
    if (/^[ \t]+\S/.test(line) && last) {
      last.value = `${last.value} ${line.trim()}`;
      continue;
    }
    const m = TRAILER.exec(line);
    if (!m) return [];
    out.push({ key: m[1]!, value: m[2]!.trim() });
  }
  return out;
}

/** A co-author trailer's name and address ("Name <address>"), or null. */
export function coauthor(value: string): { name: string; email: string } | null {
  const m = /^(.*?)\s*<([^<>\s]+)>$/.exec(value.trim());
  return m ? { name: m[1]!.trim(), email: m[2]! } : null;
}

/** What a commit says about who wrote it: its identities and its message. */
export interface CommitIdentity {
  authorName: string;
  authorEmail: string;
  committerName: string;
  committerEmail: string;
  message: string;
}

/**
 * A commit's claimed credit: the first agent its author, its committer or its trailer block names (Co-authored-by, or
 * FT-Agent for a FireTrident agent), with the first model any of them names for that owner; else a bot when the bot is
 * its author; else null.
 */
export function claimedCredit(c: CommitIdentity): Credit | null {
  const agents: Credit[] = [];
  const author = identityCredit(c.authorName, c.authorEmail);
  if (author?.kind === "agent") agents.push(author);
  const committer = identityCredit(c.committerName, c.committerEmail);
  if (committer?.kind === "agent") agents.push(committer);
  for (const t of messageTrailers(c.message)) {
    const key = t.key.toLowerCase();
    if (key === "co-authored-by") {
      const who = coauthor(t.value);
      const credit = who ? identityCredit(who.name, who.email) : null;
      if (credit?.kind === "agent") agents.push(credit);
    } else if (key === "ft-agent" && /^\S+$/.test(t.value)) {
      agents.push({ owner: "FireTrident", identity: t.value, kind: "agent", model: null, confidence: "claimed" });
    }
  }
  const first = agents[0];
  if (first) return { ...first, model: first.model ?? agents.find((a) => a.owner === first.owner && a.model !== null)?.model ?? null };
  return author?.kind === "bot" ? author : null;
}

/** The branch a merge commit's subject says it merged (GitHub's pull request merges and git's own), or null. */
export function mergedBranch(subject: string): string | null {
  const pr = /^Merge pull request #\d+ from (\S+)/.exec(subject);
  if (pr) {
    // "<owner>/<branch>": the branch is everything after the owner.
    const at = pr[1]!.indexOf("/");
    return at > 0 ? pr[1]!.slice(at + 1) : pr[1]!;
  }
  const remote = /^Merge remote-tracking branch '[^'/]+\/([^']+)'/.exec(subject);
  if (remote) return remote[1]!;
  return /^Merge branch '([^']+)'/.exec(subject)?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// Lineage notes
// ---------------------------------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);

/** The credits of a commit whose note verified: per path, and every change's credit once. */
export interface SealedCredits {
  /** The credit of each path a change's write set names (a later change over an earlier one). */
  byPath: Map<string, Credit>;
  /** The first change's credit (or the trunk writer's), for anything else. */
  first: Credit;
  /** Each distinct credit of the commit's changes. */
  all: Credit[];
}

/**
 * The credits an intact lineage note gives its commit (`paths`: what the commit changed). Each change goes to its agent,
 * with the model the trunk writer recorded (provenance) or the change named. A system commit (an antibody, a revert, a
 * recipe batch) goes to the trunk writer. Null when the note has no change, or a path the commit changed is in no
 * write set: then the note does not describe this commit.
 */
export function sealedCredits(note: unknown, paths: readonly string[]): SealedCredits | null {
  if (!isRecord(note)) return null;
  const systemKind = isRecord(note.system) ? (text(note.system.kind) ?? "system") : note.revert !== undefined ? "revert" : note.recipe !== undefined ? "recipe batch" : null;
  if (systemKind !== null) {
    const writer: Credit = { owner: "FireTrident trunk writer", identity: systemKind, kind: "bot", model: null, confidence: "sealed" };
    return { byPath: new Map(), first: writer, all: [writer] };
  }
  const proposals = Array.isArray(note.proposals) ? note.proposals.filter(isRecord) : [];
  const byPath = new Map<string, Credit>();
  const all: Credit[] = [];
  const seen = new Map<string, Credit>();
  for (const p of proposals) {
    const agent = text(p.agentId);
    if (agent === null) continue;
    const provenance = isRecord(p.provenance) && isRecord(p.provenance.model) ? text(p.provenance.model.name) : null;
    const model = provenance ?? text(p.model);
    const key = `${agent}\0${model ?? ""}`;
    let credit = seen.get(key);
    if (!credit) {
      credit = { owner: "FireTrident", identity: agent, kind: "agent", model, confidence: "sealed", ...(text(p.agentKind) ? { agentKind: text(p.agentKind)! } : {}) };
      seen.set(key, credit);
      all.push(credit);
    }
    for (const w of Array.isArray(p.writeSet) ? p.writeSet : []) if (isRecord(w) && typeof w.path === "string") byPath.set(w.path, credit);
  }
  const first = all[0];
  if (!first || paths.some((path) => !byPath.has(path))) return null;
  return { byPath, first, all };
}

// ---------------------------------------------------------------------------
// git log
// ---------------------------------------------------------------------------

/** The format `git log -z --numstat` runs with: each commit's fields after a record separator, ended by a unit separator. */
export const LOG_FORMAT = "%x1e%H%x1f%P%x1f%an%x1f%ae%x1f%cn%x1f%ce%x1f%ct%x1f%B%x1f";

/** One commit as `git log -z --numstat --format=LOG_FORMAT` gives it. */
export interface LoggedCommit extends CommitIdentity {
  sha: string;
  parents: string[];
  /** Committer time, Unix seconds. */
  time: number;
  /** Lines added per path (a rename's new path); binary files are left out. */
  files: Array<{ path: string; added: number }>;
  /** Binary files the commit changed (no line counts). */
  binary: string[];
  /** Files the commit renamed (git log -M). */
  renames: Array<{ from: string; to: string }>;
}

/**
 * Reads `git log -z --numstat --format=LOG_FORMAT` as it streams: push each decoded chunk, then end. A record is a
 * record separator, the fields up to a unit separator and git's NUL, then (when the commit changed files) a newline and
 * one entry per file: "added\tdeleted\tpath\0", or "added\tdeleted\t\0old\0new\0" for a rename. Paths are read up to
 * their NUL, so any byte in them is safe.
 */
export class LogReader {
  private buf = "";

  /** The commits a chunk completes. */
  push(chunk: string): LoggedCommit[] {
    this.buf += chunk;
    return this.drain(false);
  }

  /** The commits left when the stream ends. */
  end(): LoggedCommit[] {
    return this.drain(true);
  }

  private drain(final: boolean): LoggedCommit[] {
    const out: LoggedCommit[] = [];
    let at = 0;
    for (;;) {
      const start = this.buf.indexOf("\x1e", at);
      if (start < 0) {
        at = this.buf.length;
        break;
      }
      const read = readRecord(this.buf, start, final);
      if (read === null) {
        at = start;
        break;
      }
      out.push(read.commit);
      at = read.next;
    }
    this.buf = final ? "" : this.buf.slice(at);
    return out;
  }
}

/** One record from `start` (its record separator), or null when the buffer does not hold all of it yet. */
function readRecord(buf: string, start: number, final: boolean): { commit: LoggedCommit; next: number } | null {
  const end = buf.indexOf("\x1f\0", start + 1);
  if (end < 0) return null;
  const fields = buf.slice(start + 1, end).split("\x1f");
  const [sha = "", parents = "", authorName = "", authorEmail = "", committerName = "", committerEmail = "", time = "0"] = fields;
  const commit: LoggedCommit = {
    sha,
    parents: parents.split(" ").filter(Boolean),
    authorName,
    authorEmail,
    committerName,
    committerEmail,
    time: Number(time) || 0,
    message: fields.slice(7).join("\x1f"),
    files: [],
    binary: [],
    renames: [],
  };
  let p = end + 2;
  if (p >= buf.length) return final ? { commit, next: p } : null;
  if (buf[p] !== "\n") return { commit, next: p };
  p++;
  for (;;) {
    if (p >= buf.length) return final ? { commit, next: p } : null;
    if (buf[p] === "\x1e") return { commit, next: p };
    const tab1 = buf.indexOf("\t", p);
    const tab2 = tab1 < 0 ? -1 : buf.indexOf("\t", tab1 + 1);
    if (tab2 < 0 || tab2 + 1 >= buf.length) return final ? { commit, next: buf.length } : null;
    const added = buf.slice(p, tab1);
    let path: string;
    if (buf[tab2 + 1] === "\0") {
      const from = buf.indexOf("\0", tab2 + 2);
      const to = from < 0 ? -1 : buf.indexOf("\0", from + 1);
      if (to < 0) return final ? { commit, next: buf.length } : null;
      path = buf.slice(from + 1, to);
      commit.renames.push({ from: buf.slice(tab2 + 2, from), to: path });
      p = to + 1;
    } else {
      const z = buf.indexOf("\0", tab2 + 1);
      if (z < 0) return final ? { commit, next: buf.length } : null;
      path = buf.slice(tab2 + 1, z);
      p = z + 1;
    }
    if (added === "-") commit.binary.push(path);
    else commit.files.push({ path, added: Number(added) || 0 });
  }
}

// ---------------------------------------------------------------------------
// Merges
// ---------------------------------------------------------------------------

/** Each commit's generation in `graph` (sha to parents): 1 for a commit with no parent in it, else one more than its highest parent. */
export function generations(graph: ReadonlyMap<string, readonly string[]>): Map<string, number> {
  const gen = new Map<string, number>();
  for (const root of graph.keys()) {
    if (gen.has(root)) continue;
    const stack = [root];
    while (stack.length > 0) {
      const sha = stack[stack.length - 1]!;
      if (gen.has(sha)) {
        stack.pop();
        continue;
      }
      let ready = true;
      let g = 1;
      for (const parent of graph.get(sha) ?? []) {
        if (!graph.has(parent)) continue;
        const pg = gen.get(parent);
        if (pg === undefined) {
          ready = false;
          stack.push(parent);
        } else g = Math.max(g, pg + 1);
      }
      if (ready) {
        gen.set(sha, g);
        stack.pop();
      }
    }
  }
  return gen;
}

/**
 * The commits a merge brought in: reachable from its other parents and not from its first, within `graph` (a parent
 * outside it ends the walk there). Commits are settled highest generation first, so each is visited once, and the walk
 * stops as soon as no commit only the other parents reach is left to visit.
 */
export function broughtIn(graph: ReadonlyMap<string, readonly string[]>, gen: ReadonlyMap<string, number>, merge: string): string[] {
  const [first, ...others] = graph.get(merge) ?? [];
  if (first === undefined || others.length === 0) return [];
  const flags = new Map<string, number>();
  const heap: string[] = [];
  const queued = new Set<string>();
  let onlyOthers = 0;
  const g = (sha: string): number => gen.get(sha) ?? 0;
  const push = (sha: string): void => {
    heap.push(sha);
    let i = heap.length - 1;
    while (i > 0) {
      const up = (i - 1) >> 1;
      if (g(heap[up]!) >= g(heap[i]!)) break;
      [heap[up], heap[i]] = [heap[i]!, heap[up]!];
      i = up;
    }
  };
  const pop = (): string => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && g(heap[l]!) > g(heap[m]!)) m = l;
        if (r < heap.length && g(heap[r]!) > g(heap[m]!)) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i]!, heap[m]!];
        i = m;
      }
    }
    return top;
  };
  const mark = (sha: string, f: number): void => {
    if (!graph.has(sha)) return;
    const was = flags.get(sha) ?? 0;
    const now = was | f;
    if (now === was) return;
    flags.set(sha, now);
    if (queued.has(sha)) {
      if (was === 2) onlyOthers--;
      return;
    }
    queued.add(sha);
    push(sha);
    if (now === 2) onlyOthers++;
  };
  mark(first, 1);
  for (const o of others) mark(o, 2);
  const out: string[] = [];
  while (onlyOthers > 0 && heap.length > 0) {
    const sha = pop();
    queued.delete(sha);
    const f = flags.get(sha) ?? 0;
    if (f === 2) {
      onlyOthers--;
      out.push(sha);
    }
    for (const parent of graph.get(sha) ?? []) mark(parent, f);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

/** One commit with its credits. */
export interface Attributed {
  sha: string;
  merge: boolean;
  files: Array<{ path: string; added: number }>;
  /** Who its lines go to; null: people. */
  credit: Credit | null;
  /** A sealed commit with several changes: each path's change. */
  byPath?: Map<string, Credit>;
  /** Each distinct credit of the commit (one, or each change of a sealed landing). */
  credits: Credit[];
}

/** The credit of one path of a commit. */
export function creditOf(a: Attributed, path: string): Credit | null {
  return a.byPath?.get(path) ?? a.credit;
}

/** A count by confidence, and their sum. */
export type Split = Record<Confidence, number> & { total: number };

/** One owner (a tool and an identity in it) or one model: commits, lines added and lines alive, by confidence. */
export interface CensusRow {
  commits: Split;
  linesAdded: Split;
  linesAlive: Split;
}

/** A row of the owner table. */
export interface OwnerRow extends CensusRow {
  owner: string;
  identity: string | null;
  kind: OwnerKind;
  agentKind?: string;
  /** The models its commits name. */
  models: string[];
}

/** A row of the model table (agents only); `model` null: the commits name none. */
export interface ModelRow extends CensusRow {
  model: string | null;
  /** The owners whose commits name it. */
  owners: string[];
}

/** Agents', bots' or people's commits and lines; people's lines alive are not counted (null). */
export interface ClassTotals {
  commits: number;
  linesAdded: number;
  linesAlive: number | null;
}

/** How lines alive were counted: files blamed, and whether a cap stopped it. */
export interface AliveInfo {
  /** Files agents and bots touched that HEAD still holds as text. */
  files: number;
  /** Files blamed to the end and counted. */
  blamed: number;
  /** Files git could not blame. */
  failed: number;
  /** The cap that stopped blame, or null. */
  cap: { kind: "files" | "time"; limit: number } | null;
  ms: number;
}

/** What `ft census` found. */
export interface CensusReport {
  repository: { dir: string; head: string; branch: string | null; shallow: boolean; since: string | null };
  commits: number;
  merges: number;
  linesAdded: number;
  agents: ClassTotals;
  bots: ClassTotals;
  people: ClassTotals;
  byOwner: OwnerRow[];
  byModel: ModelRow[];
  alive: AliveInfo;
  notes: {
    /** Whether the clone has refs/notes/firetrident. */
    ref: boolean;
    /** Commits whose last line is an FT-Note trailer. */
    trailers: number;
    sealed: number;
    /** Trailers whose note is missing, altered, or does not name the files its commit changed. */
    notSealed: number;
  };
  /** What a reader should know, in sentences: notes to fetch, a shallow clone, the cap. */
  notices: string[];
}

const split = (): Split => ({ sealed: 0, claimed: 0, inferred: 0, total: 0 });
const bump = (s: Split, c: Confidence, n: number): void => {
  s[c] += n;
  s.total += n;
};

/** The key of a credit's owner row. */
export function ownerKey(c: Credit): string {
  return `${c.kind}\0${c.owner}\0${c.identity ?? ""}`;
}

/**
 * The census tables from attributed commits and lines alive (`alive`: lines at HEAD per commit, and per path for a
 * commit with several changes, keyed "<sha>" or "<sha>\0<path>"). Rows sort by lines added, then commits, then name.
 */
export function tally(commits: readonly Attributed[], alive: ReadonlyMap<string, number>): Pick<CensusReport, "commits" | "merges" | "linesAdded" | "agents" | "bots" | "people" | "byOwner" | "byModel"> {
  const owners = new Map<string, OwnerRow>();
  const models = new Map<string, ModelRow>();
  const ownerRow = (c: Credit): OwnerRow => {
    const key = ownerKey(c);
    let row = owners.get(key);
    if (!row) {
      row = { owner: c.owner, identity: c.identity, kind: c.kind, models: [], commits: split(), linesAdded: split(), linesAlive: split() };
      owners.set(key, row);
    }
    // A sealed note knows an agent's kind and a trailer does not: the row keeps the kind the first credit with one gives.
    if (row.agentKind === undefined && c.agentKind) row.agentKind = c.agentKind;
    if (c.model !== null && !row.models.includes(c.model)) row.models.push(c.model);
    return row;
  };
  const modelRow = (c: Credit): ModelRow | null => {
    if (c.kind !== "agent") return null;
    const key = c.model ?? "";
    let row = models.get(key);
    if (!row) {
      row = { model: c.model, owners: [], commits: split(), linesAdded: split(), linesAlive: split() };
      models.set(key, row);
    }
    if (!row.owners.includes(c.owner)) row.owners.push(c.owner);
    return row;
  };
  const totals = { agent: { commits: 0, linesAdded: 0, linesAlive: 0 }, bot: { commits: 0, linesAdded: 0, linesAlive: 0 }, people: { commits: 0, linesAdded: 0 } };
  let linesAdded = 0;
  let merges = 0;
  const bySha = new Map<string, Attributed>();
  for (const a of commits) {
    bySha.set(a.sha, a);
    if (a.merge) merges++;
    const added = a.files.reduce((n, f) => n + f.added, 0);
    linesAdded += added;
    if (a.credit === null) {
      totals.people.commits++;
      totals.people.linesAdded += added;
      continue;
    }
    // Each distinct owner and model of the commit counts it once.
    const ownersSeen = new Set<OwnerRow>();
    const modelsSeen = new Set<ModelRow>();
    for (const c of a.credits) {
      const o = ownerRow(c);
      if (!ownersSeen.has(o)) {
        ownersSeen.add(o);
        bump(o.commits, c.confidence, 1);
      }
      const m = modelRow(c);
      if (m && !modelsSeen.has(m)) {
        modelsSeen.add(m);
        bump(m.commits, c.confidence, 1);
      }
    }
    if (a.credits.some((c) => c.kind === "agent")) totals.agent.commits++;
    else totals.bot.commits++;
    for (const f of a.files) {
      const c = creditOf(a, f.path);
      if (c === null) continue;
      bump(ownerRow(c).linesAdded, c.confidence, f.added);
      const m = modelRow(c);
      if (m) bump(m.linesAdded, c.confidence, f.added);
      totals[c.kind].linesAdded += f.added;
    }
  }
  for (const [key, n] of alive) {
    const at = key.indexOf("\0");
    const a = bySha.get(at < 0 ? key : key.slice(0, at));
    if (!a) continue;
    const c = at < 0 ? a.credit : creditOf(a, key.slice(at + 1));
    if (c === null) continue;
    bump(ownerRow(c).linesAlive, c.confidence, n);
    const m = modelRow(c);
    if (m) bump(m.linesAlive, c.confidence, n);
    totals[c.kind].linesAlive += n;
  }
  const order = <T extends CensusRow>(rows: T[], name: (r: T) => string): T[] =>
    rows.sort((x, y) => y.linesAdded.total - x.linesAdded.total || y.commits.total - x.commits.total || name(x).localeCompare(name(y)));
  for (const r of owners.values()) r.models.sort();
  for (const r of models.values()) r.owners.sort();
  return {
    commits: commits.length,
    merges,
    linesAdded,
    agents: totals.agent,
    bots: totals.bot,
    people: { ...totals.people, linesAlive: null },
    byOwner: order([...owners.values()], ownerLabel),
    byModel: order([...models.values()], (r) => r.model ?? ""),
  };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/** Rows a table prints at most; --json lists them all. */
export const ROWS_SHOWN = 20;

const n = (x: number): string => x.toLocaleString("en-US");
const plural = (x: number, one: string, many = `${one}s`): string => `${n(x)} ${x === 1 ? one : many}`;
const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

/** An owner row's name: the owner, its identity, and a FireTrident agent's kind. */
export function ownerLabel(r: Pick<OwnerRow, "owner" | "identity" | "agentKind">): string {
  return `${r.owner}${r.identity ? ` ${r.identity}` : ""}${r.agentKind ? ` (${r.agentKind})` : ""}`;
}

/** The line that says how lines alive were counted, and whether a cap stopped it. */
export function aliveLine(a: AliveInfo): string {
  const failed = a.failed > 0 ? ` ${plural(a.failed, "file")} could not be blamed and ${a.failed === 1 ? "is" : "are"} not counted.` : "";
  if (a.files === 0) return "Lines alive: no file agents or bots touched is still at HEAD, so there was nothing to blame.";
  if (a.cap) {
    const which = a.cap.kind === "files" ? `the ${n(a.cap.limit)}-file cap` : `the ${a.cap.limit % 1000 === 0 ? `${n(a.cap.limit / 1000)} s` : seconds(a.cap.limit)} time cap`;
    return `Lines alive stopped at ${which}: git blame read ${n(a.blamed)} of the ${plural(a.files, "file")} agents and bots touched, and the other ${n(a.files - a.blamed - a.failed)} are not counted, so lines alive read low.${failed}`;
  }
  return `Lines alive: git blame at HEAD over the ${plural(a.files, "file")} agents and bots touched that HEAD still holds (${seconds(a.ms)}); people's lines alive are not counted.${failed}`;
}

/** A table's rows past ROWS_SHOWN, as one line. */
function more(total: number): string[] {
  return total > ROWS_SHOWN ? [`and ${n(total - ROWS_SHOWN)} more (ft census --json lists every one)`] : [];
}

/** Aligned columns: the first `left` left-aligned, the numbers after them right-aligned; the header dimmed. */
function columns(header: string[], rows: string[][], c: Colors, left = 1): string[] {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]): string => cells.map((cell, i) => (i < left ? cell.padEnd(widths[i]!) : cell.padStart(widths[i]!))).join("  ").trimEnd();
  return [c.dim(line(header)), ...rows.map(line)];
}

const CONFIDENCE_HEAD = ["commits", ...CONFIDENCES, "lines added", "lines alive"];
const confidenceCells = (r: CensusRow): string[] => [n(r.commits.total), ...CONFIDENCES.map((k) => n(r.commits[k])), n(r.linesAdded.total), n(r.linesAlive.total)];

/** The census as text: what was read, agents, bots and people, the owner and model tables, then the notices. */
export function censusText(r: CensusReport, c: Colors): string[] {
  const repo = r.repository;
  const where = `${repo.dir} at ${repo.head.slice(0, 12)}${repo.branch ? ` (${repo.branch})` : ""}`;
  const span = repo.since ? `since ${repo.since}` : "all history";
  const lines: string[] = [c.bold(`census of ${where}, ${span}: ${plural(r.commits, "commit")} (${plural(r.merges, "merge")}), ${plural(r.linesAdded, "line")} added`)];
  if (r.commits === 0) return [...lines, repo.since ? `No commit reachable from HEAD was made since ${repo.since}.` : "HEAD has no commits to count."];
  lines.push("");
  const total = (t: ClassTotals): string[] => [n(t.commits), n(t.linesAdded), t.linesAlive === null ? "-" : n(t.linesAlive)];
  lines.push(...columns(["", "commits", "lines added", "lines alive"], [["agents", ...total(r.agents)], ["bots", ...total(r.bots)], ["people", ...total(r.people)]], c));
  if (r.byOwner.length === 0) {
    lines.push("", "No commit names a coding agent or a bot: no FireTrident note, no agent or bot identity, no agent trailer, no agent branch merged.");
  } else {
    lines.push("", ...columns(["by owner", "kind", ...CONFIDENCE_HEAD], r.byOwner.slice(0, ROWS_SHOWN).map((o) => [ownerLabel(o), o.kind, ...confidenceCells(o)]), c, 2));
    lines.push(...more(r.byOwner.length).map(c.dim));
  }
  if (r.byModel.length > 0) {
    lines.push("", ...columns(["by model", ...CONFIDENCE_HEAD], r.byModel.slice(0, ROWS_SHOWN).map((m) => [m.model ?? "model not named", ...confidenceCells(m)]), c));
    lines.push(...more(r.byModel.length).map(c.dim));
  }
  const legend = "sealed: an intact FireTrident lineage note · claimed: an agent identity or trailer · inferred: merged from an agent's branch";
  const tail = [...r.notices, ...(r.byOwner.length > 0 ? [aliveLine(r.alive), legend] : [])];
  if (tail.length > 0) lines.push("", ...tail.map(c.dim));
  return lines;
}

/** The notices a report carries: lineage notes not fetched or not intact, a shallow clone. */
export function notices(p: { notes: CensusReport["notes"]; shallow: boolean }): string[] {
  const out: string[] = [];
  if (p.notes.trailers > 0 && !p.notes.ref) {
    out.push(`${plural(p.notes.trailers, "commit carries", "commits carry")} an FT-Note trailer and this clone has no lineage notes: fetch them with git fetch origin refs/notes/firetrident:refs/notes/firetrident, then run ft census again.`);
  } else if (p.notes.notSealed > 0) {
    out.push(`${plural(p.notes.notSealed, "commit carries", "commits carry")} an FT-Note trailer whose note is missing, altered, or does not name the files the commit changed: ${p.notes.notSealed === 1 ? "it counts" : "they count"} by ${p.notes.notSealed === 1 ? "its" : "their"} identities and trailers instead; ft verify --all says which.`);
  }
  if (p.shallow) out.push("This clone is shallow: its oldest commit counts every file it holds as lines added. Clone without --depth to count the whole history.");
  return out;
}
