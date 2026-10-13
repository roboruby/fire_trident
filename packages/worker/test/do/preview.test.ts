import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Antibody } from "@fire_trident/core";
import type { ReviewPreview } from "../../src/agents/preview.ts";
import type { DetectorState } from "../../src/decide/policy.ts";
import { DecideStore } from "../../src/decide/store.ts";
import { addAgent, addIntent, api, colony, newColony, take } from "./helpers.ts";

/**
 * Take hands the agent what review will ask of its change: the questions of the antibodies people's
 * rejections minted for the intent's paths, and the colony's other rules that cover them.
 */

/** Store antibodies in the colony's decide tables, as minting or a trunk sync would. */
async function seed(colonyId: string, list: Array<{ id: string; paths: string[]; question: string; state: DetectorState; pattern?: string }>): Promise<void> {
  await runInDurableObject(colony(colonyId), (_instance: unknown, state: DurableObjectState) => {
    const store = new DecideStore(state.storage.sql);
    list.forEach((a, i) => {
      const matcher: Antibody["matcher"] = { paths: a.paths, ...(a.pattern ? { pattern: a.pattern } : {}) };
      const ab: Antibody = { id: a.id, colonyId, origin: "human-reject", matcher, question: a.question, threshold: 0.7, createdAt: 1_000 + i, hits: 0, falsePositives: 0 };
      store.putAntibody(ab, a.state);
    });
  });
}

const reviewOf = (x: unknown): ReviewPreview | undefined => (x as { review?: ReviewPreview }).review;

describe("take shows what review will ask", () => {
  it("hands work in src/auth the antibody on src/auth/**, never an off one, and work in docs/ none", async () => {
    const c = await newColony();
    await seed(c.id, [
      { id: "ab_auth", paths: ["src/auth/**"], question: "Does this change log the session token?", state: "active" },
      { id: "ab_off", paths: ["src/auth/**"], question: "Does this change touch auth at all?", state: "off" },
    ]);
    const authIntent = await addIntent(c.id, ["src/auth/x.ts"]);
    const a1 = await addAgent(c.id, "a1");
    const got = await take(c.id, a1.id);
    expect(got.intent.id).toBe(authIntent.id);
    expect(reviewOf(got)).toEqual({ antibodies: [{ id: "ab_auth", question: "Does this change log the session token?" }], rules: [] });
    // A repeated take hands back the held assignment with the same preview.
    expect(reviewOf(await take(c.id, a1.id))?.antibodies.map((a) => a.id)).toEqual(["ab_auth"]);

    const docsIntent = await addIntent(c.id, ["docs/guide.md"]);
    const a2 = await addAgent(c.id, "a2");
    const docs = await take(c.id, a2.id);
    expect(docs.intent.id).toBe(docsIntent.id);
    expect(reviewOf(docs)).toBeUndefined();
  });

  it("never hands out a security antibody's question (its agent is told the class only)", async () => {
    const c = await newColony();
    await seed(c.id, [
      { id: "ab_sec", paths: ["src/auth/**"], question: "Does this change send the session token to a remote host?", state: "active", pattern: "(?:\\bfetch\\s*\\()" },
      { id: "ab_auth", paths: ["src/auth/**"], question: "Does this change skip the CSRF check?", state: "active" },
    ]);
    await addIntent(c.id, ["src/auth/x.ts"]);
    const a = await addAgent(c.id);
    const got = await take(c.id, a.id);
    expect(reviewOf(got)).toEqual({ antibodies: [{ id: "ab_auth", question: "Does this change skip the CSRF check?" }], rules: [] });
    expect(JSON.stringify(got)).not.toContain("session token");
  });

  it("lists the colony's other rules whose scope covers the footprint", async () => {
    const c = await newColony();
    const auth = await api("POST", `/colonies/${c.id}/rules`, { kind: "forbid-pattern", spec: { pattern: "\\beval\\(", include: ["src/auth/**"], hint: "Parse the input instead." }, description: "No eval in auth code" });
    expect(auth.status).toBe(201);
    const docs = await api("POST", `/colonies/${c.id}/rules`, { kind: "forbid-pattern", spec: { pattern: "TODO\\(", include: ["docs/**"] }, description: "No TODO( in docs" });
    expect(docs.status).toBe(201);
    await addIntent(c.id, ["src/auth/x.ts"]);
    const a = await addAgent(c.id);
    expect(reviewOf(await take(c.id, a.id))).toEqual({ antibodies: [], rules: ["No eval in auth code. Parse the input instead."] });
  });

  it("shows nothing once a person switches the colony's reflex arc off", async () => {
    const c = await newColony();
    await seed(c.id, [{ id: "ab_auth", paths: ["src/auth/**"], question: "Does this change log the session token?", state: "active" }]);
    expect((await api("POST", `/colonies/${c.id}/decide/policy`, { enabled: false })).status).toBe(200);
    await addIntent(c.id, ["src/auth/x.ts"]);
    const a = await addAgent(c.id);
    expect(reviewOf(await take(c.id, a.id))).toBeUndefined();
  });

  it("still hands out work when the stored antibodies cannot be read", async () => {
    const c = await newColony();
    await seed(c.id, [{ id: "ab_auth", paths: ["src/auth/**"], question: "Does this change log the session token?", state: "active" }]);
    await runInDurableObject(colony(c.id), (_instance: unknown, state: DurableObjectState) => {
      state.storage.sql.exec("UPDATE antibodies SET data = '{not json' WHERE id = 'ab_auth'");
    });
    const i = await addIntent(c.id, ["src/auth/x.ts"]);
    const a = await addAgent(c.id);
    const got = await take(c.id, a.id);
    expect(got.intent.id).toBe(i.id);
    expect(reviewOf(got)).toBeUndefined();
  });
});
