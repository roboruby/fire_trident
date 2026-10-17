import { describe, expect, it } from "vitest";
import type { Intent, Proposal } from "@fire_trident/core";
import { readLifecycle, type LifecycleHost } from "../../src/colony/lifecycle.ts";
import type { SqlRunner } from "../../src/colony/inline.ts";

/** The lifecycle read (colony/lifecycle.ts) on the colony's own tables: what it reads, and how it places certification. */

interface DatabaseSync {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
}
const SQLITE = "node:sqlite";
const { DatabaseSync } = (await import(SQLITE)) as { DatabaseSync: new (path: string) => DatabaseSync };

const T0 = 1_800_000_000_000;
const sha = (c: string) => c.repeat(40);

function sqlite(): SqlRunner {
  const db = new DatabaseSync(":memory:");
  const sql: SqlRunner = {
    exec: (q, ...b) => {
      const rows = db.prepare(q).all(...(b as never[]));
      return { toArray: () => rows };
    },
  };
  sql.exec("CREATE TABLE proposals (id TEXT PRIMARY KEY, intent_id TEXT NOT NULL, agent_id TEXT NOT NULL, status TEXT NOT NULL, region TEXT NOT NULL, priority REAL NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, data TEXT NOT NULL)");
  sql.exec("CREATE TABLE decisions (id TEXT PRIMARY KEY, kind TEXT NOT NULL, subject TEXT NOT NULL, layer TEXT NOT NULL, answers TEXT NOT NULL, p REAL NOT NULL, action TEXT NOT NULL, at INTEGER NOT NULL, escalated_from TEXT)");
  sql.exec("CREATE TABLE agents (id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, model TEXT, thresholds TEXT NOT NULL DEFAULT '{}', state TEXT NOT NULL, intent_id TEXT, workspace TEXT, last_seen INTEGER NOT NULL, created_at INTEGER NOT NULL)");
  sql.exec("CREATE TABLE landings (id TEXT PRIMARY KEY, at INTEGER NOT NULL, received_at INTEGER NOT NULL, trunk_sha TEXT NOT NULL, data TEXT NOT NULL)");
  return sql;
}

function certifications(sql: SqlRunner): void {
  sql.exec("CREATE TABLE certifications (trunk_sha TEXT PRIMARY KEY, landing_id TEXT, status TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER, inputs TEXT, test_key TEXT, data TEXT NOT NULL)");
}

function certify(sql: SqlRunner, trunkSha: string, status: string, at: number, detail?: string): void {
  sql.exec("INSERT INTO certifications (trunk_sha, status, started_at, finished_at, data) VALUES (?, ?, ?, ?, ?)", trunkSha, status, at, at + 10, JSON.stringify({ trunkSha, status, startedAt: at, finishedAt: at + 10, ...(detail ? { detail } : {}) }));
}

const gate = { name: "gate", ok: true, ms: 0, detail: "R3 innate+autonomy → land by reflex at head 9a7220a8f2f2 (confirmations: innate + autonomy): reasons", gate: { rule: "R3 innate+autonomy", preset: "production", values: [{ name: "confidence", value: 0.93, op: "≥", bound: 0.85 }] } };

function propose(sql: SqlRunner, p: Partial<Proposal> & { id: string; status: Proposal["status"] }, at: number): void {
  const data = { intentId: "int_1", agentId: "agt_1", evidence: { checks: [{ name: "agent: lint", ok: true, ms: 1, detail: "own check", by: "agent" }, gate] }, ...p };
  sql.exec("INSERT INTO proposals (id, intent_id, agent_id, status, region, created_at, updated_at, data) VALUES (?, 'int_1', ?, ?, 'src', ?, ?, ?)", p.id, data.agentId, p.status, at, at + 500, JSON.stringify(data));
}

function landing(sql: SqlRunner, id: string, trunkSha: string, parentSha: string, at: number, paths = ["src/a.ts"]): void {
  sql.exec("INSERT INTO landings (id, at, received_at, trunk_sha, data) VALUES (?, ?, ?, ?, ?)", id, at, at, trunkSha, JSON.stringify({ id, trunkSha, parentSha, paths, at }));
}

const intent = (over: Partial<Intent> = {}): Intent => ({ id: "int_1", colonyId: "web", title: "Add a limit", why: "w", source: "human", footprint: ["src/a.ts"], priority: 1, status: "landed", createdAt: T0, createdBy: "Lee", ...over });

