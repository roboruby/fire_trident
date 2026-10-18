import { describe, expect, it } from "vitest";
import { SlotBook, type SlotToken, type TokenOps } from "../../src/pool/slots.ts";
import {
  LeaseGuard,
  QUIET_MS,
  RELEASE_RETRY_MS,
  SWEEP_AFTER_MS,
  SWEEP_EVERY_MS,
  leaseHolders,
  nextSweepAt,
  oldLeases,
  releaseRetried,
  shrunkTarget,
  sweepLeases,
} from "../../src/pool/upkeep.ts";

/**
 * A workspace pool's upkeep (pool/upkeep.ts): the lease sweep frees only the leases whose agents the colony no longer
 * counts as holding a workspace, never one in use; a failed release is tried again; and a quiet pool's target comes
 * back down toward demand.
 */

interface DatabaseSync {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
}
const SQLITE = "node:sqlite";
const { DatabaseSync } = (await import(SQLITE)) as { DatabaseSync: new (path: string) => DatabaseSync };

function sqlStorage(): SqlStorage {
  const db = new DatabaseSync(":memory:");
  return {
    exec(query: string, ...bindings: unknown[]) {
      const rows = db.prepare(query).all(...bindings);
      return {
        toArray: () => rows,
        one: () => {
          if (rows.length !== 1) throw new Error(`expected one row, got ${rows.length}`);
          return rows[0];
        },
        [Symbol.iterator]: () => rows[Symbol.iterator](),
      };
    },
  } as unknown as SqlStorage;
}

const tokens: TokenOps = {
  mint: async (): Promise<SlotToken> => ({ id: "t", token: "fixture-token", expiresAt: Number.MAX_SAFE_INTEGER }),
  revoke: async () => undefined,
};

/** A pool of `slots` ready workspaces at time `now`, with a lease helper. */
function pool(slots: number) {
  const clock = { now: 10_000_000 };
  const sql = sqlStorage();
  const book = new SlotBook(sql, tokens, () => clock.now);
  for (let n = 0; n < slots; n++) sql.exec(`INSERT INTO ft_pool_ws (n, shard, name, remote, state, created_at) VALUES (?, ?, ?, ?, 'ready', 0)`, n, n % 4, `ws-${n}`, `https://x.invalid/ws-${n}.git`);
  const state = (agentId: string): string | undefined => (sql.exec(`SELECT state FROM ft_pool_ws WHERE agent_id = ? OR last_agent = ?`, agentId, agentId).toArray()[0] as { state?: string } | undefined)?.state;
  return { sql, book, clock, state };
}

describe("the lease sweep", () => {
  it("frees old leases whose agents hold no workspace in the colony, and keeps the ones in use and the young ones", async () => {
    const p = pool(4);
    p.book.take("gone");
    p.book.take("working");
    p.clock.now += SWEEP_AFTER_MS;
    p.book.take("young");
    expect(oldLeases(p.sql, p.clock.now).map((o) => o.agentId)).toEqual(["gone", "working"]);
    const asked: string[][] = [];
    const r = await sweepLeases({
      sql: p.sql,
      now: p.clock.now,
      guard: new LeaseGuard(),
      holders: async (ids) => (asked.push(ids), ids.filter((id) => id === "working")),
      release: (id) => p.book.release(id),
    });
    expect(asked).toEqual([["gone", "working"]]);
    expect(r).toEqual({ looked: 2, released: ["gone"] });
    expect(p.state("gone")).toBe("ready");
    expect(p.state("working")).toBe("leased");
    expect(p.state("young")).toBe("leased");
  });

  it("never frees a lease whose agent's lease call is in flight, or that leased while the colony was asked", async () => {
    const p = pool(4);
    p.book.take("a");
    p.book.take("b");
    p.book.take("c");
    p.clock.now += SWEEP_AFTER_MS + 1;
    const guard = new LeaseGuard();
    guard.enter("a");
    const r = await sweepLeases({
      sql: p.sql,
      now: p.clock.now,
      guard,
      holders: async (ids) => {
        // b leases again (the same slot comes back) while the colony is asked; the colony's answer predates it.
        guard.enter("b");
        p.book.take("b");
        guard.leave("b");
        expect(ids).toEqual(["b", "c"]);
        return [];
      },
      release: (id) => p.book.release(id),
    });
    expect(r.released).toEqual(["c"]);
    expect(p.state("a")).toBe("leased");
    expect(p.state("b")).toBe("leased");
    guard.leave("a");
    expect(guard.busy("a")).toBe(false);
  });

  it("frees nothing when the colony does not answer, or answers with something else", async () => {
    for (const holders of [async () => Promise.reject(new Error("The RPC receiver does not implement the method \"leaseHolders\".")), async () => null, async () => [1, 2]]) {
      const p = pool(1);
      p.book.take("a");
      p.clock.now += SWEEP_AFTER_MS;
      const r = await sweepLeases({ sql: p.sql, now: p.clock.now, guard: new LeaseGuard(), holders, release: (id) => p.book.release(id) });
      expect(r.released).toEqual([]);
      expect(r.skipped).toBeTruthy();
      expect(p.state("a")).toBe("leased");
    }
  });

  it("frees nothing when the colony does not answer in time", async () => {
    const p = pool(1);
    p.book.take("a");
    p.clock.now += SWEEP_AFTER_MS;
    const r = await sweepLeases({ sql: p.sql, now: p.clock.now, guard: new LeaseGuard(), holders: () => new Promise(() => undefined), release: (id) => p.book.release(id), askMs: 5 });
    expect(r).toMatchObject({ released: [], skipped: expect.stringMatching(/did not answer: no answer within/) });
    expect(p.state("a")).toBe("leased");
  });

  it("looks at a bounded batch, oldest first", async () => {
    const p = pool(10);
    for (let i = 0; i < 10; i++) {
      p.book.take(`a${i}`);
      p.clock.now += 1;
    }
    p.clock.now += SWEEP_AFTER_MS;
    const r = await sweepLeases({ sql: p.sql, now: p.clock.now, guard: new LeaseGuard(), holders: async () => [], release: (id) => p.book.release(id), limit: 3 });
    expect(r.released).toEqual(["a0", "a1", "a2"]);
  });

  it("is due again while anything is leased, at most every SWEEP_EVERY_MS", () => {
    const p = pool(2);
    expect(nextSweepAt(p.sql, 0)).toBeNull();
    const t0 = p.clock.now;
    p.book.take("a");
    expect(nextSweepAt(p.sql, 0)).toBe(t0 + SWEEP_AFTER_MS);
    expect(nextSweepAt(p.sql, t0 + SWEEP_AFTER_MS)).toBe(t0 + SWEEP_AFTER_MS + SWEEP_EVERY_MS);
  });
});

