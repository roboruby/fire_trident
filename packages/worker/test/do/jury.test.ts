import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ColonyEvent, Proposal } from "@fire_trident/core";
import { fileDiff, type FileDiff } from "../../src/decide/diff.ts";
import { addAgent, addIntent, api, colony, eventually, newColony, proposal, proposeEdit, region, take } from "./helpers.ts";

/**
 * The contest jury (FT_CONTEST_JURY, decide/jury.ts) in the colony: where the flag covers the colony,
 * a contest's tied pair goes to the policy's jury models instead of the one judge, each asked in both
 * orders; the verdict is in the loser's reason and the winner's contest check, the counters say how
 * the members voted, and every member's tokens count in the judge layer of the spend, per model.
 * Without the flag, the judge path in do/contest.test.ts and do/judge-spend.test.ts is unchanged.
 */

const MAIN = "src/app/main.ts";
const GEMMA = "@cf/google/gemma-4-26b-a4b-it";
const GPT = "@cf/openai/gpt-oss-20b";
const GLM = "@cf/zai-org/glm-4.7-flash";
const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function laneSize(colonyId: string, name: string): Promise<number> {
  return ((await region(colonyId, name).status()) as { lane: number }).lane;
}

async function metrics(colonyId: string): Promise<Record<string, number>> {
  const res = await api<{ metrics: Record<string, number> }>("GET", `/colonies/${colonyId}/metrics`);
  expect(res.status).toBe(200);
  return res.body.metrics;
}

async function events(colonyId: string): Promise<ColonyEvent[]> {
  const res = await api<{ events: ColonyEvent[] }>("GET", `/colonies/${colonyId}/events?limit=5000`);
  expect(res.status).toBe(200);
  return res.body.events;
}

