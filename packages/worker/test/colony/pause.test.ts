import { describe, expect, it } from "vitest";
import type { ColonyEvent } from "@fire_trident/core";
import { about } from "../../src/front/about.ts";
import {
  ColonyPause,
  DEPLOYMENT_PAUSE_TTL_MS,
  PAUSED_STATUS,
  cleanReason,
  isPauseRefusal,
  laneHold,
  pausedIn,
  pausedSentence,
  refuseWhilePaused,
  type PauseHost,
  type SqlRunner,
  type WriterPause,
} from "../../src/colony/pause.ts";
import { cyclePause, keepPause, newerPause, parseWriterPause, storedPause } from "../../src/trunk/pause.ts";

/** The part of node:sqlite these tests use (the worker compiles against workers types, not Node's). */
interface DatabaseSync {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
}
const SQLITE = "node:sqlite";
const { DatabaseSync } = (await import(SQLITE)) as { DatabaseSync: new (path: string) => DatabaseSync };

function sqlite(): SqlRunner {
  const db = new DatabaseSync(":memory:");
  // Run at once, as a Durable Object's storage does.
  return {
    exec: (q, ...b) => {
      const rows = db.prepare(q).all(...(b as never[]));
      return { toArray: () => rows };
    },
  };
}

/** A colony's switch over its own storage, with a registry marker and a trunk writer the test reads. */
function harness(sql: SqlRunner = sqlite()) {
  const clock = { now: 1_000_000 };
  const events: ColonyEvent[] = [];
  const writer: WriterPause[] = [];
  const registry = { raw: null as string | null, reads: 0, fail: false };
  const host: PauseHost = {
    sql,
    now: () => clock.now,
    readDeployment: async () => {
      registry.reads++;
      if (registry.fail) throw new Error("registry unreachable");
      return registry.raw;
    },
    publish: (e) => void events.push(...e),
    tellWriter: async (r) => {
      writer.push(r);
      return true;
    },
  };
  return { sw: new ColonyPause(host), sql, clock, events, writer, registry, host };
}

const SENTENCE = "Agents are paused in this colony by maya: demo reset. Reads still work; wait for a person to resume.";

describe("the pause sentence", () => {
  it("says who paused and why, and what to do", () => {
    expect(pausedSentence({ by: "maya", reason: "demo reset" })).toBe(SENTENCE);
    expect(pausedSentence({ by: "maya", reason: "demo reset." })).toBe(SENTENCE);
    expect(pausedSentence({ by: "maya", reason: "why now?" })).toBe("Agents are paused in this colony by maya: why now? Reads still work; wait for a person to resume.");
    expect(pausedSentence({ by: "", reason: "" })).toBe("Agents are paused in this colony by unknown: no reason given. Reads still work; wait for a person to resume.");
  });

  it("keeps a reason on one line, short, with secret-looking text masked", () => {
    expect(cleanReason("first\nsecond\u0007 third")).toBe("first second third");
    expect(cleanReason("x".repeat(400))).toHaveLength(300);
    expect(cleanReason("token ghp_0123456789abcdefghijklmnopqrstuvwxyzAB leaked")).not.toContain("ghp_0123456789");
  });

  it("tells a pause's refusal from other errors, across RPC", () => {
    expect(isPauseRefusal(new Error(`[ft:${PAUSED_STATUS}] ${SENTENCE}`))).toBe(true);
    expect(isPauseRefusal(new Error("[ft:409] intent revised: take again"))).toBe(false);
    expect(isPauseRefusal(new Error(SENTENCE))).toBe(false);
  });
});

