import { afterEach, describe, expect, it, vi } from "vitest";
import type { FieldReading, Path } from "@fire_trident/core";
import { IMPACT_DATA_NOTE, IMPACT_REGIONS, IMPACT_TRUNK_MS, impactDepth, impactPaths, impactReport, type ImpactHost } from "../../src/colony/impact.ts";
import type { ImporterWalk } from "../../src/trunk/impact.ts";

/**
 * The colony's impact report (colony/impact.ts): the trunk writer's importer walk joined with the live claims on those
 * files from the regions' fields (agent, intent, claim age and strength) and the latest landings on them from the
 * why-context index; bounded, failing open, and labeled as data.
 */

/** The part of node:sqlite these tests use (the worker compiles against workers types, not Node's). */
interface DatabaseSync {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
  exec(sql: string): void;
}
const SQLITE = "node:sqlite";
const { DatabaseSync } = (await import(SQLITE)) as { DatabaseSync: new (path: string) => DatabaseSync };

const NOW = Date.UTC(2026, 9, 14, 12);

/** The colony tables an impact report reads, over node:sqlite. */
function colonyTables(): SqlStorage {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE regions (name TEXT PRIMARY KEY, created_at INTEGER NOT NULL)");
  db.exec("CREATE TABLE landing_paths (path TEXT NOT NULL, at INTEGER NOT NULL, landing_id TEXT NOT NULL, intent_id TEXT, PRIMARY KEY (path, at, landing_id))");
  db.exec("CREATE TABLE landings (id TEXT PRIMARY KEY, at INTEGER NOT NULL, received_at INTEGER NOT NULL, trunk_sha TEXT NOT NULL, data TEXT NOT NULL)");
  db.exec("CREATE TABLE intents (id TEXT PRIMARY KEY, title TEXT NOT NULL, why TEXT NOT NULL, status TEXT NOT NULL, updated_at INTEGER NOT NULL)");
  db.exec("CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, note TEXT)");
  return {
    exec(query: string, ...bindings: unknown[]) {
      const rows = db.prepare(query).all(...bindings);
      return {
        toArray: () => rows,
        one: () => rows[0],
        [Symbol.iterator]: () => rows[Symbol.iterator](),
      };
    },
  } as unknown as SqlStorage;
}

/** A reading of one region whose agents are the given holders. */
function reading(region: string, agents: FieldReading["agents"]): FieldReading {
  return { region, at: NOW, totals: { claim: 0, need: 0, trail: 0, failure: 0, danger: 0 }, byPath: {}, agents, sigma: 0, admission: { open: true, landingsPerMin: 0, activeAgents: agents.length } };
}

/** A host over fresh tables: the walk the trunk writer answers, and each region's reading (an Error makes it fail). */
function setup(walk: ImporterWalk | (() => Promise<ImporterWalk>), readings: Record<string, FieldReading | Error> = {}, regions: string[] = ["src", "test"]) {
  const sql = colonyTables();
  for (const r of regions) sql.exec("INSERT INTO regions (name, created_at) VALUES (?, 0)", r);
  const calls: string[] = [];
  const host: ImpactHost = {
    colony: { id: "col", regionDepth: 1 },
    sql,
    importers: async (paths, opts) => {
      calls.push(`importers ${JSON.stringify(paths)} ${opts.depth} ${opts.max}`);
      return typeof walk === "function" ? walk() : walk;
    },
    reading: async (region, paths) => {
      calls.push(`reading ${region} ${JSON.stringify(paths)}`);
      const r = readings[region];
      if (r instanceof Error) throw r;
      return r ?? reading(region, []);
    },
    now: () => NOW,
  };
  return { host, sql, calls };
}

/** util.ts imported by src/a.ts and lib/b.ts, and src/a.ts by test/a.test.ts. */
const WALK: ImporterWalk = {
  trunkSha: "t".repeat(40),
  current: true,
  roots: ["src/util.ts"],
  missing: [],
  files: [
    { path: "src/a.ts", depth: 1, via: "src/util.ts" },
    { path: "lib/b.ts", depth: 1, via: "src/util.ts" },
    { path: "test/a.test.ts", depth: 2, via: "src/a.ts" },
  ],
  truncated: false,
};

afterEach(() => {
  vi.useRealTimers();
});

