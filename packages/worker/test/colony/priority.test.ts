import { describe, expect, it } from "vitest";
import type { IntentSource } from "@fire_trident/core";
import { REPAIR_PRIORITY } from "../../src/certify/repair.ts";
import { SPLIT_PRIORITY } from "../../src/colony/megafile.ts";
import { DEFAULT_PRIORITY, grantPriority, migratePriority, notePriority, parentIsTheirs, priorityAnswer, priorityCap, priorityCapOf, priorityCapped, priorityNote, requestedPriorityOf } from "../../src/colony/priority.ts";

/**
 * Agent-declared priority (colony/priority.ts): an agent's intent takes at most its parent's priority, or the default
 * with no parent; a person, a rule and the platform keep what they ask. What the agent asked is kept when the cap
 * lowered it, read back only while it differs, told to the agent in a sentence, and carried into the lineage note.
 */

/** The part of node:sqlite these tests use (the worker compiles against workers types, not Node's). */
interface DatabaseSync {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
  exec(sql: string): void;
}
const SQLITE = "node:sqlite";
const { DatabaseSync } = (await import(SQLITE)) as { DatabaseSync: new (path: string) => DatabaseSync };

describe("the cap", () => {
  /** A parent row as the colony keeps it: held by agt_me (claimed), held by someone else, or declared by agt_me. */
  const held = (priority: unknown, status = "claimed") => ({ priority, status, assigned_to: "agt_me", created_by: "certify" });
  const others = (priority: unknown) => ({ priority, status: "claimed", assigned_to: "agt_other", created_by: "certify" });
  const mine = (priority: unknown) => ({ priority, status: "open", assigned_to: null, created_by: "agt_me" });

  it("applies to an agent's intents only", () => {
    expect(priorityCapped("agent")).toBe(true);
    for (const source of ["human", "rule", "certify", "system"] as IntentSource[]) expect(priorityCapped(source)).toBe(false);
  });

  it("is the parent's priority when the agent holds the parent (claimed or proposed) or declared it", () => {
    expect(DEFAULT_PRIORITY).toBe(1);
    expect(priorityCap(held(REPAIR_PRIORITY), "agt_me")).toEqual({ cap: REPAIR_PRIORITY, reason: "parent" });
    expect(priorityCap(held(REPAIR_PRIORITY, "proposed"), "agt_me")).toEqual({ cap: REPAIR_PRIORITY, reason: "parent" });
    expect(priorityCap(mine(6), "agt_me")).toEqual({ cap: 6, reason: "parent" });
    expect(priorityCap(held(0), "agt_me")).toEqual({ cap: 0, reason: "parent" });
    expect(priorityCap(held(-3), "agt_me")).toEqual({ cap: 0, reason: "parent" });
    expect(parentIsTheirs(held(1), "agt_me")).toBe(true);
    expect(parentIsTheirs(mine(1), "agt_me")).toBe(true);
  });

  it("is the default with no parent, or under a parent the agent neither holds nor declared", () => {
    expect(priorityCap(null, "agt_me")).toEqual({ cap: 1, reason: "no-parent" });
    expect(priorityCap(undefined, "agt_me")).toEqual({ cap: 1, reason: "no-parent" });
    expect(priorityCap(others(REPAIR_PRIORITY), "agt_me")).toEqual({ cap: 1, reason: "other-parent" });
    // Assigned to the agent but no longer held (open again, landed, withdrawn): not its own.
    for (const status of ["open", "landed", "withdrawn", "abandoned"]) expect(priorityCap(held(REPAIR_PRIORITY, status), "agt_me")).toEqual({ cap: 1, reason: "other-parent" });
    // Never above the parent either: a parent below the default is the cap.
    expect(priorityCap(others(0.5), "agt_me")).toEqual({ cap: 0.5, reason: "parent" });
    // A declarer with no name owns nothing, not even a parent another unnamed caller declared.
    for (const by of ["", "unknown"]) {
      expect(priorityCap({ priority: REPAIR_PRIORITY, status: "claimed", assigned_to: by, created_by: by }, by)).toEqual({ cap: 1, reason: "other-parent" });
      expect(parentIsTheirs({ priority: 1, created_by: by }, by)).toBe(false);
    }
  });

  it("counts a parent with no usable priority as the default, so a bad row never lifts it", () => {
    for (const odd of [Number.NaN, Number.POSITIVE_INFINITY, "1000", null, undefined]) {
      expect(priorityCap(held(odd), "agt_me").cap).toBe(1);
      expect(priorityCap(others(odd), "agt_me").cap).toBe(1);
    }
  });
});

