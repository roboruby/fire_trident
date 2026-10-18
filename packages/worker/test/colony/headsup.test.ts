import { describe, expect, it } from "vitest";
import type { MovedBy, Proposal } from "@fire_trident/core";
import {
  HEADS_UP_AHEAD,
  HEADS_UP_UNWARNED,
  HEADS_UP_WARNED,
  HeadsUpBook,
  LANE_SCAN,
  LANE_TTL_MS,
  TOLD_KEEP,
  cleanToldOf,
  headsUpEnabled,
  returnWarning,
  toldOfField,
  warnReturn,
  type SqlRunner,
} from "../../src/colony/headsup.ts";

/** The part of node:sqlite these tests use (the worker compiles against workers types, not Node's). */
interface DatabaseSync {
  prepare(sql: string): { all(...params: unknown[]): unknown[]; run(...params: unknown[]): unknown };
}
const SQLITE = "node:sqlite";
const { DatabaseSync } = (await import(SQLITE)) as { DatabaseSync: new (path: string) => DatabaseSync };

const sha = (c: string): string => c.repeat(40);

/** The colony tables the heads-up reads, with an agent agt_me holding int_me (footprint src/a.ts and lib/) on base lnd_base. */
function colony(clock = { now: 10_000 }) {
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
  run("CREATE TABLE intents (id TEXT PRIMARY KEY, title TEXT NOT NULL, why TEXT NOT NULL, footprint TEXT NOT NULL)");
  run("CREATE TABLE agents (id TEXT PRIMARY KEY, intent_id TEXT, workspace TEXT)");
  run(
    "CREATE TABLE proposals (id TEXT PRIMARY KEY, intent_id TEXT NOT NULL, agent_id TEXT NOT NULL, status TEXT NOT NULL, region TEXT NOT NULL, created_at INTEGER NOT NULL, data TEXT NOT NULL)",
  );
  run("INSERT INTO intents (id, title, why, footprint) VALUES ('int_me', 'Mine', 'w', ?)", JSON.stringify(["src/a.ts", "lib/"]));
  run("INSERT INTO intents (id, title, why, footprint) VALUES ('int_x', 'Cache lookups', 'w', '[]'), ('int_y', 'Rename the flag', 'w', '[]'), ('int_z', 'Split the parser', 'w', '[]')");
  run("INSERT INTO agents (id, intent_id, workspace) VALUES ('agt_me', 'int_me', ?), ('agt_x', NULL, NULL)", JSON.stringify({ baseSha: sha("1") }));
  const land = (id: string, at: number, trunk: string, rows: Array<[string, string | null]>): void => {
    run("INSERT INTO landings (id, at, received_at, trunk_sha, data) VALUES (?, ?, ?, ?, '{}')", id, at, at, trunk);
    for (const [path, intent] of rows) run("INSERT INTO landing_paths (path, at, landing_id, intent_id) VALUES (?, ?, ?, ?)", path, at, id, intent);
  };
  const queue = (id: string, intent: string, agent: string, status: string, created: number, writes: string[]): void =>
    run("INSERT INTO proposals (id, intent_id, agent_id, status, region, created_at, data) VALUES (?, ?, ?, ?, 'src', ?, ?)", id, intent, agent, status, created, JSON.stringify({ writeSet: writes.map((path) => ({ path, blob: sha("9") })) }));
  land("lnd_old", 500, sha("0"), [["src/a.ts", "int_old"]]);
  land("lnd_base", 1_000, sha("1"), [["src/a.ts", null]]);
  return { sql, run, land, queue, clock, book: new HeadsUpBook(sql, () => clock.now) };
}

