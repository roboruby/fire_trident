import { INLINE_LIMITS, blobId, changesetId, inlineProblem, regionOf } from "@fire_trident/core";
import type { AgentInfo, AgentKind, Directive, EscalationKind, FieldReading, FileVersion, Id, Intent, Landing, LineageNote, Path, Proposal, ProposalStatus, RepoRef, Rule, Sha, WorkspaceLease } from "@fire_trident/core";
import { ESCALATION_KINDS, isInboxDirective, landingMessage } from "../colony/direction.ts";
import { cleanPath } from "../agents/change.ts";
import { cleanContext, type LandedWhy } from "../agents/landed.ts";
import { cleanPreview, type ReviewPreview } from "../agents/preview.ts";
import { cleanLastReturn, type LastReturn } from "../agents/prompt.ts";
import type { ColonyRpc, RegionRpc, TakeResult, TrunkRpc } from "../agents/rpc.ts";
import { diffTrees, onFirstParentChain, readFileAt } from "./gitread.ts";
import type { ReadBlob, ReadCommit, ReadTree } from "./gitread.ts";
import { RESUME_KEY_NOTE, contextBrief, escalateReceipt, gitInstructions, leaseNext, reviewBrief, ruleBrief } from "./instructions.ts";
import { newResumeKey } from "./resume.ts";
import { cleanGuideTake, type GuideTake, type LessonReceipt } from "@fire_trident/core";
import { guideBrief } from "./guide.ts";
import type { ImpactReport } from "@fire_trident/core";
import { cleanModelHint, stepupAdvice, type ModelHint } from "../colony/stepup.ts";
import { movedView } from "../colony/movedby.ts";
import { isTwinAnswer, type DeclareAnswer } from "../colony/twins.ts";
import { priorityAnswer } from "../colony/priority.ts";
import { cleanDeclaredBy, heldNote, type DeclaredBy } from "../colony/chain.ts";
import { foldPath } from "../decide/pathfold.ts";
import { refuseWhilePaused } from "../colony/pause.ts";

/** What one MCP session remembers (stored in the session's Durable Object). */
export interface Session {
  colonyId?: Id;
  agentId?: Id;
  regionDepth?: number;
  trunk?: RepoRef;
  intent?: Intent;
  lease?: WorkspaceLease;
  rule?: Rule | null;
  /** What review will ask of the held intent's change, as take returned it (sessions saved before it have none). */
  review?: ReviewPreview;
  /** Why the code is the way it is: the latest landings on the held intent's files, as take returned them. */
  context?: LandedWhy[];
  /** Why the held intent's latest change came back, as take returned it (to address first). */
  lastReturn?: LastReturn;
  /** The colony's field guide as take returned it (FT_FIELD_GUIDE): lessons with their provenance, data to check. */
  guide?: GuideTake;
  /** The take's model hint (FT_MODEL_STEPUP): after two returns, advice to use a stronger model for this attempt. */
  model?: ModelHint;
  /** Who declared the held intent, as take returned it (colony/chain.ts): its source, the declarer and its model, the chain depth. */
  declaredBy?: DeclaredBy;
  /** Read set of the current intent: path -> blob seen at the lease base (null = absent). */
  reads: Record<Path, Sha | null>;
  proposals: Array<{ id: Id; intentId: Id; headSha: Sha; at: number }>;
  /** Last heartbeat sent to the colony for this agent. */
  lastBeat?: number;
  /**
   * This session's declares of the last DECLARE_REPLAY_MS, newest last: a repeat with the same content returns the
   * intent it declared instead of a duplicate (sessions saved before it have none).
   */
  declared?: DeclaredIntent[];
}

/**
 * A declare a session remembers: the fingerprint of its content (declareFingerprint), the intent it declared and its
 * status then, and when. Only these: a replay rebuilds the rest from the repeat, whose content is the same, so fifty
 * entries stay a few kilobytes whatever the footprints.
 */
export interface DeclaredIntent {
  fingerprint: string;
  at: number;
  intentId: Id;
  status: Intent["status"];
}

/** Read access to one Artifacts repo through the binding. */
export interface RepoReader {
  readCommit: ReadCommit;
  readTree: ReadTree;
  readBlob: ReadBlob;
  release(): void;
}

/** What ColonyDO.resumeAgent answers: the agent, or why it refused (never the key or its digest). */
export type ResumeCheck = { agent: AgentInfo } | { refused: "unknown" | "no-key" | "wrong-key" };

/**
 * ColonyDO methods the MCP tools use: the agent surface plus the colony's region list, registration
 * with a resume key (only its digest is stored) and the resume check (mcp/resume.ts).
 */
export type McpColonyRpc = Omit<ColonyRpc, "registerAgent"> & {
  listRegions(): Promise<string[]>;
  registerAgent(a: { kind: AgentKind; name: string; model?: string; resumeKey?: string }): Promise<AgentInfo>;
  resumeAgent(agentId: Id, resumeKey: string): Promise<ResumeCheck>;
  /** What a change to these paths reaches, and who works on it now (colony/impact.ts). */
  impact?(paths: Path[], opts?: { depth?: number }): Promise<ImpactReport>;
  /** Declare through the agent's door: where FT_TWINS covers the colony, a twin answers instead (colony/twins.ts). */
  declareIntent?(i: Omit<Intent, "id" | "status" | "createdAt">, opts?: { force?: boolean }): Promise<DeclareAnswer>;
};

/** TrunkDO methods the MCP tools use: lineage, and the blobs at a lease base (inline changes are built against it). */
export type McpTrunkRpc = TrunkRpc & { baseBlobs?(baseSha: Sha, paths: Path[]): Promise<FileVersion[]> };

/** One file of an inline change as an agent sends it: its whole new text, or null to delete it. */
export interface InlineFile {
  path: string;
  content: string | null;
}

/** Everything the tools touch, injected by the Durable Object (or a test). */
export interface ToolContext {
  colony(colonyId: Id): McpColonyRpc;
  region(colonyId: Id, region: string): RegionRpc;
  trunk(colonyId: Id): McpTrunkRpc;
  /** Whether the colony takes inline changes (FT_INLINE); absent means it does not. */
  inline?(colonyId: Id): boolean;
  repo(ref: Pick<RepoRef, "namespace" | "name">): Promise<RepoReader>;
  load(): Promise<Session>;
  save(s: Session): Promise<void>;
  now(): number;
  /** Wait (server-side long polls). Defaults to a timer. */
  sleep?(ms: number): Promise<void>;
}

