import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import git from "isomorphic-git";
import type { NoteDecision, Proposal, Sha } from "@fire_trident/core";
import type { GitRepo } from "../../src/artifacts/git.ts";
import { sortedJson } from "../../src/decide/receipt.ts";
import { checkNote, sha256Hex, trailerDigest } from "../../src/trunk/digest.ts";
import { addAgent, addIntent, api, colony, newColony, proposeEdit, take } from "./helpers.ts";
import { landed, withWriter } from "./writer.ts";

/**
 * The review receipt and people as commit authors through the real colony and trunk writer: a person's decision records
 * the head and the digest of the view its card served (decide/receipt.ts), the lineage note carries them inside its
 * digest, and a colony's commit author (colony/commitauthor.ts) authors the landing commits FireTrident commits.
 */

type Item = Proposal & { review?: Record<string, unknown>; reviewReceipt?: { head: Sha; shown: { view: string; digest?: string; clipped?: boolean } } };

const VIEW = {
  files: [{ path: "src/app/main.ts", status: "modified", added: 1, removed: 1, hunks: "@@ -1,2 +1,2 @@\n-const a = 1;\n+const a = 2;\n export {};", truncated: false }],
  filesChanged: 1,
  danger: [],
  residual: [],
};

/** An escalated proposal whose card serves VIEW. */
async function escalated(): Promise<{ colonyId: string; p: Proposal }> {
  const c = await newColony();
  await addIntent(c.id, ["src/app/main.ts"]);
  const a = await addAgent(c.id, "x");
  const p = await proposeEdit(c.id, await take(c.id, a.id), a.id);
  await colony(c.id).updateProposals([{ id: p.id, patch: { status: "escalated" } }]);
  await runInDurableObject(colony(c.id), (_instance: unknown, state: DurableObjectState) => {
    state.storage.sql.exec("CREATE TABLE IF NOT EXISTS decide_review (proposal_id TEXT PRIMARY KEY, view TEXT NOT NULL, at INTEGER NOT NULL)");
    state.storage.sql.exec("INSERT OR REPLACE INTO decide_review (proposal_id, view, at) VALUES (?, ?, ?)", p.id, JSON.stringify(VIEW), Date.now());
  });
  return { colonyId: c.id, p };
}

/** The answers of a proposal's decisions, oldest first. */
async function answers(colonyId: string, pid: string): Promise<Array<Record<string, unknown>>> {
  return runInDurableObject(colony(colonyId), (_instance: unknown, state: DurableObjectState) =>
    state.storage.sql
      .exec<{ answers: string }>("SELECT answers FROM decisions WHERE subject = ? ORDER BY at", pid)
      .toArray()
      .map((r) => JSON.parse(r.answers) as Record<string, unknown>),
  );
}

describe("a person's review receipt", () => {
  it("records the head and the digest of the view the card served, stated without Access, and hands them to the lineage note", async () => {
    const { colonyId, p } = await escalated();
    const queue = (await api<Item[]>("GET", `/colonies/${colonyId}/review`)).body;
    const item = queue.find((x) => x.id === p.id)!;
    const digest = `sha256:${await sha256Hex(sortedJson(item.review))}`;
    expect(item.reviewReceipt).toEqual({ head: p.headSha, shown: { view: "review-card", digest } });

    const res = await api("POST", `/colonies/${colonyId}/review/${p.id}`, { decision: "approve", reason: "read it", by: "matt" });
    expect(res).toEqual({ status: 200, body: { ok: true } });
    const human = (await answers(colonyId, p.id)).at(-1)!;
    expect(human).toMatchObject({ decision: "approve", by: "matt", head: p.headSha, shown: { view: "review-card", digest }, identity: "stated" });

    const ctx = (await colony(colonyId).landContext([p.intentId], [p.agentId], [p.id])) as { decisions: Record<string, NoteDecision[]> };
    expect(ctx.decisions[p.id]!.at(-1)).toMatchObject({ layer: "human", by: "matt", head: p.headSha, shown: { view: "review-card", digest }, identity: "stated" });
  });

  it("is clipped with no digest for a card that served no view", async () => {
    const { colonyId, p } = await escalated();
    await runInDurableObject(colony(colonyId), (_instance: unknown, state: DurableObjectState) => void state.storage.sql.exec("DELETE FROM decide_review WHERE proposal_id = ?", p.id));
    await api("POST", `/colonies/${colonyId}/review/${p.id}`, { decision: "return", reason: "split it", by: "matt" });
    expect((await answers(colonyId, p.id)).at(-1)).toMatchObject({ head: p.headSha, shown: { view: "review-card", clipped: true, seen: "the card served no view of the change" }, identity: "stated" });
  });
});

/** The private parts of the writer the tests read. */
interface Internals {
  repo(): GitRepo;
  sql: SqlStorage;
  env: Record<string, unknown>;
}

async function rawCommit(g: GitRepo, sha: Sha): Promise<string> {
  return new TextDecoder().decode((await git.readObject({ fs: g.fs, dir: g.dir, oid: sha, format: "content" })).object as Uint8Array);
}