describe("heads-up: trunk moved under you", () => {
  it("names the landings after the lease base that changed a file the agent read, with the intent title", () => {
    const c = colony();
    c.land("lnd_x", 2_000, sha("2"), [["src/b.ts", "int_x"], ["src/other.ts", "int_x"]]);
    const a = c.book.answer("agt_me", { reads: ["src/b.ts"] });
    expect(a).toEqual({
      intentId: "int_me",
      baseSha: sha("1"),
      report: { moved: [{ landingId: "lnd_x", at: 2_000, intentId: "int_x", title: "Cache lookups", paths: ["src/b.ts"] }], ahead: [] },
    });
  });

  it("covers the footprint's files and directories, newest first, and never the base or what landed before it", () => {
    const c = colony();
    c.land("lnd_x", 2_000, sha("2"), [["src/a.ts", "int_x"]]);
    c.land("lnd_y", 3_000, sha("3"), [["lib/deep/c.ts", "int_y"]]);
    const a = c.book.answer("agt_me");
    expect(a.report?.moved.map((m) => [m.landingId, m.paths])).toEqual([
      ["lnd_y", ["lib/deep/c.ts"]],
      ["lnd_x", ["src/a.ts"]],
    ]);
  });

  it("says nothing when nothing applies: no landing since the base on the agent's files", () => {
    const c = colony();
    c.land("lnd_x", 2_000, sha("2"), [["src/unrelated.ts", "int_x"]]);
    expect(c.book.answer("agt_me", { reads: ["src/b.ts"] }).report).toBeNull();
  });

  it("looks at the files a hook asks about, and at an older lease base when the session names one", () => {
    const c = colony();
    c.land("lnd_x", 2_000, sha("2"), [["src/hooked.ts", "int_x"]]);
    expect(c.book.answer("agt_me", { paths: ["./src/hooked.ts"] }).report?.moved[0]?.landingId).toBe("lnd_x");
    // On the old base lnd_old, the base landing itself moved src/a.ts too.
    expect(c.book.answer("agt_me", { baseSha: sha("0") }).report?.moved.map((m) => m.landingId)).toEqual(["lnd_base"]);
  });

  it("has nothing to say for an agent that holds nothing, or an unknown one", () => {
    const c = colony();
    expect(c.book.answer("agt_x")).toEqual({ intentId: null, baseSha: null, report: null });
    expect(c.book.answer("agt_nobody")).toEqual({ intentId: null, baseSha: null, report: null });
  });
});

describe("heads-up: changes waiting ahead", () => {
  it("names other agents' changes in flight whose write sets meet the agent's read or write set, oldest first", () => {
    const c = colony();
    c.queue("prp_late", "int_y", "agt_y", "ready", 300, ["lib/x.ts"]);
    c.queue("prp_early", "int_x", "agt_x", "checking", 200, ["src/read.ts", "src/elsewhere.ts"]);
    c.queue("prp_mine", "int_me", "agt_me", "ready", 100, ["src/a.ts"]);
    c.queue("prp_done", "int_z", "agt_z", "landed", 50, ["src/a.ts"]);
    c.queue("prp_far", "int_z", "agt_z", "ready", 60, ["docs/readme.md"]);
    const a = c.book.answer("agt_me", { reads: ["src/read.ts"] });
    expect(a.report).toEqual({
      moved: [],
      ahead: [
        { proposalId: "prp_early", intentId: "int_x", title: "Cache lookups", region: "src", paths: ["src/read.ts"] },
        { proposalId: "prp_late", intentId: "int_y", title: "Rename the flag", region: "src", paths: ["lib/x.ts"] },
      ],
    });
  });

  it("reads the changes in flight once per LANE_TTL_MS, and caps the list", () => {
    const c = colony();
    expect(c.book.answer("agt_me").report).toBeNull();
    for (let i = 0; i < HEADS_UP_AHEAD + 2; i++) c.queue(`prp_${i}`, "int_x", "agt_x", "ready", 100 + i, ["src/a.ts"]);
    // Within the window the colony's earlier read stands.
    expect(c.book.answer("agt_me").report).toBeNull();
    c.clock.now += LANE_TTL_MS;
    const r = c.book.answer("agt_me").report!;
    expect(r.ahead).toHaveLength(HEADS_UP_AHEAD);
    expect(r.moreAhead).toBe(2);
    expect(r).not.toHaveProperty("aheadScanned");
  });

  it("says when it checked only the oldest LANE_SCAN changes in flight, even with nothing found among them", () => {
    const c = colony();
    // LANE_SCAN changes elsewhere, one with no written path at all, then a newer one on the agent's file past the cap.
    for (let i = 0; i < LANE_SCAN - 1; i++) c.queue(`prp_${String(i).padStart(3, "0")}`, "int_x", "agt_x", "ready", 100 + i, ["docs/other.md"]);
    c.queue("prp_empty", "int_x", "agt_x", "pending", 100 + LANE_SCAN, []);
    c.queue("prp_hidden", "int_y", "agt_y", "ready", 1_000, ["src/a.ts"]);
    c.queue("prp_hidden2", "int_y", "agt_y", "checking", 1_001, ["lib/z.ts"]);
    const r = c.book.answer("agt_me").report;
    expect(r).toEqual({ moved: [], ahead: [], aheadScanned: { scanned: LANE_SCAN, of: LANE_SCAN + 2 } });
    // At exactly the cap nothing is left unread, so there is nothing to say.
    const d = colony();
    for (let i = 0; i < LANE_SCAN; i++) d.queue(`prp_${i}`, "int_x", "agt_x", "ready", 100 + i, ["docs/other.md"]);
    expect(d.book.answer("agt_me").report).toBeNull();
  });
});

