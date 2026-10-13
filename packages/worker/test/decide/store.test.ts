import { describe, expect, it } from "vitest";
import type { Antibody } from "@fire_trident/core";
import type { ReviewView } from "../../src/decide/review.ts";
import { DecideStore } from "../../src/decide/store.ts";

/** The part of node:sqlite these tests use (the worker compiles against workers types, not Node's). */
interface DatabaseSync {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
  exec(sql: string): void;
}
const SQLITE = "node:sqlite";
const { DatabaseSync } = (await import(SQLITE)) as { DatabaseSync: new (path: string) => DatabaseSync };

/** A Durable Object SqlStorage over an in-memory database, with the colony's proposals table. */
function sqlStorage(opts: { proposals?: boolean } = {}): { sql: SqlStorage; db: DatabaseSync } {
  const db = new DatabaseSync(":memory:");
  if (opts.proposals !== false) db.exec("CREATE TABLE proposals (id TEXT PRIMARY KEY, status TEXT NOT NULL)");
  const sql = {
    exec(query: string, ...bindings: unknown[]) {
      const rows = db.prepare(query).all(...bindings);
      return {
        toArray: () => rows,
        one: () => {
          if (rows.length !== 1) throw new Error(`expected one row, got ${rows.length}`);
          return rows[0];
        },
        [Symbol.iterator]: () => rows[Symbol.iterator](),
      };
    },
  } as unknown as SqlStorage;
  return { sql, db };
}

const AB: Antibody = { id: "ab_1", colonyId: "c", origin: "human-reject", matcher: { paths: ["src/**"] }, question: "Does this change log a token?", threshold: 0.8, createdAt: 1, hits: 0, falsePositives: 0 };
const VIEW: ReviewView = { files: [{ path: "src/a.ts", status: "added", added: 1, removed: 0, hunks: "@@ -0,0 +1,1 @@\n+export const a = 1;", truncated: false }], filesChanged: 1, danger: [], residual: [] };

describe("schema", () => {
  it("adds the new antibody columns to a table that already exists, keeping its rows, and only once", () => {
    const { sql, db } = sqlStorage();
    // The antibodies table as production created it before these columns.
    db.exec(`CREATE TABLE antibodies (id TEXT PRIMARY KEY, data TEXT NOT NULL, state TEXT NOT NULL, minted_state TEXT NOT NULL DEFAULT 'active', path TEXT, landing_id TEXT, created_at INTEGER NOT NULL)`);
    db.prepare("INSERT INTO antibodies (id, data, state, created_at) VALUES (?, ?, 'active', 1)").all("ab_1", JSON.stringify(AB));
    const store = new DecideStore(sql);
    expect(store.antibody("ab_1")).toMatchObject({ state: "active", recurrences: 0, lastRecurrence: null });
    expect(() => new DecideStore(sql)).not.toThrow();
  });
});

describe("antibody recurrences", () => {
  it("counts each rejection an antibody had already caught", () => {
    const store = new DecideStore(sqlStorage().sql);
    store.putAntibody(AB, "active");
    store.recordRecurrence("ab_1", "prp_2");
    store.recordRecurrence("ab_1", "prp_3");
    expect(store.antibody("ab_1")).toMatchObject({ recurrences: 2, lastRecurrence: "prp_3" });
    expect(store.antibodies()[0]).toMatchObject({ recurrences: 2 });
    // Putting the antibody again (a sync from trunk) keeps its count.
    store.putAntibody(AB, "active");
    expect(store.antibody("ab_1")?.recurrences).toBe(2);
  });
});

describe("review views", () => {
  it("stores and reads one, and reads missing or damaged ones as null", () => {
    const { sql, db } = sqlStorage();
    const store = new DecideStore(sql);
    store.putReview("prp_1", VIEW, 10);
    expect(store.reviewView("prp_1")).toEqual(VIEW);
    expect(store.reviewView("prp_none")).toBeNull();
    db.prepare("INSERT INTO decide_review (proposal_id, view, at) VALUES ('prp_bad', 'not json', 11)").all();
    expect(store.reviewView("prp_bad")).toBeNull();
  });

  it("keeps every view still waiting for a person and prunes old decided ones", () => {
    const { sql, db } = sqlStorage();
    const store = new DecideStore(sql);
    db.prepare("INSERT INTO proposals (id, status) VALUES ('prp_wait', 'escalated')").all();
    store.putReview("prp_wait", VIEW, 1);
    for (let i = 0; i < 505; i++) store.putReview(`prp_${i}`, VIEW, 100 + i);
    const n = (db.prepare("SELECT COUNT(*) AS n FROM decide_review").all()[0] as { n: number }).n;
    expect(n).toBe(501);
    expect(store.reviewView("prp_wait")).toEqual(VIEW);
    expect(store.reviewView("prp_0")).toBeNull();
    expect(store.reviewView("prp_504")).toEqual(VIEW);
  });

  it("still stores a view where the colony's proposals table is missing", () => {
    const store = new DecideStore(sqlStorage({ proposals: false }).sql);
    store.putReview("prp_1", VIEW, 1);
    expect(store.reviewView("prp_1")).toEqual(VIEW);
  });
});

describe("intents on probation", () => {
  it("records security findings per intent, merging their classes", () => {
    const store = new DecideStore(sqlStorage().sql);
    expect(store.securityProbation("int_1")).toBeNull();
    store.markSecurityFinding("int_1", ["capability"], 5);
    store.markSecurityFinding("int_1", ["sensitive", "capability"], 9);
    expect(store.securityProbation("int_1")).toEqual({ findings: 2, classes: ["capability", "sensitive"], at: 9 });
    expect(store.securityProbation("int_2")).toBeNull();
  });
});
