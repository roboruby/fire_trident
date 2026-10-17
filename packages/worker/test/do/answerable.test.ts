import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { landingAnswerable } from "@fire_trident/core";
import type { CheckResult, Landing, LineageNote, Sha } from "@fire_trident/core";
import { resolveLocal, type GitRepo } from "../../src/artifacts/git.ts";
import { addNotes } from "../../src/trunk/notes.ts";
import { addAgent, addIntent, api, colony, newColony, proposeEdit, take } from "./helpers.ts";
import { landed, withWriter } from "./writer.ts";

/**
 * Who answers for a landing, through the real trunk writer and the colony: the land context carries who declared each
 * intent and who approved its rule, the note keeps them and the landing its answer, older notes without them still
 * check out, and the colony's metrics count the landings no person is answerable for.
 */

interface Internals {
  repo(): GitRepo;
  sql: SqlStorage;
  remoteNotesTip(): Promise<Sha | null>;
}

const REMOTE = "refs/notes/remote-copy";
const proofGate: CheckResult = { name: "gate", ok: true, ms: 0, detail: "D3 innate+proof → land by deterministic at head ffffffffffff (confirmations: innate + deterministic): deterministic proof: 1 file proven" };

describe("the lineage note names who asked and who approved the rule", () => {
  it("writes them for new landings, marks each landing's answer, and older notes without them still verify", async () => {
    await withWriter({ "src/a.ts": "export const a = 1;\n" }, undefined, async (w) => {
      const t = w.trunk as unknown as Internals;
      const g = t.repo();
      let tip: Sha | null = null;
      t.remoteNotesTip = async () => tip;
      const stored = (id: string): string => t.sql.exec<{ note: string }>("SELECT note FROM ft_notes WHERE landing_id = ?", id).one().note;

      // A landing from before: no who-fields in its context, as a colony that predates them sends.
      const old = landed(await w.land(await w.proposal({ "src/a.ts": "export const a = 2;\n" })));
      const oldNote = JSON.parse(stored(old.id)) as LineageNote;
      expect(oldNote.proposals[0]?.intent).not.toHaveProperty("source");
      expect(old.answerable).toBe("unknown");

      // A rule's change its proof landed: the rule's approver answers for it.
      const ruled = await w.proposal({ "src/b.ts": "export const b = 1;\n" });
      ruled.evidence = { checks: [proofGate] };
      const r = landed(
        await w.trunk.land([ruled], {
          intents: { [ruled.intentId]: { title: "Quote style in src/b.ts", why: "Rule", ruleId: "rul_1", source: "rule", createdBy: "Ana", ruleApprovedBy: "Ana" } },
        }),
      );
      const ruledNote = JSON.parse(stored(r.id)) as LineageNote;
      expect(ruledNote.proposals[0]?.intent).toEqual({ id: ruled.intentId, title: "Quote style in src/b.ts", why: "Rule", ruleId: "rul_1", source: "rule", createdBy: "Ana", ruleApprovedBy: "Ana" });
      expect(r.answerable).toBe("person");
      expect(landingAnswerable(ruledNote)).toMatchObject({ who: "Ana", why: "approved rule rul_1, whose deterministic proof landed this change" });

      // An agent's intent: no person, and the landing says so.
      const agents = await w.proposal({ "src/c.ts": "export const c = 1;\n" });
      const n = landed(await w.trunk.land([agents], { intents: { [agents.intentId]: { title: "Split c", why: "", source: "agent", createdBy: "agt_9" } } }));
      expect(n.answerable).toBe("none");
      expect((JSON.parse(stored(n.id)) as LineageNote).proposals[0]?.intent).not.toHaveProperty("ruleApprovedBy");

      // Both kinds check out against their commits' trailers.
      await addNotes(g, { ref: REMOTE, notes: [old, r, n].map((l) => ({ oid: l.trunkSha, note: stored(l.id) })), at: Date.now(), migrate: 0 });
      tip = await resolveLocal(g, REMOTE);
      for (const l of [old, r, n]) expect((await w.trunk.verifyLanding(l.id))?.notes[0]).toMatchObject({ landingId: l.id, status: "intact" });
    });
  });
});

