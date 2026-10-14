import { describe, expect, it } from "vitest";
import type { MovedBy, Proposal } from "@fire_trident/core";
import { MOVED_LANDINGS, MOVED_PATHS, cleanMovedBy, movedBy, movedCollision, movedLine, movedReturn, movedSentence, type SqlRunner } from "../../src/colony/movedby.ts";

/** The part of node:sqlite these tests use (the worker compiles against workers types, not Node's). */
interface DatabaseSync {
  prepare(sql: string): { all(...params: unknown[]): unknown[]; run(...params: unknown[]): unknown };
}
const SQLITE = "node:sqlite";
const { DatabaseSync } = (await import(SQLITE)) as { DatabaseSync: new (path: string) => DatabaseSync };

const sha = (c: string): string => c.repeat(40);

/** The colony tables movedBy reads, with what a few landings left in them. */
function colony(): { sql: SqlRunner; land(l: { id: string; at: number; trunk: string; rows: Array<[string, string | null]>; proposals?: string[] }): void; run(q: string, ...b: unknown[]): void } {
  const db = new DatabaseSync(":memory:");
  const sql: SqlRunner = {
    exec: (q, ...b) => {
      const rows = db.prepare(q).all(...b);
      return { toArray: () => rows };
    },
  };
  const run = (q: string, ...b: unknown[]): void => void db.prepare(q).run(...b);
  run("CREATE TABLE landings (id TEXT PRIMARY KEY, at INTEGER NOT NULL, received_at INTEGER NOT NULL, trunk_sha TEXT NOT NULL, data TEXT NOT NULL)");
  run("CREATE TABLE landing_paths (path TEXT NOT NULL, at INTEGER NOT NULL, landing_id TEXT NOT NULL, intent_id TEXT, PRIMARY KEY (path, at, landing_id))");
  run("CREATE TABLE intents (id TEXT PRIMARY KEY, title TEXT NOT NULL, why TEXT NOT NULL)");
  run("CREATE TABLE proposals (id TEXT PRIMARY KEY, intent_id TEXT NOT NULL, agent_id TEXT NOT NULL, data TEXT NOT NULL)");
  run("CREATE TABLE agents (id TEXT PRIMARY KEY, kind TEXT NOT NULL, model TEXT)");
  return {
    sql,
    run,
    land: (l) => {
      run("INSERT INTO landings (id, at, received_at, trunk_sha, data) VALUES (?, ?, ?, ?, ?)", l.id, l.at, l.at, l.trunk, JSON.stringify({ id: l.id, proposalIds: l.proposals ?? [] }));
      for (const [path, intent] of l.rows) run("INSERT INTO landing_paths (path, at, landing_id, intent_id) VALUES (?, ?, ?, ?)", path, l.at, l.id, intent);
    },
  };
}

/** A returned change built on `base`, writing and reading these paths. */
function change(base: string, writes: string[], reads: string[] = [], extra: Partial<Proposal> = {}): Proposal {
  return {
    id: "prp_back",
    colonyId: "c",
    intentId: "int_back",
    agentId: "agt_back",
    workspace: { namespace: "ft-ws-0", name: "c--ws-1", remote: "https://example.invalid/ws.git" },
    baseSha: base,
    headSha: sha("f"),
    writeSet: writes.map((path) => ({ path, blob: sha("9") })),
    readSet: reads.map((path) => ({ path, blob: sha("8") })),
    declared: { footprint: writes, summary: "back" },
    evidence: { checks: [] },
    status: "returned",
    createdAt: 0,
    reason: "stale: 1 path changed on trunk since read: src/a.ts (expected 1111111111, trunk 2222222222)",
    ...extra,
  };
}

/** A colony where landing lnd_base made the base, then lnd_a (intent int_a by an in-platform agent) and lnd_b (an external agent) moved files. */
function seeded(): ReturnType<typeof colony> {
  const c = colony();
  c.run("INSERT INTO intents (id, title, why) VALUES ('int_a', 'Cache lookups', 'Lookups repeat; keep the last 100'), ('int_b', 'Rename the flag', 'The old name misleads')");
  c.run("INSERT INTO agents (id, kind, model) VALUES ('agt_a', 'internal', 'agent-model'), ('agt_b', 'external', 'declared-model')");
  const usage = { name: "agent model usage", ok: true, ms: 0, detail: "@cf/vendor/observed-model: 3 call(s), 900 input / 120 output tokens" };
  c.run("INSERT INTO proposals (id, intent_id, agent_id, data) VALUES (?, 'int_a', 'agt_a', ?)", "prp_a", JSON.stringify({ evidence: { checks: [usage] } }));
  c.run("INSERT INTO proposals (id, intent_id, agent_id, data) VALUES (?, 'int_b', 'agt_b', ?)", "prp_b", JSON.stringify({ evidence: { checks: [] } }));
  c.land({ id: "lnd_old", at: 500, trunk: sha("0"), rows: [["src/a.ts", "int_old"]] });
  c.land({ id: "lnd_base", at: 1_000, trunk: sha("1"), rows: [["src/c.ts", null]] });
  c.land({ id: "lnd_a", at: 2_000, trunk: sha("2"), rows: [["src/a.ts", "int_a"], ["src/b.ts", "int_a"]], proposals: ["prp_a"] });
  c.land({ id: "lnd_b", at: 3_000, trunk: sha("3"), rows: [["src/b.ts", "int_b"]], proposals: ["prp_b"] });
  return c;
}

