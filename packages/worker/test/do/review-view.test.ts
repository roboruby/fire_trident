import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Proposal } from "@fire_trident/core";
import { addAgent, addIntent, api, colony, newColony, proposeEdit, take } from "./helpers.ts";

/** A review queue item as GET /review sends it: the proposal plus the change kept for its reviewer. */
type Item = Proposal & { review?: unknown };

/** The view the decide engine keeps for an escalated proposal (the contract the queue reads). */
const VIEW = {
  files: [{ path: "src/app/main.ts", status: "modified", added: 1, removed: 1, hunks: "@@ -1,2 +1,2 @@\n-const a = 1;\n+const token = req.header('Authorization');\n export {};", truncated: false }],
  filesChanged: 1,
  danger: [{ path: "src/app/main.ts", line: 1, cls: "auth", pattern: "auth:authorization-header", label: "auth (authorization-header) at src/app/main.ts:1: const token = req.header('Authorization');" }],
  residual: ["src/app/extra.ts"],
};

/** Two escalated proposals in a fresh colony. */
async function escalatedPair(): Promise<{ colonyId: string; a: Proposal; b: Proposal }> {
  const c = await newColony();
  await addIntent(c.id, ["src/app/main.ts"]);
  await addIntent(c.id, ["docs/guide.md"]);
  const x = await addAgent(c.id, "x");
  const y = await addAgent(c.id, "y");
  const a = await proposeEdit(c.id, await take(c.id, x.id), x.id);
  const b = await proposeEdit(c.id, await take(c.id, y.id), y.id);
  await colony(c.id).updateProposals([
    { id: a.id, patch: { status: "escalated" } },
    { id: b.id, patch: { status: "escalated" } },
  ]);
  return { colonyId: c.id, a, b };
}

/** Write rows the way the decide engine does (the table is created here when this build does not create it). */
async function keep(colonyId: string, rows: Array<[string, string]>): Promise<void> {
  await runInDurableObject(colony(colonyId), (_instance: unknown, state: DurableObjectState) => {
    state.storage.sql.exec("CREATE TABLE IF NOT EXISTS decide_review (proposal_id TEXT PRIMARY KEY, view TEXT NOT NULL, at INTEGER NOT NULL)");
    for (const [id, view] of rows) state.storage.sql.exec("INSERT OR REPLACE INTO decide_review (proposal_id, view, at) VALUES (?, ?, ?)", id, view, Date.now());
  });
}

async function queue(colonyId: string): Promise<Map<string, Item>> {
  const res = await api<Item[]>("GET", `/colonies/${colonyId}/review`);
  expect(res.status).toBe(200);
  return new Map(res.body.map((p) => [p.id, p]));
}

describe("review queue: the change kept for the reviewer", () => {
  it("sends the queue as before when no view was kept", async () => {
    const { colonyId, a, b } = await escalatedPair();
    const q = await queue(colonyId);
    expect([...q.keys()].sort()).toEqual([a.id, b.id].sort());
    expect([...q.values()].some((p) => "review" in p)).toBe(false);
  });

  it("builds the view of a proposal escalated before views were kept, for the next read", async () => {
    const { colonyId, a } = await escalatedPair();
    const built = await runInDurableObject(colony(colonyId), async (instance: unknown) => {
      const engine = (instance as { decider(): { backfillReview(id: string): Promise<boolean> } }).decider();
      return [await engine.backfillReview(a.id), await engine.backfillReview(a.id)];
    });
    expect(built).toEqual([true, false]); // built once, then left alone
    const q = await queue(colonyId);
    const view = q.get(a.id)?.review as { files: Array<{ path: string }> } | undefined;
    expect(view?.files.map((f) => f.path)).toContain("src/app/main.ts");
  });


  it("still sends the queue when the table has another shape", async () => {
    const { colonyId, a, b } = await escalatedPair();
    await runInDurableObject(colony(colonyId), (_instance: unknown, state: DurableObjectState) => {
      // The decide store creates the real table; replace it with a foreign shape.
      state.storage.sql.exec("DROP TABLE IF EXISTS decide_review");
      state.storage.sql.exec("CREATE TABLE decide_review (proposal_id TEXT PRIMARY KEY, payload TEXT)");
      state.storage.sql.exec("INSERT INTO decide_review (proposal_id, payload) VALUES (?, ?)", a.id, JSON.stringify(VIEW));
    });
    const q = await queue(colonyId);
    expect([...q.keys()].sort()).toEqual([a.id, b.id].sort());
    expect([...q.values()].some((p) => "review" in p)).toBe(false);
  });

  it("attaches the kept view and copies only the reviewer's fields", async () => {
    const { colonyId, a, b } = await escalatedPair();
    const extra = {
      ...VIEW,
      files: [{ ...VIEW.files[0], addedLines: ["const password = 'hunter2';"], removedLines: [] }],
      state: { diff: "everything" },
    };
    await keep(colonyId, [[a.id, JSON.stringify(extra)]]);
    const q = await queue(colonyId);
    expect(q.get(a.id)?.review).toEqual(VIEW);
    expect(q.get(a.id)).toMatchObject({ id: a.id, status: "escalated", intentId: a.intentId });
    expect(q.get(b.id) && "review" in q.get(b.id)!).toBe(false);
    // The RPC carries the same.
    const rpc = (await colony(colonyId).review()) as Item[];
    expect(rpc.find((p) => p.id === a.id)?.review).toEqual(VIEW);
  });

  it("skips rows that do not parse or hold nothing, and repairs partial ones", async () => {
    const { colonyId, a, b } = await escalatedPair();
    await keep(colonyId, [
      [a.id, "{not json"],
      [b.id, JSON.stringify({ files: "x", danger: [{ path: 3 }], residual: [1], filesChanged: 4 })],
    ]);
    let q = await queue(colonyId);
    expect(q.size).toBe(2);
    expect([...q.values()].some((p) => "review" in p)).toBe(false);

    await keep(colonyId, [
      [
        a.id,
        JSON.stringify({
          files: [{ path: "src/app/main.ts", added: "2", hunks: 7, truncated: "yes" }, { status: "added" }, null, "src/x.ts"],
          filesChanged: -3,
          danger: [{ path: "src/app/main.ts", line: "9", cls: "secret" }, { path: "src/app/main.ts", line: 2.7, cls: "auth", pattern: "auth:jwt", label: "jwt" }],
        }),
      ],
      [b.id, "null"],
    ]);
    q = await queue(colonyId);
    expect(q.get(a.id)?.review).toEqual({
      files: [{ path: "src/app/main.ts", status: "", added: 0, removed: 0, hunks: "", truncated: false }],
      filesChanged: 1,
      danger: [
        { path: "src/app/main.ts", line: 0, cls: "secret", pattern: "", label: "" },
        { path: "src/app/main.ts", line: 2, cls: "auth", pattern: "auth:jwt", label: "jwt" },
      ],
      residual: [],
    });
    expect("review" in q.get(b.id)!).toBe(false);
  });

  it("keeps the reply bounded: a view past the budget is left off, the others still come", async () => {
    const { colonyId, a, b } = await escalatedPair();
    const huge = { ...VIEW, files: [{ ...VIEW.files[0], hunks: `@@ -1,1 +1,1 @@\n+${"x".repeat(1_100_000)}`, truncated: true }] };
    await keep(colonyId, [
      [a.id, JSON.stringify(huge)],
      [b.id, JSON.stringify(VIEW)],
    ]);
    const q = await queue(colonyId);
    expect("review" in q.get(a.id)!).toBe(false);
    expect(q.get(b.id)?.review).toEqual(VIEW);
  });
});
