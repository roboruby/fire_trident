/**
 * Test worker for the Durable Object integration tests. Exports the real
 * ColonyDO and RegionDO, plus small stand-ins for TrunkDO and PoolDO that keep
 * trunk files and leases in storage, so coordination runs without Artifacts.
 */
import { DurableObject } from "cloudflare:workers";
import { Hono } from "hono";
import { newId, regionOf } from "@fire_trident/core";
import type { AgentKind, FileVersion, Id, Landing, LineageNote, NoteCertification, Path, Proposal, RepoRef, Sha, WorkspaceLease } from "@fire_trident/core";
import { createApi } from "../../src/api/app.ts";
import type { ApiDeps } from "../../src/api/app.ts";
import type { Env } from "../../src/env.ts";
import { runRevert, type RevertResult, type RevertTrunk } from "../../src/trunk/revert.ts";

export { ColonyDO } from "../../src/colony/ColonyDO.ts";
export { RegionDO } from "../../src/region/RegionDO.ts";

/** Random 40-hex id standing in for a commit or blob. */
export function fakeSha(): Sha {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

interface TrunkState {
  colonyId: Id;
  head: Sha;
  files: Record<Path, { blob: Sha; content: string }>;
  commits: Record<Sha, Record<Path, Sha>>;
  landings: Landing[];
  failLands: number;
  returnNext: Id[];
  reportLandings: boolean;
  /** land() calls that land the batch and then throw anyway (the caller never learns). */
  loseAnswers?: number;
  /** Co-change neighbors answered by neighbors() (none by default), or "fail" to make it throw. */
  neighbors?: Record<Path, Array<{ path: Path; weight: number }>> | "fail";
  /** neighbors() calls, for asserting caching. */
  neighborCalls?: number;
  /** Import links answered by importLinks() (none by default), or "fail" to make it throw. */
  imports?: Record<Path, { imports: Path[]; importers: Path[] }> | "fail";
  /** importLinks() calls, for asserting caching and that a weight of 0 never asks. */
  importCalls?: number;
  /** Lineage note fields added after landing (annotate), by landing id. */
  annotations?: Record<Id, { certification?: NoteCertification }>;
  /** certifySnapshot() calls, for asserting how often certification read trunk. */
  certifyReads?: number;
  /** markCertified() calls in order: the certified branch's moves. */
  certified?: Sha[];
  /** Every blob's content as of each commit, so a revert can restore it. */
  contents?: Record<Sha, string>;
  /** The lineage context each land() call received, as JSON (the latest 20), for asserting what lanes pass on. */
  contexts?: string[];
  /** Lineage notes by landing id, as JSON text like ft_notes: each landing's proposals (intent, write set), and each revert's note. */
  notes?: Record<Id, string>;
}

const DEFAULT_FILES: Record<Path, string> = {
  "README.md": "# demo\n",
  "src/app/main.ts": 'import { helper } from "../lib/util";\nconsole.log(helper());\n',
  "src/lib/util.ts": "export function helper() {\n  return 1;\n}\n",
  "docs/guide.md": "guide\n",
};

/** In-storage trunk: a path → blob index, commit snapshots, and landings. */
export class TrunkDO extends DurableObject<Env> {
  private async load(): Promise<TrunkState> {
    const s = await this.ctx.storage.get<TrunkState>("state");
    if (s) return s;
    return { colonyId: "", head: "", files: {}, commits: {}, landings: [], failLands: 0, returnNext: [], reportLandings: true };
  }

  private async save(s: TrunkState): Promise<void> {
    await this.ctx.storage.put("state", s);
  }

  private commit(s: TrunkState): Sha {
    const sha = fakeSha();
    s.commits[sha] = Object.fromEntries(Object.entries(s.files).map(([p, f]) => [p, f.blob]));
    s.contents = { ...(s.contents ?? {}), ...Object.fromEntries(Object.values(s.files).map((f) => [f.blob, f.content])) };
    s.head = sha;
    return sha;
  }

  async init(p: { colonyId: Id; trunk: RepoRef }): Promise<{ trunkSha: Sha; files: number }> {
    const s = await this.load();
    s.colonyId = p.colonyId;
    if (!s.head) {
      for (const [path, content] of Object.entries(DEFAULT_FILES)) s.files[path] = { blob: fakeSha(), content };
      this.commit(s);
    }
    await this.save(s);
    return { trunkSha: s.head, files: Object.keys(s.files).length };
  }

  /** Test helper: replace or add files (content null deletes) in one external commit. */
  async commitExternal(changes: Record<Path, string | null>): Promise<{ sha: Sha; blobs: Record<Path, Sha | null> }> {
    const s = await this.load();
    const blobs: Record<Path, Sha | null> = {};
    for (const [path, content] of Object.entries(changes)) {
      if (content === null) {
        delete s.files[path];
        blobs[path] = null;
      } else {
        const blob = fakeSha();
        s.files[path] = { blob, content };
        blobs[path] = blob;
      }
    }
    const sha = this.commit(s);
    await this.save(s);
    return { sha, blobs };
  }

  /** Test helper: the text land() writes for these blob ids (others land as a "// blob <id>" line). */
  async setContents(contents: Record<Sha, string>): Promise<void> {
    const s = await this.load();
    s.contents = { ...(s.contents ?? {}), ...contents };
    await this.save(s);
  }

  /** Test helper: make the next n land() calls throw. */
  async failNextLands(n: number): Promise<void> {
    const s = await this.load();
    s.failLands = n;
    await this.save(s);
  }

  /** Test helper: land() returns these proposals as conflicts instead of landing them. */
  async returnOnLand(ids: Id[]): Promise<void> {
    const s = await this.load();
    s.returnNext = ids;
    await this.save(s);
  }

  /**
   * Test helper: the next n land() calls land their batch and then throw, as when a deploy resets
   * the trunk object mid-call; with `report` false (the real writer's behavior) nobody tells the colony.
   */
  async loseNextAnswers(n: number, report = false): Promise<void> {
    const s = await this.load();
    s.loseAnswers = n;
    s.reportLandings = report;
    await this.save(s);
  }

  /** The landing of each proposal that has landed (by proposal id), as the real TrunkDO answers. */
  async landingsOf(ids: Id[]): Promise<Record<Id, Landing>> {
    const s = await this.load();
    const out: Record<Id, Landing> = {};
    for (const l of s.landings) for (const id of l.proposalIds) if (ids.includes(id)) out[id] = l;
    return out;
  }

  /** Test helper: current state. */
  async state(): Promise<TrunkState> {
    return this.load();
  }

  /** Test helper: the co-change neighbors neighbors() answers ("fail" makes it throw). */
  async setNeighbors(table: Record<Path, Array<{ path: Path; weight: number }>> | "fail"): Promise<void> {
    const s = await this.load();
    s.neighbors = table;
    await this.save(s);
  }

  /** Co-change neighbors, as the real TrunkDO answers (top k per path, paths without neighbors left out). */
  async neighbors(paths: Path[], k = 8): Promise<Record<Path, Array<{ path: Path; weight: number }>>> {
    const s = await this.load();
    s.neighborCalls = (s.neighborCalls ?? 0) + 1;
    await this.save(s);
    if (s.neighbors === "fail") throw new Error("simulated neighbors failure");
    const out: Record<Path, Array<{ path: Path; weight: number }>> = {};
    for (const p of paths) {
      const nb = s.neighbors?.[p];
      if (nb && nb.length > 0) out[p] = nb.slice(0, k);
    }
    return out;
  }

  /** Test helper: the import links importLinks() answers ("fail" makes it throw). */
  async setImports(table: Record<Path, { imports: Path[]; importers: Path[] }> | "fail"): Promise<void> {
    const s = await this.load();
    s.imports = table;
    await this.save(s);
  }

  /** Import links, as the real TrunkDO answers (paths with neither imports nor importers left out). */
  async importLinks(paths: Path[]): Promise<Record<Path, { imports: Path[]; importers: Path[] }>> {
    const s = await this.load();
    s.importCalls = (s.importCalls ?? 0) + 1;
    await this.save(s);
    if (s.imports === "fail") throw new Error("simulated import links failure");
    const out: Record<Path, { imports: Path[]; importers: Path[] }> = {};
    for (const p of paths) {
      const l = s.imports?.[p];
      if (l && l.imports.length + l.importers.length > 0) out[p] = l;
    }
    return out;
  }

  async files(): Promise<Array<{ path: Path; size: number; blob: Sha }>> {
    const s = await this.load();
    return Object.entries(s.files).map(([path, f]) => ({ path, size: f.content.length, blob: f.blob }));
  }

  async blobsFor(paths: Path[]): Promise<Record<Path, Sha | null>> {
    const s = await this.load();
    return Object.fromEntries(paths.map((p) => [p, s.files[p]?.blob ?? null]));
  }

  async readFile(path: Path): Promise<string | null> {
    return (await this.load()).files[path]?.content ?? null;
  }

  async baseBlobs(baseSha: Sha, paths: Path[]): Promise<FileVersion[]> {
    const snap = (await this.load()).commits[baseSha] ?? {};
    return paths.map((path) => ({ path, blob: snap[path] ?? null }));
  }

  async land(batch: Proposal[], ctx?: unknown): Promise<{ landing?: Landing; returned: Array<{ proposalId: Id; reason: string }> }> {
    const s = await this.load();
    s.contexts = [...(s.contexts ?? []), JSON.stringify(ctx ?? null)].slice(-20);
    if (s.failLands > 0) {
      s.failLands--;
      await this.save(s);
      throw new Error("simulated push rejection");
    }
    const returned: Array<{ proposalId: Id; reason: string }> = [];
    const landed: Proposal[] = [];
    for (const p of batch) {
      if (s.returnNext.includes(p.id)) returned.push({ proposalId: p.id, reason: "conflict at land time: src/lib/util.ts" });
      else landed.push(p);
    }
    if (landed.length === 0) {
      await this.save(s);
      return { returned };
    }
    for (const p of landed) {
      for (const w of p.writeSet) {
        if (w.blob === null) delete s.files[w.path];
        else s.files[w.path] = { blob: w.blob, content: s.contents?.[w.blob] ?? `// blob ${w.blob}\n` };
      }
    }
    const parent = s.head;
    const sha = this.commit(s);
    const paths = [...new Set(landed.flatMap((p) => p.writeSet.map((w) => w.path)))];
    const landing: Landing = {
      id: newId("lnd_"),
      colonyId: s.colonyId,
      trunkSha: sha,
      parentSha: parent,
      proposalIds: landed.map((p) => p.id),
      intentIds: [...new Set(landed.map((p) => p.intentId))],
      paths,
      regions: [...new Set(paths.map((p) => regionOf(p, 1)))],
      at: Date.now(),
    };
    s.landings.push(landing);
    s.notes = { ...(s.notes ?? {}), [landing.id]: JSON.stringify({ proposals: landed.map((p) => ({ id: p.id, intent: { id: p.intentId }, writeSet: p.writeSet })) }) };
    await this.save(s);
    // The real TrunkDO reports landings too; the ColonyDO must treat the second report as a no-op.
    if (s.reportLandings) await this.env.COLONY.get(this.env.COLONY.idFromName(s.colonyId)).onLanding(landing);
    if ((s.loseAnswers ?? 0) > 0) {
      s.loseAnswers = (s.loseAnswers ?? 0) - 1;
      await this.save(s);
      throw new Error("Durable Object reset because its code was updated.");
    }
    return { landing, returned };
  }

  async why(_path: Path, _line?: number): Promise<Array<{ landing: Landing; note: LineageNote }>> {
    return [];
  }

  async landings(limit = 20): Promise<Landing[]> {
    return (await this.load()).landings.slice(-limit).reverse();
  }

  /** Trunk certification's view, as the real TrunkDO answers (an external commit's landing id is derived as externalLanding names it). */
  async certifySnapshot(): Promise<{ trunkSha: Sha; landingId: Id | null; files: Array<{ path: Path; size: number; blob: Sha }>; truncated: boolean }> {
    const s = await this.load();
    s.certifyReads = (s.certifyReads ?? 0) + 1;
    await this.save(s);
    const files = Object.entries(s.files)
      .filter(([path]) => /\.(ts|js|mjs|json)$/.test(path))
      .map(([path, f]) => ({ path, size: f.content.length, blob: f.blob }));
    const landingId = s.landings.find((l) => l.trunkSha === s.head)?.id ?? `lnd_external_${s.head.slice(0, 8)}`;
    return { trunkSha: s.head, landingId, files, truncated: false };
  }

  /** Texts by blob id, as the real TrunkDO answers. */
  async readBlobs(blobs: Sha[]): Promise<Record<Sha, string | null>> {
    const s = await this.load();
    const byBlob = new Map(Object.values(s.files).map((f) => [f.blob, f.content]));
    return Object.fromEntries(blobs.map((b) => [b, byBlob.get(b) ?? null]));
  }

  /** Lineage note fields added after landing (recorded for assertions). */
  async annotate(landingId: Id, patch: Record<string, unknown>): Promise<boolean> {
    const s = await this.load();
    s.annotations = { ...(s.annotations ?? {}), [landingId]: { ...(s.annotations?.[landingId] ?? {}), ...(patch as { certification?: NoteCertification }) } };
    await this.save(s);
    return true;
  }

  /** Undo a landing as the real TrunkDO does (trunk/revert.ts runRevert, over this stand-in's state). */
  async revert(ref: string, p: { by: string; reason: string; proposal?: Id }): Promise<RevertResult> {
    const s = await this.load();
    const at = (id: Id) => s.landings.findIndex((l) => l.id === id);
    const trunk: RevertTrunk = {
      landing: (r) => s.landings.find((l) => l.id === r || (r.length >= 7 && l.trunkSha.startsWith(r))) ?? null,
      landed: (id) => {
        const l = s.landings[at(id)];
        if (!l) return [];
        const before = s.commits[l.parentSha] ?? {};
        const after = s.commits[l.trunkSha] ?? {};
        return [...l.paths].sort().map((path) => ({ path, before: before[path] ?? null, after: after[path] ?? null }));
      },
      note: (id) => (s.notes?.[id] === undefined ? null : (JSON.parse(s.notes[id]) as unknown)),
      landingOf: (pid) => s.landings.find((l) => l.proposalIds.includes(pid))?.id ?? null,
      later: (id, path) => [...s.landings.slice(at(id) + 1)].reverse().find((l) => l.paths.includes(path))?.id ?? null,
      blob: (path) => s.files[path]?.blob ?? null,
      files: () => Object.entries(s.files).map(([path, f]) => ({ path, blob: f.blob, size: f.content.length })),
      read: async (blob) => (s.contents?.[blob] === undefined ? null : new TextEncoder().encode(s.contents[blob])),
      serial: (fn) => fn(),
      commitNow: async (commit) => {
        for (const f of commit.files) {
          const now = s.files[f.path]?.blob ?? null;
          if (now !== f.expect) return { stale: `${f.path} ${now === null ? "deleted" : "changed"} since` };
        }
        for (const f of commit.files) {
          if (f.content === null || f.blob === null) delete s.files[f.path];
          else s.files[f.path] = { blob: f.blob, content: f.content };
        }
        const parent = s.head;
        const sha = this.commit(s);
        const paths = commit.files.map((f) => f.path).sort();
        const landing: Landing = { id: newId("lnd_"), colonyId: s.colonyId, trunkSha: sha, parentSha: parent, proposalIds: [], intentIds: [], paths, regions: [...new Set(paths.map((x) => regionOf(x, 1)))], at: Date.now() };
        s.landings.push(landing);
        s.notes = { ...(s.notes ?? {}), [landing.id]: JSON.stringify(commit.note) };
        await this.save(s);
        return { landing };
      },
      notesSoon: async () => undefined,
    };
    return runRevert(trunk, ref, p);
  }

  /** Undo one proposal of a landing, as the real TrunkDO does. */
  async revertProposal(ref: string, p: { by: string; reason: string; proposal: Id }): Promise<RevertResult> {
    return this.revert(ref, p);
  }

  /** The certified branch moves (recorded for assertions). */
  async markCertified(sha: Sha): Promise<boolean> {
    const s = await this.load();
    s.certified = [...(s.certified ?? []), sha];
    await this.save(s);
    return true;
  }

  /** Erase this object (colony deletion), as the real TrunkDO does. */
  async destroy(): Promise<{ cleared: true }> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    return { cleared: true };
  }
}