/** A host over `sql` whose trunk writer orders the commits given (index = place on trunk's chain). */
function host(sql: SqlRunner, chain: string[], over: Partial<LifecycleHost> = {}): LifecycleHost & { asked: string[][] } {
  const asked: string[][] = [];
  return {
    sql,
    colonyId: "web",
    intent: intent(),
    updatedAt: T0 + 9_000,
    trunk: () => ({
      commitOrder: async (shas) => {
        asked.push(shas);
        return Object.fromEntries(shas.flatMap((s) => (chain.includes(s) ? [[s, chain.indexOf(s)]] : [])));
      },
    }),
    off: () => null,
    asked,
    ...over,
  };
}

describe("the lifecycle read", () => {
  it("a landed change: the agent, its decisions, the landing, and the first green certification at or after it", async () => {
    const sql = sqlite();
    certifications(sql);
    sql.exec("INSERT INTO agents (id, kind, name, model, state, last_seen, created_at) VALUES ('agt_1', 'external', 'byo', 'claude-x', 'idle', 0, 0)");
    propose(sql, { id: "prp_old", status: "returned", reason: "stale: src/a.ts changed", movedBy: [{ landingId: "lnd_0", paths: ["src/a.ts"], trunkSha: sha("0"), title: "Earlier work" }] }, T0 + 1_000);
    propose(sql, { id: "prp_1", status: "landed", landingId: "lnd_1" }, T0 + 2_000);
    sql.exec("INSERT INTO decisions (id, kind, subject, layer, answers, p, action, at) VALUES ('d1', 'triage', 'prp_1', 'reflex', '{}', 0.93, 'land', ?)", T0 + 2_100);
    landing(sql, "lnd_0", sha("0"), sha("f"), T0 + 1_200);
    landing(sql, "lnd_1", sha("1"), sha("0"), T0 + 3_000);
    certify(sql, sha("0"), "red", T0 + 1_300);
    certify(sql, sha("2"), "green", T0 + 4_000);
    const h = host(sql, [sha("f"), sha("0"), sha("1"), sha("2")]);
    const l = await readLifecycle(h);
    expect(l.current.proposalId).toBe("prp_1");
    expect(l.current.steps.map((s) => s.state)).toEqual(["done", "done", "done", "done", "done", "done", "outside", "outside"]);
    expect(l.current.steps[1]).toMatchObject({ text: "byo (outside agent, claude-x)" });
    expect(l.current.steps[3]).toMatchObject({ text: "earned autonomy: R3: confidence 0.93 ≥ 0.85", at: T0 + 2_100 });
    expect(l.current.steps[4]).toMatchObject({ text: `lnd_1 · 1111111`, at: T0 + 3_000 });
    expect(l.current.steps[5]).toMatchObject({ text: "certified commit 2222222 includes it", at: T0 + 4_010 });
    // The earlier change went back, beaten by the landing that moved its file.
    expect(l.changes.map((c) => c.proposalId)).toEqual(["prp_1", "prp_old"]);
    expect(l.changes[1]!.off).toMatchObject({ kind: "returned", after: "confirmed", text: "stale: src/a.ts changed", beatenBy: { landingId: "lnd_0", title: "Earlier work" }, at: T0 + 1_500 });
    // One call places every commit.
    expect(h.asked).toHaveLength(1);
  });

  it("no tests this platform can run, trunk red, certification off, and a trunk writer that cannot place the commit", async () => {
    const sql = sqlite();
    certifications(sql);
    propose(sql, { id: "prp_1", status: "landed", landingId: "lnd_1" }, T0);
    landing(sql, "lnd_1", sha("1"), sha("0"), T0 + 100);
    // A run before it found nothing to run, and none ran after (none does until a test file comes).
    certify(sql, sha("0"), "skipped", T0 - 1_000, "no test file on trunk");
    const none = await readLifecycle(host(sql, [sha("0"), sha("1")]));
    expect(none.current.steps[5]).toMatchObject({ state: "none", text: "no tests this platform can run: no test file on trunk" });
    expect(none.current.reached).toBe("landed");

    certify(sql, sha("1"), "red", T0 + 200);
    expect((await readLifecycle(host(sql, [sha("0"), sha("1")]))).current.steps[5]).toMatchObject({ state: "todo", text: "not certified yet: trunk is red at 1111111" });

    const broken = host(sql, [], { trunk: () => ({ commitOrder: async () => Promise.reject(new Error("no such method")) }) });
    expect((await readLifecycle(broken)).current.steps[5]?.text).toBe("not known here: the trunk writer could not place its commit just now (no such method); ask again in a moment");

    const bare = sqlite();
    propose(bare, { id: "prp_1", status: "landed", landingId: "lnd_1" }, T0);
    landing(bare, "lnd_1", sha("1"), sha("0"), T0 + 100);
    const off = await readLifecycle(host(bare, [], { off: () => "trunk certification is off on this deployment" }));
    expect(off.current.steps[5]?.text).toBe("not certified yet: trunk certification is off on this deployment");
  });

  it("an intent no agent has proposed for, one held, one reaped, and a withdrawn one", async () => {
    const sql = sqlite();
    const open = await readLifecycle(host(sql, [], { intent: intent({ status: "open" }) }));
    expect([open.current.reached, open.current.off, open.changes]).toEqual(["declared", undefined, []]);

    sql.exec("INSERT INTO agents (id, kind, name, state, intent_id, workspace, last_seen, created_at) VALUES ('agt_2', 'internal', 'worker-2', 'working', 'int_1', ?, 0, 0)", JSON.stringify({ leasedAt: T0 + 50 }));
    const held = await readLifecycle(host(sql, [], { intent: intent({ status: "claimed", assignedTo: "agt_2" }) }));
    expect(held.current.steps[1]).toMatchObject({ state: "done", text: "worker-2 (in-platform agent)", at: T0 + 50 });

    sql.exec("INSERT INTO agents (id, kind, name, state, last_seen, created_at) VALUES ('agt_w', 'external', 'walker', 'idle', 0, 0)");
    const reaped = await readLifecycle(host(sql, [], { intent: intent({ status: "open", closure: { cause: "reaped_silent", at: T0 + 700, status: "open", agentId: "agt_w", gapMs: 660_000 } }) }));
    expect(reaped.current.off).toMatchObject({ kind: "reaped", after: "claimed", text: "the colony took it back: walker was silent for 11 min; it is open for the next agent", at: T0 + 700 });

    const withdrawn = await readLifecycle(host(sql, [], { intent: intent({ status: "withdrawn", withdrawnReason: "not needed" }), updatedAt: T0 + 800 }));
    expect(withdrawn.current.off).toMatchObject({ kind: "withdrawn", text: "not needed", at: T0 + 800 });
  });

  it("an escalated change, and a security return whose failing checks stay with the reviewers", async () => {
    const sql = sqlite();
    const escalate = { ...gate, ok: false, detail: "P3 protected path → escalate by deterministic at head 1 (confirmations: ): protected", gate: { rule: "P3 protected path", preset: "production", values: [] } };
    propose(sql, { id: "prp_e", status: "escalated", reason: "escalated by deterministic: protected path src/auth.ts", evidence: { checks: [escalate] } }, T0);
    const e = await readLifecycle(host(sql, [], { intent: intent({ status: "proposed", assignedTo: "agt_1" }) }));
    expect(e.current.off).toMatchObject({ kind: "escalated", after: "proposed", text: "waiting for a person: escalated by deterministic: protected path src/auth.ts" });

    const secret = { name: "reflex: @cf/x", ok: false, ms: 1, detail: "needs_human 0.9: eval of a request header in src/run.ts:12" };
    propose(sql, { id: "prp_s", status: "returned", reason: "returned for review: security (danger)", evidence: { checks: [secret, { ...gate, ok: false, detail: "R5 → return by reflex at head 1 (confirmations: ): danger" }] } }, T0 + 10);
    const s = await readLifecycle(host(sql, [], { intent: intent({ status: "proposed", assignedTo: "agt_1" }) }));
    // The change waiting for a person is the one the intent stands on; the security return is listed with it.
    expect(s.current.proposalId).toBe("prp_e");
    expect(JSON.stringify(s)).not.toContain("request header");
    expect(s.changes.find((c) => c.proposalId === "prp_s")?.off).toMatchObject({ kind: "returned", after: "proposed", text: "returned for review: security (danger)" });
  });
});
