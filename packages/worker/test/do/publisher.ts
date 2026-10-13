import { runInDurableObject } from "cloudflare:test";
import { expect } from "vitest";
import type { FileVersion, Landing, LineageNote, Path, Proposal, RepoRef, Sha, TrunkPublish } from "@fire_trident/core";
import { buildTree, ensureRepo, readLocalBlob, resolveLocal, setRef, writeCommitObject, writeLocalBlob, type GitRepo, type PushOutcome } from "../../src/artifacts/git.ts";
import type { PublishBound } from "../../src/trunk/publish.ts";
import type { LandResult } from "../../src/trunk/plan.ts";
import { TrunkDO } from "../../src/trunk/TrunkDO.ts";
import { env } from "./helpers.ts";

/**
 * The real trunk writer (TrunkDO) with asynchronous publishing (FT_ASYNC_PUBLISH), through whole landing cycles and
 * publishes, without Artifacts: trunk is a local repository in a Durable Object's storage, and only the network steps are
 * stood in for. The trunk repository is a FakeRemote whose main moves only by compare-and-swap, and the test decides what
 * each push does (lands, fails before or after reaching it, is refused, hangs). Everything else is the production code:
 * the cycle, the record, the publish loop, its recovery and the journal. A restart is a new TrunkDO over the same storage
 * (the previous one fenced, as a dead object would be).
 */

/** What one push to the fake trunk repository does. */
export type PushMode = "ok" | "fail" | "lost" | "refuse" | "hang" | "hang-after" | "held";

/** The fake trunk repository: main moves only by compare-and-swap; `certified` the same. */
export class FakeRemote {
  main: Sha;
  certified: Sha | null = null;
  /** Every move of main, in order (a push that moved it, whatever its answer). */
  readonly moves: Array<{ from: Sha; to: Sha; objects: number }> = [];
  /** What the next pushes do, in order (then `fallback`). */
  plan: PushMode[] = [];
  fallback: (() => PushMode) | null = null;
  attempts = 0;
  /** Pushes hanging forever (a crash mid-publish), and the held ones waiting for release(). */
  hung = 0;
  private held: Array<() => void> = [];
  /** The remote head lookup fails while this is set (the binding is down too). */
  headFails = false;
  /** Called as each push starts. */
  onPush: ((expected: Sha, target: Sha) => void) | null = null;

  constructor(main: Sha) {
    this.main = main;
  }

  /** A push of `target` with compare-and-swap on `expected` (the publish loop's push). */
  async push(expected: Sha, target: Sha, oids: string[]): Promise<PushOutcome> {
    this.attempts++;
    this.onPush?.(expected, target);
    const mode = this.plan.shift() ?? this.fallback?.() ?? "ok";
    if (mode === "hang") {
      this.hung++;
      return new Promise<PushOutcome>(() => undefined);
    }
    if (mode === "held") await new Promise<void>((resolve) => this.held.push(resolve));
    if (mode === "fail") throw new Error("network: connection reset before the update");
    if (mode === "refuse") return { ok: false, stale: false, detail: "unpack error" };
    if (this.main !== expected) return { ok: false, stale: true, remoteOid: this.main, detail: `stale: main is ${this.main}` };
    this.moves.push({ from: expected, to: target, objects: oids.length });
    this.main = target;
    if (mode === "lost") throw new Error("network: connection reset after the update");
    if (mode === "hang-after") {
      this.hung++;
      return new Promise<PushOutcome>(() => undefined);
    }
    return { ok: true };
  }

  /** Where main is, as the binding answers. */
  async head(): Promise<Sha | null> {
    if (this.headFails) throw new Error("binding unavailable");
    return this.main;
  }

  /** Held pushes waiting. */
  waiting(): number {
    return this.held.length;
  }

  /** Let every held push go on. */
  release(): void {
    for (const go of this.held.splice(0)) go();
  }
}

/** The private parts of TrunkDO the test stands in for or looks at. */
interface Internals {
  pullBlobs(p: Proposal): Promise<Map<Path, number>>;
  pushChain(chain: { parent: Sha; tip: Sha }): Promise<{ ok: true } | { ok: false; detail: string }>;
  publishPush(expected: Sha, target: Sha, oids: string[]): Promise<PushOutcome>;
  remoteHead(): Promise<Sha | null>;
  pushTrunkRef(ref: string, expectedOld: string | null): Promise<PushOutcome>;
  notesSoon(): Promise<void>;
  armAlarm(delayMs: number): Promise<void>;
  publishDelayMs(failures: number): number;
  rebuildIndex(head: Sha): Promise<void>;
  repo(): GitRepo;
  publishBound: PublishBound;
  epoch: number;
  publishDriver: Promise<void> | null;
  publishing: Promise<number> | null;
  publishSoon(): void;
}