interface PoolState {
  colonyId: Id;
  target: number;
  empty: boolean;
  next: number;
  released: Id[];
}

/** Leases fake workspaces until told the pool is empty. */
export class PoolDO extends DurableObject<Env> {
  private async load(): Promise<PoolState> {
    return (await this.ctx.storage.get<PoolState>("state")) ?? { colonyId: "", target: 0, empty: false, next: 0, released: [] };
  }

  async init(p: { colonyId: Id; trunk: RepoRef; target: number }): Promise<void> {
    const s = await this.load();
    await this.ctx.storage.put("state", { ...s, colonyId: p.colonyId, target: p.target });
  }

  /** Test helper: make lease() return null (or not). */
  async setEmpty(empty: boolean): Promise<void> {
    await this.ctx.storage.put("state", { ...(await this.load()), empty });
  }

  /** Test helper: current state. */
  async state(): Promise<PoolState> {
    return this.load();
  }

  async lease(_agentId: Id, trunkSha: Sha): Promise<WorkspaceLease | null> {
    const s = await this.load();
    if (s.empty) return null;
    const n = s.next++;
    await this.ctx.storage.put("state", s);
    const now = Date.now();
    return {
      repo: { namespace: `ft-ws-${n % 4}`, name: `${s.colonyId}--ws-${n}`, remote: `https://artifacts.invalid/${s.colonyId}--ws-${n}.git` },
      token: "fake-workspace-token",
      tokenExpiresAt: now + 60 * 60_000,
      baseSha: trunkSha,
      leasedAt: now,
      trunk: { remote: `https://artifacts.invalid/${s.colonyId}--trunk.git`, token: "fake-trunk-token", sha: trunkSha },
    };
  }

