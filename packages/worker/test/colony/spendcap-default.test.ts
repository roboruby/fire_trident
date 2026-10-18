import { describe, expect, it } from "vitest";
import type { ColonyEvent } from "@fire_trident/core";
import { ColonyPause, type SqlRunner } from "../../src/colony/pause.ts";
import { DEFAULT_CAP_BY, SPEND_CAP_ACTOR, SpendCapBook, agentReserve, defaultCapUsd, type SpendCapHost } from "../../src/colony/spendcap.ts";

/**
 * The deployment's default spend cap (FT_DEFAULT_SPEND_CAP, colony/spendcap.ts): a colony with no cap of its own is
 * capped at the default with the same review reserve and the same pause; a person's own cap always wins, and removing it
 * puts the default back. Absent, nothing changes.
 */

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

/** A colony's cap over one storage, with the real pause switch and the deployment's default as `setting`. */
function harness(setting: unknown, sql: SqlRunner = sqlite()) {
  const clock = { now: 1_000_000 };
  const events: ColonyEvent[] = [];
  const pending: Array<Promise<unknown>> = [];
  const state = { book: 0, setting };
  const pause = new ColonyPause({ sql, now: () => clock.now, readDeployment: async () => null, publish: (e) => void events.push(...e), tellWriter: async () => true });
  const host: SpendCapHost = {
    sql,
    now: () => clock.now,
    bookUsd: () => state.book,
    ownPause: () => pause.own(),
    trip: (reason) => pause.pause({ by: SPEND_CAP_ACTOR, reason }),
    lift: (by, reason) => pause.resume({ by, reason }),
    waitUntil: (p) => void pending.push(p),
    defaultUsd: () => defaultCapUsd(state.setting),
  };
  const cap = new SpendCapBook(host);
  return { cap, pause, sql, clock, state, settled: () => Promise.all(pending) };
}

describe("FT_DEFAULT_SPEND_CAP", () => {
  it("reads dollars, and absent, empty, off or unreadable means no default", () => {
    expect(defaultCapUsd("5")).toBe(5);
    expect(defaultCapUsd(" $12.50 ")).toBe(12.5);
    expect(defaultCapUsd(3)).toBe(3);
    for (const v of [undefined, null, "", "off", "OFF", "0", "-1", "five", "2000000"]) expect(defaultCapUsd(v), String(v)).toBeNull();
  });

  it("changes nothing when absent: no cap, nothing held", () => {
    const h = harness(undefined);
    expect(h.cap.state()).toBeNull();
    expect(h.cap.reserve({ use: "agents", usd: 1e6 })).toEqual({ ok: true, hold: null });
  });

  it("caps a colony with no cap of its own, with the same reserve rule, and says it is the default", () => {
    const h = harness("2");
    h.state.book = 0.5;
    expect(h.cap.state()).toEqual({ usd: 2, reviewReserveUsd: 0.2, spentUsd: 0.5, inFlightUsd: 0, state: "open", setBy: DEFAULT_CAP_BY, setAt: 1_000_000, byDefault: true });
    const held = h.cap.reserve({ use: "agents", usd: 0.5 });
    expect(held).toMatchObject({ ok: true });
    expect(h.cap.state()!.inFlightUsd).toBe(0.5);
  });

  it("trips the pause at the agents' share and keeps the reserve for review, as a person's cap does", async () => {
    const h = harness("1");
    h.cap.settle(null, 0.9);
    await h.settled();
    expect(h.pause.own()).toMatchObject({ by: SPEND_CAP_ACTOR, reason: "spend cap: $0.900 of $1.00 spent on model calls this platform made (the deployment's default cap)" });
    expect(h.cap.state()).toMatchObject({ state: "review-only", byDefault: true });
    // Review may still spend the reserve; an agent's call is refused with the pause's sentence.
    expect(h.cap.reserve({ use: "review", usd: 0.05 })).toMatchObject({ ok: true });
    expect(() => agentReserve(h.cap, { model: "@cf/openai/gpt-oss-20b", chars: 30, maxTokens: 1_000, copies: 1 }, (m) => m)).toThrow(/Agents are paused in this colony by platform:spend-cap: spend cap: \$0\.900 of \$1\.00/);
  });

  it("counts calls settled under the default in its own ledger, which survives a restart", () => {
    const sql = sqlite();
    const a = harness("5", sql);
    a.cap.settle(null, 0.75);
    const b = harness("5", sql);
    expect(b.cap.state()).toMatchObject({ spentUsd: 0.75, byDefault: true });
    // A person's cap is untouched by it.
    expect(sql.exec("SELECT COUNT(*) AS n FROM spend_cap").toArray()).toEqual([{ n: 0 }]);
  });

  it("gives way to a person's own cap, above or below it, and comes back when that cap is removed", async () => {
    const h = harness("1");
    h.cap.settle(null, 0.95);
    await h.settled();
    expect(h.pause.own()?.by).toBe(SPEND_CAP_ACTOR);
    // A person raises the colony's cap past the default: theirs wins, and the pause the default tripped is lifted.
    const up = await h.cap.set({ usd: 10, by: "maya" });
    expect(up).toMatchObject({ lifted: true, tripped: false, cap: { usd: 10, setBy: "maya" } });
    expect(up.cap!.byDefault).toBeUndefined();
    expect(h.pause.own()).toBeNull();
    // Below the default works too.
    expect((await h.cap.set({ usd: 0.5, by: "maya" })).tripped).toBe(true);
    // Removing their cap puts the default back; it is reached, so the agents stay paused and the note says what to do.
    const off = await h.cap.clear({ by: "maya" });
    expect(off.lifted).toBe(false);
    expect(off.cap).toMatchObject({ usd: 1, byDefault: true });
    expect(off.note).toMatch(/^The colony's own spend cap is removed: the deployment's default cap of \$1\.00 applies/);
    expect(off.note).toContain("The default cap is reached too, so the agents stay paused");
    expect(h.pause.own()?.by).toBe(SPEND_CAP_ACTOR);
  });

  it("lifts the pause on removal when the default has room", async () => {
    const h = harness("10");
    await h.cap.set({ usd: 1, by: "maya" });
    h.cap.settle(null, 0.95);
    await h.settled();
    expect(h.pause.own()?.by).toBe(SPEND_CAP_ACTOR);
    const off = await h.cap.clear({ by: "maya" });
    expect(off).toMatchObject({ lifted: true, cap: { usd: 10, byDefault: true } });
    expect(h.pause.own()).toBeNull();
  });
});