describe("the receipt in the lineage note", () => {
  it("sits inside the digested note, which checks out against its commit", async () => {
    await withWriter({ "src/a.ts": "export const a = 1;\n" }, undefined, async (w) => {
      const t = w.trunk as unknown as Internals;
      const p = await w.proposal({ "src/a.ts": "export const a = 2;\n" });
      const head = p.headSha;
      const digest = `sha256:${"d".repeat(64)}`;
      const decisions: NoteDecision[] = [
        { kind: "triage", layer: "llm", p: 0.9, action: "escalate", at: 1, by: "m", head, shown: { view: "prompt-diff", digest, clipped: true, seen: "saw 20 of 22 files" }, earlier: 3 },
        { kind: "triage", layer: "human", p: 1, action: "approve", at: 2, by: "dana@example.com", head, shown: { view: "review-card", digest }, identity: "verified" },
      ];
      const l = landed(await w.trunk.land([p], { decisions: { [p.id]: decisions } }));
      const note = t.sql.exec<{ note: string }>("SELECT note FROM ft_notes WHERE landing_id = ?", l.id).one().note;
      expect(JSON.parse(note).proposals[0].decisions).toEqual(decisions);
      const message = (await git.readCommit({ fs: t.repo().fs, dir: t.repo().dir, oid: l.trunkSha })).commit.message;
      expect(await checkNote(note, trailerDigest(message)!)).toEqual({ status: "intact" });
      // Changing a receipt field is caught.
      const forged = note.replace('"identity": "verified"', '"identity": "stated"');
      expect(forged).not.toBe(note);
      expect((await checkNote(forged, trailerDigest(message)!)).status).toBe("altered");
    });
  });
});

describe("people as commit authors through the trunk writer", () => {
  it("authors each landing commit by the colony's person and commits it as FireTrident, with no Co-authored-by", async () => {
    await withWriter({ "src/a.ts": "export const a = 1;\n" }, undefined, async (w) => {
      const t = w.trunk as unknown as Internals;
      const g = t.repo();
      const colonyId = t.sql.exec<{ value: string }>("SELECT value FROM ft_meta WHERE key = 'colony_id'").one().value;
      t.env.FT_CREDIT_TRAILERS = colonyId;
      const human = [{ kind: "triage" as const, layer: "human" as const, p: 1, action: "approve" as const, by: "Lee" }];
      const ctx = (pid: string, author?: unknown) => ({ agents: { agt_test: { kind: "external" as const, model: "m", name: "scout" } }, decisions: { [pid]: human }, ...(author ? { author } : {}) });

      const before = await w.proposal({ "src/a.ts": "export const a = 2;\n" });
      const plain = await rawCommit(g, landed(await w.trunk.land([before], ctx(before.id))).trunkSha);
      expect(plain).toMatch(/\nauthor FireTrident <lanes@firetrident\.dev> \d+ \+0000\ncommitter FireTrident <lanes@firetrident\.dev> /);
      expect(plain).toContain("Co-authored-by: scout");

      const p = await w.proposal({ "src/a.ts": "export const a = 3;\n" });
      const raw = await rawCommit(g, landed(await w.trunk.land([p], ctx(p.id, { name: "Dana Reviewer", email: "dana@example.com", at: 10 }))).trunkSha);
      expect(raw).toMatch(/\nauthor Dana Reviewer <dana@example\.com> \d+ \+0000\ncommitter FireTrident <lanes@firetrident\.dev> /);
      expect(raw).not.toContain("Co-authored-by:");
      expect(raw).toContain("Approved-by: Lee");

      // A batch whose lane passed no record still lands with the setting; a newer cleared record ends it.
      const q = await w.proposal({ "src/a.ts": "export const a = 4;\n" });
      expect(await rawCommit(g, landed(await w.trunk.land([q], ctx(q.id))).trunkSha)).toMatch(/\nauthor Dana Reviewer <dana@example\.com> /);
      const r = await w.proposal({ "src/a.ts": "export const a = 5;\n" });
      expect(await rawCommit(g, landed(await w.trunk.land([r], ctx(r.id, { name: null, email: null, at: 11 }))).trunkSha)).toMatch(/\nauthor FireTrident <lanes@firetrident\.dev> /);
    });
  });

  it("is set through the API and handed to lanes with the lineage context", async () => {
    const c = await newColony();
    expect((await api("POST", `/colonies/${c.id}/commit-author`, { name: "Dana Reviewer", email: "dana@example.com" }, {})).status).toBe(401);
    const set = await api("POST", `/colonies/${c.id}/commit-author`, { name: "Dana Reviewer", email: "dana@example.com", by: "matt" });
    expect(set.status).toBe(200);
    expect(set.body.author).toMatchObject({ name: "Dana Reviewer", email: "dana@example.com", by: "matt" });
    expect((await api("GET", `/colonies/${c.id}/commit-author`, undefined, {})).body.author).toEqual({ name: "Dana Reviewer", by: "matt", at: set.body.author.at });
    type Ctx = { author?: unknown };
    expect(((await colony(c.id).landContext([], [], [])) as Ctx).author).toEqual({ name: "Dana Reviewer", email: "dana@example.com", at: set.body.author.at });
    expect((await api("POST", `/colonies/${c.id}/commit-author`, { name: null })).body).toEqual({ colonyId: c.id, author: null, cleared: true });
    expect(((await colony(c.id).landContext([], [], [])) as Ctx).author).toMatchObject({ name: null });
    const bad = await api("POST", `/colonies/${c.id}/commit-author`, { name: "Dana", email: "not an address" });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/is not one email address/);
    // A colony that never set one hands lanes nothing, as before.
    const fresh = await newColony();
    expect((await colony(fresh.id).landContext([], [], [])) as Ctx).not.toHaveProperty("author");
  });
});
