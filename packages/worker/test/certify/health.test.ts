import { describe, expect, it } from "vitest";
import type { CulpritPrecision, Id, TrunkHealth, TrunkHealthMeasured } from "@fire_trident/core";
import { HEALTH_TTL_MS, TrunkHealthBook, culpritPrecision, healthText, holdsOf, quantile, span, trunkHealth } from "../../src/certify/health.ts";
import type { HealthInput, HealthLanding, HealthResult, Hold } from "../../src/certify/health.ts";
import type { SqlRunner } from "../../src/colony/inline.ts";

/**
 * Trunk health (certify/health.ts) from fixtures: a colony that was never red, one red episode fixed by a repair, red that
 * stays over several landings (a failed repair, landings stacked on red, a fix that was no repair), trunk still red at
 * the end of the window, and colonies with no verdict; then the book reading the colony's own tables.
 */

const T = 1_800_000_000_000;
const MIN = 60_000;
/** Minutes after T. */
const m = (x: number): number => T + x * MIN;

const NO_CULPRITS: CulpritPrecision = culpritPrecision([]);

/** Landing i at minute i (sha`i`), carrying `intents`. */
function landing(i: number, intents: Id[] = []): HealthLanding {
  return { id: `lnd_${i}`, trunkSha: `sha${i}`, at: m(i), intentIds: intents };
}

/** A result on landing i's commit, started and recorded at the given minutes. */
function result(i: number, status: HealthResult["status"], start: number, end: number, extra: Partial<HealthResult> = {}): HealthResult {
  return { trunkSha: `sha${i}`, landingId: `lnd_${i}`, status, startedAt: m(start), finishedAt: m(end), ...extra };
}

function input(over: Partial<HealthInput>): HealthInput {
  return {
    results: [],
    landings: [],
    logTrimmed: false,
    repairs: [],
    holds: new Map(),
    spend: () => null,
    culprits: NO_CULPRITS,
    off: null,
    now: m(20),
    ...over,
  };
}

function measured(h: TrunkHealth): TrunkHealthMeasured {
  if (h.status !== "measured") throw new Error(`not measured: ${h.status} ${h.text}`);
  return h;
}