const TRUNK: RepoRef = { namespace: "ft-trunk", name: "publish--trunk", remote: "https://artifacts.invalid/publish--trunk.git" };
let seq = 0;

/** Options for a writer: FT_ASYNC_PUBLISH (absent is off) and the bound on unpublished landings. */
export interface PublisherOptions {
  publish?: string;
  bound?: PublishBound;
}

/** A trunk writer over a fresh object's storage whose trunk holds `files`, publishing to a FakeRemote. */
export async function withPublisher(files: Record<Path, string>, opts: PublisherOptions, fn: (w: Publisher) => Promise<void>): Promise<void> {
  const name = `publish-${Date.now()}-${++seq}`;
  const colonyId = `col_publish_${seq}`;
  await runInDurableObject(env.TRUNK.get(env.TRUNK.idFromName(name)), async (_instance: unknown, state: DurableObjectState) => {
    const meta = (key: string, value: string): void => void state.storage.sql.exec("INSERT OR REPLACE INTO ft_meta (key, value) VALUES (?, ?)", key, value);
    const first = new TrunkDO(state, { FT_ASYNC_PUBLISH: opts.publish } as never);
    meta("colony_id", colonyId);
    meta("trunk", JSON.stringify(TRUNK));
    const g = (first as unknown as Internals).repo();
    await ensureRepo(g, TRUNK.remote);
    const tree = new Map<Path, { blob: Sha; mode: string }>();
    for (const [path, text] of Object.entries(files)) tree.set(path, { blob: await writeLocalBlob(g, new TextEncoder().encode(text)), mode: "100644" });
    const head = await writeCommitObject(g, { tree: await buildTree(g, tree), parents: [], message: "init\n", at: Date.now() });
    await setRef(g, "refs/heads/main", head);
    await (first as unknown as Internals).rebuildIndex(head);
    const w = new Publisher(state, opts, colonyId, new FakeRemote(head), head);
    w.adopt(first);
    await fn(w);
  });
}

/** Lands and publishes through the real trunk writer; restarts it over the same storage. */
export class Publisher {
  trunk!: TrunkDO;
  /** Every notes flush the writer started, with the landings whose notes were pending then. */
  readonly notes: Array<Set<string>> = [];
  readonly alarms: number[] = [];
  readonly certifiedPushes: Array<{ expectedOld: string | null; sha: Sha }> = [];
  /** Pushes the writer made without publishing (publishing off: the cycle pushes its chain). */
  readonly chainPushes: Array<{ parent: Sha; tip: Sha }> = [];
  private n = 0;
  private g!: GitRepo;
  /** Pushes left hanging by writers before the current one (fenced by a restart). */
  private hungBefore = 0;

  constructor(
    readonly state: DurableObjectState,
    private opts: PublisherOptions,
    readonly colonyId: string,
    readonly remote: FakeRemote,
    readonly initial: Sha,
  ) {}

  /** Stand in for the network steps of `t` and make it the writer. */
  adopt(t: TrunkDO): void {
    const x = t as unknown as Internals;
    this.g = x.repo();
    const g = this.g;
    x.pullBlobs = async (p) => {
      const sizes = new Map<Path, number>();
      for (const w of p.writeSet) if (w.blob !== null) sizes.set(w.path, (await readLocalBlob(g, w.blob)).length);
      return sizes;
    };
    // Publishing off: the cycle pushes its chain with compare-and-swap on its parent.
    x.pushChain = async (chain) => {
      this.chainPushes.push({ parent: chain.parent, tip: chain.tip });
      if (this.remote.main !== chain.parent) return { ok: false, detail: `stale: main is ${this.remote.main}` };
      this.remote.moves.push({ from: chain.parent, to: chain.tip, objects: 0 });
      this.remote.main = chain.tip;
      return { ok: true };
    };
    x.publishPush = (expected, target, oids) => this.remote.push(expected, target, oids);
    x.remoteHead = () => this.remote.head();
    // The `certified` branch: compare-and-swap on the fake remote, from the local ref markCertified set.
    x.pushTrunkRef = async (ref, expectedOld) => {
      if (this.remote.certified !== expectedOld) return { ok: false, stale: true, remoteOid: this.remote.certified, detail: "stale certified" };
      const local = await resolveLocal(g, ref);
      if (local === null) throw new Error(`no local ${ref}`);
      this.certifiedPushes.push({ expectedOld, sha: local });
      this.remote.certified = local;
      return { ok: true };
    };
    x.notesSoon = async () => {
      this.notes.push(new Set(this.rows<{ landing_id: string }>("SELECT landing_id FROM ft_journal WHERE state = 'pending_note'").map((r) => r.landing_id)));
    };
    x.armAlarm = async (ms) => {
      this.alarms.push(ms);
    };
    x.publishDelayMs = () => 2;
    if (this.opts.bound) x.publishBound = this.opts.bound;
    this.hungBefore = this.remote.hung;
    this.trunk = t;
  }

