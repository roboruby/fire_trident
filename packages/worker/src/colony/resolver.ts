import { blobId, changesetId, inlineProblem, isLockfile, mergeContentProblem, revalidationEnabled, utf8Length } from "@fire_trident/core";
import type { CheckResult, ColonyEvent, Evidence, FileVersion, Id, MergeConflict, NoteResolves, Path, Proposal, Sha } from "@fire_trident/core";
import type { Env } from "../env.ts";
import { modelClient, resolveModel, usesAnthropic } from "../agents/llm.ts";
import type { ModelClient, ModelReply } from "../agents/loop.ts";
import { syntaxProblems } from "../agents/create.ts";
import type { CallLimiter } from "../decide/limiter.ts";
import { isThrottled } from "../decide/reflex.ts";
import { MODEL_USAGE_CHECK } from "../trunk/provenance.ts";
import { errorText } from "./errors.ts";
import type { SqlRunner } from "./inline.ts";
import { checkMerged, cleanConflicts, cleanResolves, mergeSides, type ConflictedMerge } from "./resolver-merge.ts";
import { markedText, parseResolveReply, resolveMaxTokens, resolveMessages } from "./resolver-prompt.ts";

/**
 * The conflict resolver (FT_RESOLVER: "on", or a comma-separated list of colony ids; off when absent). Agents are bad at
 * merging around someone else's change: they overwrite it or abandon their own. So when text merge (core/textmerge.ts,
 * trunk/plan.ts) sends a change back because its edits overlap a change that landed first, the platform resolves it as
 * a neutral third party, instead of the intent being redone from scratch:
 *
 * - The trunk writer carries the conflict with the return (Proposal.mergeConflicts: paths, blobs, lines). Only such a
 *   return triggers a resolution; every other return goes on as today.
 * - The colony holds the intent for its resolver agent (an in-platform agent named "resolver") instead of reopening it,
 *   and the change's agent finds a notice in its inbox. Then, asynchronously and never inside a trunk cycle: the base,
 *   trunk and change versions of each file trunk moved are read (at most RESOLVE_MAX_FILES files of RESOLVE_FILE_BYTES),
 *   files that merge cleanly are merged as text merge would, and one model call (through the decide stage's limiter)
 *   writes each conflicting file whole, keeping both changes, or answers CANNOT. Everything agents, people and the
 *   repository wrote is fenced as data (colony/resolver-prompt.ts).
 * - The merge is validated before anything is proposed (colony/resolver-merge.ts): every line outside the conflicting
 *   hunks is exactly the clean merge of both changes, no conflicting hunk is either side's version whole, every line
 *   either side added in a conflicting hunk is kept in that side's order (unless the other side deleted it: rewrote or
 *   removed the base line it replaces), each file still parses where the colony checks syntax (agents/create.ts), and
 *   no other file changes.
 * - Then it is a new inline proposal for the same intent by the resolver agent: provenance author `platform`, its model
 *   observed through the `agent model usage` check (trunk/provenance.ts), its read set the trunk blobs it merged against
 *   (and what the change read besides), and the record of what it resolves, which the lineage note carries as
 *   `resolves` (landContext). It goes through the decide stage like any proposal; nothing is approved for it.
 * - When the resolver cannot, takes longer than RESOLVE_TIMEOUT_MS, fails validation, or its proposal goes back, the
 *   original return stands and the intent reopens as before: one attempt per returned proposal.
 *
 * At most RESOLVES_PER_HOUR resolutions start in an hour and RESOLVES_AT_ONCE at once. Metrics: resolver.attempted,
 * resolver.landed, resolver.failed.
 */

/** How long a resolution may take, from the return to its proposal; past it the return stands. */
export const RESOLVE_TIMEOUT_MS = 60_000;
/** Resolutions a colony starts in an hour at most, and works on at once (before they are proposed). */
export const RESOLVES_PER_HOUR = 20;
export const RESOLVES_AT_ONCE = 2;
/** Files one resolution merges at most (each file trunk moved under the change), and the largest version of one (UTF-8 bytes). */
export const RESOLVE_MAX_FILES = 4;
export const RESOLVE_FILE_BYTES = 64 * 1024;
/** A job still resolving this long past its deadline lost its run (it fails then). */
const LOST_MS = 120_000;
/** Finished jobs are kept this long, then pruned. */
const KEEP_MS = 7 * 24 * 60 * 60_000;
const HOUR_MS = 60 * 60_000;
/** The name of the resolver's agent in the colony. */
export const RESOLVER_AGENT = "resolver";
/** Who the resolver's inbox notices are from. */
const NOTICE_BY = "resolver";