describe("trunk health: red episodes and what they cost", () => {
  it("a colony that was never red: no episode, no time red, every landing certified", () => {
    const landings = Array.from({ length: 10 }, (_, i) => landing(i));
    const h = measured(
      trunkHealth(
        input({
          landings,
          results: [result(2, "green", 2.2, 2.5), result(5, "skipped", 5.2, 5.3, { detail: "the run judged nothing" }), result(9, "green", 9.2, 9.6)],
        }),
      ),
    );
    // The window starts at the landing the oldest result certified: landings 2..9.
    expect(h.window).toEqual({ from: m(2), to: m(20), landings: 8, results: 2 });
    expect(h.episodes).toEqual({ count: 0, open: 0, per100Landings: 0 });
    expect(h.red).toEqual({ ms: 0, share: 0, toGreen: { episodes: 0, p50Ms: null, p90Ms: null, maxMs: null } });
    expect(h.builtOnRed).toEqual({ landings: 0, afterRedKnown: 0, repairs: 0 });
    expect(h.repair).toEqual({ intents: 0, agentMs: 0, held: 0 });
    // Landing 2 was certified 0.5 min after it landed; 3..9 by the green at 9, 9.6 - i minutes after each.
    expect(h.certifiedWithin).toEqual([
      { minutes: 5, landings: 8, certified: 6, share: 0.75 },
      { minutes: 15, landings: 8, certified: 8, share: 1 },
      { minutes: 60, landings: 8, certified: 8, share: 1 },
    ]);
    expect(h.text).toBe("red 0 times in 8 landings, 0 landings built on red");
    expect(h.detail[0]).toBe("Green at every verdict over the 18 min measured (2 results).");
    expect(h.detail).toContain("Certified within 5 min 75% (6/8), 15 min 100% (8/8), 60 min 100% (8/8).");
  });

  it("one episode: from the first red result to the green one, the landings on red, the repair that fixed it", () => {
    // Landing 2 broke the tests (the first-red search's answer); the red result on 3 declared int_r; 4 landed on red;
    // 5 carried the repair and was certified green.
    const landings = [0, 1, 2, 3, 4].map((i) => landing(i)).concat([landing(5, ["int_r"]), landing(6)]);
    const holds = new Map<Id, Hold>([["int_r", { closedMs: 1.5 * MIN, since: null }]]);
    const spent: Id[][] = [];
    const h = measured(
      trunkHealth(
        input({
          landings,
          results: [
            result(1, "green", 1.2, 1.5),
            result(3, "red", 3.2, 3.5, { repairIntentId: "int_r", firstRed: { trunkSha: "sha2", landingId: "lnd_2" } }),
            { trunkSha: "shaX", landingId: null, status: "error", startedAt: m(4.1), finishedAt: m(4.2), detail: "out of time" },
            result(4, "red", 4.3, 4.5),
            result(5, "green", 5.2, 5.5),
          ],
          repairs: [{ id: "int_r", at: m(3.5) }],
          holds,
          spend: (ids) => {
            spent.push(ids);
            return { usd: 0.0123, calls: 3, intents: 1 };
          },
          now: m(10),
        }),
      ),
    );
    expect(h.episodes).toEqual({ count: 1, open: 0, per100Landings: 16.67 });
    expect(h.red.ms).toBe(2 * MIN);
    expect(h.red.toGreen).toEqual({ episodes: 1, p50Ms: 2 * MIN, p90Ms: 2 * MIN, maxMs: 2 * MIN });
    expect(h.red.since).toBeUndefined();
    // 3 and 4 have a red parent (2 and 3); 4 landed after the red result was recorded; 5 is the fix.
    expect(h.builtOnRed).toEqual({ landings: 2, afterRedKnown: 1, repairs: 1 });
    expect(h.repair).toEqual({ intents: 1, agentMs: 1.5 * MIN, held: 0, spend: { usd: 0.0123, calls: 3, intents: 1 } });
    expect(spent).toEqual([["int_r"]]);
    expect(h.text).toBe("red 1 time in 6 landings, 2.0 min to green at p50, 2 landings built on red");
    expect(h.detail).toEqual([
      "Red for 2.0 min of the 9.0 min measured (22.2%); to green at p50 2.0 min, p90 2.0 min, longest 2.0 min over 1 episode.",
      "Built on red: 2 landings besides the fixes, 1 of them after trunk was known red; 1 fix (a repair intent, or the commit that turned trunk green).",
      "Repairs: 1 intent held by agents for 1.5 min; their model calls cost $0.012 (3 calls).",
      // Landing 6 has had 4 minutes and no green includes it yet: it counts for no bound.
      "Certified within 5 min 100% (5/5), 15 min 100% (5/5), 60 min 100% (5/5).",
    ]);
  });

  it("red over several landings: a repair that did not fix it, landings stacked on red, and a fix that was no repair", () => {
    // Episode 1: 2 broke it; red on 3; 4 a repair that did not fix it (red again on 5); 6 stacked on red; 7 the second
    // repair, which fixed it; 8 landed on the fixed trunk, and the green run (on 8) came after both.
    // Episode 2: red on 10 (no first-red answer); 11 stacked on red; 12 turned it green with no repair intent.
    const landings = [0, 1, 2, 3].map((i) => landing(i)).concat([landing(4, ["int_r1"]), landing(5), landing(6), landing(7, ["int_r2"]), landing(8), landing(9), landing(10), landing(11), landing(12)]);
    const h = measured(
      trunkHealth(
        input({
          landings,
          results: [
            result(1, "green", 1.2, 1.5),
            result(3, "red", 3.2, 3.5, { repairIntentId: "int_r1", firstRed: { trunkSha: "sha2", landingId: "lnd_2" } }),
            result(5, "red", 5.2, 5.5, { repairIntentId: "int_r2" }),
            result(8, "green", 8.2, 9.5),
            result(10, "red", 10.2, 10.5),
            result(12, "green", 12.2, 14.5),
          ],
          now: m(20),
        }),
      ),
    );
    expect(h.episodes.count).toBe(2);
    expect(h.episodes.per100Landings).toBe(16.67);
    expect(h.red.ms).toBe(10 * MIN);
    expect(h.red.toGreen).toEqual({ episodes: 2, p50Ms: 5 * MIN, p90Ms: 5.8 * MIN, maxMs: 6 * MIN });
    // On red: 3, 5, 6 (stacked: 5 and 6 after the red result) and 11 (after it); fixes: 4, 7 (repairs) and 12 (green).
    expect(h.builtOnRed).toEqual({ landings: 4, afterRedKnown: 3, repairs: 3 });
    expect(h.repair.intents).toBe(2);
    expect(h.text).toBe("red 2 times in 12 landings, 5.0 min to green at p50, 4 landings built on red");
    expect(h.detail[1]).toBe("Built on red: 4 landings besides the fixes, 3 of them after trunk was known red; 3 fixes (a repair intent, or the commit that turned trunk green).");
  });

  it("still red at the end of the window: red until now, the landings after it, the repair held now", () => {
    // Red on 3 with no green after it; 4 and 5 stacked on red; 6 carried the repair (not certified yet); 7 came after it.
    const landings = [landing(0), landing(1), landing(2), landing(3), landing(4), landing(5), landing(6, ["int_r"]), landing(7)];
    const holds = holdsOf([
      { intentId: "int_r", status: "open", at: m(3.5) },
      { intentId: "int_r", status: "claimed", at: m(4) },
      { intentId: "int_r", status: "open", at: m(5) },
      { intentId: "int_r", status: "claimed", at: m(5.5) },
      { intentId: "int_r", status: "proposed", at: m(6) },
    ]);
    const h = measured(
      trunkHealth(
        input({
          landings,
          results: [result(1, "green", 1.2, 1.5), result(3, "red", 3.2, 3.5, { repairIntentId: "int_r" })],
          holds,
          now: m(10),
        }),
      ),
    );
    expect(h.episodes).toEqual({ count: 1, open: 1, per100Landings: 14.29 });
    expect(h.red.since).toBe(m(3.5));
    expect(h.red.ms).toBe(6.5 * MIN);
    expect(h.red.share).toBe(0.7222);
    expect(h.red.toGreen.episodes).toBe(0);
    expect(h.builtOnRed).toEqual({ landings: 2, afterRedKnown: 2, repairs: 1 });
    // Held 4..5 and from 5.5 on: 1 + 4.5 minutes, one hold open now.
    expect(h.repair).toEqual({ intents: 1, agentMs: 5.5 * MIN, held: 1 });
    // Landings 1..7: 1 was certified; the others have had 3 to 9 minutes and no green includes them.
    expect(h.certifiedWithin[0]).toEqual({ minutes: 5, landings: 4, certified: 1, share: 0.25 });
    expect(h.certifiedWithin[1]).toEqual({ minutes: 15, landings: 1, certified: 1, share: 1 });
    expect(h.text).toBe("red 1 time in 7 landings, red now for 6.5 min, 2 landings built on red");
  });

  it("a window the landing log trimmed starts at its oldest landing; an episode that ended before it is left out", () => {
    const landings = [10, 11, 12, 13].map((i) => landing(i));
    const h = measured(
      trunkHealth(
        input({
          landings,
          logTrimmed: true,
          results: [result(1, "green", 1, 1.5), result(2, "red", 2, 2.5), result(3, "green", 3, 4), result(12, "green", 12.2, 12.5)],
          now: m(14),
        }),
      ),
    );
    expect(h.window.from).toBe(m(10));
    expect(h.episodes.count).toBe(0);
    expect(h.window.landings).toBe(4);
  });

  it("says why instead of zeros: no test this platform can run, certification off, no verdict yet", () => {
    const none = trunkHealth(input({ landings: [landing(0)], results: [result(0, "skipped", 0.2, 0.3, { detail: "no test files (*.test.ts or *.test.js)" })] }));
    expect(none).toEqual({ status: "no-tests", reason: "no test files (*.test.ts or *.test.js)", text: "trunk health not measured: certification found no test this platform can run" });
    expect(trunkHealth(input({ results: [result(0, "skipped", 0.2, 0.3, { detail: "no test file imports node:test (3 test files)" })] })).status).toBe("no-tests");
    expect(trunkHealth(input({ off: "trunk certification is off for this colony" }))).toEqual({
      status: "off",
      reason: "trunk certification is off for this colony",
      text: "trunk health not measured: trunk certification is off for this colony",
    });
    expect(trunkHealth(input({}))).toMatchObject({ status: "none", text: "trunk health not measured yet: no certification has judged trunk" });
    expect(trunkHealth(input({ results: [result(0, "error", 0.2, 0.3, { detail: "out of time." })] }))).toMatchObject({
      status: "none",
      reason: "the last certification could not run (out of time)",
    });
    // Off now, with verdicts kept: measured over them, and it says the numbers end at the last result.
    const off = measured(trunkHealth(input({ landings: [landing(0)], results: [result(0, "green", 0.2, 0.5)], off: "trunk certification is off for this colony" })));
    expect(off.detail.at(-1)).toBe("Certification does not run now (trunk certification is off for this colony): these numbers end at its last result.");
  });
});

