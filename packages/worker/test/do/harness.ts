/**
 * Test worker for the Durable Object integration tests. Exports the real
 * ColonyDO and RegionDO, plus small stand-ins for TrunkDO and PoolDO that keep
 * trunk files and leases in storage, so coordination runs without Artifacts.
 */
import { DurableObject } from "cloudflare:workers";
import { Hono } from "hono";
import { newId, regionOf } from "@fire_trident/core";
import type { AgentKind, FileVersion, Id, Landing, LineageNote, Path, Proposal, RepoRef, Sha, WorkspaceLease } from "@fire_trident/core";
import { createApi } from "../../src/api/app.ts";
import type { ApiDeps } from "../../src/api/app.ts";
import type { Env } from "../../src/env.ts";

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

  /** Test helper: current state. */
  async state(): Promise<TrunkState> {
    return this.load();
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

  async land(batch: Proposal[]): Promise<{ landing?: Landing; returned: Array<{ proposalId: Id; reason: string }> }> {
    const s = await this.load();
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
        else s.files[w.path] = { blob: w.blob, content: `// blob ${w.blob}\n` };
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
    await this.save(s);
    // The real TrunkDO reports landings too; the ColonyDO must treat the second report as a no-op.
    if (s.reportLandings) await this.env.COLONY.get(this.env.COLONY.idFromName(s.colonyId)).onLanding(landing);
    return { landing, returned };
  }

  async why(_path: Path, _line?: number): Promise<Array<{ landing: Landing; note: LineageNote }>> {
    return [];
  }

  async landings(limit = 20): Promise<Landing[]> {
    return (await this.load()).landings.slice(-limit).reverse();
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

  async status(): Promise<{ ready: number; leased: number; forking: number; target: number }> {
    const s = await this.load();
    return { ready: s.empty ? 0 : s.target, leased: s.next - s.released.length, forking: 0, target: s.target };
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
