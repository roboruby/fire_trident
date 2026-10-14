import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Proposal } from "@fire_trident/core";
import { fileDiff, type FileDiff } from "../../src/decide/diff.ts";
import { addAgent, addIntent, api, colony, eventually, newColony, proposal, proposeEdit, region, take } from "./helpers.ts";

/**
 * The contest judge's model calls count in the decide spend: their tokens go where the second
 * opinion's go (decide.llm.tokensIn and decide.llm.tokensOut), which the demos price as decide spend.
 */

const MAIN = "src/app/main.ts";
const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function laneSize(colonyId: string, name: string): Promise<number> {
  return ((await region(colonyId, name).status()) as { lane: number }).lane;
}

async function metrics(colonyId: string): Promise<Record<string, number>> {
  const res = await api<{ metrics: Record<string, number> }>("GET", `/colonies/${colonyId}/metrics`);
  expect(res.status).toBe(200);
  return res.body.metrics;
}

describe("contest judge spend", () => {
  it("counts each judge call's tokens in the decide spend, and the judgment still decides", async () => {
    const c = await newColony();
    await colony(c.id).setDecidePolicy({ enabled: false }); // no second opinion: every decide token here is the judge's
    const texts = new Map<string, string>();
    await runInDurableObject(colony(c.id), (instance) => {
      const self = instance as unknown as { env: object; contestDiffs: (p: Proposal) => Promise<FileDiff[]> };
      const ai = {
        async run(_model: string, input: { messages: Array<{ role: string; content: string }> }): Promise<unknown> {
          const user = input.messages.find((m) => m.role === "user")?.content ?? "";
          const a = user.slice(user.indexOf("Change A"), user.indexOf("Change B"));
          return { response: JSON.stringify({ better: a.includes("bonjour") ? "A" : "B", reason: "it greets in French as asked" }), usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 } };
        },
      };
      self.env = new Proxy(self.env, { get: (t, k) => (k === "AI" ? ai : Reflect.get(t, k)) });
      self.contestDiffs = async (p: Proposal) => p.writeSet.map((w) => fileDiff(w.path, 'console.log("hello");\n', texts.get(p.agentId) ?? "", { maxChars: 24_000 }));
    });
    const before = await metrics(c.id);
    expect(before["decide.llm.tokensIn"] ?? 0).toBe(0);

    await addIntent(c.id, [MAIN], { contest: 2, title: "Greet in French", acceptance: ["prints bonjour"] });
    const [a, b] = [await addAgent(c.id, "a"), await addAgent(c.id, "b")];
    const [ta, tb] = [await take(c.id, a.id), await take(c.id, b.id)];
    texts.set(a.id, 'console.log("hello there");\n');
    texts.set(b.id, 'console.log("bonjour");\n');
    const pa = await proposeEdit(c.id, ta, a.id);
    await pause(5);
    const pb = await proposeEdit(c.id, tb, b.id);
    await eventually(() => laneSize(c.id, "src"), (n) => n === 1, 5_000);

    // Both orders were asked of one model: two calls, each 120 in and 30 out.
    const after = await metrics(c.id);
    expect(after["contest.judge.calls"]).toBe(2);
    expect(after["decide.llm.tokensIn"]).toBe(240);
    expect(after["decide.llm.tokensOut"]).toBe(60);
    // And per model, as the judge's own layer of the colony's spend (colony/spend.ts).
    const judged = (dir: string) => Object.entries(after).filter(([k]) => k.startsWith(`contest.judge.tokens${dir}:`)).reduce((a, [, v]) => a + v, 0);
    expect([judged("In"), judged("Out")]).toEqual([240, 60]);
    expect((await proposal(c.id, pb.id)).status).toBe("ready");
    expect(await proposal(c.id, pa.id)).toMatchObject({ status: "returned", supersededBy: pb.id });
  });
});