  async release(agentId: Id): Promise<void> {
    const s = await this.load();
    s.released.push(agentId);
    await this.ctx.storage.put("state", s);
  }

  async releaseMany(agentIds: Id[]): Promise<number> {
    const s = await this.load();
    s.released.push(...agentIds);
    await this.ctx.storage.put("state", s);
    return agentIds.length;
  }

  async status(): Promise<{ ready: number; leased: number; forking: number; target: number }> {
    const s = await this.load();
    return { ready: s.empty ? 0 : s.target, leased: s.next - s.released.length, forking: 0, target: s.target };
  }

  /** Colony teardown: the fake has no repos to delete; it stops leasing. */
  async teardown(): Promise<{ deleted: number; errors: string[] }> {
    await this.ctx.storage.put("state", { ...(await this.load()), target: 0, empty: true });
    return { deleted: 0, errors: [] };
  }

  /** Erase this object (colony deletion), as the real PoolDO does. */
  async destroy(): Promise<{ cleared: true }> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    return { cleared: true };
  }
}

const deps: ApiDeps = {
  async provisionTrunk(_env, colonyId) {
    return {
      trunk: { namespace: "ft-trunk", name: `${colonyId}--trunk`, remote: `https://artifacts.invalid/${colonyId}--trunk.git` },
      trunkSha: "0".repeat(40),
    };
  },
  async spawnSwarm(env, colonyId, opts) {
    const kind: AgentKind = opts.kind ?? "synthetic";
    const agents = await env.COLONY.get(env.COLONY.idFromName(colonyId)).registerAgents(
      Array.from({ length: opts.count }, (_, i) => ({ kind, name: `swarm-${i + 1}`, ...(opts.model ? { model: opts.model } : {}) })),
    );
    return { agents: agents.map((a) => a.id) };
  },
};

const app = new Hono<{ Bindings: Env }>();
app.route("/api", createApi(deps));

export default app;
