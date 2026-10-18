import { describe, expect, it, vi } from "vitest";
import type { Proposal } from "@fire_trident/core";
import type { SqlRunner } from "../../src/colony/inline.ts";
import { protectReason, type ProtectRecord } from "../../src/colony/protect.ts";
import { isFenceHeld, protectHeldReason } from "../../src/trunk/fencecheck.ts";
import { PROTECT_TABLE, cycleProtect, keepProtect, protectCheck, protectionReturns, storedProtect } from "../../src/trunk/protect.ts";

/** The trunk writer's copy of the protected-paths record and its per-cycle check (trunk/protect.ts). */

interface DatabaseSync {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
}
const SQLITE = "node:sqlite";
const { DatabaseSync } = (await import(SQLITE)) as { DatabaseSync: new (path: string) => DatabaseSync };

function store(): SqlRunner {
  const db = new DatabaseSync(":memory:");
  const sql: SqlRunner = {
    exec: (q, ...b) => {
      const rows = db.prepare(q).all(...b);
      return { toArray: () => rows };
    },
  };
  sql.exec(PROTECT_TABLE);
  sql.exec(PROTECT_TABLE); // repeatable
  return sql;
}

const V1: ProtectRecord = { version: 1, globs: [{ glob: "src/auth/**", at: 5_000 }] };
const V2: ProtectRecord = { version: 2, globs: [] };

function change(id: string, path: string): Proposal {
  return {
    id,
    colonyId: "col",
    intentId: `int_${id}`,
    agentId: "agt_a",
    workspace: { namespace: "ft-ws-0", name: "col--ws-1", remote: "https://artifacts.invalid/ws.git" },
    baseSha: "1".repeat(40),
    headSha: "2".repeat(40),
    writeSet: [{ path, blob: "b".repeat(40) }],
    readSet: [],
    declared: { footprint: [path], summary: id },
    evidence: { checks: [] },
    status: "ready",
    createdAt: 1,
  };
}

describe("the trunk writer's record", () => {
  it("keeps a record only when it is newer, and reads it back", () => {
    const sql = store();
    expect(storedProtect(sql)).toBeUndefined();
    expect(keepProtect(sql, V1, 1)).toEqual(V1);
    expect(keepProtect(sql, JSON.stringify(V2), 2)).toEqual(V2);
    expect(keepProtect(sql, V1, 3)).toEqual(V2);
    expect(keepProtect(sql, { nonsense: true }, 4)).toEqual(V2);
    expect(storedProtect(sql)).toEqual(V2);
  });

  it("checks against the newest of its own record and the ones lanes passed", () => {
    expect(cycleProtect(V1, [undefined, { protect: V2 }, { protect: "garbage" }])).toEqual(V2);
    expect(cycleProtect(V2, [{ protect: V1 }])).toEqual(V2);
    expect(cycleProtect(undefined, [])).toBeUndefined();
  });
});

describe("the per-cycle protection check", () => {
  it("sends back a covered change no person approved since the glob was protected, and lets the rest through", () => {
    const a = change("prp_a", "src/auth/x.ts");
    const b = change("prp_b", "src/auth/y.ts");
    const c = change("prp_c", "src/lib/z.ts");
    const ctx = { decisions: { prp_b: [{ kind: "triage", layer: "human", p: 1, action: "approve", at: 6_000 }] } };
    const out = protectionReturns(V1, [a, b, c].map((p) => ({ p, ctx })));
    expect([...out]).toEqual([["prp_a", protectReason([{ path: "src/auth/x.ts", glob: "src/auth/**" }])]]);
    expect(protectionReturns(undefined, [{ p: a, ctx }]).size).toBe(0);
  });

  it("reads the stored record once a cycle, keeps a newer one a lane passed, and stops by it", () => {
    const sql = store();
    keepProtect(sql, V2, 1);
    const a = change("prp_a", "src/auth/x.ts");
    // The lane read a newer record than the writer's own: it is kept and used.
    const newer: ProtectRecord = { version: 3, globs: [{ glob: "src/auth/**", at: 7_000 }] };
    expect([...protectCheck(sql, [{ p: a, ctx: { protect: newer } }], 10).returned].map(([id]) => id)).toEqual(["prp_a"]);
    expect(storedProtect(sql)).toEqual(newer);
    // A lane that read an older record changes nothing.
    expect([...protectCheck(sql, [{ p: a, ctx: { protect: V1 } }], 11).returned].map(([id]) => id)).toEqual(["prp_a"]);
    expect(storedProtect(sql)).toEqual(newer);
  });

  it("fails closed: when its record cannot be read it holds every change for the next cycle, landing none and sending none to a person", () => {
    const broken: SqlRunner = {
      exec: () => {
        throw new Error("disk on fire");
      },
    };
    const a = change("prp_a", "src/auth/x.ts");
    const b = change("prp_b", "src/lib/z.ts");
    // Even a lane's record does not stand in for the writer's own: it may be older than a glob the colony just protected.
    const out = protectCheck(broken, [{ p: a, ctx: { protect: V1 } }, { p: b, ctx: undefined }], 1);
    expect(out.returned.size).toBe(0);
    expect([...out.held.keys()]).toEqual(["prp_a", "prp_b"]);
    expect(out.problem).toBe("the protected paths could not be read: disk on fire");
    const reason = out.held.get("prp_b")!;
    expect(reason).toBe(protectHeldReason("disk on fire"));
    expect(reason).toBe(
      "waiting for the next landing cycle: the protected-path check could not read the colony's protected paths (disk on fire), so the change was neither landed nor sent to a person; once the check can run it lands, or goes to a person if it writes a protected path",
    );
    // Its lane keeps it as it keeps one the direction fence held.
    expect(isFenceHeld(reason)).toBe(true);
  });

  it("holds the cycle's changes when the stored record does not parse, and checks again once it does", () => {
    const sql = store();
    sql.exec("INSERT INTO ft_protected (k, record, at) VALUES ('record', '{not json', 1)");
    const a = change("prp_a", "src/lib/z.ts");
    expect([...protectCheck(sql, [{ p: a, ctx: undefined }], 2).held.keys()]).toEqual(["prp_a"]);
    sql.exec("DELETE FROM ft_protected");
    expect(protectCheck(sql, [{ p: a, ctx: undefined }], 3)).toEqual({ returned: new Map(), held: new Map(), problem: null });
  });

  it("still checks when only keeping a lane's newer record fails, and says so", () => {
    let writes = 0;
    const db = store();
    const flaky: SqlRunner = {
      exec: (q, ...b) => {
        if (/^INSERT/.test(q)) {
          writes++;
          throw new Error("read-only");
        }
        return db.exec(q, ...b);
      },
    };
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const out = protectCheck(flaky, [{ p: change("prp_a", "src/auth/x.ts"), ctx: { protect: V1 } }], 1);
      expect([...out.returned.keys()]).toEqual(["prp_a"]);
      expect(out.held.size).toBe(0);
      expect(writes).toBe(1);
      expect(error).toHaveBeenCalledWith("protection check: a lane's newer record was not kept: read-only");
    } finally {
      error.mockRestore();
    }
  });
});