describe("trunk health: its parts", () => {
  it("culprit precision follows definition 15: each first-red answer by where its landing stood among the suspects", () => {
    const found = (landingId: string, extra: Record<string, unknown> = {}) => ({ status: "found", landingId, ...extra });
    const c = culpritPrecision([
      { status: "red", suspects: [{ landingId: "lnd_1", proposalId: "prp_1" }], firstRed: found("lnd_1", { proposals: [], isolated: { status: "isolated", culprit: { id: "prp_1" } } }) },
      { status: "red", suspects: [{ landingId: "lnd_9" }, { landingId: "lnd_2" }], firstRed: found("lnd_2", { reusedFrom: "abc" }) },
      { status: "red", suspects: [{ landingId: "lnd_9" }], firstRed: found("lnd_3", { proposals: [] }) },
      { status: "red", firstRed: found("lnd_4", { proposals: [{ id: "p" }] }) },
      { status: "red", suspects: [{ landingId: "lnd_9" }], firstRed: found("lnd_5") },
      { status: "red", suspects: [{ landingId: "lnd_9" }], firstRed: found("lnd_6", { proposals: [{ id: "p" }] }) },
      { status: "red", firstRed: { status: "inconclusive" } },
      { status: "green", firstRed: found("lnd_7") },
    ]);
    expect(c).toEqual({ answers: 6, suspect: 2, rank1: 1, outsideImportTrace: 1, notLookedFor: 1, closureNotRecorded: 1, cutByLimit: 1, precision: 0.3333, reused: 1, isolated: { answers: 1, suspect: 1 } });
  });

  it("holds run from claimed or proposed to any other status, and one still going stays open", () => {
    const h = holdsOf([
      { intentId: "a", status: "open", at: 0 },
      { intentId: "a", status: "claimed", at: 10 },
      { intentId: "a", status: "proposed", at: 15 },
      { intentId: "a", status: "landed", at: 40 },
      { intentId: "b", status: "claimed", at: 20 },
    ]);
    expect(h.get("a")).toEqual({ closedMs: 30, since: null });
    expect(h.get("b")).toEqual({ closedMs: 0, since: 20 });
  });

  it("words: durations, quantiles and the line", () => {
    expect([30_000, 204_000, 720_000, 9_000_000, 300_000_000].map(span)).toEqual(["30 s", "3.4 min", "12 min", "2.5 h", "3.5 d"]);
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([], 0.5)).toBeNull();
    const h = measured(trunkHealth(input({ landings: [landing(0)], results: [result(0, "green", 0.2, 0.5)] })));
    expect(healthText({ ...h, episodes: { count: 2, open: 0, per100Landings: 0.5 }, window: { ...h.window, landings: 400 }, red: { ...h.red, toGreen: { episodes: 2, p50Ms: 204_000, p90Ms: 204_000, maxMs: 204_000 } } })).toBe(
      "red 2 times in 400 landings, 3.4 min to green at p50, 0 landings built on red",
    );
  });
});

