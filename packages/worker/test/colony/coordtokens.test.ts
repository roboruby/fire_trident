import { describe, expect, it } from "vitest";
import {
  COORD_AGENTS,
  COORD_EVERYTHING,
  COORD_HEADS_UPS,
  COORD_HEADS_UP_CHARS,
  COORD_TAKES,
  CoordMeter,
  READ_EVERY_MS,
  agentBucket,
  bucketMetric,
  charsOf,
  coordTokensReport,
  headsUpBumps,
  partMetric,
  takeBumps,
  type SqlRunner,
} from "../../src/colony/coordtokens.ts";

/** The part of node:sqlite these tests use (the worker compiles against workers types, not Node's). */
interface DatabaseSync {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
}
const SQLITE = "node:sqlite";
const { DatabaseSync } = (await import(SQLITE)) as { DatabaseSync: new (path: string) => DatabaseSync };

function sqlite(): SqlRunner {
  const db = new DatabaseSync(":memory:");
  return {
    exec: (q, ...b) => {
      const rows = db.prepare(q).all(...(b as never[]));
      return { toArray: () => rows };
    },
  };
}

/** The colony's agents and intents tables, as far as the meter reads them, with three agents and two landed intents. */
function colonyTables(guide = false): SqlRunner {
  const sql = sqlite();
  sql.exec("CREATE TABLE agents (id TEXT PRIMARY KEY, state TEXT NOT NULL)");
  sql.exec("CREATE TABLE intents (id TEXT PRIMARY KEY, why TEXT NOT NULL, status TEXT NOT NULL)");
  sql.exec("INSERT INTO agents (id, state) VALUES ('a1', 'working'), ('a2', 'idle'), ('a3', 'waiting'), ('a4', 'dead')");
  sql.exec("INSERT INTO intents (id, why, status) VALUES ('i1', ?, 'landed'), ('i2', ?, 'landed'), ('i3', ?, 'open')", "x".repeat(100), "y".repeat(50), "z".repeat(1000));
  if (guide) {
    sql.exec("CREATE TABLE guide_lessons (id TEXT PRIMARY KEY, status TEXT NOT NULL, data TEXT NOT NULL)");
    sql.exec("INSERT INTO guide_lessons (id, status, data) VALUES ('l1', 'active', ?), ('l2', 'retired', ?)", JSON.stringify({ text: "t".repeat(40) }), JSON.stringify({ text: "r".repeat(900) }));
  }
  return sql;
}

const toMap = (bumps: Array<[string, number]>, into: Record<string, number> = {}): Record<string, number> => {
  for (const [name, delta] of bumps) into[name] = (into[name] ?? 0) + delta;
  return into;
};

describe("coordination tokens: the counters of one take", () => {
  it("measures each part as the characters of its JSON, and nothing for a part the take did not carry", () => {
    expect(charsOf(undefined)).toBe(0);
    expect(charsOf(null)).toBe(0);
    expect(charsOf({ a: "bc" })).toBe(10);
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(charsOf(loop)).toBe(0);
    const context = [{ landingId: "lnd_1", why: "because" }];
    const review = { antibodies: [{ question: "Is this wanted?" }] };
    const m = toMap(takeBumps({ context, review }, { agents: 5, everything: 1_200 }));
    expect(m[COORD_TAKES]).toBe(1);
    expect(m[partMetric("context")]).toBe(JSON.stringify(context).length);
    expect(m[partMetric("review")]).toBe(JSON.stringify(review).length);
    expect(m[partMetric("guide")]).toBeUndefined();
    expect(m[partMetric("lastReturn")]).toBeUndefined();
    expect(m[COORD_AGENTS]).toBe(5);
    expect(m[COORD_EVERYTHING]).toBe(1_200);
    // Five agents fall in the 4-7 bucket.
    expect(m[bucketMetric(4, "takes")]).toBe(1);
    expect(m[bucketMetric(4, "chars")]).toBe(JSON.stringify(context).length + JSON.stringify(review).length);
    expect(m[bucketMetric(4, "everything")]).toBe(1_200);
  });

  it("buckets active agents by powers of two", () => {
    expect([0, 1, 2, 3, 4, 7, 8, 20, 80, 5_000].map(agentBucket)).toEqual([1, 1, 2, 2, 4, 4, 8, 16, 64, 4_096]);
    expect(agentBucket(Number.NaN)).toBe(1);
  });

  it("counts a heads-up only when it has something to say", () => {
    expect(headsUpBumps(null)).toEqual([]);
    const report = { moved: [{ landingId: "lnd_1", at: 1, title: "t", paths: ["src/a.ts"] }], ahead: [] };
    expect(headsUpBumps(report)).toEqual([
      [COORD_HEADS_UPS, 1],
      [COORD_HEADS_UP_CHARS, JSON.stringify(report).length],
    ]);
  });
});

