import { describe, expect, it } from "vitest";
import type { Id } from "@fire_trident/core";
import { READ_EVERY_MS, SETTLE_MS, SpendBook, counterUsage, dearestModel, journalUsage, meteredAi, meteredClient, modelOfClass, spendCounters } from "../../src/colony/spend.ts";
import type { SpendHost } from "../../src/colony/spend.ts";
import type { SqlRunner } from "../../src/colony/inline.ts";

/** The part of node:sqlite these tests use (the worker compiles against workers types, not Node's). */
interface DatabaseSync {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
}
const SQLITE = "node:sqlite";
const { DatabaseSync } = (await import(SQLITE)) as { DatabaseSync: new (path: string) => DatabaseSync };

const GEMMA = "@cf/google/gemma-4-26b-a4b-it";
const KIMI = "@cf/moonshotai/kimi-k2.7-code";
const GPT = "@cf/openai/gpt-oss-120b";
const CLEF = "@cf/cloudflare/clef";
const NOW = 10_000_000_000;
const DAY = 24 * 60 * 60_000;
const REVIEW = { reflexModel: CLEF, secondOpinionModels: [GEMMA, GPT, "@cf/zai-org/glm-4.7-flash"] };

/** An agent journal as AgentDO.status returns it (the parts the spend book reads). */
type Journal = { running: boolean; model?: string; counters: Record<string, number> };

/** A colony's agent tables (as ColonyDO has them) in memory, a spend book on them, and the journals it reads. */
function colony() {
  const db = new DatabaseSync(":memory:");
  const sql: SqlRunner = {
    exec: (q, ...b) => {
      const rows = db.prepare(q).all(...b);
      return { toArray: () => rows };
    },
  };
  sql.exec(
    `CREATE TABLE agents (id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, model TEXT, thresholds TEXT NOT NULL DEFAULT '{}',
      state TEXT NOT NULL, intent_id TEXT, workspace TEXT, last_seen INTEGER NOT NULL, created_at INTEGER NOT NULL)`,
  );
  sql.exec("CREATE TABLE agent_stops (agent_id TEXT PRIMARY KEY, at INTEGER NOT NULL, reason TEXT NOT NULL)");
  const journals = new Map<Id, Journal | "silent">();
  const reads: Id[] = [];
  const platform: Id[] = [];
  const host: SpendHost = {
    sql,
    readAgent: async (id) => {
      reads.push(id);
      const j = journals.get(id);
      if (j === "silent") return new Promise(() => undefined);
      return j ?? { running: false, counters: {} };
    },
    platformAgents: () => platform,
    resolveModel: (m) => modelOfClass({ FT_DEFAULT_MODEL: KIMI, FT_BULK_MODEL: GEMMA }, m),
    waitUntil: () => undefined,
  };
  const add = (id: Id, a: { kind?: string; model?: string | null; lastSeen?: number; stoppedAt?: number; journal?: Journal | "silent" }): void => {
    sql.exec(
      "INSERT INTO agents (id, kind, name, model, state, last_seen, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      id,
      a.kind ?? "internal",
      id,
      a.model === undefined ? GEMMA : a.model,
      a.stoppedAt ? "dead" : "working",
      a.lastSeen ?? NOW,
      NOW - DAY,
    );
    if (a.stoppedAt) sql.exec("INSERT INTO agent_stops (agent_id, at, reason) VALUES (?, ?, 'demo finished')", id, a.stoppedAt);
    if (a.journal) journals.set(id, a.journal);
  };
  return { book: new SpendBook(host), add, journals, reads, platform, sql };
}

/** Spread `total` over `n` agents: equal shares, the remainder on the last. */
function shares(total: number, n: number): number[] {
  const each = Math.floor(total / n);
  return Array.from({ length: n }, (_, i) => (i === n - 1 ? total - each * (n - 1) : each));
}

describe("journalUsage", () => {
  it("gives the agent's own model the calls its per-model counters do not claim", () => {
    const counters = { llmCalls: 10, tokensIn: 1_000, tokensOut: 100, [`llmCalls:${KIMI}`]: 3, [`tokensIn:${KIMI}`]: 400, [`tokensOut:${KIMI}`]: 40, landed: 4 };
    expect(journalUsage(counters, GEMMA)).toEqual([
      { model: GEMMA, calls: 7, input: 600, output: 60 },
      { model: KIMI, calls: 3, input: 400, output: 40 },
    ]);
  });

  it("is empty for an agent that made no model call, and reads bad counters as none", () => {
    expect(journalUsage({ landed: 3, waits: 2 }, GEMMA)).toEqual([]);
    expect(journalUsage({ tokensIn: -5, tokensOut: Number.NaN }, GEMMA)).toEqual([]);
  });
});