/** Largest file the read tool returns (bytes). */
export const MAX_READ_BYTES = 1_000_000;
/** Commits walked from head looking for the lease base. */
export const MAX_ANCESTRY = 64;
/** Longest server-side wait of take and inbox (seconds): below the 60 s request timeout most MCP clients use. */
export const MAX_WAIT_S = 45;
/**
 * Heartbeat period: any tool call at least this long after the last one refreshes the agent's
 * claims and last-seen time. Without it a slow external agent's claims decay (they stop
 * inhibiting other agents after a few minutes) and the colony reaps it after ten silent minutes,
 * reopening its intent and revoking its workspace token.
 */
export const HEARTBEAT_EVERY_MS = 15_000;
/** Poll period of the server-side waits. */
const POLL_MS = 1_000;
/** Regions one sense call reads. */
const MAX_SENSE_REGIONS = 16;
const SHA = /^[0-9a-f]{40}$/;
/** Colony ids are slugs (same rule as the REST API). */
const COLONY_ID = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;
/** Proposal states after which nothing more happens to a proposal. */
const FINAL: ReadonlySet<ProposalStatus> = new Set<ProposalStatus>(["landed", "returned", "rejected"]);
/** The gap statement used when the agent does not state one. */
export const EXTERNAL_NOT_VERIFIED = "Not verified: external agent over MCP; no check it ran is visible to the platform.";
/**
 * How long a repeat of a declare in the same session returns the intent it declared instead of a new one. The
 * session lives in its own Durable Object (FireTridentMcp), so this holds across retries and reconnects of the session.
 */
export const DECLARE_REPLAY_MS = 10 * 60_000;
/** Declares a session remembers for replay (the newest). */
const MAX_DECLARED = 50;
/** What a replayed declare says next to the intent. */
const REPLAY_NOTE =
  "You declared an intent with the same title, why, footprint, acceptance, priority and parent in this session less than ten minutes ago: this is that intent, not a new one. Change one of them to declare another.";

function fail(status: number, message: string): never {
  throw new Error(`[ft:${status}] ${message}`);
}

/** Longest path an inline change may write. */
const MAX_INLINE_PATH = 1_024;

/**
 * Why an agent cannot write `path` in an inline change, or null: relative POSIX, no empty, "." or ".." segment, nothing
 * under .git, no leading or trailing space (the colony keeps paths trimmed, so the change would not be the one sent).
 */
export function inlinePathProblem(path: unknown): string | null {
  if (typeof path !== "string" || path === "") return "a file has no path";
  if (path.length > MAX_INLINE_PATH) return `path ${JSON.stringify(path.slice(0, 80))}... is over ${MAX_INLINE_PATH} characters`;
  if (path !== path.trim()) return `${JSON.stringify(path)} starts or ends with a space`;
  if (path.startsWith("/") || path.includes("\\") || path.includes("\0") || /^[A-Za-z]:/.test(path)) return `${JSON.stringify(path)} is not a relative path with / separators`;
  for (const seg of path.split("/")) {
    if (seg === "" || seg === "." || seg === "..") return `${JSON.stringify(path)} has an empty, "." or ".." segment`;
    if (foldPath(seg) === ".git") return `${JSON.stringify(path)} is inside .git`;
  }
  return null;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Seconds to wait, clamped to [0, MAX_WAIT_S]. */
function waitSeconds(w: number | undefined): number {
  return typeof w === "number" && Number.isFinite(w) ? Math.max(0, Math.min(MAX_WAIT_S, w)) : 0;
}

/** A field reading trimmed for an agent's context window. */
export function compactReading(r: FieldReading): Record<string, unknown> {
  const totals = Object.fromEntries(Object.entries(r.totals).map(([k, v]) => [k, round(v)]));
  const paths = Object.entries(r.byPath)
    .map(([path, v]) => ({ path, v, weight: (v.claim ?? 0) + (v.danger ?? 0) + (v.need ?? 0) + (v.failure ?? 0) }))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 50);
  return {
    region: r.region,
    totals,
    byPath: Object.fromEntries(paths.map((p) => [p.path, Object.fromEntries(Object.entries(p.v).map(([k, v]) => [k, round(v ?? 0)]))])),
    agents: (r.agents ?? []).slice(0, 20),
    sigma: round(r.sigma),
    admission: r.admission,
  };
}

/** One proposal as the inbox shows it (a change back because trunk moved its files names the landings that did: movedBy). */
function proposalView(p: Proposal): Record<string, unknown> {
  const movedBy = movedView(p.movedBy);
  return {
    id: p.id,
    intentId: p.intentId,
    status: p.status,
    reason: p.reason ?? null,
    landingId: p.landingId ?? null,
    headSha: p.headSha,
    createdAt: new Date(p.createdAt).toISOString(),
    ...(movedBy ? { movedBy } : {}),
  };
}

/** One directive as the inbox shows it (a landing notice with its facts: the landing, the blobs, the intent). */
function directiveView(d: Directive): Record<string, unknown> {
  return {
    id: d.id,
    kind: d.kind,
    intentId: d.intentId ?? null,
    message: d.message,
    by: d.by,
    at: new Date(d.at).toISOString(),
    ...(typeof d.revision === "number" ? { revision: d.revision, changed: d.changed ?? [] } : {}),
    ...(d.landing
      ? { landing: { landingId: d.landing.landingId, trunkSha: d.landing.trunkSha, paths: d.landing.paths, intent: { title: d.landing.intentTitle, why: d.landing.why } } }
      : {}),
  };
}

/** Forget the held intent: its lease, rule, review questions, why-context, last return, field guide, model hint and read set. */
function dropHeld(s: Session): void {
  delete s.intent;
  delete s.lease;
  delete s.rule;
  delete s.review;
  delete s.context;
  delete s.lastReturn;
  delete s.guide;
  delete s.model;
  s.reads = {};
}

/** The take's lastReturn as an external agent sees it (times in ISO form, the landings that moved its files as movedBy); null without one. */
function lastReturnView(r: LastReturn | undefined): Record<string, unknown> | null {
  if (!r) return null;
  const movedBy = movedView(r.movedBy);
  return { proposalId: r.proposalId, status: r.status, at: new Date(r.at).toISOString(), reason: r.reason, paths: r.paths, ...(r.morePaths ? { morePaths: r.morePaths } : {}), ...(movedBy ? { movedBy } : {}) };
}

