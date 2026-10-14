import { describe, expect, it } from "vitest";
import { colonySpend, intentSpend } from "@fire_trident/core";
import type { Id } from "@fire_trident/core";
import { SpendBook, modelOfClass } from "../../src/colony/spend.ts";
import type { SpendHost } from "../../src/colony/spend.ts";
import { IntentSpendBook, MAP_CAP, NOT_COUNTING, agentIntentUsage, countIntentCall, intentSpendEnabled, intentSpendMap, intentUsageOf, migrateIntentSpend, reportIntentSpend, storeAgentIntents } from "../../src/colony/intentspend.ts";
import type { SqlRunner } from "../../src/colony/inline.ts";

/**
 * Spend per intent (colony/intentspend.ts): the colony's own calls counted by intent as they happen, the agents' rows
 * stored from their journals, and one intent's report from both, held against the colony's spend.
 */

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
const REVIEW = { reflexModel: CLEF, secondOpinionModels: [GEMMA, GPT] };

function db(): SqlRunner {
  const d = new DatabaseSync(":memory:");
  return {
    exec: (q, ...b) => {
      const rows = d.prepare(q).all(...b);
      return { toArray: () => rows };
    },
  };
}

const resolve = (m: string): string => modelOfClass({ FT_DEFAULT_MODEL: KIMI, FT_BULK_MODEL: GEMMA }, m);

describe("the flag", () => {
  it("reads like FT_REVALIDATE", () => {
    expect(intentSpendEnabled(undefined, "col")).toBe(false);
    expect(intentSpendEnabled("off", "col")).toBe(false);
    expect(intentSpendEnabled("on", "col")).toBe(true);
    expect(intentSpendEnabled("a, col ,b", "col")).toBe(true);
    expect(intentSpendEnabled("a,b", "col")).toBe(false);
  });
});

describe("the colony's own calls", () => {
  it("add up by intent, layer and model, one row each, a call without tokens counting as a call", () => {
    const sql = db();
    migrateIntentSpend(sql);
    countIntentCall(sql, { intentId: "int_1", layer: "review", model: CLEF, usage: { input: 100 }, at: NOW });
    countIntentCall(sql, { intentId: "int_1", layer: "review", model: CLEF, usage: { input: 200 }, at: NOW + 1 });
    countIntentCall(sql, { intentId: "int_1", layer: "judge", model: GPT, usage: { input: 50, output: 10 }, at: NOW + 2 });
    countIntentCall(sql, { intentId: "int_1", layer: "judge", model: GPT, usage: null, at: NOW + 3 });
    countIntentCall(sql, { intentId: "int_2", layer: "review", model: GPT, usage: { input: 10, output: 1 }, at: NOW + 4 });
    expect(intentUsageOf(sql, "int_1")).toEqual([
      { layer: "judge", model: GPT, calls: 2, input: 50, output: 10 },
      { layer: "review", model: CLEF, calls: 2, input: 300, output: 0 },
    ]);
    expect(intentUsageOf(sql, "int_3")).toEqual([]);
  });
});

describe("the agents' rows", () => {
  const status = {
    running: true,
    counters: { llmCalls: 2, tokensIn: 150, tokensOut: 15 },
    intentUsage: [
      { intentId: "int_1", model: "default", calls: 1, input: 100, output: 10, at: NOW - 10 },
      { intentId: "int_1", model: KIMI, calls: 1, input: 50, output: 5, at: NOW - 5 },
      { intentId: "int_2", model: GEMMA, calls: 1, input: 30, output: 3, at: NOW - 20 },
      { intentId: "", model: GEMMA, calls: 1, input: 1, output: 1, at: 0 },
      { intentId: "int_9", model: GEMMA, calls: 0, input: 0, output: 0, at: 0 },
      "junk",
    ],
  };

  it("are read from an agent's status, dropping what does not read as a row, and none from an agent on older code", () => {
    expect(agentIntentUsage(status).map((r) => r.intentId)).toEqual(["int_1", "int_1", "int_2"]);
    expect(agentIntentUsage({ running: true, counters: {} })).toEqual([]);
    expect(agentIntentUsage(null)).toEqual([]);
  });

  it("are stored as last read, a class name priced as the model it names, each read replacing the row it names", () => {
    const sql = db();
    migrateIntentSpend(sql);
    storeAgentIntents(sql, "agt_1", agentIntentUsage(status), resolve, NOW);
    expect(intentUsageOf(sql, "int_1")).toEqual([{ layer: "agents", model: KIMI, calls: 2, input: 150, output: 15 }]);
    expect(intentUsageOf(sql, "int_2")).toEqual([{ layer: "agents", model: GEMMA, calls: 1, input: 30, output: 3 }]);
    // The next read carries the journal's new total for int_1 (and nothing for int_2, whose row stands).
    storeAgentIntents(sql, "agt_1", [{ intentId: "int_1", model: KIMI, calls: 3, input: 400, output: 40, at: NOW }], resolve, NOW + 1);
    expect(intentUsageOf(sql, "int_1")).toEqual([{ layer: "agents", model: KIMI, calls: 3, input: 400, output: 40 }]);
    expect(intentUsageOf(sql, "int_2")).toEqual([{ layer: "agents", model: GEMMA, calls: 1, input: 30, output: 3 }]);
    // Another agent's take of the same intent adds to it.
    storeAgentIntents(sql, "agt_2", [{ intentId: "int_1", model: GEMMA, calls: 1, input: 20, output: 2, at: NOW }], resolve, NOW + 2);
    expect(intentUsageOf(sql, "int_1")).toEqual([
      { layer: "agents", model: GEMMA, calls: 1, input: 20, output: 2 },
      { layer: "agents", model: KIMI, calls: 3, input: 400, output: 40 },
    ]);
  });
});