describe("grantPriority", () => {
  const held = (priority: number) => ({ priority, status: "claimed", assigned_to: "agt_me", created_by: "certify" });
  const others = (priority: number) => ({ priority, status: "claimed", assigned_to: "agt_other", created_by: "certify" });

  it("lowers an agent's priority above its cap to the cap and keeps what was asked and which cap", () => {
    expect(grantPriority(1000, "agent", null, "agt_me")).toEqual({ priority: 1, requestedPriority: 1000, priorityCap: "no-parent" });
    expect(grantPriority(1000, "agent", held(REPAIR_PRIORITY), "agt_me")).toEqual({ priority: REPAIR_PRIORITY, requestedPriority: 1000, priorityCap: "parent" });
    expect(grantPriority(1000, "agent", others(REPAIR_PRIORITY), "agt_me")).toEqual({ priority: 1, requestedPriority: 1000, priorityCap: "other-parent" });
    expect(grantPriority(2, "agent", held(1), "agt_me")).toEqual({ priority: 1, requestedPriority: 2, priorityCap: "parent" });
    expect(grantPriority(1, "agent", held(0), "agt_me")).toEqual({ priority: 0, requestedPriority: 1, priorityCap: "parent" });
  });

  it("leaves an agent's priority at or under its cap as asked, with nothing kept", () => {
    expect(grantPriority(1, "agent", null, "agt_me")).toEqual({ priority: 1 });
    expect(grantPriority(0.5, "agent", null, "agt_me")).toEqual({ priority: 0.5 });
    expect(grantPriority(REPAIR_PRIORITY, "agent", held(REPAIR_PRIORITY), "agt_me")).toEqual({ priority: REPAIR_PRIORITY });
    expect(grantPriority(4, "agent", held(SPLIT_PRIORITY), "agt_me")).toEqual({ priority: 4 });
    expect(grantPriority(1, "agent", others(REPAIR_PRIORITY), "agt_me")).toEqual({ priority: 1 });
  });

  it("never caps a person, a rule or the platform", () => {
    for (const source of ["human", "rule", "certify", "system"] as IntentSource[]) {
      expect(grantPriority(1000, source, null, "matt")).toEqual({ priority: 1000 });
      expect(grantPriority(1000, source, others(1), "matt")).toEqual({ priority: 1000 });
    }
    expect(grantPriority(REPAIR_PRIORITY, "certify", null, "certify")).toEqual({ priority: REPAIR_PRIORITY });
    expect(grantPriority(SPLIT_PRIORITY, "system", null, "megafile")).toEqual({ priority: SPLIT_PRIORITY });
  });

  it("floors at 0 and reads anything that is not a finite number as the default, as before", () => {
    expect(grantPriority(-5, "human", null, "matt")).toEqual({ priority: 0 });
    expect(grantPriority(-5, "agent", null, "agt_me")).toEqual({ priority: 0 });
    for (const odd of [undefined, null, Number.NaN, Number.POSITIVE_INFINITY, "1000", {}]) {
      expect(grantPriority(odd, "human", null, "matt")).toEqual({ priority: 1 });
      expect(grantPriority(odd, "agent", null, "agt_me")).toEqual({ priority: 1 });
    }
    // The default an agent's child of a priority-0 intent would get is above its cap.
    expect(grantPriority(undefined, "agent", held(0), "agt_me")).toEqual({ priority: 0, requestedPriority: 1, priorityCap: "parent" });
  });
});

describe("reading what was asked back", () => {
  it("reports it only while it differs from the priority now; a row without it reads as before", () => {
    expect(requestedPriorityOf(1000, 1)).toBe(1000);
    // A person raised it to what was asked: nothing more to say.
    expect(requestedPriorityOf(1000, 1000)).toBeUndefined();
    for (const none of [null, undefined, Number.NaN, "1000"]) expect(requestedPriorityOf(none, 1)).toBeUndefined();
    for (const cap of ["parent", "no-parent", "other-parent"]) expect(priorityCapOf(cap)).toBe(cap);
    for (const none of [null, undefined, "", "mine", 1]) expect(priorityCapOf(none)).toBeUndefined();
  });
});

