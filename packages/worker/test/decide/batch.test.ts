import { describe, expect, it } from "vitest";
import type { Id } from "@fire_trident/core";
import {
  ESCALATION_BATCH_PER_HOUR,
  EscalationBatches,
  NEVER_BATCHED,
  answerBatch,
  batchId,
  batchKeyOf,
  escalationBatchOn,
  heldByPerson,
  markBatches,
  markQueueBatches,
  recordEscalation,
  type BatchHost,
} from "../../src/decide/batch.ts";
import type { DangerClass } from "../../src/decide/danger.ts";
import { DEFAULT_POLICY, mergePolicy } from "../../src/decide/policy.ts";

/** The part of node:sqlite these tests use (the worker compiles against workers types, not Node's). */
interface DatabaseSync {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
  exec(sql: string): void;
}
const SQLITE = "node:sqlite";
const { DatabaseSync } = (await import(SQLITE)) as { DatabaseSync: new (path: string) => DatabaseSync };

function sqlStorage(): { sql: SqlStorage; db: DatabaseSync } {
  const db = new DatabaseSync(":memory:");
  const sql = {
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
  return { sql, db };
}

const HOUR = 60 * 60_000;
const hit = (cls: DangerClass, pattern: string) => ({ cls, pattern });
const NETWORK = batchKeyOf("P1 danger pattern", { danger: [hit("capability", "capability:network")] })!;
const PROCESS = batchKeyOf("P1 danger pattern", { danger: [hit("capability", "capability:process")] })!;
const AUTH = batchKeyOf("P1 danger pattern", { danger: [hit("auth", "auth:bearer-scheme")] })!;

describe("which escalations are counted and which may be batched", () => {
  it("counts only the rules the alert budget cannot send back", () => {
    for (const rule of ["P1 danger pattern", "P2 security finding", "P3 protected path", "P4 goal conflict", "M2 antibodies unscreened", "L5 too large", "L7 acceptance unclear", "L8 spend cap"]) {
      expect(batchKeyOf(rule), rule).not.toBeNull();
    }
    for (const rule of ["R1 detector+damage", "L1 detector+damage", "R1 detector+damage+budget", "D3 innate+proof", "L4 one signal", ""]) expect(batchKeyOf(rule), rule).toBeNull();
  });

  it("batches a capability danger pattern and the operational rules, keyed so a batch's changes hit exactly the same patterns", () => {
    expect(NETWORK).toEqual({ key: "P1|capability (network)", rule: "P1 danger pattern", label: "hit the danger pattern capability (network)", batchable: true });
    const two = [hit("capability", "capability:network"), hit("capability", "capability:import-process"), hit("capability", "capability:network")];
    const one = batchKeyOf("P1 danger pattern", { danger: two })!;
    expect(one).toMatchObject({ key: "P1|capability (import-process),capability (network)", label: "hit the danger patterns capability (import-process) and capability (network)", batchable: true });
    expect(batchKeyOf("P1 danger pattern", { danger: [...two].reverse() })!.key).toBe(one.key);
    // Crypto, CI and dependency signals are no reason to keep a change apart.
    expect(batchKeyOf("P1 danger pattern", { danger: two, signals: [{ cls: "crypto" }, { cls: "dependency" }, { cls: "ci" }] })!.batchable).toBe(true);
    for (const rule of ["M2 antibodies unscreened", "L5 too large", "L7 acceptance unclear", "L8 spend cap"]) expect(batchKeyOf(rule)).toMatchObject({ key: rule.split(" ")[0], batchable: true });
    expect(batchKeyOf("L8 spend cap")?.label).toBe("had no second opinion because the spend cap refused its model call");
  });

  it("never batches governance, handoff, secret, auth, a repair's test change or a loosened guard, alone or among capability hits", () => {
    expect([...NEVER_BATCHED].sort()).toEqual(["auth", "governance", "handoff", "loosened-guard", "secret", "test-change"]);
    const cases: Array<[string, Parameters<typeof batchKeyOf>[1]]> = [
      ["governance", { danger: [hit("governance", "governance:colony-memory")] }],
      ["handoff", { danger: [hit("handoff", "handoff:mcp-config")] }],
      ["secret", { danger: [hit("secret", "secret:token-format")] }],
      ["auth", { danger: [hit("auth", "auth:bearer-scheme")] }],
      ["test-change", { danger: [hit("test-change", "test-change:edited")] }],
      ["secret", { danger: [hit("capability", "capability:network"), hit("secret", "secret:logged")] }],
      ["loosened-guard", { danger: [hit("capability", "capability:network")], signals: [{ cls: "loosened-guard" }] }],
      ["secret", { danger: [hit("capability", "capability:network")], signals: [{ cls: "secret" }] }],
    ];
    for (const [cls, facts] of cases) {
      const k = batchKeyOf("P1 danger pattern", facts)!;
      expect(k.batchable, cls).toBe(false);
      expect(k.solo, cls).toBe(`it has a ${cls} hit, which a person decides change by change`);
    }
    // A loosened guard keeps a change apart whatever its rule.
    expect(batchKeyOf("L5 too large", { signals: [{ cls: "loosened-guard" }] })).toMatchObject({ batchable: false });
  });

  it("never batches a protected path, a security finding's next proposal, a goal conflict, or a P1 whose hits are not known", () => {
    expect(batchKeyOf("P3 protected path", { protected: [{ glob: "src/auth/**" }] })).toMatchObject({ batchable: false, solo: "it writes a protected path" });
    expect(batchKeyOf("P1 danger pattern", { danger: [hit("capability", "capability:network")], protected: [{ glob: "infra/**" }] })).toMatchObject({ batchable: false, solo: "it writes a protected path" });
    expect(batchKeyOf("P2 security finding", { probation: { classes: ["capability"] } })).toMatchObject({ batchable: false, solo: "an earlier proposal for its intent had a security finding" });
    expect(batchKeyOf("P4 goal conflict")).toMatchObject({ batchable: false, solo: "it would undo another intent's landing" });
    expect(batchKeyOf("P1 danger pattern")).toMatchObject({ batchable: false, solo: "its danger patterns are not known" });
  });

  it("bounds a long key, keeps two long keys apart, and gives each a short id", () => {
    const many = (n: number) => Array.from({ length: 80 }, (_, i) => hit("capability", `capability:import-area-${n}-${i}`));
    const a = batchKeyOf("P1 danger pattern", { danger: many(1) })!;
    const b = batchKeyOf("P1 danger pattern", { danger: many(2) })!;
    expect(a.key.length).toBeLessThanOrEqual(400);
    expect(a.key).not.toBe(b.key);
    expect(a.label).toMatch(/and 76 more$/);
    expect(batchId(NETWORK.key)).toMatch(/^bat_[0-9a-f]{8}$/);
    expect(batchId(NETWORK.key)).not.toBe(batchId(PROCESS.key));
  });

  it("reads the flag as the other colony flags: on, a list of colony ids, or off", () => {
    expect(escalationBatchOn(undefined, "c1")).toBe(false);
    expect(escalationBatchOn("off", "c1")).toBe(false);
    expect(escalationBatchOn("on", "c1")).toBe(true);
    expect(escalationBatchOn("c2, c1", "c1")).toBe(true);
    expect(escalationBatchOn("c2", "c1")).toBe(false);
  });
});

describe("the hourly budget", () => {
  it("batches the batchable escalations past the budget in the hour before, and nothing an hour later", () => {
    const { sql } = sqlStorage();
    const b = new EscalationBatches(sql);
    const t = 1_000 * HOUR;
    expect([1, 2, 3].map((i) => b.record(`prp_${i}`, NETWORK, t + i, 3).batched)).toEqual([false, false, false]);
    expect(b.record("prp_4", PROCESS, t + 4, 3)).toEqual({ batched: true, used: 3 });
    expect(b.record("prp_5", NETWORK, t + 5, 3).batched).toBe(true);
    // Recording the same change again counts it once.
    expect(b.record("prp_5", NETWORK, t + 6, 3)).toEqual({ batched: true, used: 4 });
    // An hour after the first ones, the budget has room again; batched rows stay until a person decides.
    expect(b.record("prp_6", NETWORK, t + HOUR + 4, 3)).toEqual({ batched: false, used: 1 });
    expect([...b.batchedOf(["prp_1", "prp_4", "prp_5", "prp_6", "prp_x"]).keys()]).toEqual(["prp_4", "prp_5"]);
  });

  it("counts a change that is never batched against the budget, and never batches it past it", () => {
    const { sql } = sqlStorage();
    const b = new EscalationBatches(sql);
    expect(b.record("prp_auth1", AUTH, 1, 1)).toEqual({ batched: false, used: 0 });
    expect(b.record("prp_auth2", AUTH, 2, 1)).toEqual({ batched: false, used: 1 });
    expect(b.record("prp_net", NETWORK, 3, 1)).toEqual({ batched: true, used: 2 });
    expect([...b.batchedOf(["prp_auth1", "prp_auth2", "prp_net"]).keys()]).toEqual(["prp_net"]);
  });

  it("is a decide policy setting: 60 an hour unless a colony sets another, from 1 to 10,000", () => {
    expect(DEFAULT_POLICY.escalationBatchPerHour).toBe(ESCALATION_BATCH_PER_HOUR);
    expect(mergePolicy(DEFAULT_POLICY, {}).escalationBatchPerHour).toBe(60);
    expect(mergePolicy(DEFAULT_POLICY, { escalationBatchPerHour: 5 }).escalationBatchPerHour).toBe(5);
    expect(mergePolicy(DEFAULT_POLICY, { escalationBatchPerHour: 0 }).escalationBatchPerHour).toBe(1);
    expect(mergePolicy(DEFAULT_POLICY, { escalationBatchPerHour: 20_000 }).escalationBatchPerHour).toBe(10_000);
    expect(mergePolicy(DEFAULT_POLICY, { escalationBatchPerHour: "3" }).escalationBatchPerHour).toBe(60);
  });

  it("uses a budget of 60 an hour by default", () => {
    expect(ESCALATION_BATCH_PER_HOUR).toBe(60);
    const { sql } = sqlStorage();
    const b = new EscalationBatches(sql);
    const batched = Array.from({ length: 62 }, (_, i) => b.record(`prp_${i}`, NETWORK, 5_000 + i).batched);
    expect(batched.filter(Boolean)).toHaveLength(2);
    expect(batched.indexOf(true)).toBe(60);
  });
});

describe("the queue: one card per batch", () => {
  it("marks the waiting changes of each batch with its id, key, words, budget and ids in queue order", () => {
    const { sql } = sqlStorage();
    const b = new EscalationBatches(sql);
    for (let i = 0; i < 3; i++) b.record(`prp_early${i}`, NETWORK, 10 + i, 3);
    b.record("prp_n1", NETWORK, 20, 3);
    b.record("prp_p1", PROCESS, 21, 3);
    b.record("prp_n2", NETWORK, 22, 3);
    const queue: Array<{ id: Id; batch?: unknown }> = ["prp_n2", "prp_early0", "prp_p1", "prp_n1"].map((id) => ({ id }));
    const marked = markBatches(queue, b.batchedOf(queue.map((p) => p.id)), 3);
    expect(marked).toEqual([{ id: batchId(NETWORK.key), key: "P1|capability (network)", rule: "P1 danger pattern", label: "hit the danger pattern capability (network)", budget: 3, ids: ["prp_n2", "prp_n1"] }]);
    expect(queue.map((p) => (p.batch as { key?: string } | undefined)?.key ?? null)).toEqual(["P1|capability (network)", null, null, "P1|capability (network)"]);
    // A batch down to one waiting change (prp_p1 alone in its batch) is that change's own card.
    expect(queue[2]!.batch).toBeUndefined();
  });

  it("leaves a change a person already decided that came back, such as a held merge, on its own card", () => {
    expect(heldByPerson({ approvedAt: 5 })).toBe(true);
    expect(heldByPerson({ mergeHold: [{ path: "src/a.ts" }] })).toBe(true);
    expect(heldByPerson({ mergeHold: [] })).toBe(false);
    expect(heldByPerson({ reason: "escalated by deterministic: danger patterns need a human: capability (network)" })).toBe(false);
    const { sql } = sqlStorage();
    const b = new EscalationBatches(sql);
    b.record("prp_early", NETWORK, 1, 1);
    for (const id of ["prp_n1", "prp_n2", "prp_held"]) b.record(id, NETWORK, 2, 1);
    const queue: Array<{ id: Id; approvedAt?: number; mergeHold?: unknown; batch?: { ids: Id[] } }> = [{ id: "prp_n1" }, { id: "prp_held", approvedAt: 9, mergeHold: [{ path: "src/a.ts" }] }, { id: "prp_n2" }];
    markBatches(queue, b.batchedOf(queue.map((p) => p.id)), 1);
    expect(queue[0]!.batch?.ids).toEqual(["prp_n1", "prp_n2"]);
    expect(queue[1]!.batch).toBeUndefined();
  });

  it("reads the colony's record for the queue, and leaves the queue as it was when the record cannot be read", () => {
    const { sql } = sqlStorage();
    const b = new EscalationBatches(sql);
    for (const id of ["prp_1", "prp_2", "prp_3"]) b.record(id, NETWORK, 10, 1);
    const queue: Array<{ id: Id; batch?: unknown }> = [{ id: "prp_2" }, { id: "prp_3" }];
    expect(markQueueBatches(sql, queue).map((g) => g.ids)).toEqual([["prp_2", "prp_3"]]);
    const broken = { exec: () => { throw new Error("no such table"); } } as unknown as SqlStorage;
    const untouched: Array<{ id: Id; batch?: unknown }> = [{ id: "prp_2" }];
    expect(markQueueBatches(broken, untouched)).toEqual([]);
    expect(untouched).toEqual([{ id: "prp_2" }]);
  });
});

describe("answering a batch", () => {
  type Row = { status: string; approvedAt?: number; mergeHold?: unknown };
  function host(rows: Record<Id, Row>, fail: Id[] = []) {
    const { sql } = sqlStorage();
    const batches = new EscalationBatches(sql);
    for (let i = 0; i < 2; i++) batches.record(`prp_early${i}`, NETWORK, 1 + i, 2);
    const calls: Array<{ id: Id; decision: string; reason: string; by: string; mint: boolean }> = [];
    const h: BatchHost = {
      batches,
      proposal: (id) => rows[id] ?? null,
      decide: async (id, decision, reason, by, mint) => {
        if (fail.includes(id)) throw new Error("proposal is already landed");
        calls.push({ id, decision, reason, by, mint });
        rows[id] = { status: decision === "approve" ? "ready" : "rejected" };
      },
    };
    return { h, batches, calls };
  }

  it("decides each listed change still waiting in the batch, one by one, and says why it left the others", async () => {
    const rows: Record<Id, Row> = {
      prp_n1: { status: "escalated" },
      prp_n2: { status: "escalated" },
      prp_n3: { status: "returned" },
      prp_p1: { status: "escalated" },
      prp_early0: { status: "escalated" },
      prp_held: { status: "escalated", approvedAt: 7, mergeHold: [{ path: "src/a.ts" }] },
    };
    const { h, batches, calls } = host(rows);
    for (const [id, k] of [["prp_n1", NETWORK], ["prp_n2", NETWORK], ["prp_n3", NETWORK], ["prp_p1", PROCESS], ["prp_held", NETWORK]] as const) batches.record(id, k, 10, 2);
    const answer = await answerBatch(h, { key: NETWORK.key, ids: ["prp_n1", "prp_n2", "prp_n3", "prp_p1", "prp_early0", "prp_held", "prp_gone", "prp_n1"], decision: "approve", reason: "", by: "matt" });
    expect(answer.decided).toEqual(["prp_n1", "prp_n2"]);
    expect(answer.skipped).toEqual([
      { id: "prp_n3", why: "it is returned and no longer waits for a person" },
      { id: "prp_p1", why: "not in this batch; decide it on its own card" },
      { id: "prp_early0", why: "not in this batch; decide it on its own card" },
      { id: "prp_held", why: "a person already decided it once (a held merge); decide it on its own card" },
      { id: "prp_gone", why: "not in this batch; decide it on its own card" },
    ]);
    expect(calls).toEqual([
      { id: "prp_n1", decision: "approve", reason: "", by: "matt", mint: true },
      { id: "prp_n2", decision: "approve", reason: "", by: "matt", mint: true },
    ]);
  });

  it("never decides a change that may not be batched, even when it is listed under a batch's key", async () => {
    const rows: Record<Id, Row> = { prp_auth: { status: "escalated" } };
    const { h, batches, calls } = host(rows);
    batches.record("prp_auth", AUTH, 10, 0);
    const answer = await answerBatch(h, { key: AUTH.key, ids: ["prp_auth"], decision: "approve", reason: "", by: "matt" });
    expect(answer).toMatchObject({ decided: [], skipped: [{ id: "prp_auth", why: "not in this batch; decide it on its own card" }] });
    expect(calls).toEqual([]);
  });

  it("a rejection mints one antibody, from the first change it decides; a failed decision is listed, not thrown", async () => {
    const rows: Record<Id, Row> = { prp_n1: { status: "escalated" }, prp_n2: { status: "escalated" }, prp_n3: { status: "escalated" } };
    const { h, batches, calls } = host(rows, ["prp_n1"]);
    for (const id of ["prp_n1", "prp_n2", "prp_n3"]) batches.record(id, NETWORK, 10, 2);
    const answer = await answerBatch(h, { key: NETWORK.key, ids: ["prp_n1", "prp_n2", "prp_n3"], decision: "reject", reason: "No new network calls in the store.", by: "matt" });
    expect(answer.decided).toEqual(["prp_n2", "prp_n3"]);
    expect(answer.skipped).toEqual([{ id: "prp_n1", why: "proposal is already landed" }]);
    expect(calls.map((c) => [c.id, c.mint])).toEqual([
      ["prp_n2", true],
      ["prp_n3", false],
    ]);
  });
});

describe("counting an escalation from the decide engine", () => {
  const colony = { id: "c1" };

  it("does nothing where the flag is off, and counts only the rules the alert budget cannot send back", () => {
    const { sql, db } = sqlStorage();
    const bumps: string[] = [];
    const off = { env: {}, sql, colony: () => colony, bump: (name: string) => void bumps.push(name) };
    expect(recordEscalation(off, "prp_1", "P1 danger pattern", { danger: [hit("capability", "capability:network")] }, 1)).toBeNull();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'decide_batches'").all()).toEqual([]);
    const on = { ...off, env: { FT_ESCALATION_BATCH: "c1" } };
    expect(recordEscalation(on, "prp_1", "R1 detector+damage", {}, 1)).toBeNull();
    expect(recordEscalation(on, "prp_1", "L5 too large", {}, 1)).toEqual({ batched: false, batch: { key: "L5", rule: "L5 too large", label: "were too large for model review", batchable: true } });
    expect(bumps).toEqual([]);
  });

  it("counts a batched one, and leaves a change on its own card when the record fails", () => {
    const { sql } = sqlStorage();
    const bumps: string[] = [];
    const on = { env: { FT_ESCALATION_BATCH: "on" }, sql, colony: () => colony, bump: (name: string) => void bumps.push(name) };
    const b = new EscalationBatches(sql);
    for (let i = 0; i < ESCALATION_BATCH_PER_HOUR; i++) b.record(`prp_${i}`, NETWORK, 1_000 + i);
    expect(recordEscalation(on, "prp_next", "P1 danger pattern", { danger: [hit("capability", "capability:network")] }, 2_000)?.batched).toBe(true);
    expect(recordEscalation(on, "prp_secret", "P1 danger pattern", { danger: [hit("secret", "secret:token-format")] }, 2_001)?.batched).toBe(false);
    expect(bumps).toEqual(["decide.escalations.batched"]);
    const broken = { ...on, sql: { exec: () => { throw new Error("disk full"); } } as unknown as SqlStorage };
    expect(recordEscalation(broken, "prp_more", "L5 too large", {}, 2_002)).toBeNull();
  });
});