/** What a proposer is told about its lesson: the colony's receipt, or, from a colony that keeps no field guide (it sends none), that it was not recorded. */
function lessonReceipt(x: unknown): LessonReceipt {
  const r = x as Partial<LessonReceipt> | null | undefined;
  if (r && typeof r === "object" && typeof r.status === "string" && typeof r.note === "string") return r as LessonReceipt;
  return { status: "ignored", note: "This colony keeps no field guide (FT_FIELD_GUIDE), so the lesson was not recorded." };
}

/** What a take or checkout with a lastReturn asks first. */
const RETURN_NEXT = "An earlier change for this intent came back: address lastReturn.reason first, so that your change does not come back for the same reason.";
/** And, when landings moved its files (lastReturn.movedBy), what to do about them. */
const MOVED_NEXT = "lastReturn.movedBy names the landings that moved its files, with their intents: keep what they did unless your intent says otherwise, and escalate if both cannot hold.";

/**
 * One landing of a why answer, cut to the path asked about: its note keeps only the proposals that
 * wrote the path (all of them when none did, as `ft why` shows them), and `otherProposals` counts the
 * proposals of the landing left out.
 */
function whyEntry(e: { landing: Landing; note: LineageNote }, path: Path): { landing: Landing; note: LineageNote; otherProposals: number } {
  const all = Array.isArray(e.note?.proposals) ? e.note.proposals : [];
  const wrote = all.filter((p) => Array.isArray(p?.writeSet) && p.writeSet.some((w) => w?.path === path));
  const shown = wrote.length > 0 ? wrote : all;
  return { landing: e.landing, note: { ...e.note, proposals: shown }, otherProposals: all.length - shown.length };
}

/** Landings one why answer shows at most. */
const WHY_LANDINGS = 10;

/**
 * A why answer as both MCP servers give it (the authenticated `why` and the public one): the trunk's landings for the
 * path in its order, at most ten, each cut to the path by whyEntry.
 */
export function whyAnswer(
  path: Path,
  line: number | undefined,
  entries: ReadonlyArray<{ landing: Landing; note: LineageNote }>,
): { path: Path; line: number | null; entries: Array<{ landing: Landing; note: LineageNote; otherProposals: number }> } {
  return { path, line: line ?? null, entries: (Array.isArray(entries) ? entries : []).slice(0, WHY_LANDINGS).map((e) => whyEntry(e, path)) };
}

/** The part of an intent a declare answers with. */
function declaredView(i: Pick<Intent, "id" | "title" | "status" | "footprint" | "parentId">): { id: Id; title: string; status: Intent["status"]; footprint: Path[]; parentId: Id | null } {
  return { id: i.id, title: i.title, status: i.status, footprint: i.footprint, parentId: i.parentId ?? null };
}

/**
 * SHA-256 (hex) of a declare's content in canonical form: title, why, footprint (sorted), acceptance, priority and
 * parent. Two declares with the same fingerprint ask for the same intent.
 */