/** The part of node:sqlite these tests use (the worker compiles against workers types, not Node's). */
interface DatabaseSync {
  prepare(sql: string): { all(...params: unknown[]): unknown[]; run(...params: unknown[]): unknown };
  exec(sql: string): void;
}
const SQLITE = "node:sqlite";
const { DatabaseSync } = (await import(SQLITE)) as { DatabaseSync: new (path: string) => DatabaseSync };

/** A colony's tables as ColonyDO and the certifier make them, with the columns trunk health reads. */
function colonyTables() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE landings (id TEXT PRIMARY KEY, at INTEGER NOT NULL, received_at INTEGER NOT NULL, trunk_sha TEXT NOT NULL, data TEXT NOT NULL)");
  db.exec("CREATE TABLE certifications (trunk_sha TEXT PRIMARY KEY, landing_id TEXT, status TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER, inputs TEXT, test_key TEXT, data TEXT NOT NULL)");
  db.exec("CREATE TABLE certify_repairs (intent_id TEXT PRIMARY KEY, trunk_sha TEXT NOT NULL, state TEXT NOT NULL, at INTEGER NOT NULL, owed TEXT NOT NULL, lost TEXT NOT NULL)");
  db.exec("CREATE TABLE intents (id TEXT PRIMARY KEY, status TEXT NOT NULL, updated_at INTEGER NOT NULL)");
  db.exec("CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, t TEXT NOT NULL, data TEXT NOT NULL)");
  let reads = 0;
  let landingRows = 0;
  const sql: SqlRunner = {
    exec(query: string, ...bindings: unknown[]) {
      if (/FROM events/.test(query)) reads++;
      const rows = db.prepare(query).all(...bindings);
      if (/FROM landings WHERE rowid >/.test(query)) landingRows += rows.length;
      return { toArray: () => rows };
    },
  };
  const land = (i: number, intentIds: Id[] = []) =>
    db.prepare("INSERT INTO landings (id, at, received_at, trunk_sha, data) VALUES (?, ?, ?, ?, ?)").run(`lnd_${i}`, m(i), m(i), `sha${i}`, JSON.stringify({ id: `lnd_${i}`, trunkSha: `sha${i}`, parentSha: `sha${i - 1}`, intentIds, paths: ["src/a.ts"], at: m(i) }));
  const certify = (i: number, status: string, start: number, end: number, extra: Record<string, unknown> = {}) =>
    db
      .prepare("INSERT INTO certifications (trunk_sha, landing_id, status, started_at, finished_at, data) VALUES (?, ?, ?, ?, ?, ?)")
      .run(`sha${i}`, `lnd_${i}`, status, m(start), m(end), JSON.stringify({ trunkSha: `sha${i}`, landingId: `lnd_${i}`, status, startedAt: m(start), finishedAt: m(end), ...extra }));
  const event = (at: number, data: Record<string, unknown>) => db.prepare("INSERT INTO events (at, t, data) VALUES (?, ?, ?)").run(m(at), String(data.t), JSON.stringify({ at: m(at), ...data }));
  return { db, sql, land, certify, event, reads: () => reads, landingRows: () => landingRows };
}

