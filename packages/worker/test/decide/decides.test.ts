import { describe, expect, it } from "vitest";
import { splitText } from "@fire_trident/core";
import { ALWAYS_A_PERSON, DECIDES_DAYS, cachedSplit, confirmKind, decidesReport, landedSplit } from "../../src/decide/decides.ts";
import { DEFAULT_POLICY, mergePolicy } from "../../src/decide/policy.ts";
import { presetPolicy } from "../../src/decide/presets.ts";
import { DecideStore } from "../../src/decide/store.ts";

/** How a colony decides: the last 30 days of landed changes by what confirmed them, from the colony's own tables, and the report around it. */

/** The part of node:sqlite these tests use (the worker compiles against workers types, not Node's). */
interface DatabaseSync {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
  exec(sql: string): void;
}
const SQLITE = "node:sqlite";
const { DatabaseSync } = (await import(SQLITE)) as { DatabaseSync: new (path: string) => DatabaseSync };

const DAY = 24 * 60 * 60_000;
const NOW = 1_792_000_000_000;

/** A Durable Object SqlStorage over an in-memory database with the colony's proposals table, and the decide tables. */
function colony(): { sql: SqlStorage; db: DatabaseSync; store: DecideStore } {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE proposals (id TEXT PRIMARY KEY, intent_id TEXT NOT NULL DEFAULT 'int', status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
  const sql = {
    exec(query: string, ...bindings: unknown[]) {
      const rows = db.prepare(query).all(...bindings);
      return { toArray: () => rows, one: () => rows[0], [Symbol.iterator]: () => rows[Symbol.iterator]() };
    },
  } as unknown as SqlStorage;
  return { sql, db, store: new DecideStore(sql) };
}

type Fixture = ReturnType<typeof colony>;

/** A proposal row, landed (or not) at `at`, created an hour before. */
function proposal(f: Fixture, id: string, status: string, at: number, createdAt = at - 60 * 60_000): void {
  f.db.prepare("INSERT INTO proposals (id, status, created_at, updated_at) VALUES (?, ?, ?, ?)").all(id, status, createdAt, at);
}

/** The pipeline's outcome row for a proposal. */
function outcome(f: Fixture, id: string, layer: string, action: string, at: number, vaccine = false): void {
  f.store.recordOutcome({ proposalId: id, region: "src", head: "h", layer, action, risk: 0, detectors: [], vaccine, state: null, at });
}

/** One of each kind, and the rows the split must leave out. */
function fixture(): Fixture {
  const f = colony();
  // D3 or M1: the deterministic proof.
  proposal(f, "prp_proof", "landed", NOW - DAY);
  outcome(f, "prp_proof", "deterministic", "land", NOW - DAY);
  proposal(f, "prp_proof2", "landed", NOW - 2 * DAY);
  outcome(f, "prp_proof2", "deterministic", "land", NOW - 2 * DAY);
  // R3: the reflex on earned autonomy.
  proposal(f, "prp_auto", "landed", NOW - 3 * DAY);
  outcome(f, "prp_auto", "reflex", "land", NOW - 3 * DAY);
  // L3: the second opinion.
  proposal(f, "prp_model", "landed", NOW - 4 * DAY);
  outcome(f, "prp_model", "llm", "land", NOW - 4 * DAY);
  // L5 escalated it, a person approved it, it landed a week later.
  proposal(f, "prp_person", "landed", NOW - 5 * DAY, NOW - 12 * DAY);
  outcome(f, "prp_person", "llm", "escalate", NOW - 12 * DAY);
  f.store.recordHuman("prp_person", "src", "h", "approve", NOW - 5 * DAY);
  // Review off: no outcome row at all.
  proposal(f, "prp_off", "landed", NOW - 6 * DAY);
  // Left out: landed 40 days ago; still waiting; returned; a vaccine; a person rejected it.
  proposal(f, "prp_old", "landed", NOW - 40 * DAY);
  outcome(f, "prp_old", "deterministic", "land", NOW - 40 * DAY);
  proposal(f, "prp_ready", "ready", NOW - DAY);
  outcome(f, "prp_ready", "llm", "land", NOW - DAY);
  proposal(f, "prp_back", "returned", NOW - DAY);
  outcome(f, "prp_back", "reflex", "return", NOW - DAY);
  proposal(f, "prp_vax", "landed", NOW - DAY);
  outcome(f, "prp_vax", "reflex", "land", NOW - DAY, true);
  proposal(f, "prp_rejected", "rejected", NOW - DAY);
  outcome(f, "prp_rejected", "reflex", "escalate", NOW - 2 * DAY);
  f.store.recordHuman("prp_rejected", "src", "h", "reject", NOW - DAY);
  return f;
}

describe("the 30-day split", () => {
  it("counts each landed change of the last 30 days once, by what confirmed it", () => {
    const split = landedSplit(fixture().sql, NOW);
    expect(split).toEqual({ days: DECIDES_DAYS, since: NOW - 30 * DAY, total: 6, counts: { deterministic: 2, model: 1, autonomy: 1, person: 1, unreviewed: 1 } });
    expect(splitText(split)).toBe(
      "Last 30 days: 6 changes landed, 2 by deterministic proof (33%), 1 by a model (17%), 1 on earned autonomy (17%), 1 by a person (17%), 1 with no review recorded (16%).",
    );
  });

  it("reads a person's approval as a person, whatever layer sent the change to them", () => {
    expect(confirmKind({ layer: "deterministic", action: "escalate", human: "approve" })).toBe("person");
    expect(confirmKind({ layer: "human", action: "none", human: "approve" })).toBe("person");
    expect(confirmKind({ layer: "llm", action: "land", human: null })).toBe("model");
    expect(confirmKind({ layer: "reflex", action: "land", human: null })).toBe("autonomy");
    expect(confirmKind({ layer: "deterministic", action: "land", human: null })).toBe("deterministic");
    // Escalated and landed with no approval (a change of direction raced it), or no outcome row at all.
    expect(confirmKind({ layer: "llm", action: "escalate", human: null })).toBe("unreviewed");
    expect(confirmKind({ layer: null, action: null, human: null })).toBe("unreviewed");
  });

  it("leaves out a change that waited longer than the window before it landed (the read stays bounded)", () => {
    const f = colony();
    proposal(f, "prp_slow", "landed", NOW - DAY, NOW - 70 * DAY);
    outcome(f, "prp_slow", "llm", "escalate", NOW - 70 * DAY);
    f.store.recordHuman("prp_slow", "src", "h", "approve", NOW - DAY);
    proposal(f, "prp_wait", "landed", NOW - DAY, NOW - 50 * DAY);
    f.store.recordHuman("prp_wait", "src", "h", "approve", NOW - DAY);
    expect(landedSplit(f.sql, NOW).counts.person).toBe(1);
  });

  it("is zero on a colony with nothing landed", () => {
    const split = landedSplit(colony().sql, NOW);
    expect(split.total).toBe(0);
    expect(splitText(split)).toBe("Last 30 days: no change landed.");
  });

  it("is read at most once a minute per colony", () => {
    const f = fixture();
    expect(cachedSplit(f.sql, NOW).total).toBe(6);
    proposal(f, "prp_new", "landed", NOW);
    outcome(f, "prp_new", "llm", "land", NOW);
    expect(cachedSplit(f.sql, NOW + 30_000).total).toBe(6);
    expect(cachedSplit(f.sql, NOW + 61_000).total).toBe(7);
    // A clock that went back reads again rather than trusting a reading from the future.
    expect(cachedSplit(f.sql, NOW).total).toBe(7);
  });
});

describe("the report", () => {
  const split = { days: 30, since: NOW - 30 * DAY, total: 0, counts: { deterministic: 0, model: 0, autonomy: 0, person: 0, unreviewed: 0 } };

  it("names the preset the policy equals, the four presets with their sentences, and the settings", () => {
    const r = decidesReport({ colonyId: "web", policy: presetPolicy("production"), reviewing: true, split, now: NOW });
    expect(r).toMatchObject({ colonyId: "web", preset: "production", nearest: "production", differs: [], reviewing: true, protectedPaths: 0, dangerAllow: 0, always: ALWAYS_A_PERSON, at: NOW });
    expect(r.presets.map((p) => p.label)).toEqual(["local development", "central development", "pre-production", "production"]);
    expect(r.presets[3]!.lets).toBe(r.lets);
    expect(r.settings.find((s) => s.field === "needsHuman")).toEqual({ field: "needsHuman", label: "p(needs_human) a landing stays under", value: 0.2 });
    expect(r.presets[0]!.settings.find((s) => s.field === "autonomyAfter")?.value).toBe(1);
  });

  it("says custom with the values that differ, and counts the protected paths and danger allowances", () => {
    const policy = mergePolicy(DEFAULT_POLICY, { autonomyAfter: 5, protectedPaths: ["src/auth/**", "db/**"], dangerAllow: [{ cls: "network" }, { cls: "dependency" }] });
    const r = decidesReport({ colonyId: "web", policy, reviewing: false, split, now: NOW });
    expect(r).toMatchObject({ preset: "custom", nearest: "central-development", reviewing: false, protectedPaths: 2, dangerAllow: 1 });
    expect(r.differs).toEqual([{ field: "autonomyAfter", label: "approved landings to earn autonomy", value: 5, preset: 3 }]);
    expect(r.lets).toContain("in a region with 5 approved landings");
  });
});
