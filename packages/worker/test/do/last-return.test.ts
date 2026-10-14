import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Id, Intent } from "@fire_trident/core";
import type { LastReturn } from "../../src/agents/prompt.ts";
import type { Assignment } from "./helpers.ts";
import { addAgent, addIntent, api, colony, externalLanding, newColony, proposal, proposeEdit, take, tick } from "./helpers.ts";

/**
 * Agents learn from returns: a take hands the agent why the intent's latest change came back (the
 * reason that change's agent was given, the proposal, when, and the paths it wrote). Changes that went
 * back because the direction changed or because they lost a contest are skipped, and once a change for
 * the intent has landed there is nothing to show.
 */

/** Past the colony's shared field reading, which may still hold the claims cleared by the return. */
const pastSharedReading = (): Promise<void> => new Promise((r) => setTimeout(r, 300));

const lastReturnOf = (a: Assignment): LastReturn | undefined => (a as Assignment & { lastReturn?: LastReturn }).lastReturn;

/** Store a proposal row for an intent as the colony keeps it (a past outcome, without the path that led there). */
async function pastProposal(colonyId: string, intentId: Id, p: { id: string; status: string; at: number; reason?: string; supersededBy?: string; writes?: string[]; checks?: unknown[] }): Promise<void> {
  const data = {
    id: p.id,
    colonyId,
    intentId,
    agentId: "agt_past",
    status: p.status,
    createdAt: p.at,
    writeSet: (p.writes ?? ["src/lib/util.ts"]).map((path) => ({ path, blob: "1".repeat(40) })),
    readSet: [],
    declared: { footprint: ["src/lib/util.ts"], summary: "past" },
    evidence: { checks: p.checks ?? [] },
    ...(p.reason !== undefined ? { reason: p.reason } : {}),
    ...(p.supersededBy ? { supersededBy: p.supersededBy } : {}),
  };
  await runInDurableObject(colony(colonyId), (_i: unknown, state: DurableObjectState) => {
    state.storage.sql.exec(
      "INSERT INTO proposals (id, intent_id, agent_id, status, region, priority, created_at, updated_at, data) VALUES (?, ?, 'agt_past', ?, 'src', 1, ?, ?, ?)",
      p.id,
      intentId,
      p.status,
      p.at,
      p.at + 500,
      JSON.stringify(data),
    );
  });
}

