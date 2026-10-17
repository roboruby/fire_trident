import { describe, expect, it } from "vitest";
import type { ColonySnapshot, ColonySpend, Landing, Proposal, RecipeRecord, Rule } from "@fire_trident/core";
import { addAgent, addIntent, api, colony, externalLanding, fakeSha, newColony, take, trunk } from "./helpers.ts";

/**
 * Target items that carry recipes (colony/rulerecipe.ts) through the API: a rule with a recipe lands it directly and
 * declares agent intents only for its residue; the rule's violations fall as the recipe's batches land. The harness's
 * trunk writer records the recipe and answers it running; a test lands its batches by changing trunk and telling the
 * colony, as the real trunk writer does (ColonyDO.recipeNews).
 */

const FILES = {
  "src/a.ts": "export function compose(x: number) {\n  return x;\n}\n",
  "src/b.ts": 'import { compose } from "./a.ts";\nexport const b = compose(1) + compose(2);\n',
  "src/c.ts": 'import { compose } from "./a.ts";\n// compose is the old name\nexport const c = compose(3);\n',
  "lib/e.ts": "export const compose = 5;\n",
};

type RuleAnswer = { rule: Rule; violations: number; intents: number; recipe?: { id: string; intentId: string; files: number; violations: number; state?: string; skipped?: string } };

/** A recipe record the trunk writer would send with a batch (or at the end). */
function news(r: NonNullable<RuleAnswer["recipe"]>, state: RecipeRecord["state"], landing?: Landing) {
  const record: Partial<RecipeRecord> = { id: r.id, intentId: r.intentId, state, batches: landing ? [{ landingId: landing.id, trunkSha: landing.trunkSha, from: null, through: landing.paths.at(-1)!, files: landing.paths.length, changed: landing.paths.length, at: landing.at }] : [] };
  return { record, ...(landing ? { landing } : {}) };
}

