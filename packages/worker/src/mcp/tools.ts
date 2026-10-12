import { regionOf } from "@fire_trident/core";
import type { AgentInfo, FieldReading, FileVersion, Id, Intent, Path, RepoRef, Rule, Sha, WorkspaceLease } from "@fire_trident/core";
import { cleanPath } from "../agents/change.ts";
import type { ColonyRpc, RegionRpc, TrunkRpc } from "../agents/rpc.ts";
import { diffTrees, onFirstParentChain, readFileAt } from "./gitread.ts";
import type { ReadBlob, ReadCommit, ReadTree } from "./gitread.ts";
import { gitInstructions, ruleBrief } from "./instructions.ts";

/** What one MCP session remembers (stored in the session's Durable Object). */
export interface Session {
  colonyId?: Id;
  agentId?: Id;
  regionDepth?: number;
  trunk?: RepoRef;
  intent?: Intent;
  lease?: WorkspaceLease;
  rule?: Rule | null;
  /** Read set of the current intent: path -> blob seen at the lease base (null = absent). */
  reads: Record<Path, Sha | null>;
  proposals: Array<{ id: Id; intentId: Id; headSha: Sha; at: number }>;
}

/** Read access to one Artifacts repo through the binding. */
export interface RepoReader {
  readCommit: ReadCommit;
  readTree: ReadTree;
  readBlob: ReadBlob;
  release(): void;
}

/** Everything the tools touch, injected by the Durable Object (or a test). */
export interface ToolContext {
  colony(colonyId: Id): ColonyRpc;
  region(colonyId: Id, region: string): RegionRpc;
  trunk(colonyId: Id): TrunkRpc;
  repo(ref: Pick<RepoRef, "namespace" | "name">): Promise<RepoReader>;
  load(): Promise<Session>;
  save(s: Session): Promise<void>;
  now(): number;
}

/** Largest file the read tool returns (bytes). */
export const MAX_READ_BYTES = 1_000_000;
/** Commits walked from head looking for the lease base. */
export const MAX_ANCESTRY = 64;
/** Regions one sense call reads. */
const MAX_SENSE_REGIONS = 16;
const SHA = /^[0-9a-f]{40}$/;