describe("take: why the intent's latest change came back", () => {
  it("hands the next taker a stale return's reason, proposal, time and paths, and nothing before any return", async () => {
    const c = await newColony();
    const i = await addIntent(c.id, ["src/lib/util.ts"]);
    const a = await addAgent(c.id, "a");
    const first = await take(c.id, a.id);
    expect(lastReturnOf(first)).toBeUndefined();
    // Trunk moves under the agent: its change goes back stale.
    await externalLanding(c.id, { "src/lib/util.ts": "export const changed = true;\n" });
    const p = await proposeEdit(c.id, first, a.id);
    await tick(c.id, "src");
    const back = await proposal(c.id, p.id);
    expect(back.status).toBe("returned");
    // Another agent takes the reopened intent: it sees why the last change came back.
    const b = await addAgent(c.id, "b");
    await pastSharedReading();
    const again = await take(c.id, b.id);
    expect(again.intent.id).toBe(i.id);
    const last = lastReturnOf(again)!;
    // With the landing that moved the file (colony/movedby.ts): this one changed trunk outside any intent.
    const moved = [{ landingId: expect.stringMatching(/^lnd_external_/), paths: ["src/lib/util.ts"], trunkSha: expect.stringMatching(/^[0-9a-f]{40}$/), at: expect.any(Number) }];
    expect(last).toEqual({ proposalId: p.id, status: "returned", at: expect.any(Number), reason: back.reason, paths: ["src/lib/util.ts"], movedBy: moved });
    expect(last.reason).toMatch(/^stale: 1 path changed on trunk since read: src\/lib\/util\.ts/);
    expect(last.at).toBeGreaterThanOrEqual(back.createdAt);
    // A repeated take hands the same back.
    expect(lastReturnOf(await take(c.id, b.id))).toEqual(last);
  });

  it("shows a person's rejection, and keeps it when the next change goes back because the intent was revised", async () => {
    const c = await newColony();
    const i = await addIntent(c.id, ["src/lib/util.ts"]);
    const a = await addAgent(c.id, "a");
    const t1 = await take(c.id, a.id);
    const p1 = await proposeEdit(c.id, t1, a.id);
    expect((await api("POST", `/colonies/${c.id}/review/${p1.id}`, { decision: "reject", reason: "this rewrites the session cookie; keep it", by: "matt" })).status).toBe(200);
    expect((await proposal(c.id, p1.id)).status).toBe("rejected");
    const b = await addAgent(c.id, "b");
    await pastSharedReading();
    const t2 = await take(c.id, b.id);
    expect(t2.intent.id).toBe(i.id);
    expect(lastReturnOf(t2)).toMatchObject({ proposalId: p1.id, status: "rejected", reason: "this rewrites the session cookie; keep it", paths: ["src/lib/util.ts"] });
    // B proposes; a person revises the intent while it is in flight, so it goes back as a change of direction.
    const p2 = await proposeEdit(c.id, t2, b.id);
    expect((await api("PATCH", `/colonies/${c.id}/intents/${i.id}`, { why: "test, and leave the session cookie alone", reason: "clarify" })).status).toBe(200);
    expect((await proposal(c.id, p2.id)).reason).toMatch(/^intent revised: /);
    // B keeps the intent: its take hands it back at the new revision, and the rejection is still the last return.
    const t3 = await take(c.id, b.id);
    expect(t3.intent).toMatchObject({ id: i.id, revision: 2 });
    expect(lastReturnOf(t3)).toMatchObject({ proposalId: p1.id, status: "rejected" });
  });

  it("skips contest losses and changes of direction, carries a security return's class and nothing more, and caps the paths", async () => {
    const c = await newColony();
    const i = await addIntent(c.id, ["src/lib/util.ts"]);
    const many = Array.from({ length: 25 }, (_, n) => `src/lib/f${String(n).padStart(2, "0")}.ts`);
    const security = "returned for review: security (sensitive); details are with the reviewers, and a person reviews this intent's next proposal";
    await pastProposal(c.id, i.id, { id: "prp_stale", status: "returned", at: 1_000, reason: "stale: src/lib/util.ts (expected 1111111111, trunk 2222222222)" });
    await pastProposal(c.id, i.id, { id: "prp_sec", status: "returned", at: 2_000, reason: security, writes: many, checks: [{ name: "innate: residual", ok: false, ms: 1, detail: "SECRET-DETAIL wrote outside the footprint" }] });
    await pastProposal(c.id, i.id, { id: "prp_recalled", status: "returned", at: 3_000, reason: "superseded: recalled by its agent" });
    await pastProposal(c.id, i.id, { id: "prp_withdrawn", status: "returned", at: 4_000, reason: "withdrawn: rule rul_1 retracted: too strict" });
    await pastProposal(c.id, i.id, { id: "prp_lost", status: "returned", at: 5_000, reason: "superseded: contest for x won by prp_win (smaller diff)", supersededBy: "prp_win" });
    const a = await addAgent(c.id);
    const got = await take(c.id, a.id);
    expect(lastReturnOf(got)).toEqual({ proposalId: "prp_sec", status: "returned", at: 2_500, reason: security, paths: many.slice(0, 20), morePaths: 5 });
    expect(JSON.stringify(got)).not.toContain("SECRET-DETAIL");
  });

  it("shows nothing once a change for the intent landed after the return", async () => {
    const c = await newColony();
    const i = await addIntent(c.id, ["src/lib/util.ts"]);
    await pastProposal(c.id, i.id, { id: "prp_review", status: "returned", at: 1_000, reason: "llm: the change does not handle an empty slug" });
    await pastProposal(c.id, i.id, { id: "prp_landed", status: "landed", at: 2_000 });
    const a = await addAgent(c.id);
    const got = await take(c.id, a.id);
    expect(got.intent.id).toBe(i.id);
    expect(lastReturnOf(got)).toBeUndefined();
  });

  it("reads an intent's proposals through the per-intent index the take creates", async () => {
    const c = await newColony();
    const i = await addIntent(c.id, ["src/lib/util.ts"]);
    const a = await addAgent(c.id);
    await take(c.id, a.id);
    const plan = (await runInDurableObject(colony(c.id), (_i: unknown, state: DurableObjectState) =>
      state.storage.sql
        .exec<{ detail: string }>(
          "EXPLAIN QUERY PLAN SELECT id, status, updated_at, json_extract(data, '$.reason') AS reason FROM proposals WHERE intent_id = ? AND status IN ('returned', 'rejected', 'landed') ORDER BY created_at DESC LIMIT 10",
          i.id,
        )
        .toArray()
        .map((r) => r.detail)
        .join("\n"),
    )) as string;
    expect(plan).toContain("proposals_by_intent");
    expect(plan).not.toContain("TEMP B-TREE");
  });

  it("still hands out work when a stored proposal cannot be read", async () => {
    const c = await newColony();
    const i = await addIntent(c.id, ["src/lib/util.ts"]);
    await runInDurableObject(colony(c.id), (_i: unknown, state: DurableObjectState) => {
      state.storage.sql.exec("INSERT INTO proposals (id, intent_id, agent_id, status, region, priority, created_at, updated_at, data) VALUES ('prp_bad', ?, 'agt_x', 'returned', 'src', 1, 1, 1, '{not json')", i.id);
    });
    const a = await addAgent(c.id);
    const got = await take(c.id, a.id);
    expect(got.intent.id).toBe(i.id);
    expect(lastReturnOf(got)).toBeUndefined();
    expect(((await colony(c.id).getIntent(i.id)) as Intent).status).toBe("claimed");
  });
});