describe("a rule that carries a recipe", () => {
  it("lands the recipe instead of an intent per file, counts violations off as batches land, and declares intents only for the residue", async () => {
    const c = await newColony();
    await externalLanding(c.id, FILES);
    const res = await api<RuleAnswer>("POST", `/colonies/${c.id}/rules`, {
      kind: "forbid-pattern",
      spec: { pattern: "\\bcompose\\b", include: ["src/**", "lib/**"], hint: "call it assemble" },
      description: "No identifier compose",
      approvedBy: "matt",
      recipe: { kind: "rename-identifier", args: { from: "compose", to: "assemble" }, scope: ["src/**"] },
    });
    expect(res.status).toBe(201);
    // lib/e.ts is outside the recipe's scope: its violation is an intent now; the six in src wait for the recipe.
    expect(res.body).toMatchObject({ violations: 7, intents: 1, recipe: { files: 3, violations: 6, state: "running" } });
    expect(res.body.rule.spec.recipe).toEqual({ kind: "rename-identifier", version: "1", args: { from: "compose", to: "assemble" }, scope: ["src/**"] });
    const recipe = res.body.recipe!;

    let snap = (await api<ColonySnapshot>("GET", `/colonies/${c.id}`)).body;
    const ruleId = res.body.rule.id;
    expect(snap.violations).toEqual({ total: 7, byRule: { [ruleId]: 7 } });
    const own = snap.intents.filter((i) => i.ruleId === ruleId);
    expect(own.map((i) => [i.footprint[0], i.status, i.source]).sort()).toEqual([
      ["lib/e.ts", "open", "rule"],
      ["src", "proposed", "rule"],
    ]);
    expect(own.find((i) => i.id === recipe.intentId)).toMatchObject({ createdBy: "matt", recipe: { id: recipe.id, kind: "rename-identifier" } });

    // A batch rewrites a.ts and b.ts: their violations come off, and the first screen's distance falls.
    const before = (await trunk(c.id).state()).head;
    const { sha } = await trunk(c.id).commitExternal({ "src/a.ts": FILES["src/a.ts"].replace("compose", "assemble"), "src/b.ts": FILES["src/b.ts"].replaceAll("compose", "assemble") });
    const batch: Landing = { id: "lnd_recipe_1", colonyId: c.id, trunkSha: sha, parentSha: before, proposalIds: [], intentIds: [recipe.intentId], paths: ["src/a.ts", "src/b.ts"], regions: ["src"], at: Date.now() };
    await colony(c.id).recipeNews(news(recipe, "running", batch));
    snap = (await api<ColonySnapshot>("GET", `/colonies/${c.id}`)).body;
    expect(snap.violations).toEqual({ total: 4, byRule: { [ruleId]: 4 } });
    // The spend card's mechanical share: one recipe batch, two files, three violations, no model call.
    const spend = (await api<{ spend: ColonySpend }>("GET", `/colonies/${c.id}/metrics`)).body.spend;
    expect(spend).toMatchObject({ usd: 0, mechanical: { landings: 1, files: 2, violations: 3, reproducedLines: 0 } });

    // The recipe ends having left c.ts's comment: that file becomes the only new intent.
    await trunk(c.id).commitExternal({ "src/c.ts": 'import { assemble } from "./a.ts";\n// compose is the old name\nexport const c = assemble(3);\n' });
    const last: Landing = { ...batch, id: "lnd_recipe_2", paths: ["src/c.ts"] };
    await colony(c.id).recipeNews(news(recipe, "running", last));
    await colony(c.id).recipeNews(news(recipe, "landed"));
    snap = (await api<ColonySnapshot>("GET", `/colonies/${c.id}`)).body;
    expect(snap.violations).toEqual({ total: 2, byRule: { [ruleId]: 2 } });
    const after = snap.intents.filter((i) => i.ruleId === ruleId && i.id !== recipe.intentId);
    expect(after.map((i) => [i.footprint[0], i.status]).sort()).toEqual([
      ["lib/e.ts", "open"],
      ["src/c.ts", "open"],
    ]);
    expect(after.find((i) => i.footprint[0] === "src/c.ts")!.why).toBe("No identifier compose.\nHint: call it assemble\nViolation on line 2.");
  });

  it("refuses a recipe it cannot run before anything is stored", async () => {
    const c = await newColony();
    const res = await api<{ error?: string }>("POST", `/colonies/${c.id}/rules`, {
      kind: "forbid-pattern",
      spec: { pattern: "x" },
      description: "No x",
      recipe: { kind: "rename-identifier", version: "7", args: { from: "x", to: "y" } },
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/the rule's recipe is refused: rename-identifier is at version 1 here/);
    const snap = (await api<ColonySnapshot>("GET", `/colonies/${c.id}`)).body;
    expect(snap.rules).toEqual([]);
  });
});

describe("a proposal that declares the recipe that made it", () => {
  it("keeps the recipe on the proposal (REST propose), bounded, for the decide stage", async () => {
    const c = await newColony();
    await addIntent(c.id, ["src/lib/util.ts"]);
    const a = await addAgent(c.id, "a");
    const got = await take(c.id, a.id);
    const paths = got.intent.footprint;
    const res = await api<Proposal>("POST", `/colonies/${c.id}/proposals`, {
      intentId: got.intent.id,
      agentId: a.id,
      workspace: got.lease.repo,
      baseSha: got.lease.baseSha,
      headSha: fakeSha(),
      writeSet: paths.map((path) => ({ path, blob: fakeSha() })),
      readSet: await trunk(c.id).baseBlobs(got.lease.baseSha, paths),
      declared: { footprint: paths, summary: "rename helper" },
      recipe: { kind: "rename-identifier", version: "1", args: { from: "helper", to: "assist" }, scope: "src/**" },
    });
    expect(res.status).toBe(201);
    expect(res.body.recipe).toEqual({ kind: "rename-identifier", version: "1", args: { from: "helper", to: "assist" }, scope: ["src/**"] });
  });
});