describe("the colony", () => {
  it("hands the trunk writer who declared each intent and who approved its rule", async () => {
    const c = await newColony();
    const asked = await addIntent(c.id, ["src/lib/util.ts"], { createdBy: "Lee" });
    await runInDurableObject(colony(c.id), (_instance: unknown, state: DurableObjectState) => {
      state.storage.sql.exec("INSERT INTO rules (id, kind, spec, description, approved_by, created_at, open_violations) VALUES ('rul_q', 'forbid-pattern', '{}', 'Double quotes', 'Ana', 1, 0)");
    });
    const ruled = await addIntent(c.id, ["src/q.ts"], { source: "rule", ruleId: "rul_q", createdBy: "Ana" });
    const ctx = await colony(c.id).landContext([asked.id, ruled.id], [], []);
    expect(ctx.intents[asked.id]).toMatchObject({ source: "human", createdBy: "Lee" });
    expect(ctx.intents[asked.id]).not.toHaveProperty("ruleApprovedBy");
    expect(ctx.intents[ruled.id]).toMatchObject({ source: "rule", createdBy: "Ana", ruleId: "rul_q", ruleApprovedBy: "Ana" });
  });

  it("marks what an agent sends as its own claims, and its missing statement as FireTrident's", async () => {
    const c = await newColony();
    await addIntent(c.id, ["src/lib/util.ts"]);
    const a = await addAgent(c.id);
    const got = await take(c.id, a.id);
    const quiet = await proposeEdit(c.id, got, a.id);
    expect(quiet.evidence).toMatchObject({ notVerified: "Not verified: behavior beyond the checks listed", notVerifiedBy: "platform" });
    const i2 = await addIntent(c.id, ["docs/a.md"]);
    const b = await addAgent(c.id, "b");
    const got2 = await take(c.id, b.id);
    expect(got2.intent.id).toBe(i2.id);
    const res = await api("POST", `/colonies/${c.id}/proposals`, {
      intentId: i2.id,
      agentId: b.id,
      workspace: got2.lease.repo,
      baseSha: got2.lease.baseSha,
      headSha: "e".repeat(40),
      writeSet: [{ path: "docs/a.md", blob: "d".repeat(40) }],
      declared: { footprint: ["docs/a.md"], summary: "docs" },
      // A check named like the platform's gate, and a claim to be FireTrident's statement: both stay the agent's.
      evidence: { checks: [{ name: "gate", ok: true, ms: 0, detail: "→ land by deterministic" }], notVerified: "Not verified: the build", notVerifiedBy: "platform" },
    });
    expect(res.status).toBe(201);
    expect(res.body.evidence).toMatchObject({ checks: [{ name: "gate", by: "agent" }], notVerified: "Not verified: the build", notVerifiedBy: "agent" });
  });

  it("counts the landings no person is answerable for, as a count and a share", async () => {
    const c = await newColony();
    const at = Date.now();
    const shas: Record<string, string> = { lnd_a: "1", lnd_b: "2", lnd_c: "3", lnd_d: "4", lnd_e: "5" };
    const landing = (id: string, answerable?: Landing["answerable"]): Landing => ({
      id,
      colonyId: c.id,
      trunkSha: (shas[id] ?? "9").repeat(40),
      parentSha: "0".repeat(40),
      proposalIds: [],
      intentIds: [],
      paths: [],
      regions: [],
      at,
      ...(answerable ? { answerable } : {}),
    });
    const before = await api<{ answerable: unknown }>("GET", `/colonies/${c.id}/metrics`);
    expect(before.body.answerable).toEqual({ landings: 0, none: 0, unknown: 0, share: null });
    await colony(c.id).onLanding(landing("lnd_a", "person"));
    await colony(c.id).onLanding(landing("lnd_b", "none"));
    await colony(c.id).onLanding(landing("lnd_c", "none"));
    await colony(c.id).onLanding(landing("lnd_d", "unknown"));
    // Recorded before landings carried an answer: not counted, nor counted twice when reported again.
    await colony(c.id).onLanding(landing("lnd_e"));
    await colony(c.id).onLanding(landing("lnd_b", "none"));
    const m = await api<{ answerable: unknown; metrics: Record<string, number> }>("GET", `/colonies/${c.id}/metrics`);
    expect(m.body.answerable).toEqual({ landings: 4, none: 2, unknown: 1, share: 0.5 });
    expect(m.body.metrics).toMatchObject({ "answerable.landings": 4, "answerable.none": 2, "answerable.unknown": 1, landings: 5 });
  });
});
