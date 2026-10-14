import { describe, expect, it } from "vitest";
import type { Id, Intent } from "@fire_trident/core";
import type { SqlRunner } from "../../src/colony/inline.ts";
import {
  LIVE_CANDIDATES,
  TWIN_DESCRIPTION,
  ancestry,
  findTwin,
  isTwinAnswer,
  twinCandidates,
  twinChecked,
  twinNote,
  twinsEnabled,
  twinsOffered,
} from "../../src/colony/twins.ts";

/** The part of node:sqlite these tests use (the worker compiles against workers types, not Node's). */
interface DatabaseSync {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
  exec(sql: string): void;
}
const SQLITE = "node:sqlite";
const { DatabaseSync } = (await import(SQLITE)) as { DatabaseSync: new (path: string) => DatabaseSync };

const NOW = 10_000_000_000;
const MIN = 60_000;

/** An intents table as the colony keeps it, in memory, with a row writer. */
function colony() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE intents (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, why TEXT NOT NULL, source TEXT NOT NULL, rule_id TEXT, parent_id TEXT,
    footprint TEXT NOT NULL, acceptance TEXT, priority REAL NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL,
    created_by TEXT NOT NULL, assigned_to TEXT, violations INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)`);
  const sql: SqlRunner = { exec: (q, ...b) => ({ toArray: () => db.prepare(q).all(...b) }) };
  let created = 0;
  const add = (id: Id, title: string, footprint: string[] | string, o: { status?: string; updatedAgo?: number; parent?: Id; by?: string } = {}) => {
    db.prepare(
      "INSERT INTO intents (id, title, why, source, parent_id, footprint, priority, status, created_at, created_by, updated_at) VALUES (?, ?, '', 'human', ?, ?, 1, ?, ?, ?, ?)",
    ).all(id, title, o.parent ?? null, typeof footprint === "string" ? footprint : JSON.stringify(footprint), o.status ?? "open", ++created, o.by ?? "person", NOW - (o.updatedAgo ?? 0) * MIN);
  };
  /** An intent as the colony would read it back (only the fields the answer uses matter here). */
  const load = (id: Id): Intent | null => {
    const r = db.prepare("SELECT * FROM intents WHERE id = ?").all(id)[0] as Record<string, any> | undefined;
    return r ? { id: r.id, colonyId: "col", title: r.title, why: r.why, source: "human", footprint: JSON.parse(r.footprint), priority: 1, status: r.status, createdAt: r.created_at, createdBy: r.created_by } : null;
  };
  return { sql, add, load };
}

const RATE = "Add rate limiting to /api/links";

describe("the FT_TWINS flag", () => {
  it("covers the colonies it names, or every colony with on; off when absent", () => {
    expect(twinsEnabled(undefined, "a")).toBe(false);
    expect(twinsEnabled("off", "a")).toBe(false);
    expect(twinsEnabled("on", "a")).toBe(true);
    expect(twinsEnabled("b, a", "a")).toBe(true);
    expect(twinsEnabled("b", "a")).toBe(false);
    expect([undefined, "", "off", " , "].map(twinsOffered)).toEqual([false, false, false, false]);
    expect(["on", "b", "a,b"].map(twinsOffered)).toEqual([true, true, true]);
  });
});

describe("twinChecked", () => {
  it("checks what a person or an agent declares, never a rule's, a repair's or the colony's own", () => {
    expect(twinChecked({ source: "human" })).toBe(true);
    expect(twinChecked({ source: "agent" })).toBe(true);
    // A source the colony keeps as a person's.
    expect(twinChecked({})).toBe(true);
    for (const source of ["rule", "certify", "system"]) expect(twinChecked({ source }), source).toBe(false);
    expect(twinChecked({ source: "human", ruleId: "rul_1" })).toBe(false);
  });
});

describe("twinNote", () => {
  it("names the intent, quotes its title and says what to do next for its status", () => {
    expect(twinNote({ id: "int_1", title: RATE, status: "open" })).toBe(
      'This looks like int_1 "Add rate limiting to /api/links" (open): take that one, or declare again with force: true if yours is different work.',
    );
    expect(twinNote({ id: "int_1", title: RATE, status: "claimed" })).toBe(
      'This looks like int_1 "Add rate limiting to /api/links" (claimed): an agent is already on it, so leave it to them, or declare again with force: true if yours is different work.',
    );
    expect(twinNote({ id: "int_1", title: RATE, status: "landed" })).toMatch(/\(landed\): it landed in the last 30 minutes, so read trunk first, or declare again with force: true/);
    // An agent reported it cannot be done as written: nobody is offered it until a person answers.
    expect(twinNote({ id: "int_1", title: RATE, status: "open" }, true)).toBe(
      'This looks like int_1 "Add rate limiting to /api/links" (open, waiting for a person): an agent reported it cannot be done as written, so wait for a person\'s answer, or declare again with force: true if yours is different work.',
    );
  });

  it("keeps a title on one line, quoted as data, and cuts a long one", () => {
    const note = twinNote({ id: "int_2", title: 'Say "hi"\nthen\tstop', status: "proposed" });
    expect(note).toContain('int_2 "Say \\"hi\\" then stop" (proposed)');
    expect(twinNote({ id: "int_3", title: "x".repeat(300), status: "open" })).toContain(`"${"x".repeat(119)}…"`);
  });

  it("is one sentence, as the declare tool describes it", () => {
    expect(TWIN_DESCRIPTION.split(/[.!?](\s|$)/).filter((s) => s.trim() !== "").length).toBe(1);
  });
});

describe("isTwinAnswer", () => {
  it("tells a twin answer from a declared intent", () => {
    expect(isTwinAnswer({ intent: {}, duplicateOf: "int_1", similar: [], note: "n" })).toBe(true);
    expect(isTwinAnswer({ intent: {} })).toBe(false);
    expect(isTwinAnswer({ duplicateOf: "" })).toBe(false);
    expect(isTwinAnswer(null)).toBe(false);
  });
});

describe("twinCandidates", () => {
  it("reads intents open, claimed or proposed and landed in the window, never withdrawn, abandoned, vaccines or excluded ones", () => {
    const { sql, add } = colony();
    add("int_open", "a", ["a.ts"]);
    add("int_claimed", "b", ["b.ts"], { status: "claimed" });
    add("int_proposed", "c", ["c.ts"], { status: "proposed" });
    add("int_landed", "d", ["d.ts"], { status: "landed", updatedAgo: 29 });
    add("int_old", "e", ["e.ts"], { status: "landed", updatedAgo: 31 });
    add("int_withdrawn", "f", ["f.ts"], { status: "withdrawn" });
    add("int_abandoned", "g", ["g.ts"], { status: "abandoned" });
    add("int_vaccine", "h", ["h.ts"], { status: "claimed", by: "vaccine" });
    add("int_parent", "i", ["i.ts"]);
    const got = twinCandidates(sql, NOW, new Set(["int_parent"]));
    expect(got.map((x) => x.id)).toEqual(["int_open", "int_claimed", "int_proposed", "int_landed"]);
    expect(got.find((x) => x.id === "int_landed")).toEqual({ id: "int_landed", title: "d", status: "landed", footprint: ["d.ts"], landedAt: NOW - 29 * MIN });
    expect(got.find((x) => x.id === "int_open")).not.toHaveProperty("landedAt");
  });

  it("reads the newest LIVE_CANDIDATES, lists them oldest first, and an unreadable footprint as empty", () => {
    const { sql, add } = colony();
    for (let n = 0; n <= LIVE_CANDIDATES; n++) add(`int_${n}`, `t${n}`, [`f${n}.ts`]);
    add("int_bad", "bad", "not json");
    const got = twinCandidates(sql, NOW);
    expect(got).toHaveLength(LIVE_CANDIDATES);
    expect(got.map((x) => x.id).slice(0, 2)).toEqual(["int_2", "int_3"]);
    expect(got[got.length - 1]).toEqual({ id: "int_bad", title: "bad", status: "open", footprint: [] });
  });
});

describe("ancestry", () => {
  it("walks up the parents, and stops at a cycle", () => {
    const { sql, add } = colony();
    add("int_root", "r", ["r.ts"]);
    add("int_mid", "m", ["m.ts"], { parent: "int_root" });
    add("int_a", "a", ["a.ts"], { parent: "int_b" });
    add("int_b", "b", ["b.ts"], { parent: "int_a" });
    expect([...ancestry(sql, "int_mid")]).toEqual(["int_mid", "int_root"]);
    expect([...ancestry(sql, "int_a")]).toEqual(["int_a", "int_b"]);
    expect(ancestry(sql, undefined).size).toBe(0);
    expect([...ancestry(sql, "int_unknown")]).toEqual(["int_unknown"]);
  });
});

describe("findTwin", () => {
  it("answers with the existing intent as the colony has it, every match, and the note", () => {
    const { sql, add, load } = colony();
    add("int_rate", RATE, ["src/links/**"]);
    add("int_cache", "Add caching to /api/links", ["src/links/**"]);
    const got = findTwin(sql, { title: "  Rate-limit the links API ", footprint: ["./src/links/handler.ts"] }, NOW, load);
    expect(got).toEqual({
      intent: load("int_rate"),
      duplicateOf: "int_rate",
      similar: [{ id: "int_rate", title: RATE, status: "open", score: 1 }],
      note: twinNote({ id: "int_rate", title: RATE, status: "open" }),
    });
  });

  it("says so when the twin waits for a person's answer to an agent's report", () => {
    const { sql, add, load } = colony();
    add("int_rate", RATE, ["src/links/**"]);
    const reported = (id: Id): Intent | null => {
      const i = load(id);
      return i ? { ...i, escalation: { kind: "contradictory-spec", report: "The spec asks for two limits.", by: "agt_1", at: NOW } } : null;
    };
    const got = findTwin(sql, { title: "Rate-limit the links API", footprint: ["src/links/handler.ts"] }, NOW, reported);
    expect(got?.note).toBe(twinNote({ id: "int_rate", title: RATE, status: "open" }, true));
    const answered = (id: Id): Intent | null => {
      const i = reported(id);
      return i?.escalation ? { ...i, escalation: { ...i.escalation, resolved: { by: "person", at: NOW, decision: "dismiss", note: "fine" } } } : i;
    };
    expect(findTwin(sql, { title: "Rate-limit the links API", footprint: ["src/links/handler.ts"] }, NOW, answered)?.note).toBe(twinNote({ id: "int_rate", title: RATE, status: "open" }));
  });

  it("names the intent declared first among equal matches", () => {
    const { sql, add, load } = colony();
    add("int_first", RATE, ["src/links/**"]);
    add("int_copy", RATE, ["src/links/**"]);
    const got = findTwin(sql, { title: "Rate-limit the links API", footprint: ["src/links/handler.ts"] }, NOW, load);
    expect(got?.duplicateOf).toBe("int_first");
    expect(got?.similar.map((m) => m.id)).toEqual(["int_first", "int_copy"]);
  });

  it("never answers with the declaration's own parent or its ancestors", () => {
    const { sql, add, load } = colony();
    add("int_rate", RATE, ["src/links/**"], { status: "claimed" });
    const declared = { title: "Rate-limit the links API", footprint: ["src/links/handler.ts"] };
    expect(findTwin(sql, declared, NOW, load)?.duplicateOf).toBe("int_rate");
    expect(findTwin(sql, { ...declared, parentId: "int_rate" }, NOW, load)).toBeNull();
  });

  it("answers null without a match, without a title or footprint, or when the match cannot be read", () => {
    const { sql, add, load } = colony();
    add("int_rate", RATE, ["src/links/**"]);
    expect(findTwin(sql, { title: "Rate-limit the users API", footprint: ["src/links/handler.ts"] }, NOW, load)).toBeNull();
    expect(findTwin(sql, { title: " ", footprint: ["src/links/handler.ts"] }, NOW, load)).toBeNull();
    expect(findTwin(sql, { title: "Rate-limit the links API", footprint: [" "] }, NOW, load)).toBeNull();
    expect(findTwin(sql, { title: "Rate-limit the links API", footprint: ["src/links/handler.ts"] }, NOW, () => null)).toBeNull();
  });
});