describe("contest jury", () => {
  it("seats the policy's jury where the flag covers the colony, records every vote, counts the verdict and each member's spend", async () => {
    const c = await newColony();
    await colony(c.id).setDecidePolicy({ enabled: false }); // no second opinion: every decide token here is the jury's
    const texts = new Map<string, string>();
    const calls: string[] = [];
    await runInDurableObject(colony(c.id), (instance) => {
      const self = instance as unknown as { env: object; contestDiffs: (p: Proposal) => Promise<FileDiff[]> };
      const ai = {
        async run(model: string, input: { messages: Array<{ role: string; content: string }> }): Promise<unknown> {
          const user = input.messages.find((m) => m.role === "user")?.content ?? "";
          const a = user.slice(user.indexOf("Change A"), user.indexOf("Change B"));
          calls.push(model);
          const usage = { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 };
          // Two members prefer the French greeting in either order; the third prefers whatever it is shown first.
          if (model === GPT) return { response: JSON.stringify({ better: "A", reason: "the first one reads better" }), usage };
          return { response: JSON.stringify({ better: a.includes("bonjour") ? "A" : "B", reason: "it greets in French as asked" }), usage };
        },
      };
      self.env = new Proxy(self.env, { get: (t, k) => (k === "AI" ? ai : k === "FT_CONTEST_JURY" ? c.id : Reflect.get(t, k)) });
      self.contestDiffs = async (p: Proposal) => p.writeSet.map((w) => fileDiff(w.path, 'console.log("hello");\n', texts.get(p.agentId) ?? "", { maxChars: 24_000 }));
    });
    expect((await metrics(c.id))["contest.judge.calls"] ?? 0).toBe(0);

    const x = await addIntent(c.id, [MAIN], { contest: 2, title: "Greet in French", acceptance: ["prints bonjour"] });
    const [a, b] = [await addAgent(c.id, "a"), await addAgent(c.id, "b")];
    const [ta, tb] = [await take(c.id, a.id), await take(c.id, b.id)];
    texts.set(a.id, 'console.log("hello there");\n');
    texts.set(b.id, 'console.log("bonjour");\n');
    const pa = await proposeEdit(c.id, ta, a.id);
    await pause(5);
    const pb = await proposeEdit(c.id, tb, b.id);
    await eventually(() => laneSize(c.id, "src"), (n) => n === 1, 5_000);

    // Three members, both orders each: six calls, two per member.
    expect(calls).toHaveLength(6);
    expect(calls.filter((m) => m === GEMMA)).toHaveLength(2);
    expect(calls.filter((m) => m === GPT)).toHaveLength(2);
    expect(calls.filter((m) => m === GLM)).toHaveLength(2);
    // The majority of consistent votes decided; the verdict names each member's vote in the loser's reason.
    expect((await proposal(c.id, pb.id)).status).toBe("ready");
    const lost = await proposal(c.id, pa.id);
    expect(lost).toMatchObject({ status: "returned", supersededBy: pb.id });
    expect(lost.reason).toBe(
      `superseded: contest for ${x.id} won by ${pb.id} (judged better by 2 of 3 jurors in both orders (${GEMMA}, ${GLM}): it greets in French as asked; ${GPT} preferred the change shown first in both orders)`,
    );
    // And in the winner's contest check, and in the contest event.
    const check = (await proposal(c.id, pb.id)).evidence.checks.find((k) => k.name === "contest");
    expect(check?.detail).toMatch(/^won the contest for .* against 1 other change: over .*: judged better by 2 of 3 jurors in both orders/);
    const contest = (await events(c.id)).find((ev): ev is Extract<ColonyEvent, { t: "contest" }> => ev.t === "contest");
    expect(contest?.reason).toMatch(/judged better by 2 of 3 jurors/);

    const after = await metrics(c.id);
    expect(after["contest.judge.calls"]).toBe(6);
    expect(after["contest.jury.majority"]).toBe(1);
    expect(after["contest.jury.ties"] ?? 0).toBe(0);
    expect(after["contest.jury.consistent"]).toBe(2);
    expect(after["contest.jury.inconsistent"]).toBe(1);
    // Each member's tokens, per model, in the judge layer of the spend, and in the decide aggregate the judge shares.
    for (const m of [GEMMA, GPT, GLM]) {
      expect(after[`contest.judge.tokensIn:${m}`]).toBe(240);
      expect(after[`contest.judge.tokensOut:${m}`]).toBe(60);
    }
    expect(after["decide.llm.tokensIn"]).toBe(720);
    expect(after["decide.llm.tokensOut"]).toBe(180);
    const spend = (await api<{ spend: { byLayer: Record<string, number>; byModel: Record<string, { input: number }> } }>("GET", `/colonies/${c.id}/metrics`)).body.spend;
    expect(spend.byLayer.judge).toBeGreaterThan(0);
    expect(Object.keys(spend.byModel).sort()).toEqual([GEMMA, GPT, GLM].sort());
  });

  it("breaks a split jury by the deterministic tie-break, and counts the tie", async () => {
    const c = await newColony();
    await colony(c.id).setDecidePolicy({ enabled: false, juryModels: [GEMMA, GPT] });
    const texts = new Map<string, string>();
    await runInDurableObject(colony(c.id), (instance) => {
      const self = instance as unknown as { env: object; contestDiffs: (p: Proposal) => Promise<FileDiff[]> };
      const ai = {
        async run(model: string, input: { messages: Array<{ role: string; content: string }> }): Promise<unknown> {
          const user = input.messages.find((m) => m.role === "user")?.content ?? "";
          const a = user.slice(user.indexOf("Change A"), user.indexOf("Change B"));
          // One member prefers the French greeting, the other the plain one, each consistently: a split.
          const french = a.includes("bonjour");
          return { response: JSON.stringify({ better: (model === GEMMA) === french ? "A" : "B", reason: "my pick" }) };
        },
      };
      self.env = new Proxy(self.env, { get: (t, k) => (k === "AI" ? ai : k === "FT_CONTEST_JURY" ? "on" : Reflect.get(t, k)) });
      self.contestDiffs = async (p: Proposal) => p.writeSet.map((w) => fileDiff(w.path, 'console.log("hello");\n', texts.get(p.agentId) ?? "", { maxChars: 24_000 }));
    });
    const x = await addIntent(c.id, [MAIN], { contest: 2, title: "Greet in French" });
    const [a, b] = [await addAgent(c.id, "a"), await addAgent(c.id, "b")];
    const [ta, tb] = [await take(c.id, a.id), await take(c.id, b.id)];
    texts.set(a.id, 'console.log("bonjour");\nconsole.log("et bienvenue");\n');
    texts.set(b.id, 'console.log("salut");\n');
    const pa = await proposeEdit(c.id, ta, a.id);
    await pause(5);
    const pb = await proposeEdit(c.id, tb, b.id);
    await eventually(() => laneSize(c.id, "src"), (n) => n === 1, 5_000);
    // The smaller diff wins the tie, although it was proposed second, and the reason shows the split.
    expect((await proposal(c.id, pb.id)).status).toBe("ready");
    const lost = await proposal(c.id, pa.id);
    expect(lost).toMatchObject({ status: "returned", supersededBy: pb.id });
    expect(lost.reason).toBe(`superseded: contest for ${x.id} won by ${pb.id} (a tie (the jury of 2 split 1 to 1: ${GEMMA} for ${pa.id}; ${GPT} for ${pb.id}), broken by the smaller diff: 2 lines against 3)`);
    const m = await metrics(c.id);
    expect(m["contest.judge.calls"]).toBe(4);
    expect(m["contest.jury.ties"]).toBe(1);
    expect(m["contest.jury.majority"] ?? 0).toBe(0);
    expect(m["contest.jury.consistent"]).toBe(2);
    expect(m["contest.jury.inconsistent"] ?? 0).toBe(0);
  });

  it("leaves the single judge in place where the flag does not cover the colony", async () => {
    const c = await newColony();
    await colony(c.id).setDecidePolicy({ enabled: false });
    const texts = new Map<string, string>();
    const calls: string[] = [];
    await runInDurableObject(colony(c.id), (instance) => {
      const self = instance as unknown as { env: object; contestDiffs: (p: Proposal) => Promise<FileDiff[]> };
      const ai = {
        async run(model: string, input: { messages: Array<{ role: string; content: string }> }): Promise<unknown> {
          const user = input.messages.find((m) => m.role === "user")?.content ?? "";
          const a = user.slice(user.indexOf("Change A"), user.indexOf("Change B"));
          calls.push(model);
          return { response: JSON.stringify({ better: a.includes("bonjour") ? "A" : "B", reason: "it greets in French as asked" }) };
        },
      };
      // The flag lists other colonies only.
      self.env = new Proxy(self.env, { get: (t, k) => (k === "AI" ? ai : k === "FT_CONTEST_JURY" ? "hono,scale" : Reflect.get(t, k)) });
      self.contestDiffs = async (p: Proposal) => p.writeSet.map((w) => fileDiff(w.path, 'console.log("hello");\n', texts.get(p.agentId) ?? "", { maxChars: 24_000 }));
    });
    await addIntent(c.id, [MAIN], { contest: 2, title: "Greet in French" });
    const [a, b] = [await addAgent(c.id, "a"), await addAgent(c.id, "b")];
    const [ta, tb] = [await take(c.id, a.id), await take(c.id, b.id)];
    texts.set(a.id, 'console.log("hello there");\n');
    texts.set(b.id, 'console.log("bonjour");\n');
    const pa = await proposeEdit(c.id, ta, a.id);
    await pause(5);
    await proposeEdit(c.id, tb, b.id);
    await eventually(() => laneSize(c.id, "src"), (n) => n === 1, 5_000);
    // One judge model, both orders: two calls, and the judge's own wording.
    expect(calls).toEqual([GEMMA, GEMMA]);
    expect((await proposal(c.id, pa.id)).reason).toMatch(/\(judged better by @cf\/google\/gemma-4-26b-a4b-it in both orders: it greets in French as asked\)$/);
    const m = await metrics(c.id);
    expect(m["contest.judge.calls"]).toBe(2);
    expect(m["contest.jury.majority"] ?? 0).toBe(0);
    expect(m["contest.jury.ties"] ?? 0).toBe(0);
  });
});