describe("spendCounters and the meters", () => {
  it("names one counter per direction and model, and none for a call without tokens", () => {
    expect(spendCounters("decide.llm", GPT, { input: 120, output: 30 })).toEqual([
      [`decide.llm.tokensIn:${GPT}`, 120],
      [`decide.llm.tokensOut:${GPT}`, 30],
    ]);
    expect(spendCounters("decide.clef", CLEF, { input: 50 })).toEqual([[`decide.clef.tokensIn:${CLEF}`, 50]]);
    expect(spendCounters("resolver", "", { input: 0, output: 0 })).toEqual([]);
    expect(spendCounters("resolver", KIMI, null)).toEqual([]);
  });

  it("counts a Workers AI call's tokens by the model it went to, and passes the answer through", async () => {
    const bumps: Array<[string, number]> = [];
    const answer = { response: "{}", usage: { prompt_tokens: 120, completion_tokens: 30 } };
    const ai = meteredAi({ run: async () => answer }, "decide.antibody", (n, d) => bumps.push([n, d]));
    expect(await ai.run(GPT, { messages: [] })).toBe(answer);
    expect(bumps).toEqual([
      [`decide.antibody.tokensIn:${GPT}`, 120],
      [`decide.antibody.tokensOut:${GPT}`, 30],
    ]);
  });

  it("counts a model client's reply under the model that answered", async () => {
    const bumps: Array<[string, number]> = [];
    const client = meteredClient({ complete: async () => ({ text: "ok", model: KIMI, usage: { input: 9, output: 2, cached: 0, neurons: 0 } }) }, "resolver", (n, d) => bumps.push([n, d]));
    expect((await client.complete({ model: "default", messages: [], maxTokens: 10 })).text).toBe("ok");
    expect(bumps).toEqual([
      [`resolver.tokensIn:${KIMI}`, 9],
      [`resolver.tokensOut:${KIMI}`, 2],
    ]);
  });
});

describe("counterUsage", () => {
  it("prices each per-model counter at its model, and what the aggregates hold beyond them at the layer's configured model", () => {
    const usage = counterUsage(
      {
        // 1,000 second-opinion and judge tokens in from before per-model counting, 100 out; 300 Clef tokens.
        "decide.llm.tokensIn": 1_000 + 2_000 + 500,
        "decide.llm.tokensOut": 100 + 200 + 50,
        [`decide.llm.tokensIn:${GEMMA}`]: 2_000,
        [`decide.llm.tokensOut:${GEMMA}`]: 200,
        [`contest.judge.tokensIn:${GPT}`]: 500,
        [`contest.judge.tokensOut:${GPT}`]: 50,
        "decide.clef.tokens": 300 + 700,
        [`decide.clef.tokensIn:${CLEF}`]: 700,
        [`resolver.tokensIn:${KIMI}`]: 90,
        [`resolver.tokensOut:${KIMI}`]: 9,
        [`decide.antibody.tokensIn:${GPT}`]: 40,
        "decide.llm.throttled": 3,
        intentsLanded: 5,
      },
      REVIEW,
    );
    expect(usage).toEqual(
      expect.arrayContaining([
        { layer: "review", model: GEMMA, input: 2_000, output: 200 },
        { layer: "judge", model: GPT, input: 500, output: 50 },
        { layer: "review", model: CLEF, input: 700, output: 0 },
        { layer: "resolver", model: KIMI, input: 90, output: 9 },
        { layer: "other", model: GPT, input: 40, output: 0 },
        // The older aggregate: at the dearest second-opinion model, and the reflex model.
        { layer: "review", model: GPT, input: 1_000, output: 100 },
        { layer: "review", model: CLEF, input: 300, output: 0 },
      ]),
    );
    expect(usage).toHaveLength(7);
  });

  it("finds nothing in a colony that made no model call", () => {
    expect(counterUsage({ landings: 4, "decide.llm.tokensIn": 0 }, REVIEW)).toEqual([]);
  });

  it("prices the older aggregate at the dearest configured model that has a price", () => {
    expect(dearestModel(REVIEW.secondOpinionModels)).toBe(GPT);
    expect(dearestModel(["@cf/x/unlisted", GEMMA])).toBe(GEMMA);
    expect(dearestModel(["@cf/x/unlisted"])).toBe("@cf/x/unlisted");
  });
});