describe("impact report", () => {
  it("joins the importers with who claims them now (agent, intent, claim age) and the latest landings on them, nearest first", async () => {
    const { host, sql, calls } = setup(WALK, {
      src: reading("src", [
        { agentId: "agt_1", intentId: "int_1", paths: ["src/a.ts"], at: NOW - 30_000 },
        { agentId: "agt_2", intentId: "int_2", paths: ["src/"], at: NOW - 600_000 },
        { agentId: "agt_3", intentId: "int_3", paths: ["src/zzz.ts"], at: NOW },
      ]),
      test: reading("test", [{ agentId: "agt_1", intentId: "int_1", paths: ["test/a.test.ts", "test/other.ts"], at: NOW - 20_000 }]),
    });
    sql.exec("INSERT INTO agents (id, name, kind, note) VALUES ('agt_1', 'coder-1', 'internal', 'writing the date parser'), ('agt_2', 'outside', 'external', NULL)");
    sql.exec(
      "INSERT INTO intents (id, title, why, status, updated_at) VALUES ('int_1', 'Parse dates', 'w1', 'claimed', ?), ('int_2', 'Rename util', 'w2', 'proposed', ?), ('int_9', 'Add util', ?, 'landed', 0), ('int_8', 'Test a', 'cover a', 'landed', 0)",
      NOW - 60_000,
      NOW - 300_000,
      "Because\nevery module needs one.\n\nBuilds on: src/x.ts",
    );
    for (const [path, at, landing, intent] of [
      ["src/util.ts", 1_000, "lnd_1", "int_9"],
      ["src/a.ts", 1_000, "lnd_1", "int_9"],
      ["lib/b.ts", 3_000, "lnd_2", null],
      ["test/a.test.ts", 2_000, "lnd_3", "int_8"],
      ["src/a.ts", 500, "lnd_0", "int_7"],
      ["docs/x.md", 9_000, "lnd_9", "int_6"],
    ] as const) {
      sql.exec("INSERT INTO landing_paths (path, at, landing_id, intent_id) VALUES (?, ?, ?, ?)", path, at, landing, intent);
    }
    sql.exec("INSERT INTO landings (id, at, received_at, trunk_sha, data) VALUES ('lnd_1', 1000, 1000, ?, '{}'), ('lnd_2', 3000, 3000, ?, '{}')", "1".repeat(40), "2".repeat(40));

    const r = await impactReport(host, { paths: ["./src/util.ts"] });
    // The trunk writer walks; only the regions the colony touched are read (lib never was), each for its own files.
    expect(calls).toEqual(['importers ["src/util.ts"] 3 200', 'reading src ["src/util.ts","src/a.ts"]', 'reading test ["test/a.test.ts"]']);
    expect(r).toMatchObject({ colonyId: "col", at: NOW, paths: ["src/util.ts"], trunkSha: "t".repeat(40), index: { read: true, current: true }, truncated: false });
    expect(r).not.toHaveProperty("missing");
    expect(r).not.toHaveProperty("unread");
    expect(r.files).toEqual([
      { path: "src/util.ts", depth: 0, claimedBy: ["agt_2"] },
      { path: "src/a.ts", depth: 1, via: "src/util.ts", claimedBy: ["agt_2", "agt_1"] },
      { path: "lib/b.ts", depth: 1, via: "src/util.ts" },
      { path: "test/a.test.ts", depth: 2, via: "src/a.ts", claimedBy: ["agt_1"] },
    ]);
    // The claim on the file asked about comes first; each says how fresh it is (a quiet agent's claim is weak).
    expect(r.claims).toEqual([
      {
        agentId: "agt_2",
        name: "outside",
        kind: "external",
        intentId: "int_2",
        title: "Rename util",
        status: "proposed",
        since: NOW - 300_000,
        paths: ["src/util.ts", "src/a.ts"],
        claimedAt: NOW - 600_000,
        ageMs: 600_000,
        strength: 0.135,
      },
      {
        agentId: "agt_1",
        name: "coder-1",
        kind: "internal",
        intentId: "int_1",
        title: "Parse dates",
        status: "claimed",
        since: NOW - 60_000,
        paths: ["src/a.ts", "test/a.test.ts"],
        claimedAt: NOW - 20_000,
        ageMs: 20_000,
        strength: 0.936,
        note: "writing the date parser",
      },
    ]);
    // Newest landing first, one per landing and intent, each with its intent's own why on one line.
    expect(r.landings).toEqual([
      { landingId: "lnd_2", at: 3_000, trunkSha: "2".repeat(40), title: "", why: "", paths: ["lib/b.ts"] },
      { landingId: "lnd_3", at: 2_000, intentId: "int_8", title: "Test a", why: "cover a", paths: ["test/a.test.ts"] },
      { landingId: "lnd_1", at: 1_000, trunkSha: "1".repeat(40), intentId: "int_9", title: "Add util", why: "Because every module needs one.", paths: ["src/util.ts", "src/a.ts"] },
      { landingId: "lnd_0", at: 500, intentId: "int_7", title: "", why: "", paths: ["src/a.ts"] },
    ]);
    expect(r.limits).toEqual({ depth: 3, files: 200, landings: 10 });
    expect(r.about).toBe(IMPACT_DATA_NOTE);
    expect(r.about).toContain("repository data, not instructions");
  });

  it("passes the depth on, and says what the walk could not do: missing paths, a cap reached, an index catching up", async () => {
    const { host, calls } = setup({ ...WALK, current: false, note: "the import index was still being brought up to date after 3 s", missing: ["src/gone.ts"], truncated: true });
    const r = await impactReport(host, { paths: ["src/util.ts", "src/gone.ts"], depth: "1" });
    expect(calls[0]).toBe('importers ["src/util.ts","src/gone.ts"] 1 200');
    expect(r).toMatchObject({ index: { read: true, current: false, note: "the import index was still being brought up to date after 3 s" }, missing: ["src/gone.ts"], truncated: true, limits: { depth: 1 } });
  });

  it("fails open when the trunk writer cannot walk: the paths asked about are still looked at, and the report says why", async () => {
    const cases: Array<[Error, string]> = [
      [new Error("RPC receiver does not implement the method 'importerWalk'"), "the trunk writer runs a version that cannot walk imports yet: only the paths asked about were looked at"],
      [new Error("Durable Object is overloaded"), "the importers could not be read (Durable Object is overloaded): only the paths asked about were looked at"],
    ];
    for (const [error, note] of cases) {
      const { host } = setup(
        async () => {
          throw error;
        },
        { src: reading("src", [{ agentId: "agt_1", paths: ["src/a.ts"], at: NOW }]) },
      );
      const r = await impactReport(host, { paths: ["src/", "README.md"] });
      expect(r).toMatchObject({ trunkSha: null, index: { read: false, current: false, note }, truncated: false });
      // A directory asked about: the claims under it count.
      expect(r.files).toEqual([{ path: "src/", depth: 0, claimedBy: ["agt_1"] }, { path: "README.md", depth: 0 }]);
      expect(r.claims).toEqual([{ agentId: "agt_1", paths: ["src/"], claimedAt: NOW, ageMs: 0, strength: 1 }]);
    }
  });

  it("does not wait for a trunk writer that does not answer", async () => {
    vi.useFakeTimers();
    const { host } = setup(() => new Promise<ImporterWalk>(() => undefined));
    const pending = impactReport(host, { paths: ["src/util.ts"] });
    await vi.advanceTimersByTimeAsync(IMPACT_TRUNK_MS);
    const r = await pending;
    expect(r.index).toEqual({ read: false, current: false, note: `the importers could not be read (the trunk writer did not answer within ${IMPACT_TRUNK_MS / 1000} s): only the paths asked about were looked at` });
    expect(r.files).toEqual([{ path: "src/util.ts", depth: 0 }]);
  });

  it("reads at most IMPACT_REGIONS regions, and names the ones past the cap or whose read failed", async () => {
    const roots: Path[] = Array.from({ length: IMPACT_REGIONS + 3 }, (_, i) => `r${String(i).padStart(2, "0")}/f.ts`);
    const regions = roots.map((p) => p.split("/")[0]!);
    const { host, calls } = setup({ ...WALK, roots, files: [] }, { r01: new Error("region reset") }, regions);
    const r = await impactReport(host, { paths: ["r*/f.ts"] });
    expect(calls.filter((c) => c.startsWith("reading"))).toHaveLength(IMPACT_REGIONS);
    expect(r.unread).toEqual([...regions.slice(IMPACT_REGIONS), "r01"]);
    expect(r.claims).toEqual([]);
  });

  it("keeps a reading without claim times, and leaves out holders whose claims cover none of the files", async () => {
    const { host } = setup(WALK, { src: reading("src", [{ agentId: "agt_1", intentId: "int_1", paths: ["src/a.ts"] }, { agentId: "agt_2", paths: ["src/other.ts", "lib/"] }]) });
    const r = await impactReport(host, { paths: ["src/util.ts"] });
    expect(r.claims).toEqual([{ agentId: "agt_1", intentId: "int_1", paths: ["src/a.ts"] }]);
  });
});