describe("trunk health: the book over the colony's tables", () => {
  it("reads results, landings, repairs and the record, and reads them again only when they change", () => {
    const t = colonyTables();
    for (const i of [0, 1, 2, 3]) t.land(i);
    t.land(4, ["int_r"]);
    t.certify(1, "green", 1.2, 1.5);
    t.certify(3, "red", 3.2, 3.5, {
      repairIntentId: "int_r",
      suspects: [{ landingId: "lnd_2", paths: ["src/a.ts"], files: ["test/a.test.ts"], at: m(2) }],
      firstRed: { status: "found", trunkSha: "sha2", landingId: "lnd_2", proposals: [{ id: "prp_2", paths: ["src/a.ts"] }], probes: 2, ms: 10 },
    });
    t.db.prepare("INSERT INTO certify_repairs (intent_id, trunk_sha, state, at, owed, lost) VALUES (?, ?, ?, ?, ?, ?)").run("int_r", "sha3", "pending", m(3.5), "[]", "[]");
    t.db.prepare("INSERT INTO intents (id, status, updated_at) VALUES (?, ?, ?)").run("int_r", "claimed", m(3.6));
    t.event(3.5, { t: "intent", intentId: "int_r", status: "open" });
    t.event(3.6, { t: "intent", intentId: "int_r", status: "claimed" });
    t.event(3.7, { t: "intent", intentId: "int_other", status: "claimed" });
    const book = new TrunkHealthBook({ sql: t.sql, off: () => null, spend: () => null, landingsKept: 1_000 });

    let h = measured(book.report(m(5)));
    expect(h.episodes).toMatchObject({ count: 1, open: 1 });
    expect(h.builtOnRed).toEqual({ landings: 1, afterRedKnown: 0, repairs: 1 });
    expect(h.repair).toEqual({ intents: 1, agentMs: 1.4 * MIN, held: 1 });
    expect(h.culprits).toMatchObject({ answers: 1, suspect: 1, rank1: 1, precision: 1 });
    expect(t.reads()).toBe(1);

    // Nothing changed: the record is not read again, and the open hold grows with the clock.
    h = measured(book.report(m(6)));
    expect(h.repair.agentMs).toBe(2.4 * MIN);
    expect(t.reads()).toBe(1);

    // The repair landed and the green run recorded it: read again.
    t.event(5.5, { t: "intent", intentId: "int_r", status: "landed" });
    t.db.prepare("UPDATE intents SET status = 'landed', updated_at = ? WHERE id = 'int_r'").run(m(5.5));
    t.certify(4, "green", 5.6, 6);
    h = measured(book.report(m(6) + HEALTH_TTL_MS - 1));
    expect(t.reads()).toBe(2);
    expect(h.episodes).toMatchObject({ count: 1, open: 0 });
    expect(h.repair).toEqual({ intents: 1, agentMs: 1.9 * MIN, held: 0 });
    expect(h.text).toBe("red 1 time in 4 landings, 2.5 min to green at p50, 1 landing built on red");
  });

  it("reads only the landings added since the last call, and drops the ones the log trimmed", () => {
    const t = colonyTables();
    for (const i of [0, 1, 2]) t.land(i);
    t.certify(0, "green", 0.2, 0.5);
    const book = new TrunkHealthBook({ sql: t.sql, off: () => null, spend: () => null, landingsKept: 3 });
    expect(measured(book.report(m(5))).window).toMatchObject({ from: m(0), landings: 3 });
    expect(t.landingRows()).toBe(3);
    t.db.prepare("DELETE FROM landings WHERE id = 'lnd_0'").run();
    t.land(3);
    // The log is at its cap (3) and no longer holds the oldest result's landing: the window starts at its oldest landing.
    expect(measured(book.report(m(6))).window).toMatchObject({ from: m(1), landings: 3 });
    expect(t.landingRows()).toBe(4);
    expect(measured(book.report(m(7))).window.landings).toBe(3);
    expect(t.landingRows()).toBe(4);
  });

  it("answers without the repair record or the event record", () => {
    const t = colonyTables();
    t.db.exec("DROP TABLE certify_repairs");
    t.db.exec("DROP TABLE events");
    t.land(0);
    t.certify(0, "red", 0.2, 0.5, { repairIntentId: "int_r" });
    const h = measured(new TrunkHealthBook({ sql: t.sql, off: () => null, spend: () => null, landingsKept: 1_000 }).report(m(2)));
    expect(h.repair).toEqual({ intents: 1, agentMs: 0, held: 0 });
  });
});
