import { describe, expect, it } from "vitest";
import type { ColonySnapshot, FieldReading, Intent, Rule } from "@fire_trident/core";
import { addAgent, api, externalLanding, newColony, proposal, proposeEdit, region, take, tick } from "./helpers.ts";

describe("morphology rules", () => {
  it("turns violations into one intent per file and counts them down as intents land", async () => {
    const c = await newColony();
    await externalLanding(c.id, {
      "src/app/main.ts": 'console.log("a");\nconst x = 1;\nconsole.log(x);\n',
      "src/lib/util.ts": "export const y = 2;\nconsole.log(y);\n",
      "docs/guide.md": "console.log in prose is fine\n",
    });
    const res = await api<{ rule: Rule; violations: number; intents: number }>("POST", `/colonies/${c.id}/rules`, {
      colonyId: c.id,
      kind: "forbid-pattern",
      spec: { pattern: "console\\.log", hint: "use the logger", replacement: "logger.info" },
      description: "No console.log",
      approvedBy: "matt",
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ violations: 3, intents: 2 });
    const rule = res.body.rule;
    expect(rule).toMatchObject({ colonyId: c.id, kind: "forbid-pattern", description: "No console.log", approvedBy: "matt" });
    expect(rule.spec).toMatchObject({ replacement: "logger.info" });

    const snap = (await api<ColonySnapshot>("GET", `/colonies/${c.id}`)).body;
    expect(snap.violations).toEqual({ total: 3, byRule: { [rule.id]: 3 } });
    expect(snap.rules.map((r) => r.id)).toEqual([rule.id]);
    const ruleIntents = snap.intents.filter((i) => i.ruleId === rule.id);
    expect(ruleIntents.map((i) => i.title).sort()).toEqual(["No console.log in src/app/main.ts", "No console.log in src/lib/util.ts"]);
    const main = ruleIntents.find((i) => i.footprint[0] === "src/app/main.ts")!;
    expect(main).toMatchObject({ source: "rule", priority: 1, status: "open", createdBy: "matt" });
    expect(main.why).toBe("No console.log.\nHint: use the logger\n2 violations on lines 1, 3.");
    const field = (await region(c.id, "src").reading()) as FieldReading;
    expect(field.byPath["src/app/main.ts"]).toMatchObject({ need: 1 });

    // Taking a rule intent hands the agent the rule too.
    const a = await addAgent(c.id);
    const got = await take(c.id, a.id);
    expect(got.rule).toEqual(rule);
    const p = await proposeEdit(c.id, got, a.id);
    await tick(c.id, "src");
    expect((await proposal(c.id, p.id)).status).toBe("landed");
    const fixed = got.intent.footprint[0] === "src/app/main.ts" ? 2 : 1;
    const after = (await api<ColonySnapshot>("GET", `/colonies/${c.id}`)).body;
    expect(after.violations).toEqual({ total: 3 - fixed, byRule: { [rule.id]: 3 - fixed } });
    expect(((await api<Intent>("GET", `/colonies/${c.id}`)).body as unknown as ColonySnapshot).intents.find((i) => i.id === got.intent.id)!.status).toBe("landed");
  });

  it("checks import boundaries", async () => {
    const c = await newColony();
    const res = await api("POST", `/colonies/${c.id}/rules`, {
      kind: "forbid-import",
      spec: { from: ["src/app/**"], module: "^\\.\\./lib", hint: "go through the public api" },
      description: "App code must not reach into lib.",
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ violations: 1, intents: 1 });
    // The rule's trailing period stays out of the intent title.
    const snap = (await api<ColonySnapshot>("GET", `/colonies/${c.id}`)).body;
    expect(snap.intents.map((i) => i.title)).toEqual(["App code must not reach into lib in src/app/main.ts"]);
  });

  it("rejects invalid rules with a 400", async () => {
    const c = await newColony();
    const broken = await api("POST", `/colonies/${c.id}/rules`, { kind: "forbid-pattern", spec: { pattern: "(" }, description: "broken" });
    expect(broken.status).toBe(400);
    expect(broken.body.error).toMatch(/^invalid rule: spec\.pattern is not a valid RegExp/);
    const missing = await api("POST", `/colonies/${c.id}/rules`, { kind: "forbid-import", spec: { from: "src/**" }, description: "no module" });
    expect(missing.status).toBe(400);
    expect((await api("POST", `/colonies/${c.id}/rules`, { kind: "forbid-everything", spec: {}, description: "x" })).status).toBe(400);
    expect((await api<ColonySnapshot>("GET", `/colonies/${c.id}`)).body.rules).toEqual([]);
  });
});