describe("the sentence", () => {
  it("says what was asked, the cap and what the intent got, with or without a parent", () => {
    expect(priorityNote({ priority: 1, requestedPriority: 1000, priorityCap: "parent", parentId: "int_p" })).toBe(
      "You asked for priority 1000; an agent's intent takes at most its parent's priority (1), so it was declared at 1. A person can raise it.",
    );
    expect(priorityNote({ priority: 1, requestedPriority: 1000, priorityCap: "no-parent" })).toBe(
      "You asked for priority 1000; an agent's intent with no parent takes at most the default priority (1), so it was declared at 1. A person can raise it.",
    );
    expect(priorityNote({ priority: 1, requestedPriority: 1000, priorityCap: "other-parent", parentId: "int_repair" })).toBe(
      "You asked for priority 1000; its parent is not an intent you hold or declared, so it was declared at 1. A person can raise it.",
    );
    // An intent that does not say which cap applied reads it from its parent.
    expect(priorityNote({ priority: 1, requestedPriority: 1000, parentId: "int_p" })).toContain("its parent's priority (1)");
    expect(priorityNote({ priority: 1, requestedPriority: 1000 })).toContain("with no parent");
    expect(priorityNote({ priority: 2.25, requestedPriority: 3.3333333, parentId: "int_p" })).toContain("You asked for priority 3.333;");
  });

  it("is absent when the intent got what was asked", () => {
    expect(priorityNote({ priority: 1 })).toBeNull();
    expect(priorityNote({ priority: 5, requestedPriority: 5 })).toBeNull();
    expect(priorityAnswer({ priority: 1 })).toBeNull();
  });

  it("goes in a declare answer with the priority granted and the one asked", () => {
    expect(priorityAnswer({ priority: 10, requestedPriority: 1000, priorityCap: "parent", parentId: "int_repair" })).toEqual({
      priority: 10,
      requestedPriority: 1000,
      priorityNote: "You asked for priority 1000; an agent's intent takes at most its parent's priority (10), so it was declared at 10. A person can raise it.",
    });
  });
});

describe("the lineage note's fields", () => {
  it("carry both priorities only when what was asked differs", () => {
    expect(notePriority({ priority: 1, requestedPriority: 1000 })).toEqual({ priority: 1, requestedPriority: 1000 });
    expect(notePriority({ priority: 1000, requestedPriority: 1000 })).toEqual({});
    expect(notePriority({ priority: 1 })).toEqual({});
    expect(notePriority({})).toEqual({});
    expect(notePriority({ priority: "1", requestedPriority: 1000 })).toEqual({});
  });
});

describe("migratePriority", () => {
  const columns = (db: DatabaseSync): string[] => (db.prepare("PRAGMA table_info(intents)").all() as Array<{ name: string }>).map((c) => c.name);

  it("adds requested_priority and priority_cap to an older intents table once, keeping its rows, which read with none", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE intents (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, why TEXT NOT NULL, source TEXT NOT NULL, rule_id TEXT, parent_id TEXT,
      footprint TEXT NOT NULL, acceptance TEXT, priority REAL NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL,
      created_by TEXT NOT NULL, assigned_to TEXT, violations INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)`);
    db.prepare("INSERT INTO intents (id, title, why, source, footprint, priority, status, created_at, created_by, updated_at) VALUES ('int_old', 't', '', 'agent', '[]', 1000, 'open', 0, 'agt', 0)").all();
    // Run at once, as a Durable Object's exec does (an ALTER is never read back).
    const sql = {
      exec: (q: string, ...b: unknown[]) => {
        const rows = db.prepare(q).all(...b);
        return { toArray: () => rows };
      },
    };
    migratePriority(sql);
    migratePriority(sql);
    expect(columns(db).filter((c) => c === "requested_priority" || c === "priority_cap")).toEqual(["requested_priority", "priority_cap"]);
    const [row] = db.prepare("SELECT priority, requested_priority FROM intents WHERE id = 'int_old'").all() as Array<{ priority: number; requested_priority: number | null }>;
    expect(row).toEqual({ priority: 1000, requested_priority: null });
    expect(requestedPriorityOf(row!.requested_priority, row!.priority)).toBeUndefined();
  });

  it("goes on when the store cannot list a table's columns (the ALTER decides)", () => {
    const seen: string[] = [];
    migratePriority({
      exec: (q: string) => {
        seen.push(q);
        throw new Error("no such pragma");
      },
    });
    expect(seen).toEqual(["PRAGMA table_info(intents)", "ALTER TABLE intents ADD COLUMN requested_priority REAL", "ALTER TABLE intents ADD COLUMN priority_cap TEXT"]);
  });
});
