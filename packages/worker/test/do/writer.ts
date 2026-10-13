import { runInDurableObject } from "cloudflare:test";
import { expect } from "vitest";
import type { FileVersion, Landing, Path, Proposal, RepoRef, Sha } from "@fire_trident/core";
import { buildTree, ensureRepo, readLocalBlob, setRef, writeCommitObject, writeLocalBlob, type GitRepo } from "../../src/artifacts/git.ts";
import type { LandResult } from "../../src/trunk/plan.ts";
import { TrunkDO, type CycleStat } from "../../src/trunk/TrunkDO.ts";
import { env } from "./helpers.ts";

/**
 * The real trunk writer (TrunkDO) through whole landing cycles, without Artifacts: it runs over a Durable Object's
 * storage with trunk as a local repository there, and only the network steps are stood in for: the blob pull reads
 * the blobs the test wrote locally, the push of the chain always succeeds, and notes are not pushed. Everything else
 * (screening, the import index, the plan, the commits, the record of each landing) is the production code.
 */

/** The private steps the test stands in for, and the ones it calls to set trunk up. */
interface Internals {
  pullBlobs(p: Proposal): Promise<Map<Path, number>>;
  pushChain(chain: unknown): Promise<{ ok: true }>;
  notesSoon(): Promise<void>;
  rebuildIndex(head: Sha): Promise<void>;
  repo(): GitRepo;
}

const TRUNK: RepoRef = { namespace: "ft-trunk", name: "guard--trunk", remote: "https://artifacts.invalid/guard--trunk.git" };
let seq = 0;

/** A trunk writer over a fresh object's storage whose trunk holds `files`; `guard` is FT_DELETION_GUARD. */
export async function withWriter(files: Record<Path, string>, guard: string | undefined, fn: (w: Writer) => Promise<void>): Promise<void> {
  const name = `deletion-guard-${Date.now()}-${++seq}`;
  const colonyId = `col_guard_${seq}`;
  await runInDurableObject(env.TRUNK.get(env.TRUNK.idFromName(name)), async (_instance: unknown, state: DurableObjectState) => {
    const trunk = new TrunkDO(state, { FT_DELETION_GUARD: guard } as never);
    const t = trunk as unknown as Internals;
    const meta = (key: string, value: string): void => void state.storage.sql.exec("INSERT OR REPLACE INTO ft_meta (key, value) VALUES (?, ?)", key, value);
    meta("colony_id", colonyId);
    meta("trunk", JSON.stringify(TRUNK));
    const g = t.repo();
    await ensureRepo(g, TRUNK.remote);
    const tree = new Map<Path, { blob: Sha; mode: string }>();
    for (const [path, text] of Object.entries(files)) tree.set(path, { blob: await writeLocalBlob(g, new TextEncoder().encode(text)), mode: "100644" });
    const head = await writeCommitObject(g, { tree: await buildTree(g, tree), parents: [], message: "init\n", at: Date.now() });
    await setRef(g, "refs/heads/main", head);
    await t.rebuildIndex(head);
    // The network steps.
    t.pullBlobs = async (p) => {
      const sizes = new Map<Path, number>();
      for (const w of p.writeSet) if (w.blob !== null) sizes.set(w.path, (await readLocalBlob(g, w.blob)).length);
      return sizes;
    };
    t.pushChain = async () => ({ ok: true });
    t.notesSoon = async () => undefined;
    await fn(new Writer(trunk, g, state, colonyId));
  });
}

/** Proposes through the real trunk writer. */
export class Writer {
  private n = 0;
  constructor(
    readonly trunk: TrunkDO,
    private readonly g: GitRepo,
    private readonly state: DurableObjectState,
    private readonly colonyId: string,
  ) {}

  /** One proposal on current trunk writing these files (content null deletes). */
  async proposal(changes: Record<Path, string | null>): Promise<Proposal> {
    const id = `prp_${++this.n}`;
    const writeSet: FileVersion[] = [];
    for (const [path, text] of Object.entries(changes)) writeSet.push({ path, blob: text === null ? null : await writeLocalBlob(this.g, new TextEncoder().encode(text)) });
    return {
      id,
      colonyId: this.colonyId,
      intentId: `int_${id}`,
      agentId: "agt_test",
      workspace: { namespace: "ft-ws-0", name: `${this.colonyId}--ws-1`, remote: "https://artifacts.invalid/ws.git" },
      baseSha: this.head(),
      headSha: "f".repeat(40),
      writeSet,
      readSet: [],
      declared: { footprint: Object.keys(changes), summary: id },
      evidence: { checks: [] },
      status: "ready",
      createdAt: Date.now(),
    };
  }

  /** Land one batch in its own cycle. */
  land(...batch: Proposal[]): Promise<LandResult> {
    return this.trunk.land(batch);
  }

  /** The trunk commit the writer is on. */
  head(): Sha {
    return this.state.storage.sql.exec<{ value: string }>("SELECT value FROM ft_meta WHERE key = 'trunk_sha'").one().value;
  }

  /** Whether trunk has this file. */
  has(path: Path): boolean {
    return this.state.storage.sql.exec("SELECT 1 AS x FROM ft_files WHERE path = ?", path).toArray().length > 0;
  }

  /** Whether the import index's tables exist in this object (created on its first use). */
  indexed(): boolean {
    return this.state.storage.sql.exec("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'ft_imp_meta'").toArray().length > 0;
  }

  /** The writer's recent cycles, oldest first. */
  async cycles(): Promise<CycleStat[]> {
    return (await this.trunk.stats()).recentCycles;
  }
}

/** The landing of a batch that landed whole. */
export function landed(r: LandResult): Landing {
  expect(r.returned).toEqual([]);
  expect(r.landing).toBeDefined();
  return r.landing!;
}