  /**
   * A restart (`over`: a deploy that changed the options): the running writer is fenced, as a dead object would be (its
   * pushes in flight may still reach the remote), and a new one starts over the same storage.
   */
  restart(over: Partial<PublisherOptions> = {}): TrunkDO {
    (this.trunk as unknown as Internals).epoch += 1_000;
    this.opts = { ...this.opts, ...over };
    const next = new TrunkDO(this.state, { FT_ASYNC_PUBLISH: this.opts.publish } as never);
    this.adopt(next);
    return next;
  }

  /** One proposal on the current recorded trunk writing these files (content null deletes). */
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

  /** A system commit (an antibody file). */
  systemCommit(path: Path, content: string): Promise<Landing> {
    const note = { schema: "firetrident.lineage/v1", landingId: "", colonyId: this.colonyId, proposals: [] } as unknown as LineageNote & Record<string, unknown>;
    return this.trunk.systemCommit({ files: [{ path, content }], message: `antibody ${path}`, note });
  }

  /** The recorded trunk head. */
  head(): Sha {
    return this.rows<{ value: string }>("SELECT value FROM ft_meta WHERE key = 'trunk_sha'")[0]!.value;
  }

  /** The writer's publishing state, as the colony reads it. */
  publishState(): Promise<TrunkPublish> {
    return this.trunk.publishState();
  }

  /** Journal rows by state. */
  journal(state: string): string[] {
    return this.rows<{ landing_id: string }>("SELECT landing_id FROM ft_journal WHERE state = ? ORDER BY rowid", state).map((r) => r.landing_id);
  }

  /** Every landing's commit, in the order they were recorded. */
  landingCommits(): Sha[] {
    return this.rows<{ trunk_sha: string }>("SELECT trunk_sha FROM ft_landings ORDER BY seq").map((r) => r.trunk_sha);
  }

  /**
   * The commits main moved through, in order: each move's commits after its old value up to its new one, by the
   * recorded parent links. A commit published twice would appear twice.
   */
  publishedOrder(): Sha[] {
    const parent = new Map(this.rows<{ trunk_sha: string; parent_sha: string }>("SELECT trunk_sha, parent_sha FROM ft_landings").map((r) => [r.trunk_sha, r.parent_sha]));
    const out: Sha[] = [];
    let at = this.initial;
    for (const m of this.remote.moves) {
      expect(m.from).toBe(at);
      const segment: Sha[] = [];
      for (let c: Sha | undefined = m.to; c !== m.from; c = parent.get(c)) {
        if (c === undefined || segment.length > 10_000) throw new Error(`move ${m.from} -> ${m.to} is not along the recorded chain`);
        segment.push(c);
      }
      out.push(...segment.reverse());
      at = m.to;
    }
    return out;
  }

  /** Wait until the current writer's publish loop is idle (or one of its pushes hangs), at most `ms`. */
  async settle(ms = 5_000): Promise<void> {
    const x = this.trunk as unknown as Internals;
    const until = Date.now() + ms;
    while ((x.publishDriver !== null || x.publishing !== null) && this.remote.hung === this.hungBefore && Date.now() < until) await new Promise((r) => setTimeout(r, 2));
  }

  /** Start the publish loop now (as a cycle that recorded something does). */
  kick(): void {
    (this.trunk as unknown as Internals).publishSoon();
  }

  rows<T>(sql: string, ...args: unknown[]): T[] {
    return this.state.storage.sql.exec(sql, ...args).toArray() as T[];
  }
}

/** The landing of a batch that landed whole. */
export function landed(r: LandResult): Landing {
  expect(r.returned).toEqual([]);
  expect(r.landing).toBeDefined();
  return r.landing!;
}
