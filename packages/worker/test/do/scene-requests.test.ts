import { describe, expect, it } from "vitest";
import { blobId, changesetId } from "@fire_trident/core";
import type { Intent, Proposal, WorkspaceLease } from "@fire_trident/core";
import { sceneData } from "../../../../scripts/scene_project.ts";
import { ProposalBody } from "../../src/api/schemas.ts";
import { api, colony, eventually, newColony, tick } from "./helpers.ts";

/**
 * The finals' recipe scenes (scripts/scene_rename.rb, scripts/scene_smuggle.rb) send their requests to the real API and
 * colony: these are those requests, body for body, as the scene scripts build them, so a field the API refuses or an
 * answer the scripts cannot read fails here rather than on stage. The project comes from scripts/scene_project.ts. The
 * harness runs with FT_INLINE off (staging has it on), so an inline change is checked against the API's schema and then
 * proposed to the colony directly, as test/do/inline.test.ts does.
 */

const DATA = sceneData();
const BY = "stage-scene";

/** POST /agents as Scene::Run#register sends it. */
async function register(colonyId: string, name: string): Promise<string> {
  const res = await api<{ id: string }>("POST", `/colonies/${colonyId}/agents`, { name, kind: "synthetic", model: "scripted" });
  expect(res.status).toBe(201);
  return res.body.id;
}

/** POST /intents as Scene::Run#declare sends it: assigned to the agent at once, declared even when it matches another. */
async function declare(colonyId: string, agent: string, title: string, footprint: string[], why: string): Promise<Intent & { duplicateOf?: string }> {
  const res = await api<Intent & { duplicateOf?: string }>("POST", `/colonies/${colonyId}/intents`, { title, why, footprint, assignedTo: agent, createdBy: BY, force: true });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  expect(res.body.duplicateOf).toBeUndefined();
  return res.body;
}

/** POST /take, which hands the agent the intent assigned to it and a lease with both remotes and their tokens. */
async function take(colonyId: string, agent: string, intentId: string): Promise<{ intent: Intent & { revision?: number }; lease: WorkspaceLease }> {
  const res = await api<{ intent: Intent & { revision?: number }; lease: WorkspaceLease }>("POST", `/colonies/${colonyId}/agents/${agent}/take`, {});
  expect(res.status).toBe(200);
  expect(res.body.intent.id).toBe(intentId);
  for (const s of [res.body.lease.repo.remote, res.body.lease.token, res.body.lease.trunk.remote, res.body.lease.trunk.token, res.body.lease.baseSha]) expect(typeof s === "string" && s.length > 0).toBe(true);
  return res.body;
}