function fail(status: number, message: string): never {
  throw new Error(`[ft:${status}] ${message}`);
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** A field reading trimmed for an agent's context window. */
function compactReading(r: FieldReading): Record<string, unknown> {
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

/** The MCP tools' behavior, independent of the transport. Every method returns JSON-able data or throws. */
export class FireTridentTools {
  constructor(private readonly ctx: ToolContext) {}

  private async joined(): Promise<Session & { colonyId: Id; agentId: Id }> {
    const s = await this.ctx.load();
    if (!s.colonyId || !s.agentId) fail(400, "call join first");
    return s as Session & { colonyId: Id; agentId: Id };
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

  /** Join a colony as an external agent (or resume an existing external agent id). */
  async join(a: { colony: string; name?: string; model?: string; agentId?: string }): Promise<unknown> {
    const colonyId = a.colony.trim();
    if (!colonyId) fail(400, "colony is required");
    const colony = this.ctx.colony(colonyId);
    const c = await colony.getColony();
    if (!c) fail(404, `colony ${colonyId} not found`);
    const prev = await this.ctx.load();
    let agent: AgentInfo | null = null;
    if (a.agentId) {
      agent = await colony.getAgent(a.agentId.trim());
      if (!agent || agent.kind !== "external") fail(404, `no external agent ${a.agentId} in colony ${colonyId}`);
    } else if (prev.agentId && prev.colonyId === colonyId) {
      agent = await colony.getAgent(prev.agentId);
    }
    if (!agent) {
      const reg: { kind: "external"; name: string; model?: string } = { kind: "external", name: (a.name ?? "").trim().slice(0, 100) || "mcp-agent" };
      if (a.model?.trim()) reg.model = a.model.trim().slice(0, 200);
      agent = await colony.registerAgent(reg);
    }
    const resumed = prev.agentId === agent.id && prev.colonyId === colonyId;
    const s: Session = resumed ? prev : { reads: {}, proposals: [] };
    s.colonyId = colonyId;
    s.agentId = agent.id;
    s.regionDepth = c.regionDepth;
    s.trunk = c.trunk;
    await this.ctx.save(s);
    return {
      agentId: agent.id,
      resumed,
      colony: { id: c.id, name: c.name, trunkSha: c.trunkSha, regionDepth: c.regionDepth },
      next: "Call take to receive an intent and a workspace lease.",
    };
  }

  /** Field readings for the regions of the given paths (or the given regions, or the held intent's footprint). */
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
    if (byRegion.size === 0) fail(400, "give paths or regions (or take an intent first)");
    const picked = [...byRegion].slice(0, MAX_SENSE_REGIONS);
    const readings = await Promise.all(
      picked.map(async ([region, ps]) => {
        try {
          const r = await this.ctx.region(s.colonyId, region).reading(ps.length > 0 ? { paths: ps } : {});
          return compactReading(r);
        } catch (e) {
          return { region, error: e instanceof Error ? e.message : String(e) };
        }
      }),
    );
    return { regionDepth: depth, readings, truncated: byRegion.size > picked.length };
  }

  private leaseView(s: Session & { intent: Intent; lease: WorkspaceLease }): Record<string, unknown> {
    const { intent, lease } = s;
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
      },
      rule: ruleBrief(s.rule),
      lease: {
        baseSha: lease.baseSha,
        trunk: { remote: lease.trunk.remote, sha: lease.trunk.sha },
        workspace: { namespace: lease.repo.namespace, name: lease.repo.name, remote: lease.repo.remote },
        tokenExpiresAt: new Date(lease.tokenExpiresAt).toISOString(),
      },
      tokens: { trunkRead: lease.trunk.token, workspaceWrite: lease.token },
      git: gitInstructions(lease, intent),
      next: "Read the files you depend on with read, edit only the footprint, push, then call propose with your head commit id.",
    };
  }

  /** Self-assign work: an intent plus a workspace lease, or a wait hint. */
  async take(): Promise<unknown> {
    const s = await this.joined();
    const res = await this.ctx.colony(s.colonyId).take(s.agentId);
    if ("wait" in res) return { wait: true, retryInMs: res.retryInMs, reason: res.reason };
    const changed = s.intent?.id !== res.intent.id;
    s.intent = res.intent;
    s.lease = res.lease;
    s.rule = res.rule ?? null;
    if (changed) s.reads = {};
    await this.ctx.save(s);
    return this.leaseView(s as Session & { intent: Intent; lease: WorkspaceLease });
  }

  /** The current lease and git instructions again. */
  async checkout(): Promise<unknown> {
    return this.leaseView(await this.leased());
  }

  /** Declare a new intent (source "agent"); by default it is a child of the held intent. */
  async declare(a: { title: string; why: string; footprint: string[]; acceptance?: string[]; priority?: number; parentId?: string }): Promise<unknown> {
    const s = await this.joined();
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
    const intent = await this.ctx.colony(s.colonyId).addIntent(input);
    return { intent: { id: intent.id, title: intent.title, status: intent.status, footprint: intent.footprint, parentId: intent.parentId ?? null } };
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
    s.reads[path] = file.blob;
    await this.ctx.save(s);
    return { ...file, baseSha: s.lease.baseSha, recorded: true };
  }

  /**
   * Propose the commit `headSha` already pushed to the workspace. The write set is
   * computed here by diffing the head tree against the lease base tree in the
   * workspace repo; the read set is what this session read. Head must descend
   * from the base on its first-parent chain.
   */
  async propose(a: { headSha: string; summary?: string }): Promise<unknown> {
    const s = await this.leased();
    const headSha = a.headSha.trim().toLowerCase();
    if (!SHA.test(headSha)) fail(400, "headSha must be a full 40-character commit id");
    const { lease, intent } = s;
    const ws = await this.ctx.repo(lease.repo);
    let writeSet: FileVersion[];
    try {
      const head = await ws.readCommit(headSha);
      if (!head) fail(404, `commit ${headSha} is not in your workspace ${lease.repo.name}; push it to refs/heads/main first`);
      if (!(await onFirstParentChain(ws.readCommit, headSha, lease.baseSha, MAX_ANCESTRY))) {
        fail(409, `commit ${headSha} does not build on the lease base ${lease.baseSha}; commit on top of the base and push again`);
      }
      const base = await ws.readCommit(lease.baseSha);
      if (!base) fail(409, `the lease base ${lease.baseSha} is not in your workspace`);
      writeSet = await diffTrees(ws.readTree, base.treeHash, head.treeHash);
    } finally {
      ws.release();
    }
    if (writeSet.length === 0) fail(400, "the head commit changes nothing relative to the base");
    const readSet: FileVersion[] = Object.entries(s.reads).map(([path, blob]) => ({ path, blob }));
    const proposal = await this.ctx.colony(s.colonyId).propose({
      colonyId: s.colonyId,
      intentId: intent.id,
      agentId: s.agentId,
      workspace: lease.repo,
      baseSha: lease.baseSha,
      headSha,
      writeSet,
      readSet,
      declared: { footprint: intent.footprint, summary: (a.summary ?? "").trim() || intent.title },
      evidence: { notVerified: "External agent over MCP: no checks ran on the agent's side that the platform can verify." },
    });
    s.proposals = [...s.proposals.slice(-49), { id: proposal.id, intentId: intent.id, headSha, at: this.ctx.now() }];
    const done: Session = s;
    delete done.intent;
    delete done.lease;
    delete done.rule;
    done.reads = {};
    await this.ctx.save(done);
    return {
      proposal: { id: proposal.id, status: proposal.status, reason: proposal.reason ?? null, residual: proposal.evidence?.residual ?? [] },
      writeSet,
      readSet: readSet.length,
      next: "Call inbox to follow the outcome, and take for more work.",
    };
  }

  /** Outcomes of this agent's proposals, newest first. */
  async inbox(a: { limit?: number }): Promise<unknown> {
    const s = await this.joined();
    const list = await this.ctx.colony(s.colonyId).inbox(s.agentId, Math.max(1, Math.min(50, a.limit ?? 20)));
    return {
      proposals: list.map((p) => ({
        id: p.id,
        intentId: p.intentId,
        status: p.status,
        reason: p.reason ?? null,
        landingId: p.landingId ?? null,
        headSha: p.headSha,
        createdAt: new Date(p.createdAt).toISOString(),
      })),
      holding: s.intent ? { intentId: s.intent.id, title: s.intent.title } : null,
    };
  }

  /** Lineage of a trunk path (optionally one line): the landings and intents behind it. */
  async why(a: { path: string; line?: number }): Promise<unknown> {
    const s = await this.joined();
    const path = cleanPath(a.path);
    if (!path) fail(400, `invalid path ${a.path}`);
    const entries = await this.ctx.trunk(s.colonyId).why(path, a.line);
    return { path, line: a.line ?? null, entries: entries.slice(0, 10) };
  }
}