describe("a colony's switch", () => {
  it("pauses with a reason, stands when paused again, refuses writes, and resumes", async () => {
    const h = harness();
    await expect(h.sw.pause({ by: "maya", reason: "  " })).rejects.toThrow(/a reason is required/);
    const first = await h.sw.pause({ by: "maya", reason: "demo reset" });
    expect(first).toEqual({ pause: { scope: "colony", by: "maya", reason: "demo reset", at: 1_000_000 }, already: false, writer: true });
    h.clock.now += 10;
    expect(await h.sw.pause({ by: "lee", reason: "other" })).toEqual({ pause: first.pause, already: true });
    await expect(h.sw.refuse()).rejects.toThrow(`[ft:409] ${SENTENCE}`);
    expect(await h.sw.view()).toEqual({ paused: true, pauses: [first.pause], refusal: SENTENCE });
    expect(h.writer).toEqual([{ paused: true, by: "maya", reason: "demo reset", at: 1_000_000 }]);

    h.clock.now += 10;
    const back = await h.sw.resume({ by: "maya" });
    expect(back).toEqual({ resumed: { scope: "colony", paused: false, by: "maya", reason: "", at: 1_000_020, pausedAt: 1_000_000 }, already: false, pauses: [], writer: true });
    await expect(h.sw.refuse()).resolves.toBeUndefined();
    expect(await h.sw.resume({ by: "maya" })).toEqual({ resumed: null, already: true, pauses: [] });
    expect(h.events).toEqual([
      { t: "paused", at: 1_000_000, scope: "colony", by: "maya", reason: "demo reset" },
      { t: "resumed", at: 1_000_020, scope: "colony", by: "maya", pausedAt: 1_000_000 },
    ]);
    expect(h.writer.at(-1)).toEqual({ paused: false, at: 1_000_020 });
  });

  it("is stored: a switch made again over the same storage is still paused", async () => {
    const h = harness();
    await h.sw.pause({ by: "maya", reason: "demo reset" });
    const again = harness(h.sql);
    expect(await again.sw.view()).toMatchObject({ paused: true, refusal: SENTENCE });
  });
});

describe("the deployment's pause in a colony", () => {
  const record = (over: object = {}) => JSON.stringify({ paused: true, by: "ops", reason: "spend check", at: 500, ...over });

  it("reads the registry at most once per TTL, and publishes a change once", async () => {
    const h = harness();
    h.registry.raw = record();
    expect(await h.sw.current()).toEqual([{ scope: "deployment", by: "ops", reason: "spend check", at: 500 }]);
    await h.sw.current();
    await h.sw.refuse().catch(() => undefined);
    expect(h.registry.reads).toBe(1);
    h.clock.now += DEPLOYMENT_PAUSE_TTL_MS;
    await h.sw.current();
    expect(h.registry.reads).toBe(2);
    expect(h.events).toEqual([{ t: "paused", at: 1_000_000, scope: "deployment", by: "ops", reason: "spend check" }]);
    // A colony that misses the push hears it on its next read, and its trunk writer is told.
    expect(h.writer).toEqual([{ paused: true, by: "ops", reason: "spend check", at: 1_000_000 }]);
  });

  it("never lets an older record, or a missing marker, undo a newer change (a read that raced a push)", async () => {
    const h = harness();
    expect(await h.sw.deploymentChanged(record())).toEqual({ changed: true, writer: true });
    h.registry.raw = JSON.stringify({ paused: false, by: "ops", reason: "", at: 400 });
    h.clock.now += DEPLOYMENT_PAUSE_TTL_MS;
    expect((await h.sw.view()).paused).toBe(true);
    h.registry.raw = null;
    h.clock.now += DEPLOYMENT_PAUSE_TTL_MS;
    expect((await h.sw.view()).paused).toBe(true);
    expect(h.events).toHaveLength(1);
  });

  it("keeps the last state it saw when the registry does not answer", async () => {
    const h = harness();
    h.registry.raw = record();
    await h.sw.current();
    h.registry.fail = true;
    h.clock.now += DEPLOYMENT_PAUSE_TTL_MS;
    expect((await h.sw.view()).paused).toBe(true);
    // A colony that never saw the registry and cannot read it knows of no pause.
    const fresh = harness();
    fresh.registry.fail = true;
    expect((await fresh.sw.view()).paused).toBe(false);
  });

  it("puts the colony's own pause first, and takes a pushed change at once", async () => {
    const h = harness();
    await h.sw.pause({ by: "maya", reason: "demo reset" });
    expect(await h.sw.deploymentChanged(record())).toEqual({ changed: true, writer: true });
    expect(await h.sw.deploymentChanged(record())).toEqual({ changed: false, writer: null });
    expect((await h.sw.current()).map((p) => p.scope)).toEqual(["colony", "deployment"]);
    expect((await h.sw.view()).refusal).toBe(SENTENCE);
    await h.sw.resume({ by: "maya" });
    expect((await h.sw.view()).refusal).toBe("Agents are paused in this colony by ops: spend check. Reads still work; wait for a person to resume.");
    expect(await h.sw.deploymentChanged(JSON.stringify({ paused: false, by: "ops", reason: "", at: 900, pausedAt: 500 }))).toEqual({ changed: true, writer: true });
    expect(await h.sw.view()).toEqual({ paused: false, pauses: [], refusal: null });
    expect(h.events.map((e) => `${e.t}:${(e as { scope: string }).scope}`)).toEqual(["paused:colony", "paused:deployment", "resumed:colony", "resumed:deployment"]);
    // Odd markers read as no pause.
    expect(await harness().sw.deploymentChanged("not json")).toEqual({ changed: false, writer: null });
  });
});