describe("the recipe scenes' requests, as the API and the colony take them", () => {
  it("creates the colony with its pool, turns review off and on, and lands a seed chunk proposed inline", async () => {
    const c = await newColony({ pool: 40 });
    for (const enabled of [false, true, false]) {
      const res = await api<{ enabled: boolean }>("POST", `/colonies/${c.id}/decide/policy`, { enabled });
      expect(res.status).toBe(200);
      expect(res.body.enabled).toBe(enabled);
    }
    // A seed chunk all under src (one lane), sixty files in one inline change, as Scene::Run#propose_inline sends it.
    const chunk = DATA.seed[1]!;
    expect(chunk).toHaveLength(60);
    const agent = await register(c.id, "seed-2");
    const intent = await declare(c.id, agent, "Seed the shop, part 2 of 5", chunk, "The project the scene runs on.");
    const took = await take(c.id, agent, intent.id);
    const write = chunk.map((path) => ({ path, blob: blobId(DATA.files[path]!) }));
    const body = {
      intentId: intent.id,
      agentId: agent,
      workspace: took.lease.repo,
      baseSha: took.lease.baseSha,
      headSha: changesetId(took.lease.baseSha, write),
      writeSet: write,
      readSet: [],
      contents: Object.fromEntries(chunk.map((path) => [blobId(DATA.files[path]!), DATA.files[path]!])),
      intentRevision: took.intent.revision ?? 1,
      declared: { footprint: chunk, summary: `Seed ${chunk.length} files of the shop` },
      evidence: { checks: [], notVerified: "A scripted scene agent: no tests were run." },
    };
    const parsed = ProposalBody.safeParse(body);
    expect(parsed.success, JSON.stringify(parsed.error?.issues.slice(0, 3))).toBe(true);
    const proposed = await colony(c.id).propose({ colonyId: c.id, ...body });
    expect(proposed.status).toBe("ready");
    const landed = await eventually(
      async () => {
        await tick(c.id, "src");
        return (await api<Proposal>("GET", `/colonies/${c.id}/proposals/${proposed.id}`)).body;
      },
      (p) => p.status === "landed",
      10_000,
    );
    expect(landed).toMatchObject({ status: "landed", landingId: expect.any(String) });
  });

  it("takes a change of every file the rename rewrites, pushed and proposed by its commit, naming its recipe", async () => {
    const c = await newColony({ pool: 10 });
    const paths = Object.keys(DATA.renamed);
    expect(paths).toHaveLength(212);
    const agent = await register(c.id, "scene-smuggler");
    const intent = await declare(c.id, agent, DATA.smuggle.title, paths, DATA.smuggle.why);
    const took = await take(c.id, agent, intent.id);
    const files = { ...DATA.renamed, [DATA.smuggle.path]: DATA.smuggle.text };
    // As SceneSmuggle::Run#propose_pushed sends it: no contents, the commit as its head, the recipe it names.
    const body = {
      intentId: intent.id,
      agentId: agent,
      workspace: took.lease.repo,
      baseSha: took.lease.baseSha,
      headSha: "c".repeat(40),
      writeSet: paths.map((path) => ({ path, blob: blobId(files[path]!) })),
      readSet: paths.map((path) => ({ path, blob: blobId(DATA.files[path]!) })),
      intentRevision: took.intent.revision ?? 1,
      declared: { footprint: paths, summary: DATA.smuggle.title },
      evidence: { checks: [], notVerified: "A scripted scene agent: no tests were run." },
      recipe: { kind: DATA.recipe.kind, version: DATA.recipe.version, args: DATA.recipe.args, scope: DATA.recipe.scope },
    };
    const proposed = await api<Proposal>("POST", `/colonies/${c.id}/proposals`, body);
    expect(proposed.status, JSON.stringify(proposed.body)).toBe(201);
    const p = (await api<Proposal>("GET", `/colonies/${c.id}/proposals/${proposed.body.id}`)).body;
    expect(p.recipe).toEqual({ kind: "rename-identifier", version: "1", args: { from: "formatPrice", to: "formatAmount" }, scope: ["src/**"] });
    expect(p.writeSet).toHaveLength(212);
    // What the scripts read afterwards: the review queue (a list) and the model calls counted against the intent.
    const review = await api<unknown>("GET", `/colonies/${c.id}/review`);
    expect(review.status).toBe(200);
    expect(Array.isArray(review.body)).toBe(true);
    const spend = await api<{ calls?: Record<string, number> }>("GET", `/colonies/${c.id}/intents/${intent.id}/spend`);
    expect(spend.status).toBe(200);
    expect(Object.values(spend.body.calls ?? {}).reduce((a, b) => a + b, 0)).toBe(0);
  });

  it("declares the person's recipe as the rename scene sends it", async () => {
    const c = await newColony();
    const res = await api<{ intent: Intent; recipe: { id: string; state: string } }>("POST", `/colonies/${c.id}/recipes`, {
      kind: DATA.recipe.kind,
      version: DATA.recipe.version,
      args: DATA.recipe.args,
      scope: DATA.recipe.scope,
      by: BY,
      why: DATA.recipeWhy,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.recipe.id).toMatch(/^rcp_/);
    expect(res.body.intent.recipe).toMatchObject({ kind: "rename-identifier", args: { from: "formatPrice", to: "formatAmount" } });
  });
});