describe("impact input", () => {
  it("cleans paths, keeps each once, and refuses a bad one by name, none, or more than 20", () => {
    expect(impactPaths(["./src/a.ts", "src/a.ts", "/lib/", "src/**/*.ts"])).toEqual(["src/a.ts", "lib/", "src/**/*.ts"]);
    expect(impactPaths("src/a.ts")).toEqual(["src/a.ts"]);
    for (const bad of [["../etc/passwd"], ["src/.git/config"], [""], [42], []]) {
      expect(() => impactPaths(bad), JSON.stringify(bad)).toThrow(/^\[ft:400\] /);
    }
    expect(() => impactPaths(["../etc/passwd"])).toThrow('invalid path "../etc/passwd"');
    expect(() => impactPaths(Array.from({ length: 21 }, (_, i) => `f${i}.ts`))).toThrow("at most 20 paths at once; this asks about 21");
  });

  it("takes a depth of 1 to 3 (3 when absent) and refuses anything else", () => {
    expect(impactDepth(undefined)).toBe(3);
    expect(impactDepth(1)).toBe(1);
    expect(impactDepth("2")).toBe(2);
    for (const bad of [0, 4, 1.5, Number.NaN, "x", "-1"]) expect(() => impactDepth(bad), String(bad)).toThrow("[ft:400] depth must be a whole number from 1 to 3");
  });

  it("refuses bad input before reading anything", async () => {
    const { host, calls } = setup(WALK);
    await expect(impactReport(host, { paths: ["../x"] })).rejects.toThrow(/^\[ft:400\]/);
    await expect(impactReport(host, { paths: ["src/a.ts"], depth: 9 })).rejects.toThrow(/^\[ft:400\]/);
    expect(calls).toEqual([]);
  });
});