describe("the doors' checks", () => {
  const view = (paused: boolean) => ({ pauseState: async () => (paused ? { paused: true, pauses: [], refusal: SENTENCE } : { paused: false, pauses: [], refusal: null }) });

  it("refuse while paused, and let a colony with no switch through", async () => {
    await expect(refuseWhilePaused(view(true))).rejects.toThrow(`[ft:409] ${SENTENCE}`);
    await expect(refuseWhilePaused(view(false))).resolves.toBeUndefined();
    await expect(refuseWhilePaused({})).resolves.toBeUndefined();
    await expect(refuseWhilePaused({ pauseState: async () => Promise.reject(new Error('The RPC receiver does not implement the method "pauseState".')) })).resolves.toBeUndefined();
  });

  it("hold a lane while paused, and also when the colony does not answer (fail closed)", async () => {
    const env = (stub: unknown) => ({ COLONY: { idFromName: (n: string) => n as unknown as DurableObjectId, get: () => stub } });
    expect(await laneHold(env(view(true)), "c")).toBe(2_000);
    expect(await laneHold(env(view(false)), "c")).toBeNull();
    expect(await laneHold(env({ pauseState: async () => Promise.reject(new Error("overloaded")) }), "c")).toBe(2_000);
    expect(await laneHold(env({ pauseState: async () => Promise.reject(new Error("[ft:404] colony not found")) }), "c")).toBeNull();
    expect(pausedIn({ pause: { paused: true, at: 1 } })).toBe(true);
    expect(pausedIn({ pause: { paused: false, at: 1 } })).toBe(false);
    expect(pausedIn(undefined)).toBe(false);
  });
});

describe("the trunk writer's record", () => {
  it("keeps the newest record and stores only changes", () => {
    const sql = sqlite();
    sql.exec("CREATE TABLE ft_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    expect(parseWriterPause({ paused: true, by: "m\nx", reason: "r", at: 5 })).toEqual({ paused: true, by: "m x", reason: "r", at: 5 });
    expect(parseWriterPause({ paused: "yes", at: 5 })).toBeUndefined();
    expect(newerPause({ paused: true, at: 5 }, { paused: false, at: 4 })).toEqual({ paused: true, at: 5 });
    // Never paused: nothing is stored, and a cycle defers nothing.
    expect(cyclePause(sql, [{ pause: { paused: false, at: 1 } }, undefined, {}])).toBeNull();
    expect(storedPause(sql)).toBeUndefined();
    keepPause(sql, { paused: true, by: "maya", reason: "demo reset", at: 10 });
    expect(cyclePause(sql, [{ pause: { paused: false, at: 9 } }])).toBe(SENTENCE);
    // The same state from a newer read writes nothing: the record keeps when the pause began.
    keepPause(sql, { paused: true, by: "maya", reason: "demo reset", at: 20 });
    expect(storedPause(sql)?.at).toBe(10);
    expect(cyclePause(sql, [{ pause: { paused: false, at: 15 } }])).toBeNull();
    expect(storedPause(sql)).toEqual({ paused: false, at: 15 });
  });
});

describe("GET /api/about", () => {
  it("names the deployment's pause while one is in force, and only then", () => {
    const pause = { scope: "deployment" as const, by: "ops", reason: "spend check", at: 500 };
    expect(about({}, null, pause).pause).toEqual(pause);
    expect("pause" in about({})).toBe(false);
  });
});