describe("movedBy: the landings that moved a returned change's files", () => {
  it("names, for each stale path, the newest landing after the change's base, with its intent, agent, model and commit", () => {
    const c = seeded();
    const moved = movedBy(c.sql, change(sha("1"), ["src/a.ts"], ["src/b.ts"]), [{ path: "src/a.ts" }, { path: "src/b.ts" }]);
    expect(moved).toEqual([
      { landingId: "lnd_b", paths: ["src/b.ts"], at: 3_000, trunkSha: sha("3"), intentId: "int_b", title: "Rename the flag", why: "The old name misleads", agentId: "agt_b", model: "declared-model" },
      // An in-platform agent's model is the one its calls went to, as its lineage note names it.
      { landingId: "lnd_a", paths: ["src/a.ts"], at: 2_000, trunkSha: sha("2"), intentId: "int_a", title: "Cache lookups", why: "Lookups repeat; keep the last 100", agentId: "agt_a", model: "@cf/vendor/observed-model" },
    ]);
  });

  it("skips landings at or before the base, and a path no landing moved", () => {
    const c = seeded();
    // Based on lnd_b's commit: nothing after it moved these files.
    expect(movedBy(c.sql, change(sha("3"), ["src/a.ts", "src/b.ts"]), [{ path: "src/a.ts" }, { path: "src/b.ts" }])).toEqual([]);
    expect(movedBy(c.sql, change(sha("1"), ["src/z.ts"]), [{ path: "src/z.ts" }])).toEqual([]);
    // A base the colony did not record (an imported trunk): every landing counts, the newest per path.
    expect(movedBy(c.sql, change(sha("e"), ["src/a.ts"]), [{ path: "src/a.ts" }]).map((m) => m.landingId)).toEqual(["lnd_a"]);
  });

  it("without stale paths, looks at what the change wrote, read and relies on", () => {
    const c = seeded();
    const moved = movedBy(c.sql, change(sha("1"), ["src/a.ts"], [], { assumptions: ["src/b.ts"] }));
    expect(moved.map((m) => [m.landingId, m.paths])).toEqual([
      ["lnd_b", ["src/b.ts"]],
      ["lnd_a", ["src/a.ts"]],
    ]);
  });

  it("names a landing the colony knows only by its index (no intent, no proposals) by its landing and commit", () => {
    const c = colony();
    c.land({ id: "lnd_ext", at: 5_000, trunk: sha("5"), rows: [["src/a.ts", null]] });
    expect(movedBy(c.sql, change(sha("1"), ["src/a.ts"]), [{ path: "src/a.ts" }])).toEqual([{ landingId: "lnd_ext", paths: ["src/a.ts"], at: 5_000, trunkSha: sha("5") }]);
  });

  it("caps the landings and the paths it names", () => {
    const c = colony();
    const paths = Array.from({ length: 30 }, (_, i) => `src/f${String(i).padStart(2, "0")}.ts`);
    // One landing moved 20 files; then 8 more landings moved one each.
    c.land({ id: "lnd_big", at: 2_000, trunk: sha("2"), rows: paths.slice(0, 20).map((p) => [p, null]) });
    for (let i = 20; i < 28; i++) c.land({ id: `lnd_${i}`, at: 3_000 + i, trunk: sha("3"), rows: [[paths[i]!, null]] });
    const moved = movedBy(c.sql, change(sha("1"), paths), paths.map((path) => ({ path })));
    expect(moved).toHaveLength(MOVED_LANDINGS);
    expect(moved.map((m) => m.landingId)).toEqual(["lnd_27", "lnd_26", "lnd_25", "lnd_24", "lnd_23"]);
    const big = movedBy(c.sql, change(sha("1"), paths.slice(0, 20)), paths.slice(0, 20).map((path) => ({ path })));
    expect(big[0]!.paths).toHaveLength(MOVED_PATHS);
  });
});