/** A change that went back because lnd_x (landed at 2,000) moved its file, proposed at 50,000. */
function back(extra: Partial<Proposal> = {}): Proposal {
  const moved: MovedBy[] = [{ landingId: "lnd_x", paths: ["src/a.ts"], at: 2_000 }];
  return {
    id: "prp_back",
    colonyId: "c",
    intentId: "int_me",
    agentId: "agt_me",
    workspace: { namespace: "ns", name: "c--ws-1", remote: "https://example.invalid/ws.git" },
    baseSha: sha("1"),
    headSha: sha("f"),
    writeSet: [{ path: "src/a.ts", blob: sha("9") }],
    readSet: [],
    declared: { footprint: ["src/a.ts"], summary: "s" },
    evidence: { checks: [] },
    status: "returned",
    createdAt: Date.UTC(2026, 9, 17, 12, 3, 50),
    reason: "stale: 1 path changed on trunk since read: src/a.ts. Landing lnd_x moved it. Keep what that landing did unless your intent says otherwise, and escalate if both cannot hold.",
    movedBy: moved,
    ...extra,
  };
}

describe("heads-up: a return says whether the agent was told of the landing that beat it", () => {
  const toldAt = Date.UTC(2026, 9, 17, 12, 3, 10);

  it("warned: told before it proposed, with when and how long before", () => {
    const p = back({ toldOf: { landings: [{ landingId: "lnd_x", at: 2_000, toldAt }], lastReplyAt: toldAt + 5_000 } });
    expect(returnWarning(p)).toEqual({ warning: { landingId: "lnd_x", verdict: "warned", toldAt }, sentence: "You were told of lnd_x at 12:03:10 UTC, 40 s before you proposed." });
    expect(warnReturn(p)).toBe(HEADS_UP_WARNED);
    expect(p.reason).toMatch(/escalate if both cannot hold\. You were told of lnd_x at 12:03:10 UTC, 40 s before you proposed\.$/);
    expect(p.warning?.verdict).toBe("warned");
  });

  it("unwarned: the landing came after the agent's last reply", () => {
    const lastReplyAt = Date.UTC(2026, 9, 17, 12, 3, 40);
    const p = back({ toldOf: { landings: [], lastReplyAt }, movedBy: [{ landingId: "lnd_x", paths: ["src/a.ts"], at: lastReplyAt + 2_000 }] });
    expect(returnWarning(p)?.sentence).toBe("Landing lnd_x came after your last reply, so you could not have known.");
    expect(warnReturn(p)).toBe(HEADS_UP_UNWARNED);
    expect(p.warning).toEqual({ landingId: "lnd_x", verdict: "unwarned" });
  });

  it("unwarned: told only after it proposed, or named by no reply", () => {
    const later = back({ toldOf: { landings: [{ landingId: "lnd_x", at: 2_000, toldAt: Date.UTC(2026, 9, 17, 12, 4, 0) }] } });
    expect(returnWarning(later)?.sentence).toBe("You were told of lnd_x only at 12:04:00 UTC, after you proposed: you could not have known.");
    const never = back({ toldOf: { landings: [], lastReplyAt: Date.UTC(2026, 9, 17, 12, 3, 40) } });
    expect(returnWarning(never)?.sentence).toBe("No reply named landing lnd_x before you proposed, so you could not have known.");
  });

  it("names nothing for a change its agent's session never served, or one nothing known moved", () => {
    const p = back();
    expect(returnWarning(p)).toBeNull();
    expect(warnReturn(p)).toBeNull();
    expect(p.reason).not.toContain("told");
    expect(returnWarning(back({ toldOf: { landings: [] }, movedBy: [] }))).toBeNull();
  });
});

describe("heads-up: toldOf as received", () => {
  it("keeps well-formed entries, capped, and drops anything else", () => {
    const many = Array.from({ length: TOLD_KEEP + 3 }, (_, i) => ({ landingId: `lnd_${i}`, at: i, toldAt: i + 1 }));
    expect(cleanToldOf({ landings: [...many, { landingId: "bad id!", at: 1, toldAt: 2 }, { landingId: "lnd_n", at: "x", toldAt: 1 }], lastReplyAt: 9 })?.landings).toHaveLength(TOLD_KEEP);
    expect(cleanToldOf({ landings: "no", through: { landingId: "lnd_1", at: 1, toldAt: 2 }, lastReplyAt: -1 })).toEqual({ landings: [], through: { landingId: "lnd_1", at: 1, toldAt: 2 } });
    expect(cleanToldOf(null)).toBeUndefined();
    expect(toldOfField(undefined)).toEqual({});
    expect(toldOfField({ landings: [] })).toEqual({ toldOf: { landings: [] } });
  });

  it("FT_HEADS_UP reads like the other colony flags", () => {
    expect(headsUpEnabled(undefined, "c")).toBe(false);
    expect(headsUpEnabled("off", "c")).toBe(false);
    expect(headsUpEnabled("on", "c")).toBe(true);
    expect(headsUpEnabled("a, c", "c")).toBe(true);
    expect(headsUpEnabled("a", "c")).toBe(false);
  });
});