describe("SpendBook", () => {
  it("prices the round-7 Hono run's agents at the log's $0.0419 from their journals, a day after they stopped", async () => {
    // packages/bench/results/2026-10-14-round7/checks/p21-hono.log: 20 Gemma agents, 275 calls, 227,842 in / 15,467 out;
    // the prerequisite's Kimi agent, 8 calls, 9,230 in / 1,422 out; "model cost estimate: $0.0419"; 283 intents landed.
    const c = colony();
    const [calls, ins, outs] = [shares(275, 20), shares(227_842, 20), shares(15_467, 20)];
    for (let i = 0; i < 20; i++) {
      c.add(`agt_g${i}`, { model: GEMMA, lastSeen: NOW - DAY, stoppedAt: NOW - DAY, journal: { running: false, model: GEMMA, counters: { llmCalls: calls[i]!, tokensIn: ins[i]!, tokensOut: outs[i]!, landed: 14 } } });
    }
    c.add("agt_k", { model: KIMI, lastSeen: NOW - DAY, stoppedAt: NOW - DAY, journal: { running: false, model: KIMI, counters: { llmCalls: 8, tokensIn: 9_230, tokensOut: 1_422, landed: 1 } } });
    const s = await c.book.report(NOW, { metrics: { intentsLanded: 283 }, review: REVIEW });
    expect(s.byLayer.agents.toFixed(4)).toBe("0.0419");
    expect(s.byModel[GEMMA]).toMatchObject({ input: 227_842, output: 15_467 });
    expect(s.byModel[GEMMA]?.usd?.toFixed(4)).toBe("0.0274");
    expect(s.byModel[KIMI]?.usd?.toFixed(4)).toBe("0.0145");
    expect(s.usd.toFixed(4)).toBe("0.0419");
    expect(s.perLandedIntent?.toFixed(4)).toBe("0.0001");
    expect(s.agentsUnread).toBeUndefined();
    expect(c.reads).toHaveLength(21);
    // Stopped and quiet: their journals are final, so later reports read none of them again.
    await c.book.report(NOW + 10 * READ_EVERY_MS, { metrics: { intentsLanded: 283 }, review: REVIEW });
    expect(c.reads).toHaveLength(21);
  });

  it("reads a working agent's journal again at most every READ_EVERY_MS, with calls to a stepped-up model at that model", async () => {
    const c = colony();
    c.add("agt_a", { journal: { running: true, model: GEMMA, counters: { tokensIn: 1_000, tokensOut: 100 } } });
    expect((await c.book.report(NOW, { metrics: {}, review: REVIEW })).byLayer.agents).toBeCloseTo(0.00013, 8);
    c.journals.set("agt_a", { running: true, model: GEMMA, counters: { tokensIn: 2_000, tokensOut: 200, [`tokensIn:${KIMI}`]: 1_000, [`tokensOut:${KIMI}`]: 100 } });
    await c.book.report(NOW + 1_000, { metrics: {}, review: REVIEW });
    expect(c.reads).toHaveLength(1);
    const s = await c.book.report(NOW + READ_EVERY_MS, { metrics: {}, review: REVIEW });
    expect(c.reads).toHaveLength(2);
    expect(s.byModel[GEMMA]).toMatchObject({ input: 1_000, output: 100 });
    expect(s.byModel[KIMI]).toMatchObject({ input: 1_000, output: 100 });
    expect(s.byLayer.agents).toBeCloseTo(0.00013 + 0.00135, 8);
  });

  it("keeps reading a stopped agent until it has been quiet for SETTLE_MS (a call in flight when it stopped may still count)", async () => {
    const c = colony();
    c.add("agt_a", { lastSeen: NOW - 1_000, stoppedAt: NOW - 1_000, journal: { running: false, model: GEMMA, counters: { tokensIn: 10 } } });
    await c.book.report(NOW, { metrics: {}, review: REVIEW });
    await c.book.report(NOW + READ_EVERY_MS, { metrics: {}, review: REVIEW });
    expect(c.reads).toHaveLength(2);
    await c.book.report(NOW + SETTLE_MS + READ_EVERY_MS, { metrics: {}, review: REVIEW });
    expect(c.reads).toHaveLength(3);
    await c.book.report(NOW + SETTLE_MS + 3 * READ_EVERY_MS, { metrics: {}, review: REVIEW });
    expect(c.reads).toHaveLength(3);
  });

  it("reads only agents with a journal: not outside agents, the colony's own, or synthetic ones registered without a model", async () => {
    const c = colony();
    c.add("agt_in", { journal: { running: true, counters: { tokensIn: 5 } } });
    c.add("agt_syn", { kind: "synthetic", model: GEMMA });
    c.add("agt_bench", { kind: "synthetic", model: null });
    c.add("agt_ext", { kind: "external", model: "claude-code" });
    c.add("agt_resolver", { model: KIMI });
    c.platform.push("agt_resolver");
    const s = await c.book.report(NOW, { metrics: {}, review: REVIEW });
    expect(c.reads.sort()).toEqual(["agt_in", "agt_syn"]);
    expect(s.byModel[GEMMA]?.input).toBe(5);
  });

  it("keeps an agent's last read when its journal does not answer, and says how many were never read", async () => {
    const c = colony();
    c.add("agt_a", { journal: { running: true, model: GEMMA, counters: { tokensIn: 100 } } });
    c.add("agt_b", { journal: "silent" });
    const s = await c.book.report(NOW, { metrics: {}, review: REVIEW });
    expect(s.byModel[GEMMA]?.input).toBe(100);
    expect(s.agentsUnread).toBe(1);
    c.journals.set("agt_a", "silent");
    const later = await c.book.report(NOW + READ_EVERY_MS, { metrics: {}, review: REVIEW });
    expect(later.byModel[GEMMA]?.input).toBe(100);
  }, 15_000);

  it("prices the colony's own counters with the agents, over the intents landed", async () => {
    const c = colony();
    const s = await c.book.report(NOW, { metrics: { intentsLanded: 0, [`decide.llm.tokensIn:${GPT}`]: 1_000_000 }, review: REVIEW });
    expect(s.byLayer.review).toBeCloseTo(0.35, 8);
    expect(s.perLandedIntent).toBeNull();
    expect(s.agentsUnread).toBeUndefined();
  });
});