export async function declareFingerprint(i: Pick<Intent, "title" | "why" | "footprint" | "priority" | "acceptance" | "parentId">): Promise<string> {
  const canonical = JSON.stringify([i.title, i.why, [...i.footprint].sort(), i.acceptance ?? [], i.priority, i.parentId ?? null]);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A session's declares still inside the replay window, oldest first; malformed entries (older or foreign data) are dropped. */
function recentDeclares(list: unknown, now: number): DeclaredIntent[] {
  if (!Array.isArray(list)) return [];
  return list.filter(
    (d): d is DeclaredIntent =>
      !!d && typeof d === "object" && typeof d.fingerprint === "string" && typeof d.at === "number" && now - d.at < DECLARE_REPLAY_MS && typeof d.intentId === "string" && d.intentId !== "",
  );
}

/** What an agent should do next, given its proposal's status. */
function nextFor(status: ProposalStatus): string {
  switch (status) {
    case "landed":
      return "Landed. Call why on a changed path for its lineage, or take for more work.";
    case "returned":
      return "Returned: read the reason, then take again (you get a fresh lease on the current trunk) and redo the change.";
    case "rejected":
      return "Rejected by review: read the reason. Take for other work.";
    case "escalated":
      return "Waiting for a human reviewer: call inbox with wait again (it returns when the human decides), or take other work meanwhile.";
    default:
      return "Still in review or queued to land: call inbox with wait again.";
  }
}

/**
 * The MCP tools' behavior, independent of the transport. Every method returns JSON-able data or
 * throws. Use one instance per session: it serializes the session's writes.
 */
export class FireTridentTools {
  /** Tail of the session write queue (see update). */
  private writes: Promise<unknown> = Promise.resolve();

  constructor(private readonly ctx: ToolContext) {}

  private sleep(ms: number): Promise<void> {
    return this.ctx.sleep ? this.ctx.sleep(ms) : new Promise((r) => setTimeout(r, ms));
  }

  /**
   * Change the stored session: load the latest copy, apply `fn` (which may return a replacement),
   * save. Updates run one at a time on this instance (one instance per session object), so
   * concurrent tool calls never interleave between a load and a save. Every write goes through
   * here, never a save of a copy loaded before other I/O: agents call tools in parallel, and a
   * stale save would drop another call's read-set entry or lease.
   */
  private update(fn: (s: Session) => Session | void): Promise<Session> {
    const run = this.writes.then(async () => {
      const cur = await this.ctx.load();
      const next = fn(cur) ?? cur;
      await this.ctx.save(next);
      return next;
    });
    this.writes = run.catch(() => undefined);
    return run;
  }

  private async joined(): Promise<Session & { colonyId: Id; agentId: Id }> {
    const s = await this.ctx.load();
    if (!s.colonyId || !s.agentId) fail(400, "call join first");
    const j = s as Session & { colonyId: Id; agentId: Id };
    await this.beat(j);
    return j;
  }

  /** Keep the agent alive in the colony (claims refreshed, not reaped) while it works through tool calls. */
  private async beat(s: Session & { colonyId: Id; agentId: Id }): Promise<void> {
    const now = this.ctx.now();
    if (now - (s.lastBeat ?? 0) < HEARTBEAT_EVERY_MS) return;
    try {
      await this.ctx.colony(s.colonyId).heartbeat(s.agentId);
      s.lastBeat = now;
      await this.update((x) => {
        if (x.agentId === s.agentId) x.lastBeat = now;
      });
    } catch {
      // Best effort: a missed heartbeat only shortens the claim's life.
    }
  }

  private async leased(): Promise<Session & { colonyId: Id; agentId: Id; intent: Intent; lease: WorkspaceLease }> {
    const s = await this.joined();
    if (!s.intent || !s.lease) fail(400, "you hold no intent; call take first");
    return s as Session & { colonyId: Id; agentId: Id; intent: Intent; lease: WorkspaceLease };
  }

  private async trunkRef(s: Session & { colonyId: Id }): Promise<RepoRef> {
    if (s.trunk) return s.trunk;
    const c = await this.ctx.colony(s.colonyId).getColony();
    if (!c) fail(404, `colony ${s.colonyId} not found`);
    s.trunk = c.trunk;
    s.regionDepth = c.regionDepth;
    return c.trunk;
  }

  /**
   * Join a colony as an external agent. A new agent gets a resume key, returned here once (the colony
   * keeps only its digest). This session resumes its own agent without the key; resuming an agent id
   * from another session needs it, because agent ids are public. An agent registered without a key
   * (before resume keys, or outside MCP) cannot be resumed from another session: it joins again as new.
   */
  async join(a: { colony: string; name?: string; model?: string; agentId?: string; resumeKey?: string }): Promise<unknown> {
    const colonyId = a.colony.trim().toLowerCase();
    if (!colonyId) fail(400, "colony is required");
    if (!COLONY_ID.test(colonyId)) fail(400, `invalid colony id ${a.colony}: colony ids are lowercase slugs such as my-colony`);
    const colony = this.ctx.colony(colonyId);
    const c = await colony.getColony();
    if (!c) fail(404, `colony ${colonyId} not found`);
    const prev = await this.ctx.load();
    const own = prev.colonyId === colonyId ? prev.agentId : undefined;
    const wanted = a.agentId?.trim();
    let agent: AgentInfo | null = null;
    if (wanted && wanted !== own) {
      agent = await this.resumeOther(colony, colonyId, wanted, a.resumeKey);
    } else if (own) {
      agent = await colony.getAgent(own);
      if (wanted && (!agent || agent.kind !== "external")) fail(404, `no external agent ${wanted} in colony ${colonyId}`);
    }
    let registered = false;
    let resumeKey: string | null = null;
    if (!agent) {
      resumeKey = newResumeKey();
      const reg: { kind: "external"; name: string; model?: string; resumeKey: string } = { kind: "external", name: (a.name ?? "").trim().slice(0, 100) || "mcp-agent", resumeKey };
      if (a.model?.trim()) reg.model = a.model.trim().slice(0, 200);
      agent = await colony.registerAgent(reg);
      registered = true;
    }
    // An existing agent resumed: this session's own, or another session's with its key.
    const resumed = !registered;
    const id = agent.id;
    // A returning agent comes back to life (heartbeat); a registration is a sign of life on its own.
    if (!registered) await this.ctx.colony(colonyId).heartbeat(id).catch(() => undefined);
    const now = this.ctx.now();
    await this.update((x) => {
      const s: Session = x.agentId === id && x.colonyId === colonyId ? x : { reads: {}, proposals: [] };
      s.colonyId = colonyId;
      s.agentId = id;
      s.regionDepth = c.regionDepth;
      s.trunk = c.trunk;
      s.lastBeat = now;
      return s;
    });
    return {
      agentId: agent.id,
      ...(resumeKey ? { resumeKey, resumeKeyNote: RESUME_KEY_NOTE } : {}),
      resumed,
      colony: { id: c.id, name: c.name, trunkSha: c.trunkSha, regionDepth: c.regionDepth },
      next: "Call take to receive an intent and a workspace lease (sense first to see where others work).",
    };
  }

  /**
   * Another session's agent, resumed by its id and the key it registered with (checked by the colony
   * against the stored digest, in constant time). Refuses with 404 when there is no such external
   * agent and 403 when the key is missing or wrong or the agent has none.
   */
  private async resumeOther(colony: McpColonyRpc, colonyId: Id, agentId: Id, resumeKey: string | undefined): Promise<AgentInfo> {
    const key = (resumeKey ?? "").trim();
    const unknown = `no external agent ${agentId} in colony ${colonyId}`;
    if (!key) {
      const known = await colony.getAgent(agentId);
      if (!known || known.kind !== "external") fail(404, unknown);
      fail(403, `forbidden: resuming agent ${agentId} from another session needs the resumeKey join returned when it registered. Without it, call join without agentId to register a new agent.`);
    }
    const r = await colony.resumeAgent(agentId, key);
    if ("agent" in r) return r.agent;
    if (r.refused === "unknown") fail(404, unknown);
    if (r.refused === "no-key") {
      fail(403, `forbidden: agent ${agentId} has no resume key (it registered before resume keys, or not over MCP), so no other session can resume it. Call join without agentId to register a new agent.`);
    }
    fail(403, `forbidden: wrong resumeKey for agent ${agentId}`);
  }

  /**
   * Field readings for the regions of the given paths, or the given regions, or the held intent's
   * footprint; with none of these, the colony's regions (the whole field, up to 16 regions).
   */
  async sense(a: { paths?: string[]; regions?: string[] }): Promise<unknown> {
    const s = await this.joined();
    const depth = s.regionDepth ?? 1;
    const byRegion = new Map<string, Path[]>();
    const paths = (a.paths && a.paths.length > 0 ? a.paths : (a.regions?.length ? [] : (s.intent?.footprint ?? []))).map(cleanPath).filter(Boolean);
    for (const p of paths) {
      const r = regionOf(p, depth);
      const list = byRegion.get(r) ?? [];
      list.push(p);
      byRegion.set(r, list);
    }
    for (const r of a.regions ?? []) if (r.trim()) byRegion.set(r.trim(), byRegion.get(r.trim()) ?? []);
    let scope = "paths";
    if (byRegion.size === 0) {
      // Nothing named and nothing held: the colony's own region list (a query never creates a region).
      scope = "colony";
      for (const r of await this.ctx.colony(s.colonyId).listRegions()) byRegion.set(r, []);
      if (byRegion.size === 0) return { regionDepth: depth, scope, readings: [], truncated: false, note: "the colony has no regions yet" };
    }
    const picked = [...byRegion].slice(0, MAX_SENSE_REGIONS);
    const readings = await Promise.all(
      picked.map(async ([region, ps]) => {
        try {
          const r = await this.ctx.region(s.colonyId, region).reading(ps.length > 0 ? { paths: ps } : {});
          return compactReading({ ...r, region });
        } catch (e) {
          return { region, error: e instanceof Error ? e.message : String(e) };
        }
      }),
    );
    return { regionDepth: depth, scope, readings, truncated: byRegion.size > picked.length };
  }

  private leaseView(s: Session & { intent: Intent; lease: WorkspaceLease }): Record<string, unknown> {
    const { intent, lease } = s;
    const review = reviewBrief(s.review);
    const context = contextBrief(s.context);
    const lastReturn = lastReturnView(s.lastReturn);
    // The colony's field guide (FT_FIELD_GUIDE): lessons other agents recorded, labeled as data to check.
    const guide = guideBrief(s.guide);
    // Model step-up (FT_MODEL_STEPUP): advice only, since the platform does not run an outside agent's model.
    const model = s.model ? stepupAdvice(s.model) : null;
    return {
      intent: {
        id: intent.id,
        title: intent.title,
        why: intent.why,
        footprint: intent.footprint,
        acceptance: intent.acceptance ?? [],
        priority: intent.priority,
        ruleId: intent.ruleId ?? null,
        parentId: intent.parentId ?? null,
        ...(s.declaredBy ? { declaredBy: s.declaredBy } : {}),
      },
      rule: ruleBrief(s.rule),
      ...(review ? { review } : {}),
      ...(context ? { context } : {}),
      ...(lastReturn ? { lastReturn } : {}),
      ...(guide ? { guide } : {}),
      ...(model ? { model } : {}),
      lease: {
        baseSha: lease.baseSha,
        trunk: { remote: lease.trunk.remote, sha: lease.trunk.sha },
        workspace: { namespace: lease.repo.namespace, name: lease.repo.name, remote: lease.repo.remote },
        tokenExpiresAt: new Date(lease.tokenExpiresAt).toISOString(),
      },
      tokens: { trunkRead: lease.trunk.token, workspaceWrite: lease.token },
      git: gitInstructions(lease, intent),
      next: lastReturn ? `${RETURN_NEXT}${lastReturn.movedBy ? ` ${MOVED_NEXT}` : ""} ${leaseNext(s.review)}` : leaseNext(s.review),
    };
  }

  /**
   * Self-assign work: an intent plus a workspace lease, or a wait hint. With `wait` (seconds,
   * at most MAX_WAIT_S) the server keeps asking while the colony says wait, so an agent with no
   * sleep tool can still wait for work.
   */
  async take(a: { wait?: number } = {}): Promise<unknown> {
    const s = await this.joined();
    // Pause (colony/pause.ts): refused at once while the colony's agents are paused; the colony checks again inside.
    await refuseWhilePaused(this.ctx.colony(s.colonyId));
    const colony = this.ctx.colony(s.colonyId);
    const deadline = this.ctx.now() + waitSeconds(a.wait) * 1000;
    let res: TakeResult = await colony.take(s.agentId);
    while ("wait" in res && this.ctx.now() + POLL_MS <= deadline) {
      await this.sleep(Math.min(Math.max(res.retryInMs, POLL_MS), deadline - this.ctx.now()));
      res = await colony.take(s.agentId);
    }
    if ("wait" in res) {
      return { wait: true, retryInMs: res.retryInMs, reason: res.reason, next: `No work for you yet. Call take again (with wait up to ${MAX_WAIT_S} the server waits for you).` };
    }
    const got = res;
    const now = this.ctx.now();
    const review = cleanPreview(got.review);
    const context = cleanContext(got.context);
    // Why the intent's latest change came back (a colony on the previous version sends none).
    const lastReturn = cleanLastReturn("lastReturn" in got ? got.lastReturn : undefined);
    // The colony's field guide (FT_FIELD_GUIDE; none where it is off).
    const guide = cleanGuideTake("guide" in got ? got.guide : undefined);
    // The model step-up's hint (FT_MODEL_STEPUP; none where it is off).
    const model = cleanModelHint(got.model);
    // Who declared the intent (colony/chain.ts; a colony on the previous version sends none).
    const declaredBy = cleanDeclaredBy("declaredBy" in got ? got.declaredBy : undefined);
    const next = await this.update((x) => {
      if (x.intent?.id !== got.intent.id) x.reads = {};
      x.intent = got.intent;
      x.lease = got.lease;
      x.rule = got.rule ?? null;
      if (review) x.review = review;
      else delete x.review;
      if (context) x.context = context;
      else delete x.context;
      if (lastReturn) x.lastReturn = lastReturn;
      else delete x.lastReturn;
      if (guide) x.guide = guide;
      else delete x.guide;
      if (model) x.model = model;
      else delete x.model;
      if (declaredBy) x.declaredBy = declaredBy;
      else delete x.declaredBy;
      x.lastBeat = now; // a take deposits fresh claims
    });
    return this.leaseView(next as Session & { intent: Intent; lease: WorkspaceLease });
  }

  /** The current lease and git instructions again. */
  async checkout(): Promise<unknown> {
    return this.leaseView(await this.leased());
  }

  /**
   * Declare a new intent (source "agent"); by default it is a child of the held intent. A repeat in this session within
   * DECLARE_REPLAY_MS with the same content (declareFingerprint) returns the intent the first one declared, marked
   * `replayed`, instead of a duplicate: a client that timed out, or a model retrying to be sure, paints one need.
   * Repeats in flight together wait for the first. Where FT_TWINS covers the colony, a declare that matches an intent
   * the colony has answers with that intent, `duplicateOf`, `similar` and a note instead, unless `force` (colony/twins.ts).
   */
  async declare(a: { title: string; why: string; footprint: string[]; acceptance?: string[]; priority?: number; parentId?: string; force?: boolean }): Promise<unknown> {
    const s = await this.joined();
    // Pause (colony/pause.ts): refused at once while the colony's agents are paused; the colony checks again inside.
    await refuseWhilePaused(this.ctx.colony(s.colonyId));
    const footprint = a.footprint.map((p) => p.trim()).filter((p) => p !== "" && !p.split("/").includes(".."));
    if (footprint.length === 0) fail(400, "footprint needs at least one path");
    const input: Omit<Intent, "id" | "status" | "createdAt"> = {
      colonyId: s.colonyId,
      title: a.title.trim(),
      why: a.why.trim(),
      source: "agent",
      footprint,
      priority: a.priority ?? 1,
      createdBy: s.agentId,
    };
    if (a.acceptance && a.acceptance.length > 0) input.acceptance = a.acceptance;
    const parent = a.parentId?.trim() || s.intent?.id;
    if (parent) input.parentId = parent;
    const fingerprint = await declareFingerprint(input);
    const run = (this.declaring.get(fingerprint) ?? Promise.resolve()).catch(() => undefined).then(() => this.declareOnce(s, input, fingerprint, a.force === true));
    this.declaring.set(fingerprint, run);
    try {
      return await run;
    } finally {
      if (this.declaring.get(fingerprint) === run) this.declaring.delete(fingerprint);
    }
  }

  /** Declares in flight by fingerprint: a repeat waits for the one ahead of it, then finds it in the session. */
  private readonly declaring = new Map<string, Promise<unknown>>();

  /** One declare: the intent this session declared with the same content lately (replayed), or a new one, remembered. */
  private async declareOnce(s: Session & { colonyId: Id; agentId: Id }, input: Omit<Intent, "id" | "status" | "createdAt">, fingerprint: string, force = false): Promise<unknown> {
    const colony = this.ctx.colony(s.colonyId);
    const now = this.ctx.now();
    const latest = await this.ctx.load();
    const earlier =
      latest.colonyId === s.colonyId && latest.agentId === s.agentId ? recentDeclares(latest.declared, now).findLast((d) => d.fingerprint === fingerprint) : undefined;
    if (earlier) {
      // The same content, so the same title, footprint and parent; the status as declared, unless the colony says more.
      let intent = declaredView({ id: earlier.intentId, title: input.title, status: earlier.status, footprint: input.footprint, ...(input.parentId ? { parentId: input.parentId } : {}) });
      // The priority it was granted, when the cap lowered it (colony/priority.ts): a client that missed the first answer learns it here.
      let granted: ReturnType<typeof priorityAnswer> = null;
      try {
        // Its status now (taken, landed, ...); called as a method (a detached stub function would name a remote property).
        const current = colony.getIntent ? await colony.getIntent(earlier.intentId) : null;
        if (current) intent = declaredView(current);
        if (current) granted = priorityAnswer(current);
      } catch {
        // Best effort: the intent as declared stands.
      }
      return { intent, replayed: true, declaredAt: new Date(earlier.at).toISOString(), note: REPLAY_NOTE, ...(granted ?? {}) };
    }
    // Twin intents (FT_TWINS, colony/twins.ts): a twin creates nothing, so the session has nothing to replay. Called as a
    // method (a detached stub function would name a remote property).
    const answer = colony.declareIntent ? await colony.declareIntent(input, force ? { force: true } : {}) : { intent: await colony.addIntent(input) };
    if (isTwinAnswer(answer)) return { intent: declaredView(answer.intent), duplicateOf: answer.duplicateOf, similar: answer.similar, note: answer.note };
    const intent = declaredView(answer.intent);
    await this.update((x) => {
      if (x.colonyId !== s.colonyId || x.agentId !== s.agentId) return; // the session joined as another agent meanwhile
      x.declared = [...recentDeclares(x.declared, now), { fingerprint, at: now, intentId: intent.id, status: intent.status }].slice(-MAX_DECLARED);
    });
    // The chain gate (FT_INTENT_CHAIN_GATE, colony/chain.ts): a held intent waits for a person, and the answer says so.
    const held = heldNote(answer.intent);
    // An agent's intent takes at most the priority of a parent it holds or declared, else 1: the answer says what it got (colony/priority.ts).
    const granted = priorityAnswer(answer.intent);
    return held ? { intent, held, ...(granted ?? {}) } : { intent, ...(granted ?? {}) };
  }

  /** A trunk file at the lease base; records (path, blob) in this session's read set. */
  async read(a: { path: string }): Promise<unknown> {
    const s = await this.leased();
    const path = cleanPath(a.path);
    if (!path) fail(400, `invalid path ${a.path}`);
    const repo = await this.ctx.repo(await this.trunkRef(s));
    let file;
    try {
      file = await readFileAt(repo, s.lease.baseSha, path, MAX_READ_BYTES);
    } finally {
      repo.release();
    }
    // Record into the latest session: parallel reads each add their own entry.
    const intentId = s.intent.id;
    const blob = file.blob;
    let recorded = false;
    await this.update((x) => {
      if (x.intent?.id !== intentId) return; // the intent was proposed or released meanwhile
      x.reads[path] = blob;
      recorded = true;
    });
    return { ...file, baseSha: s.lease.baseSha, recorded };
  }

  /**
   * Propose a change, given exactly one of: `headSha`, a commit already pushed to the workspace (the
   * write set is computed here by diffing the head tree against the lease base tree in the workspace
   * repo; head must descend from the base on its first-parent chain), or `files`, the new text of
   * each changed file (an inline change, see inlineChange: no git at all). The read set is what this
   * session read. `notVerified` is the agent's own statement of what it did not check (recorded as
   * evidence and shown to review). `lesson`, where the colony keeps a field guide (FT_FIELD_GUIDE), is
   * one surprising fact the agent learned; the answer says what became of it.
   */
  async propose(a: { headSha?: string; files?: InlineFile[]; summary?: string; notVerified?: string; lesson?: string }): Promise<unknown> {
    const s = await this.leased();
    // Pause (colony/pause.ts): refused at once while the colony's agents are paused; the colony checks again inside.
    await refuseWhilePaused(this.ctx.colony(s.colonyId));
    const head = typeof a.headSha === "string" ? a.headSha.trim().toLowerCase() : "";
    if ((head !== "") === (a.files !== undefined)) fail(400, "pass exactly one of headSha (a commit pushed to your workspace) and files (each changed file's path and new content)");
    const { lease, intent } = s;
    let headSha: Sha;
    let writeSet: FileVersion[];
    let contents: Record<Sha, string> | undefined;
    let unchanged: Path[] = [];
    if (a.files !== undefined) {
      ({ headSha, writeSet, contents, unchanged } = await this.inlineChange(s, a.files));
    } else {
      headSha = head;
      if (!SHA.test(headSha)) fail(400, "headSha must be a full 40-character commit id");
      const ws = await this.ctx.repo(lease.repo);
      try {
        const commit = await ws.readCommit(headSha);
        if (!commit) fail(404, `commit ${headSha} is not in your workspace ${lease.repo.name}; push it to refs/heads/main first`);
        if (!(await onFirstParentChain(ws.readCommit, headSha, lease.baseSha, MAX_ANCESTRY))) {
          fail(409, `commit ${headSha} does not build on the lease base ${lease.baseSha}; commit on top of the base and push again`);
        }
        const base = await ws.readCommit(lease.baseSha);
        if (!base) fail(409, `the lease base ${lease.baseSha} is not in your workspace`);
        writeSet = await diffTrees(ws.readTree, base.treeHash, commit.treeHash);
      } finally {
        ws.release();
      }
      if (writeSet.length === 0) fail(400, "the head commit changes nothing relative to the base");
    }
    // The freshest read set (a read may have finished while the workspace was being diffed).
    const latest = await this.ctx.load();
    const reads = latest.intent?.id === intent.id ? latest.reads : s.reads;
    const readSet: FileVersion[] = Object.entries(reads).map(([path, blob]) => ({ path, blob }));
    const stated = (a.notVerified ?? "").trim().slice(0, 5_000);
    const lesson = typeof a.lesson === "string" && a.lesson.trim() !== "" ? a.lesson : undefined;
    const proposal = await this.ctx.colony(s.colonyId).propose({
      colonyId: s.colonyId,
      intentId: intent.id,
      agentId: s.agentId,
      workspace: lease.repo,
      baseSha: lease.baseSha,
      headSha,
      writeSet,
      readSet,
      ...(contents ? { contents } : {}),
      declared: { footprint: intent.footprint, summary: (a.summary ?? "").trim() || intent.title },
      ...(typeof intent.revision === "number" ? { intentRevision: intent.revision } : {}),
      evidence: { notVerified: stated === "" ? EXTERNAL_NOT_VERIFIED : /^not verified/i.test(stated) ? stated : `Not verified: ${stated}` },
      ...(lesson ? { lesson } : {}),
    });
    const at = this.ctx.now();
    await this.update((x) => {
      x.proposals = [...x.proposals.slice(-49), { id: proposal.id, intentId: intent.id, headSha, at }];
      if (x.intent?.id !== intent.id) return; // a newer take replaced it meanwhile
      dropHeld(x);
    });
    return {
      proposal: { id: proposal.id, status: proposal.status, reason: proposal.reason ?? null, residual: proposal.evidence?.residual ?? [] },
      writeSet,
      ...(unchanged.length > 0 ? { unchanged } : {}),
      // What became of the lesson (a colony with the field guide off says nothing, so this says it).
      ...(lesson ? { lesson: lessonReceipt(proposal.lesson) } : {}),
      readSet: readSet.length,
      next: `Call inbox with wait: ${MAX_WAIT_S} to wait for the outcome (repeat until it settles), then take for more work.`,
    };
  }

  /**
   * An inline change from the files an agent sends (content null deletes), built against its lease base: paths
   * checked (inlinePathProblem), the base blobs read from the trunk writer (TrunkDO.baseBlobs), a file sent
   * unchanged dropped (and named in `unchanged`), deleting a file the base does not have refused, then the blob
   * ids, core's content check and the changeset id that stands in for a head commit. The colony checks it again.
   */
  private async inlineChange(s: Session & { colonyId: Id; lease: WorkspaceLease }, files: InlineFile[]): Promise<{ headSha: Sha; writeSet: FileVersion[]; contents: Record<Sha, string>; unchanged: Path[] }> {
    if (!this.ctx.inline?.(s.colonyId)) fail(409, "inline changes are off for this colony: push a commit to your workspace and propose its headSha");
    if (!Array.isArray(files) || files.length === 0) fail(400, "files is empty: send each file you change with its new content (null deletes it)");
    if (files.length > INLINE_LIMITS.files) fail(400, `an inline change sends at most ${INLINE_LIMITS.files} files (this one sends ${files.length}); push larger changes to your workspace and propose the commit`);
    const sent = new Map<Path, string | null>();
    for (const f of files) {
      const problem = inlinePathProblem(f?.path);
      if (problem) fail(400, problem);
      if (sent.has(f.path)) fail(400, `${f.path} is sent twice`);
      if (f.content !== null && typeof f.content !== "string") fail(400, `the content of ${f.path} must be its text, or null to delete it`);
      sent.set(f.path, f.content);
    }
    const trunk = this.ctx.trunk(s.colonyId);
    if (!trunk.baseBlobs) fail(503, "this colony cannot build inline changes yet: push a commit to your workspace and propose its headSha");
    const base = new Map((await trunk.baseBlobs(s.lease.baseSha, [...sent.keys()])).map((v) => [v.path, v.blob ?? null]));
    const writeSet: FileVersion[] = [];
    const contents: Record<Sha, string> = {};
    const unchanged: Path[] = [];
    for (const [path, content] of sent) {
      const before = base.get(path) ?? null;
      if (content === null) {
        if (before === null) fail(400, `${path} does not exist at your lease base, so it cannot be deleted`);
        writeSet.push({ path, blob: null });
        continue;
      }
      const blob = blobId(content);
      if (blob === before) {
        unchanged.push(path);
        continue;
      }
      writeSet.push({ path, blob });
      contents[blob] = content;
    }
    if (writeSet.length === 0) fail(400, "every file you sent is unchanged from your lease base: nothing to propose");
    const problem = inlineProblem(writeSet, contents);
    if (problem) fail(400, problem);
    return { headSha: changesetId(s.lease.baseSha, writeSet), writeSet, contents, unchanged };
  }

  /**
   * Outcomes of this agent's proposals, newest first. With `wait` (seconds, at most MAX_WAIT_S)
   * the server first waits on `proposalId` (default: this session's latest proposal) until it is
   * final (landed, returned, rejected) or newly escalated to a human; a proposal already waiting
   * for a human is waited on until the human decides.
   */
  async inbox(a: { limit?: number; proposalId?: string; wait?: number }): Promise<unknown> {
    const s = await this.joined();
    const colony = this.ctx.colony(s.colonyId);
    const wait = waitSeconds(a.wait);
    let watched: { id: Id; status: ProposalStatus; final: boolean; reason: string | null; landingId: Id | null; waitedMs: number; movedBy?: Array<Record<string, unknown>> } | null = null;
    if (wait > 0 || a.proposalId) {
      const id = a.proposalId?.trim() || s.proposals.at(-1)?.id;
      if (!id) fail(400, "you have no proposals in this session to wait for (pass proposalId)");
      const t0 = this.ctx.now();
      const deadline = t0 + wait * 1000;
      let p = await colony.getProposal(id);
      if (!p || p.agentId !== s.agentId) fail(404, `proposal ${id} is not one of yours`);
      const startedAs = p.status;
      const news = (st: ProposalStatus): boolean => FINAL.has(st) || (st === "escalated" && startedAs !== "escalated");
      while (!news(p.status) && this.ctx.now() + POLL_MS <= deadline) {
        await this.sleep(POLL_MS);
        p = (await colony.getProposal(id)) ?? p;
      }
      watched = { id, status: p.status, final: FINAL.has(p.status), reason: p.reason ?? null, landingId: p.landingId ?? null, waitedMs: this.ctx.now() - t0 };
      // What beat it, when trunk moved its files (colony/movedby.ts).
      const movedBy = movedView(p.movedBy);
      if (movedBy) watched.movedBy = movedBy;
    }
    const list: unknown[] = await colony.inbox(s.agentId, Math.max(1, Math.min(50, a.limit ?? 20)));
    const proposals = list.filter((e): e is Proposal => !isInboxDirective(e));
    const directives = list.filter(isInboxDirective).map((e) => e.directive);
    // Directives change course: a withdrawal ends the held intent, a revision refreshes it, guidance is followed.
    const held = s.intent;
    const about = directives.filter((d) => !d.intentId || (held !== undefined && d.intentId === held.id));
    let direction: string | undefined;
    let current: Intent | undefined = held;
    const withdrawal = held ? about.find((d) => d.kind === "withdrawal" && d.intentId === held.id) : undefined;
    const revision = held
      ? about
          .filter((d) => d.kind === "revision" && d.intentId === held.id && typeof d.revision === "number" && d.revision > (held.revision ?? 1))
          .sort((x, y) => (y.revision ?? 0) - (x.revision ?? 0))[0]
      : undefined;
    if (held && withdrawal) {
      await this.update((x) => {
        if (x.intent?.id !== held.id) return;
        dropHeld(x);
      });
      current = undefined;
      direction = `Your intent ${held.id} was withdrawn: ${withdrawal.message}. Stop working on it (your lease is revoked) and call take for other work.`;
    } else if (held && revision) {
      const fresh = colony.getIntent ? await colony.getIntent(held.id) : null;
      if (fresh) {
        await this.update((x) => {
          if (x.intent?.id === held.id) x.intent = fresh;
        });
        current = fresh;
      }
      const changed = (revision.changed ?? []).join(", ") || "details";
      direction = `Your intent was revised to r${revision.revision} (changed: ${changed}): ${revision.message}. Call checkout for the new text and rebuild your change on it; a change built on an older revision is refused.`;
    } else {
      const guidance = about.find((d) => d.kind === "guidance");
      const landing = held ? about.find((d) => d.kind === "landing" && d.intentId === held.id && d.landing) : undefined;
      if (guidance) direction = `A human sent you guidance: "${guidance.message}". Follow it in your change.`;
      // Facts only: what landed, and that the lane checks a change against trunk when it lands.
      else if (landing?.landing) direction = `Trunk moved under your intent. ${landingMessage(landing.landing)} A change built on the old blobs comes back when it lands.`;
    }
    return {
      ...(watched ? { watching: watched, next: nextFor(watched.status) } : {}),
      ...(direction ? { direction } : {}),
      proposals: proposals.map(proposalView),
      directives: directives.map(directiveView),
      holding: current ? { intentId: current.id, title: current.title, revision: current.revision ?? 1 } : null,
    };
  }

  /**
   * Give back the intent this agent holds without proposing: it reopens for other agents, the
   * claims clear, a failure mark is left, and the workspace lease is revoked.
   */
  async release(a: { reason?: string }): Promise<unknown> {
    const s = await this.joined();
    const reason = (a.reason ?? "").trim().slice(0, 500) || "released by an external agent";
    await this.ctx.colony(s.colonyId).abandon(s.agentId, reason);
    const held = s.intent ? { intentId: s.intent.id, title: s.intent.title } : null;
    await this.update((x) => dropHeld(x));
    return { released: held, next: "Call take for other work." };
  }

  /**
   * Report to a person that an intent cannot be done as written (a wrong test, a contradictory spec,
   * an impossible ask) instead of working around it. Defaults to the held intent. The colony keeps the
   * intent for a person and releases this agent's claim and lease; the session forgets the intent.
   * The answer is fixed text (escalateReceipt).
   */
  async escalate(a: { intentId?: string; kind: string; report: string }): Promise<unknown> {
    const s = await this.joined();
    // Pause (colony/pause.ts): refused at once while the colony's agents are paused; the colony checks again inside.
    await refuseWhilePaused(this.ctx.colony(s.colonyId));
    const kind = (ESCALATION_KINDS as readonly string[]).includes(a.kind) ? (a.kind as EscalationKind) : null;
    if (!kind) fail(400, `kind must be one of ${ESCALATION_KINDS.join(", ")}`);
    const report = (a.report ?? "").trim();
    if (!report) fail(400, "a report is required: say what is wrong, quoting the test or the spec line");
    const intentId = a.intentId?.trim() || s.intent?.id;
    if (!intentId) fail(400, "you hold no intent: take one, or pass the intentId your report is about");
    const colony = this.ctx.colony(s.colonyId);
    // Called as a method: on a Durable Object stub, a detached function would name a remote property.
    if (!colony.escalate) fail(503, "this colony cannot take reports yet; release the intent with your report as the reason");
    const res = await colony.escalate(s.agentId, { intentId, kind, report });
    await this.update((x) => {
      if (x.intent?.id === intentId) dropHeld(x);
    });
    return { escalated: { intentId: res.intent.id, title: res.intent.title, kind }, receipt: escalateReceipt(res.intent.id), next: "Call take for other work." };
  }

  /**
   * Lineage of a trunk path (optionally one line): the landings and intents behind it, in the trunk's
   * order (with a line, the landing that wrote it first). Each landing's note keeps only the proposals
   * that wrote the path, with a count of the others it carried; each proposal keeps its provenance (how
   * its author and model are known), which notes written before it lack.
   */
  async why(a: { path: string; line?: number }): Promise<unknown> {
    const s = await this.joined();
    const path = cleanPath(a.path);
    if (!path) fail(400, `invalid path ${a.path}`);
    const entries = await this.ctx.trunk(s.colonyId).why(path, a.line);
    return whyAnswer(path, a.line, entries);
  }

  /**
   * What a change to these paths (default: the held intent's footprint) reaches, and who works on it now
   * (ColonyDO.impact, colony/impact.ts): the trunk files that import them, up to `depth` levels, the live claims on those
   * files and the latest landings on them with their intents' whys. The answer's `about` labels its quoted text as data.
   */
  async impact(a: { paths?: string[]; depth?: number }): Promise<unknown> {
    const s = await this.joined();
    const asked = (a.paths ?? []).filter((p) => typeof p === "string" && p.trim() !== "");
    const paths = asked.length > 0 ? asked : (s.intent?.footprint ?? []);
    if (paths.length === 0) fail(400, "name the files to look at in paths, or take an intent first: impact then looks at its footprint");
    const colony = this.ctx.colony(s.colonyId);
    // Called as a method: on a Durable Object stub, a detached function would name a remote property.
    if (!colony.impact) fail(503, "this colony cannot answer impact yet");
    return colony.impact(paths, a.depth !== undefined ? { depth: a.depth } : {});
  }
}