describe("movedReturn: what a change going back because trunk moved its files gains", () => {
  it("ends its reason with the landings and the instruction, keeping what came before", () => {
    const c = seeded();
    const p = change(sha("1"), ["src/a.ts"]);
    const out = movedReturn(c.sql, p, [{ path: "src/a.ts" }])!;
    expect(out.movedBy.map((m) => m.landingId)).toEqual(["lnd_a"]);
    expect(out.reason).toBe(
      `${p.reason}. Landing lnd_a (commit ${sha("2").slice(0, 7)}, intent int_a, agent agt_a) moved it. Keep what that landing did unless your intent says otherwise, and escalate if both cannot hold.`,
    );
  });

  it("keeps a text merge conflict's hunks in the reason, and words several landings as such", () => {
    const c = seeded();
    const reason = "stale: src/a.ts (expected 1, trunk has 2); text merge of src/a.ts: 1 conflicting hunk, at line 13 of its base";
    const out = movedReturn(c.sql, change(sha("1"), ["src/a.ts", "src/b.ts"], [], { reason }), [{ path: "src/a.ts" }, { path: "src/b.ts" }])!;
    expect(out.reason.startsWith(`${reason}. Landings lnd_b (commit ${sha("3").slice(0, 7)}, intent int_b, agent agt_b) and lnd_a (commit ${sha("2").slice(0, 7)}, intent int_a, agent agt_a) moved them. `)).toBe(true);
    // No file is named in what it adds (a reason that names a file counts toward that file's megafile alarm).
    expect(out.reason.slice(reason.length)).not.toMatch(/src\//);
    expect(out.reason.endsWith("Keep what those landings did unless your intent says otherwise, and escalate if they cannot all hold.")).toBe(true);
  });

  it("adds nothing to other returns, or when no landing is known to have moved the files", () => {
    const c = seeded();
    for (const reason of ["returned for review: security (sensitive)", "withdrawn: no longer needed", "superseded: recalled by its agent", "landing failed 5 times: x", "deleting src/a.ts breaks the imports of src/b.ts: change them in the same change, or first"]) {
      expect(movedCollision({ status: "returned", reason })).toBe(false);
      expect(movedReturn(c.sql, change(sha("1"), ["src/a.ts"], [], { reason }), [{ path: "src/a.ts" }])).toBeNull();
    }
    expect(movedCollision({ status: "rejected", reason: "stale: x" })).toBe(false);
    expect(movedCollision({ status: "returned", reason: "conflicts with another proposal in this landing on src/a.ts" })).toBe(true);
    expect(movedReturn(c.sql, change(sha("3"), ["src/a.ts"]), [{ path: "src/a.ts" }])).toBeNull();
  });
});

describe("movedBy as received, and as an agent reads it", () => {
  const good: MovedBy = { landingId: "lnd_a", paths: ["src/a.ts"], trunkSha: sha("2"), at: 2_000, intentId: "int_a", title: "Cache lookups", why: "Lookups repeat", agentId: "agt_a", model: "m" };

  it("keeps well-formed entries, drops malformed ones and fields, and caps them", () => {
    expect(cleanMovedBy([good])).toEqual([good]);
    expect(cleanMovedBy("nope")).toBeUndefined();
    expect(cleanMovedBy([{ landingId: "lnd_x", paths: [] }, { landingId: "bad id!", paths: ["a"] }, null])).toBeUndefined();
    expect(cleanMovedBy([{ ...good, trunkSha: "not-a-sha", at: Number.NaN, agentId: 7, title: "  two\nlines  ", model: "x".repeat(300) }])).toEqual([
      { landingId: "lnd_a", paths: ["src/a.ts"], intentId: "int_a", title: "two lines", why: "Lookups repeat", model: "x".repeat(200) },
    ]);
    expect(cleanMovedBy(Array.from({ length: 9 }, (_, i) => ({ ...good, landingId: `lnd_${i}` })))).toHaveLength(MOVED_LANDINGS);
  });

  it("reads as one line per landing: commit, time, files, intent, agent and model", () => {
    expect(movedLine(good)).toBe(`moved by landing lnd_a ${sha("2").slice(0, 7)} at 1970-01-01 00:00: src/a.ts for "Cache lookups": Lookups repeat (agent agt_a, model m)`);
    expect(movedLine({ landingId: "lnd_x", paths: ["a", "b"] })).toBe("moved by landing lnd_x: a, b");
    expect(movedSentence([{ landingId: "lnd_x", paths: ["a", "b", "c", "d"] }])).toBe(
      "Landing lnd_x moved them. Keep what that landing did unless your intent says otherwise, and escalate if both cannot hold.",
    );
  });
});