describe("one intent's report and the listing's map", () => {
  function counted(): SqlRunner {
    const sql = db();
    migrateIntentSpend(sql);
    storeAgentIntents(sql, "agt_1", [{ intentId: "int_1", model: KIMI, calls: 3, input: 400, output: 40, at: NOW - 30 }], resolve, NOW);
    countIntentCall(sql, { intentId: "int_1", layer: "review", model: CLEF, usage: { input: 300 }, at: NOW - 20 });
    countIntentCall(sql, { intentId: "int_1", layer: "judge", model: GPT, usage: { input: 50, output: 10 }, at: NOW - 10 });
    countIntentCall(sql, { intentId: "int_2", layer: "review", model: CLEF, usage: { input: 100 }, at: NOW - 5 });
    return sql;
  }

  it("prices the intent's calls by layer and model", () => {
    const s = reportIntentSpend(counted(), "int_1");
    expect(s.intentId).toBe("int_1");
    expect(s.usd).toBeCloseTo(0.00054 + 0.000072 + 0.000025, 10);
    expect(s.byLayer.agents).toBeCloseTo(0.00054, 10);
    expect(s.byLayer.review).toBeCloseTo(0.000072, 10);
    expect(s.byLayer.judge).toBeCloseTo(0.000025, 10);
    expect(s.calls).toEqual({ agents: 3, review: 1, judge: 1, resolver: 0, other: 0 });
    expect(s.tokens).toEqual({ input: 750, output: 50 });
    expect(Object.keys(s.byModel).sort()).toEqual([CLEF, KIMI, GPT].sort());
  });

  it("answers an intent nothing was counted for with no tokens, even before any table existed", () => {
    const s = reportIntentSpend(db(), "int_x");
    expect(s.tokens).toEqual({ input: 0, output: 0 });
    expect(s.usd).toBe(0);
    expect(s.calls.agents).toBe(0);
  });

  it("lists the most recently active intents first, in their short form, and nothing when nothing was counted", () => {
    const sql = counted();
    const map = intentSpendMap(sql);
    expect(Object.keys(map)).toEqual(["int_1", "int_2"]);
    expect(map["int_1"]).toMatchObject({ byLayer: { agents: { calls: 3 }, review: { calls: 1 }, judge: { calls: 1 } }, tokens: { input: 750, output: 50 } });
    expect(map["int_2"]).toEqual({ usd: 0.000024, byLayer: { review: { usd: 0.000024, calls: 1 } }, tokens: { input: 100, output: 0 } });
    expect(Object.keys(intentSpendMap(sql, 1))).toEqual(["int_2"]);
    expect(intentSpendMap(db())).toEqual({});
    expect(MAP_CAP).toBe(2_000);
  });

  it("gives no intent a prototype's name", () => {
    const sql = db();
    migrateIntentSpend(sql);
    countIntentCall(sql, { intentId: "__proto__", layer: "review", model: CLEF, usage: { input: 100 }, at: NOW });
    const map = intentSpendMap(sql);
    expect(Object.hasOwn(map, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(map)).toBe(Object.prototype);
  });
});

describe("the colony's book", () => {
  it("counts only where the flag covers the colony, and says so beside an intent nothing was counted for", () => {
    const sql = db();
    let on = false;
    const book = new IntentSpendBook(sql, () => on);
    book.count("int_1", "review", CLEF, { input: 100 }, NOW);
    expect(book.report("int_1")).toMatchObject({ intentId: "int_1", usd: 0, tokens: { input: 0, output: 0 }, note: NOT_COUNTING });
    expect(book.map()).toBeNull();
    on = true;
    book.count("int_1", "review", CLEF, { input: 100 }, NOW);
    book.count("int_1", "judge", GPT, { input: 50, output: 10 }, NOW + 1);
    const s = book.report("int_1");
    expect(s.note).toBeUndefined();
    expect(s.calls).toEqual({ agents: 0, review: 1, judge: 1, resolver: 0, other: 0 });
    expect(s.tokens).toEqual({ input: 150, output: 10 });
    expect(Object.keys(book.map() ?? {})).toEqual(["int_1"]);
    // Off again: what was counted still reads, without the note.
    on = false;
    expect(book.report("int_1").note).toBeUndefined();
    expect(book.report("int_2").note).toBe(NOT_COUNTING);
  });

  it("never fails the call it counts for", () => {
    const broken: SqlRunner = {
      exec: () => {
        throw new Error("storage is gone");
      },
    };
    const book = new IntentSpendBook(broken, () => true);
    expect(() => book.count("int_1", "review", CLEF, { input: 100 }, NOW)).not.toThrow();
  });
});

describe("with the spend book", () => {
  /** A colony's agent tables (as ColonyDO has them) in memory, a spend book on them, and the journals it reads. */
  function colony() {
    const sql = db();
    sql.exec(
      `CREATE TABLE agents (id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, model TEXT, thresholds TEXT NOT NULL DEFAULT '{}',
        state TEXT NOT NULL, intent_id TEXT, workspace TEXT, last_seen INTEGER NOT NULL, created_at INTEGER NOT NULL)`,
    );
    sql.exec("CREATE TABLE agent_stops (agent_id TEXT PRIMARY KEY, at INTEGER NOT NULL, reason TEXT NOT NULL)");
    const journals = new Map<Id, unknown>();
    const host: SpendHost = {
      sql,
      readAgent: async (id) => journals.get(id) ?? { running: false, counters: {} },
      platformAgents: () => [],
      resolveModel: resolve,
      waitUntil: () => undefined,
    };
    const add = (id: Id, model: string, journal: unknown): void => {
      sql.exec("INSERT INTO agents (id, kind, name, model, state, last_seen, created_at) VALUES (?, 'internal', ?, ?, 'working', ?, ?)", id, id, model, NOW, NOW - DAY);
      journals.set(id, journal);
    };
    return { sql, book: new SpendBook(host), add };
  }

  it("stores each journal's rows by intent with its totals, so the intents' spend adds up to the agents' layer", async () => {
    const { sql, book, add } = colony();
    // Two Gemma agents: the first took int_1 and int_2, the second int_1 again (a return) with a step-up to "default".
    add(GEMMA.length > 0 ? "agt_1" : "agt_1", GEMMA, {
      running: true,
      model: GEMMA,
      counters: { llmCalls: 3, tokensIn: 1_200, tokensOut: 90 },
      intentUsage: [
        { intentId: "int_1", model: GEMMA, calls: 2, input: 800, output: 60, at: NOW - 100 },
        { intentId: "int_2", model: GEMMA, calls: 1, input: 400, output: 30, at: NOW - 50 },
      ],
    });
    add("agt_2", GEMMA, {
      running: true,
      model: GEMMA,
      counters: { llmCalls: 2, tokensIn: 1_000, tokensOut: 70, [`llmCalls:${KIMI}`]: 1, [`tokensIn:${KIMI}`]: 600, [`tokensOut:${KIMI}`]: 50 },
      intentUsage: [
        { intentId: "int_1", model: GEMMA, calls: 1, input: 400, output: 20, at: NOW - 80 },
        { intentId: "int_1", model: "default", calls: 1, input: 600, output: 50, at: NOW - 70 },
      ],
    });
    const spend = await book.report(NOW, { metrics: { landedIntents: 2 }, review: REVIEW });
    const one = reportIntentSpend(sql, "int_1");
    const two = reportIntentSpend(sql, "int_2");
    expect(one.calls.agents).toBe(4);
    expect(one.byModel[GEMMA]).toEqual({ input: 1_200, output: 80, usd: 0.000144 });
    expect(one.byModel[KIMI]).toEqual({ input: 600, output: 50, usd: 0.00077 });
    expect(two.calls.agents).toBe(1);
    expect(one.usd + two.usd).toBeCloseTo(spend.byLayer.agents, 10);
    expect(one.tokens.input + two.tokens.input).toBe(spend.tokens.input);
    expect(one.tokens.output + two.tokens.output).toBe(spend.tokens.output);
    // The colony's own calls for int_1 are its review layer, beside the agents'.
    countIntentCall(sql, { intentId: "int_1", layer: "review", model: CLEF, usage: { input: 300 }, at: NOW });
    const again = reportIntentSpend(sql, "int_1");
    expect(again.byLayer.review).toBeCloseTo(0.000072, 10);
    expect(again.usd).toBeCloseTo(one.usd + 0.000072, 10);
    expect(colonySpend([{ layer: "review", model: CLEF, input: 300, output: 0 }], 0).usd).toBeCloseTo(0.000072, 10);
  });

  it("reads a journal without per-intent rows (an agent that counted none, or one on older code) as before", async () => {
    const { sql, book, add } = colony();
    add("agt_1", GEMMA, { running: true, model: GEMMA, counters: { llmCalls: 1, tokensIn: 100, tokensOut: 10 } });
    const spend = await book.report(NOW, { metrics: {}, review: REVIEW });
    expect(spend.tokens).toEqual({ input: 100, output: 10 });
    expect(intentSpendMap(sql)).toEqual({});
    expect(intentSpend("int_1", intentUsageOf(sql, "int_1")).tokens).toEqual({ input: 0, output: 0 });
  });
});