describe("coordination tokens: the meter", () => {
  it("reads the active agents and every landed why and active lesson, and reuses that read for a while", () => {
    const sql = colonyTables(true);
    let now = 1_000;
    const meter = new CoordMeter({ sql, now: () => now });
    const first = toMap(meter.take({ guide: { lessons: [] } }));
    expect(first[COORD_AGENTS]).toBe(3);
    // 100 + 50 characters of landed whys, and the one active lesson's 40.
    expect(first[COORD_EVERYTHING]).toBe(190);
    expect(first[bucketMetric(2, "takes")]).toBe(1);
    sql.exec("INSERT INTO agents (id, state) VALUES ('a5', 'idle'), ('a6', 'idle')");
    now += READ_EVERY_MS - 1;
    expect(toMap(meter.take({}))[COORD_AGENTS]).toBe(3);
    now += 1;
    const later = toMap(meter.take({}));
    expect(later[COORD_AGENTS]).toBe(5);
    expect(later[bucketMetric(4, "takes")]).toBe(1);
  });

  it("counts no lessons where the guide has no table, and never throws", () => {
    const meter = new CoordMeter({ sql: colonyTables(false), now: () => 0 });
    expect(toMap(meter.take({}))[COORD_EVERYTHING]).toBe(150);
    const broken: SqlRunner = {
      exec: () => {
        throw new Error("storage gone");
      },
    };
    const m = toMap(new CoordMeter({ sql: broken, now: () => 0 }).take({ lastReturn: { reason: "stale" } }));
    expect(m[COORD_TAKES]).toBe(1);
    expect(m[COORD_AGENTS]).toBeUndefined();
    expect(m[bucketMetric(1, "takes")]).toBe(1);
  });
});

describe("coordination tokens: the metrics report", () => {
  it("is absent before the first counted take", () => {
    expect(coordTokensReport({ takes: 4 })).toBeUndefined();
  });

  it("gives tokens per take (characters / 4) per part, at take and with the heads-up, and per bucket of active agents", () => {
    const metrics = toMap([
      ...takeBumps({ context: "c".repeat(398), lastReturn: "r".repeat(198) }, { agents: 2, everything: 4_000 }),
      ...takeBumps({ context: "c".repeat(198) }, { agents: 3, everything: 6_000 }),
      ...takeBumps({ context: "c".repeat(398), guide: "g".repeat(798) }, { agents: 9, everything: 40_000 }),
      ...headsUpBumps({ moved: "m".repeat(1_188) }),
    ]);
    const r = coordTokensReport({ ...metrics, takes: 3 });
    expect(r).toBeDefined();
    expect(r?.estimate).toContain("characters / 4");
    expect(r?.takes).toBe(3);
    // context: 400 + 200 + 400 characters (JSON strings carry two quotes) over 3 takes is 83.3 tokens a take.
    expect(r?.perTake).toEqual({ context: 83.3, guide: 66.7, lastReturn: 16.7, review: 0, headsUp: 100 });
    expect(r?.atTakeTokensPerTake).toBe(166.7);
    expect(r?.tokensPerTake).toBe(266.7);
    expect(r?.readEverythingTokensPerTake).toBe(4_166.7);
    expect(r?.agentsPerTake).toBe(4.7);
    expect(r?.byAgents).toEqual([
      { from: 2, to: 3, takes: 2, tokensPerTake: 100, readEverythingTokensPerTake: 1_250 },
      { from: 8, to: 15, takes: 1, tokensPerTake: 300, readEverythingTokensPerTake: 10_000 },
    ]);
  });
});