/** Is the conflict resolver on for this colony? FT_RESOLVER, read like FT_REVALIDATE: "on", a list of colony ids, or off. */
export function resolverEnabled(setting: string | undefined, colonyId: Id): boolean {
  return revalidationEnabled(setting, colonyId);
}

/** Create the resolver's tables (additive: nothing existing is touched). */
export function migrateResolver(sql: SqlRunner): void {
  sql.exec(
    `CREATE TABLE IF NOT EXISTS resolver_jobs (
      proposal_id TEXT PRIMARY KEY, intent_id TEXT NOT NULL, agent_id TEXT NOT NULL, resolver_id TEXT NOT NULL, state TEXT NOT NULL,
      conflicts TEXT NOT NULL, resolution_id TEXT, record TEXT, reason TEXT, landing_id TEXT,
      created_at INTEGER NOT NULL, deadline INTEGER NOT NULL, finished_at INTEGER)`,
  );
  sql.exec("CREATE INDEX IF NOT EXISTS resolver_jobs_by_state ON resolver_jobs(state, created_at)");
  sql.exec("CREATE INDEX IF NOT EXISTS resolver_jobs_by_created ON resolver_jobs(created_at)");
  sql.exec("CREATE INDEX IF NOT EXISTS resolver_jobs_by_resolution ON resolver_jobs(resolution_id) WHERE resolution_id IS NOT NULL");
  sql.exec("CREATE TABLE IF NOT EXISTS resolver_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
}

/** One resolution: `resolving` while the resolver holds the intent, `proposed` once its change is in, then `landed` or `failed`. */
export interface ResolverJob {
  proposal_id: string;
  intent_id: string;
  agent_id: string;
  resolver_id: string;
  state: "resolving" | "proposed" | "landed" | "failed";
  conflicts: string;
  resolution_id: string | null;
  record: string | null;
  reason: string | null;
  landing_id: string | null;
  created_at: number;
  deadline: number;
  finished_at: number | null;
}

/** An intent as the resolver reads it. */
export interface ResolverIntent {
  title: string;
  why: string;
  status: string;
  assignedTo: Id | null;
  /** Contest mode seats (absent or 1: one holder). */
  contest?: number | null;
}

/** The trunk reads a resolution makes (TrunkDO). */
export interface ResolverTrunk {
  baseBlobs(baseSha: Sha, paths: Path[]): Promise<FileVersion[]>;
  readBlobs(blobs: Sha[]): Promise<Record<Sha, string | null>>;
}

/** What the resolver proposes (ColonyDO.propose's input). */
export type ResolveInput = Omit<Proposal, "id" | "status" | "createdAt" | "evidence"> & { evidence?: Partial<Evidence> };

/** The variables and bindings the resolver reads. */
export type ResolverEnv = Pick<Env, "FT_DEFAULT_MODEL" | "FT_BULK_MODEL"> & Partial<Pick<Env, "FT_RESOLVER" | "FT_RESOLVER_MODEL" | "AI" | "ANTHROPIC_API_KEY">>;

/** What the resolver needs from its colony (ColonyDO implements it; tests fake it). */
export interface ResolverHost {
  sql: SqlRunner;
  /** The colony's variables and bindings, read at each call (a flag reaches the object when it restarts). */
  env(): ResolverEnv;
  colonyId(): Id;
  now(): number;
  waitUntil(p: Promise<unknown>): void;
  /** The model client; absent: the one agents use (agents/llm.ts), on env(). */
  model?(): ModelClient;
  /** The decide stage's model call limiter, shared so the resolver's calls count against the same rate. */
  limiter(): CallLimiter;
  /** The resolver's agent: `known` when that agent still exists (marked seen), else a new in-platform agent named RESOLVER_AGENT. */
  agent(known: Id | null, model: string): Id;
  intent(id: Id): ResolverIntent | null;
  /** Hold an intent for the resolver's agent: proposed, assigned to it, the agent working on it (events go to `events`). */
  hold(intentId: Id, agentId: Id, events: ColonyEvent[]): void;
  /** Give back an intent the resolver's agent still holds: it reopens as a return reopens it. The intent's status after, or null. */
  release(intentId: Id, agentId: Id): string | null;
  proposal(id: Id): Proposal | null;
  /** The texts of an inline change by blob id (kept a while after it went back), or null. */
  inlineContents(proposalId: Id): Record<Sha, string> | null;
  /** The colony's trunk head. */
  trunkSha(): Sha;
  trunk(): ResolverTrunk;
  /** The landings that changed these paths after `baseSha` landed (newest first, a few a path), with their intents. */
  landedSince(paths: Path[], baseSha: Sha): Array<{ path: Path; landingId: Id; intentId: Id | null }>;
  propose(input: ResolveInput): Promise<Proposal>;
  /** Leave a resolution notice in an agent's inbox (a directive of kind "resolution"); the event to publish. */
  notice(agentId: Id, intentId: Id, message: string): ColonyEvent;
  publish(events: ColonyEvent[]): void;
  bump(name: string): void;
}

/** A resolution ready to propose, or why there is none. */
type Built = { input: ResolveInput; record: NoteResolves } | { fail: string };

/** A file the change writes that trunk moved since its base: its three texts and their merge. */
interface Moved {
  path: Path;
  base: string;
  ours: string;
  theirs: string;
  merge: ReturnType<typeof mergeSides>;
}

/** Statuses after which a proposal moves no more. */
const FINAL = new Set(["landed", "returned", "rejected"]);

/** "a", "a and b", "a, b and c"; past `max` items, the first `max` and "N more". */
function listText(items: readonly string[], max = 4): string {
  const parts = items.length > max ? [...items.slice(0, max), `${items.length - max} more`] : [...items];
  return parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** One line, collapsed whitespace, at most `max` characters. */
function oneLine(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** The conflicting files and hunks, as a notice names them: "src/a.ts at line 6; src/b.ts at lines 3 and 9". */
export function conflictList(conflicts: readonly MergeConflict[]): string {
  return conflicts
    .slice(0, 4)
    .map((c) => (c.lines.length === 0 ? c.path : `${c.path} at line${c.lines.length === 1 ? "" : "s"} ${listText(c.lines.map(String), 5)}`))
    .join("; ");
}

/** The notice an agent gets when the resolver takes on its returned change. */
export function startText(proposalId: Id, conflicts: readonly MergeConflict[]): string {
  return `Your change ${proposalId} came back because text merge found overlapping hunks (${conflictList(conflicts)}). The platform's conflict resolver is merging it with what landed first on those lines, keeping both changes, so you do not need to redo it; how that ends will follow here.`;
}

/** The notice when the resolver's merge landed. */
export function landedText(proposalId: Id, resolution: Id, landingId: Id | undefined, intentId: Id, landings: readonly Id[]): string {
  const with_ = landings.length > 0 ? `the change${landings.length === 1 ? "" : "s"} that landed first (${listText([...landings])})` : "what landed first";
  return `The conflict resolver merged your change ${proposalId} with ${with_}, and the merge landed (${resolution}${landingId ? ` in ${landingId}` : ""}), so intent ${intentId} is done.`;
}

/** An intent's status after a failed resolution, as a notice says it. */
function intentNow(intentId: Id, status: string | null): string {
  switch (status) {
    case "open":
      return `intent ${intentId} is open again for the next agent`;
    case "claimed":
    case "proposed":
      return `intent ${intentId} is with another agent now`;
    case null:
      return `intent ${intentId} is no longer known`;
    default:
      return `intent ${intentId} is ${status}`;
  }
}

/** The notice when the resolution failed: before it was proposed (`resolution` absent) or after its proposal went back. */
export function failedText(proposalId: Id, why: string, intentId: Id, status: string | null, resolution?: Id): string {
  const then = intentNow(intentId, status);
  const head = resolution ? `The conflict resolver's merge of your change ${proposalId} (${resolution}) did not land: ${why}.` : `The conflict resolver could not merge your change ${proposalId}: ${why}.`;
  return `${head} Its return stands, and ${then}.`;
}

/** Resolve `p` against a deadline: `fallback` when `ms` passes first. */
async function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), Math.max(0, ms));
  });
  try {
    return await Promise.race([p, late]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** The conflict resolver of one colony (see the module comment). */
export class Resolver {
  /** The resolver's agent id as last read or set (undefined: not read yet). */
  private agentKnown: Id | null | undefined = undefined;

  constructor(private readonly host: ResolverHost) {}

  /** Is it on for this colony (FT_RESOLVER)? */
  enabled(): boolean {
    return resolverEnabled(this.host.env().FT_RESOLVER, this.host.colonyId());
  }

  /** The model the resolver calls: FT_RESOLVER_MODEL, else FT_DEFAULT_MODEL. */
  modelName(): string {
    const env = this.host.env();
    return resolveModel(env, env.FT_RESOLVER_MODEL);
  }

  /** Can that model be called here (Workers AI bound; or, for a model agents/llm.ts sends to its API key, that key set)? */
  private modelReady(model: string): boolean {
    const env = this.host.env();
    if (model.startsWith("claude-")) return usesAnthropic({ ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY }, model);
    return Boolean(env.AI);
  }

  /** The model client: the host's, or the one agents use. */
  private client(): ModelClient {
    return this.host.model ? this.host.model() : modelClient(this.host.env() as Parameters<typeof modelClient>[0]);
  }

  private meta(k: string): string | null {
    const row = this.host.sql.exec("SELECT v FROM resolver_meta WHERE k = ?", k).toArray()[0] as { v: string } | undefined;
    return row?.v ?? null;
  }

  private setMeta(k: string, v: string): void {
    this.host.sql.exec("INSERT INTO resolver_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, v);
  }

  /** The resolver's agent id, when it has one (read once, then kept). */
  agentId(): Id | null {
    if (this.agentKnown === undefined) this.agentKnown = this.meta("agent");
    return this.agentKnown;
  }

  /** One job by the returned proposal it resolves. */
  job(proposalId: Id): ResolverJob | null {
    return (this.host.sql.exec("SELECT * FROM resolver_jobs WHERE proposal_id = ?", proposalId).toArray()[0] as ResolverJob | undefined) ?? null;
  }

  private count(query: string, ...bindings: unknown[]): number {
    const row = this.host.sql.exec(query, ...bindings).toArray()[0] as { n: number } | undefined;
    return Number(row?.n ?? 0);
  }

  /**
   * A proposal just went back (ColonyDO.transition). When the trunk writer sent it back for overlapping hunks
   * (`mergeConflicts`), the resolver is on for the colony, the return would reopen its intent (`intent` held by its agent
   * or by no one), it is not the resolver's own change or a contest's, it was never tried before, it touches at most
   * RESOLVE_MAX_FILES conflicting files, a model can be called, and the limits allow: the resolver takes it on. The intent
   * stays held (for the resolver's agent) instead of reopening, the change's agent gets an inbox notice (its event goes to
   * `events`), resolver.attempted counts, and the resolution runs in the background. True when it took it on; the
   * caller then skips reopening the intent and does everything else a return does. Never throws.
   */
  hold(p: Proposal, intent: { id: Id; status: string; assigned_to: string | null; contest?: number | null } | null, events: ColonyEvent[]): boolean {
    try {
      if (p.status !== "returned" || !Array.isArray(p.mergeConflicts) || p.mergeConflicts.length === 0) return false;
      if (!this.enabled()) return false;
      const conflicts = cleanConflicts(p.mergeConflicts);
      if (conflicts.length === 0 || !intent) return false;
      if ((intent.status !== "proposed" && intent.status !== "claimed") || (intent.assigned_to !== p.agentId && intent.assigned_to !== null)) return false;
      if ((intent.contest ?? 1) > 1) return false;
      const known = this.agentId();
      if (known !== null && p.agentId === known) return false;
      if (this.job(p.id)) return false;
      const skip = (why: string): false => {
        console.log(`resolver: ${p.id} goes back as before: ${why}`);
        return false;
      };
      if (conflicts.length > RESOLVE_MAX_FILES) return skip(`${conflicts.length} files conflict (at most ${RESOLVE_MAX_FILES})`);
      const model = this.modelName();
      if (!this.modelReady(model)) return skip(`model ${model} cannot be called here`);
      const now = this.host.now();
      if (this.count("SELECT COUNT(*) AS n FROM resolver_jobs WHERE state = 'resolving'") >= RESOLVES_AT_ONCE) return skip(`${RESOLVES_AT_ONCE} resolutions are already running`);
      if (this.count("SELECT COUNT(*) AS n FROM resolver_jobs WHERE created_at > ?", now - HOUR_MS) >= RESOLVES_PER_HOUR) return skip(`${RESOLVES_PER_HOUR} resolutions started in the last hour`);
      const agent = this.host.agent(known, model);
      if (agent !== known) {
        this.setMeta("agent", agent);
        this.agentKnown = agent;
      }
      this.host.sql.exec(
        `INSERT INTO resolver_jobs (proposal_id, intent_id, agent_id, resolver_id, state, conflicts, created_at, deadline)
         VALUES (?, ?, ?, ?, 'resolving', ?, ?, ?)`,
        p.id,
        p.intentId,
        p.agentId,
        agent,
        JSON.stringify(conflicts),
        now,
        now + RESOLVE_TIMEOUT_MS,
      );
      try {
        this.host.hold(intent.id, agent, events);
        events.push(this.host.notice(p.agentId, p.intentId, startText(p.id, conflicts)));
      } catch (err) {
        // Not taken on after all: the caller reopens the intent as for any return, and no job is left behind.
        this.host.sql.exec("DELETE FROM resolver_jobs WHERE proposal_id = ?", p.id);
        throw err;
      }
      this.host.bump("resolver.attempted");
      this.host.sql.exec("DELETE FROM resolver_jobs WHERE finished_at IS NOT NULL AND finished_at < ?", now - KEEP_MS);
      this.host.waitUntil(this.run(p.id));
      // A job whose run died without an eviction (never expected) is failed on the next return.
      this.host.waitUntil(Promise.resolve().then(() => this.sweep()));
      return true;
    } catch (err) {
      console.warn(`resolver: ${p?.id ?? "?"} not taken on: ${errorText(err)}`);
      return false;
    }
  }

  /**
   * Outcomes the colony delivered (ColonyDO.deliverOutcomes): a resolver proposal that landed finishes its job (the change's
   * agent is told, resolver.landed counts); one that went back or was rejected fails it (the return stands; the
   * transition already reopened the intent; resolver.failed counts). Never throws.
   */
  settled(list: readonly Proposal[]): void {
    try {
      const agent = this.agentId();
      if (agent === null) return;
      for (const p of list) if (p?.agentId === agent && FINAL.has(p.status)) this.finish(p);
    } catch (err) {
      console.warn(`resolver: outcomes not settled: ${errorText(err)}`);
    }
  }

  /**
   * After the colony object starts: a job that was resolving lost its run with the old object, so it fails (the return
   * stands, the intent reopens); a proposed one whose proposal settled meanwhile is finished. Never throws.
   */
  resume(): void {
    try {
      if (this.agentId() === null) return;
      for (const job of this.host.sql.exec("SELECT * FROM resolver_jobs WHERE state = 'resolving' LIMIT 50").toArray() as ResolverJob[]) {
        this.fail(job.proposal_id, "the colony restarted while it worked");
      }
      this.reconcile();
    } catch (err) {
      console.warn(`resolver: not resumed: ${errorText(err)}`);
    }
  }

  /** Fail jobs whose run was lost (resolving long past their deadline), and finish proposed jobs whose proposal settled. */
  sweep(): void {
    try {
      const lost = this.host.sql.exec("SELECT proposal_id FROM resolver_jobs WHERE state = 'resolving' AND deadline < ? LIMIT 50", this.host.now() - LOST_MS).toArray() as Array<{ proposal_id: string }>;
      for (const r of lost) this.fail(r.proposal_id, `it did not finish within ${RESOLVE_TIMEOUT_MS / 1000} s`);
      this.reconcile();
    } catch (err) {
      console.warn(`resolver: sweep failed: ${errorText(err)}`);
    }
  }

  /** Finish proposed jobs whose proposal has settled (an outcome the colony delivered before the job knew its proposal). */
  private reconcile(): void {
    const rows = this.host.sql.exec("SELECT resolution_id FROM resolver_jobs WHERE state = 'proposed' AND resolution_id IS NOT NULL LIMIT 50").toArray() as Array<{ resolution_id: string }>;
    for (const r of rows) {
      const p = this.host.proposal(r.resolution_id);
      if (p && FINAL.has(p.status)) this.finish(p);
    }
  }

  /**
   * The `resolves` record of each of these proposals that the resolver wrote (ColonyDO.landContext hands them to the
   * trunk writer, which writes them into the lineage note), keyed by proposal id. Never throws: a lane's context must
   * not fail over it.
   */
  records(ids: readonly Id[]): Record<Id, NoteResolves> {
    const out: Record<Id, NoteResolves> = {};
    try {
      // A colony whose resolver never ran has nothing to say (and no query is made).
      if (this.agentId() === null) return out;
      const want = [...new Set(ids.filter((x) => typeof x === "string" && x !== ""))].slice(0, 500);
      if (want.length === 0) return out;
      const rows = this.host.sql
        .exec("SELECT resolution_id, record FROM resolver_jobs WHERE resolution_id IN (SELECT value FROM json_each(?)) AND record IS NOT NULL", JSON.stringify(want))
        .toArray() as Array<{ resolution_id: string; record: string }>;
      for (const r of rows) {
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(r.record);
        } catch {
          continue;
        }
        const rec = cleanResolves(parsed);
        if (rec) out[r.resolution_id] = rec;
      }
    } catch (err) {
      console.warn(`resolver: records not read: ${errorText(err)}`);
    }
    return out;
  }

  /** Resolve one held return: build the merge (bounded by the job's deadline), then propose it or fail. */
  async run(proposalId: Id): Promise<void> {
    const job = this.job(proposalId);
    if (!job || job.state !== "resolving") return;
    let built: Built;
    try {
      built = await within<Built>(this.build(job), job.deadline - this.host.now(), { fail: `it took longer than ${RESOLVE_TIMEOUT_MS / 1000} s` });
    } catch (err) {
      built = { fail: `it failed: ${oneLine(errorText(err), 300)}` };
    }
    if ("fail" in built) {
      this.fail(proposalId, built.fail);
      return;
    }
    await this.submit(proposalId, built);
  }

  /**
   * The merge for one job, or why there is none. Reads the change's base, trunk's current version and the change's own
   * version of every file it writes that trunk moved since its base; merges cleanly what merges; asks the model for the
   * rest; validates; and builds the inline proposal (same intent, base: trunk's head, every other file as the change
   * wrote it).
   */
  private async build(job: ResolverJob): Promise<Built> {
    const host = this.host;
    const p = host.proposal(job.proposal_id);
    if (!p) return { fail: "the change is no longer known" };
    const head = host.trunkSha();
    const paths = p.writeSet.map((w) => w.path);
    const trunk = host.trunk();
    const [onHead, onBase] = await Promise.all([trunk.baseBlobs(head, paths), trunk.baseBlobs(p.baseSha, paths)]);
    const now = new Map(onHead.map((v) => [v.path, v.blob ?? null]));
    const then = new Map(onBase.map((v) => [v.path, v.blob ?? null]));
    const moved = p.writeSet.filter((w) => (then.get(w.path) ?? null) !== (now.get(w.path) ?? null));
    if (moved.length === 0) return { fail: "trunk no longer differs from its base on the files it writes" };
    if (moved.length > RESOLVE_MAX_FILES) return { fail: `${moved.length} of the files it writes changed on trunk, and the resolver merges at most ${RESOLVE_MAX_FILES}` };
    for (const w of moved) {
      if (w.blob === null || !then.get(w.path) || !now.get(w.path)) return { fail: `${w.path} was added or deleted on one side, and the resolver only merges edits` };
      if (isLockfile(w.path)) return { fail: `${w.path} is a lockfile, which is regenerated, not merged` };
    }

    // Texts: the change's own from its inline contents when it was inline, everything else from the trunk writer (its
    // store holds the change's blobs after the cycle that sent it back; base and trunk versions are in trunk history).
    const wanted = new Set<Sha>();
    for (const w of p.writeSet) if (w.blob) wanted.add(w.blob);
    for (const w of moved) {
      wanted.add(then.get(w.path)!);
      wanted.add(now.get(w.path)!);
    }
    const texts = await this.texts(p, [...wanted]);
    const files: Moved[] = [];
    for (const w of moved) {
      const base = texts.get(then.get(w.path)!);
      const ours = texts.get(now.get(w.path)!);
      const theirs = texts.get(w.blob!);
      if (base === undefined || ours === undefined || theirs === undefined) return { fail: `${w.path} could not be read` };
      const problem = mergeContentProblem([base, ours, theirs]);
      if (problem) return { fail: `${w.path} is ${problem}` };
      if (Math.max(utf8Length(base), utf8Length(ours), utf8Length(theirs)) > RESOLVE_FILE_BYTES) return { fail: `${w.path} is over ${RESOLVE_FILE_BYTES / 1024} KB` };
      const merge = mergeSides(base, ours, theirs);
      if (!merge.clean && merge.limited) return { fail: `${w.path} changed too much on one side to merge line by line` };
      files.push({ path: w.path, base, ours, theirs, merge });
    }
    const conflicted = files.filter((f): f is Moved & { merge: ConflictedMerge & { clean: false } } => !f.merge.clean);
    if (conflicted.length === 0) return { fail: "its files now merge cleanly with trunk, so there is nothing left to resolve" };

    // The other side: the landings that changed the conflicting files after the change's base, with their intents.
    const landed = host.landedSince(conflicted.map((f) => f.path), p.baseSha);
    const landingIds = [...new Set(landed.map((l) => l.landingId))].slice(0, 10);
    const sides = landingIds.map((landingId) => {
      const intentId = landed.find((l) => l.landingId === landingId)?.intentId ?? null;
      const i = intentId ? host.intent(intentId) : null;
      return { landingId, title: i?.title ?? "", why: i?.why ?? "" };
    });
    const mine = host.intent(p.intentId);
    const marked = conflicted.map((f) => ({ path: f.path, marked: markedText(f.merge), conflicts: f.merge.conflicts.length }));
    const { messages } = resolveMessages({ change: { proposalId: p.id, title: mine?.title ?? p.declared.summary, why: mine?.why ?? "" }, landed: sides, files: marked });

    // One model call, through the decide stage's limiter.
    const model = this.modelName();
    const limiter = host.limiter();
    const release = await limiter.acquire(model, job.deadline);
    if (!release) return { fail: `no call to ${model} could start in time (rate limits)` };
    const t0 = host.now();
    let reply: ModelReply;
    try {
      reply = await this.client().complete({ model, messages, maxTokens: resolveMaxTokens(marked) });
    } catch (err) {
      if (isThrottled(err)) limiter.cooldown(model, 2_000);
      return { fail: `the call to ${model} failed: ${oneLine(errorText(err), 200)}` };
    } finally {
      release();
    }
    const ms = host.now() - t0;
    const used = reply.model ?? model;
    const parsed = parseResolveReply(reply.text ?? "", conflicted.map((f) => f.ours));
    if ("cannot" in parsed) return { fail: `the model found the two changes cannot both be kept: ${parsed.cannot}` };
    if ("problem" in parsed) return { fail: `the model's reply was not usable: ${parsed.problem}` };

    // Validate before proposing.
    const mergedText = new Map<Path, string>();
    for (const f of files) if (f.merge.clean) mergedText.set(f.path, f.merge.text);
    for (const [i, f] of conflicted.entries()) {
      const text = parsed.files[i]!;
      const check = checkMerged(f.merge, text);
      if (!check.ok) return { fail: `the merge of ${f.path} ${check.problem}` };
      if (syntaxProblems(f.path, f.ours, false).length === 0 && syntaxProblems(f.path, f.theirs, false).length === 0) {
        const bad = syntaxProblems(f.path, text, false);
        if (bad.length > 0) return { fail: `the merge of ${f.path} does not parse: ${oneLine(bad[0]!, 200)}` };
      }
      if (utf8Length(text) > RESOLVE_FILE_BYTES || mergeContentProblem([text]) !== null) return { fail: `the merge of ${f.path} is not text of at most ${RESOLVE_FILE_BYTES / 1024} KB` };
      mergedText.set(f.path, text);
    }

    // The proposal: every file the change writes, the moved ones merged; nothing else.
    const writeSet: FileVersion[] = [];
    const contents: Record<Sha, string> = {};
    for (const w of p.writeSet) {
      if (w.blob === null) {
        writeSet.push({ path: w.path, blob: null });
        continue;
      }
      const text = mergedText.get(w.path) ?? texts.get(w.blob);
      if (text === undefined) return { fail: `${w.path} could not be read` };
      const blob = blobId(text);
      writeSet.push({ path: w.path, blob });
      contents[blob] = text;
    }
    const inline = inlineProblem(writeSet, contents);
    if (inline) return { fail: `the merged change cannot be proposed inline: ${inline}` };
    // Read set: the trunk blobs it merged against (every file it writes, as trunk has it at its base), and the other
    // files the change read, as it read them, so a change to one of those still sends the merge back.
    const written = new Set(paths);
    const readSet: FileVersion[] = [
      ...p.writeSet.flatMap((w) => (now.get(w.path) ? [{ path: w.path, blob: now.get(w.path)! }] : [])),
      ...(Array.isArray(p.readSet) ? p.readSet : []).filter((r) => r && typeof r.path === "string" && !written.has(r.path)),
    ];
    const conflictPaths = conflicted.map((f) => f.path);
    const hunks = conflicted.reduce((n, f) => n + f.merge.conflicts.length, 0);
    const checks: CheckResult[] = [
      {
        name: MODEL_USAGE_CHECK,
        ok: true,
        ms,
        detail: `${used}: 1 call(s), ${reply.usage?.input ?? 0} input / ${reply.usage?.output ?? 0} output tokens${reply.usage?.cached ? ` (${reply.usage.cached} cached)` : ""}`,
      },
      {
        name: "resolver: merge",
        ok: true,
        ms: 0,
        detail: oneLine(
          `resolves ${p.id} (${hunks} conflicting hunk${hunks === 1 ? "" : "s"} in ${listText(conflictPaths)}) against ${landingIds.length > 0 ? listText(landingIds) : "trunk"}: every line outside the conflicting hunks is exactly the clean merge of both changes, no conflicting hunk is either side's version whole, every line either side added in one is kept in its order unless the other side deleted it, each file parses where both versions did, and no other file changed`,
          1_000,
        ),
      },
    ];
    const input: ResolveInput = {
      colonyId: p.colonyId,
      intentId: p.intentId,
      agentId: job.resolver_id,
      workspace: p.workspace,
      baseSha: head,
      headSha: changesetId(head, writeSet),
      writeSet,
      readSet,
      contents,
      declared: { footprint: p.declared?.footprint ?? [], summary: oneLine(`Resolve the text merge conflict of ${p.id} in ${listText(conflictPaths)}, keeping both changes`, 300) },
      ...(typeof p.intentRevision === "number" ? { intentRevision: p.intentRevision } : {}),
      evidence: {
        checks,
        notVerified: `Not verified: written by the platform's conflict resolver with model ${used} from both changes' texts and intents. Checked before proposing: every line outside the conflicting hunks is exactly what a clean merge of both changes gives, no conflicting hunk is either side's version whole, every line either side added in one is kept in its order unless the other side deleted it, and each file still parses. No tests, type checks or builds were run.`,
      },
    };
    return { input, record: { proposalId: p.id, landingIds, paths: conflictPaths } };
  }

  /** Texts of these blobs (the change's inline contents first, then the trunk writer), each checked against its blob id. */
  private async texts(p: Proposal, blobs: Sha[]): Promise<Map<Sha, string>> {
    const out = new Map<Sha, string>();
    const inline = this.host.inlineContents(p.id) ?? {};
    for (const blob of blobs) {
      const text = Object.hasOwn(inline, blob) ? inline[blob] : undefined;
      if (typeof text === "string" && blobId(text) === blob) out.set(blob, text);
    }
    const rest = blobs.filter((b) => !out.has(b));
    if (rest.length > 0) {
      const read = await this.host.trunk().readBlobs(rest);
      for (const blob of rest) {
        const text = read?.[blob];
        if (typeof text === "string" && blobId(text) === blob) out.set(blob, text);
      }
    }
    return out;
  }

  /** Propose a built merge as the resolver's agent, unless the intent changed hands meanwhile. */
  private async submit(proposalId: Id, built: { input: ResolveInput; record: NoteResolves }): Promise<void> {
    const job = this.job(proposalId);
    if (!job || job.state !== "resolving") return;
    const intent = this.host.intent(job.intent_id);
    if (!intent || intent.assignedTo !== job.resolver_id || (intent.status !== "proposed" && intent.status !== "claimed")) {
      this.fail(proposalId, "its intent changed while the resolver worked (withdrawn, amended or taken by another agent)");
      return;
    }
    let r: Proposal;
    try {
      r = await this.host.propose(built.input);
    } catch (err) {
      this.fail(proposalId, `the colony refused the merged change: ${oneLine(errorText(err), 300)}`);
      return;
    }
    this.host.sql.exec("UPDATE resolver_jobs SET state = 'proposed', resolution_id = ?, record = ? WHERE proposal_id = ? AND state = 'resolving'", r.id, JSON.stringify(built.record), proposalId);
    console.log(`resolver: ${proposalId} resolved as ${r.id} (${r.status})`);
    // A proposal that settled at once (its outcome reached settled() before the job knew it) finishes now.
    const now = this.host.proposal(r.id) ?? r;
    if (FINAL.has(now.status)) this.finish(now);
  }

  /** Fail a job that is still resolving: the return stands, the intent reopens, its agent is told, resolver.failed counts. */
  private fail(proposalId: Id, why: string): void {
    const job = this.job(proposalId);
    if (!job || job.state !== "resolving") return;
    const now = this.host.now();
    this.host.sql.exec("UPDATE resolver_jobs SET state = 'failed', reason = ?, finished_at = ? WHERE proposal_id = ? AND state = 'resolving'", why, now, proposalId);
    const status = this.host.release(job.intent_id, job.resolver_id);
    this.host.publish([this.host.notice(job.agent_id, job.intent_id, failedText(proposalId, why, job.intent_id, status))]);
    this.host.bump("resolver.failed");
    console.log(`resolver: ${proposalId} not resolved: ${why}`);
  }

  /** Finish the job of a resolver proposal that settled: landed, or failed with the reason it went back. */
  private finish(p: Proposal): void {
    const job = (this.host.sql.exec("SELECT * FROM resolver_jobs WHERE resolution_id = ? AND state = 'proposed'", p.id).toArray()[0] as ResolverJob | undefined) ?? null;
    if (!job) return;
    const now = this.host.now();
    if (p.status === "landed") {
      this.host.sql.exec("UPDATE resolver_jobs SET state = 'landed', landing_id = ?, finished_at = ? WHERE proposal_id = ? AND state = 'proposed'", p.landingId ?? null, now, job.proposal_id);
      let landings: Id[] = [];
      try {
        landings = cleanResolves(JSON.parse(job.record ?? "null"))?.landingIds ?? [];
      } catch {
        landings = [];
      }
      this.host.publish([this.host.notice(job.agent_id, job.intent_id, landedText(job.proposal_id, p.id, p.landingId, job.intent_id, landings))]);
      this.host.bump("resolver.landed");
      return;
    }
    const why = oneLine(p.reason ?? `it was ${p.status}`, 500);
    this.host.sql.exec("UPDATE resolver_jobs SET state = 'failed', reason = ?, finished_at = ? WHERE proposal_id = ? AND state = 'proposed'", why, now, job.proposal_id);
    const status = this.host.intent(job.intent_id)?.status ?? null;
    this.host.publish([this.host.notice(job.agent_id, job.intent_id, failedText(job.proposal_id, why, job.intent_id, status, p.id))]);
    this.host.bump("resolver.failed");
  }
}