describe("the colony's side of the sweep", () => {
  it("counts an agent as holding a workspace while one is recorded for it or it is working", () => {
    const sql = sqlStorage();
    sql.exec("CREATE TABLE agents (id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, state TEXT NOT NULL, intent_id TEXT, workspace TEXT, last_seen INTEGER NOT NULL, created_at INTEGER NOT NULL)");
    const add = (id: string, state: string, workspace: string | null) => sql.exec("INSERT INTO agents (id, kind, name, state, workspace, last_seen, created_at) VALUES (?, 'internal', ?, ?, ?, 0, 0)", id, id, state, workspace);
    add("holds", "waiting", '{"repo":{}}');
    add("works", "working", null);
    add("idle", "idle", null);
    add("dead", "dead", null);
    expect(leaseHolders(sql, ["holds", "works", "idle", "dead", "unknown"]).sort()).toEqual(["holds", "works"]);
    expect(leaseHolders(sql, "not a list")).toEqual([]);
    expect(leaseHolders(sql, [])).toEqual([]);
  });
});

describe("release retries", () => {
  it("tries again after a failure, asking each time which agents are still to be released", async () => {
    const calls: string[][] = [];
    const waits: number[] = [];
    let left = ["a", "b"];
    const out = await releaseRetried(
      async (ids) => {
        calls.push(ids);
        if (calls.length === 1) throw new Error("pool reset");
      },
      () => {
        const now = left;
        left = ["a"]; // b leased again before the retry
        return now;
      },
      async (ms) => void waits.push(ms),
    );
    expect(out).toBe("released");
    expect(calls).toEqual([["a", "b"], ["a"]]);
    expect(waits).toEqual([RELEASE_RETRY_MS[0]]);
  });

  it("gives up after the retries, says when the pool is on the previous version, and does nothing with nobody to release", async () => {
    let n = 0;
    expect(await releaseRetried(async () => Promise.reject(new Error(`boom ${++n}`)), () => ["a"], async () => undefined)).toBe("failed");
    expect(n).toBe(RELEASE_RETRY_MS.length + 1);
    expect(await releaseRetried(async () => Promise.reject(new Error('The RPC receiver does not implement the method "releaseMany".')), () => ["a"], async () => undefined)).toBe("unsupported");
    expect(await releaseRetried(async () => undefined, () => [], async () => undefined)).toBe("nothing");
  });
});

describe("the target after a quiet period", () => {
  it("comes down toward the leases held now, never below the floor, and only after QUIET_MS without a raise", () => {
    const now = 100 * QUIET_MS;
    expect(shrunkTarget({ target: 8_192, floor: 16, leased: 40, quietSince: now - QUIET_MS, now })).toBe(50);
    expect(shrunkTarget({ target: 8_192, floor: 16, leased: 0, quietSince: now - QUIET_MS, now })).toBe(16);
    expect(shrunkTarget({ target: 8_192, floor: 64, leased: 2, quietSince: now - QUIET_MS, now })).toBe(64);
    // Not yet quiet long enough, or already at demand: left alone.
    expect(shrunkTarget({ target: 8_192, floor: 16, leased: 0, quietSince: now - QUIET_MS + 1, now })).toBeNull();
    expect(shrunkTarget({ target: 16, floor: 16, leased: 3, quietSince: 0, now })).toBeNull();
    expect(shrunkTarget({ target: 20, floor: 4, leased: 30, quietSince: 0, now })).toBeNull();
  });
});
