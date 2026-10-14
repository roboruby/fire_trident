import { describe, expect, it } from "vitest";
import { meteredAi } from "../../src/colony/spend.ts";
import { selectWinner, type ContestCandidate, type PairJudge } from "../../src/decide/contest.ts";
import { fileDiff, type FileDiff } from "../../src/decide/diff.ts";
import { JURY_MAX, JURY_MIN, juryEnabled, juryMembers, memberVote, pairJury, tally, type JuryMember } from "../../src/decide/jury.ts";
import { CallLimiter } from "../../src/decide/limiter.ts";
import { DEFAULT_POLICY, mergePolicy } from "../../src/decide/policy.ts";
import type { AiRunner } from "../../src/decide/reflex.ts";

/**
 * The contest jury (FT_CONTEST_JURY, decide/jury.ts): several small models in place of one judge, each
 * asked in both orders; only consistent votes count, the majority wins, and anything else is a tie
 * that the deterministic tie-break settles as today.
 */

/** A candidate with neutral evidence, overridable field by field. */
function cand(id: string, extra: Partial<ContestCandidate> = {}): ContestCandidate {
  return { proposalId: id, agentId: `agt_${id}`, createdAt: 1_000, proof: false, residual: 0, danger: false, size: null, diffs: null, ...extra };
}

/** A one-file change from `before` to `after`. */
function change(after: string, before = "export const greet = () => 'hello';\n"): FileDiff[] {
  return [fileDiff("src/greet.ts", before, after, { maxChars: 24_000 })];
}

/** The letter a member answers, from what it sees as change A and change B; a string answers prose instead. */
type Pick = (a: string, b: string) => "A" | "B" | "tie" | { prose: string } | { wait: number } | { fail: string };

/**
 * A jury of fakes: `picks` answers for each model from the prompt; the log keeps every call's model
 * and the position bonjour was shown in, and every reply reports tokens so the spend can be counted.
 */
function fakeAi(picks: Record<string, Pick>, log: Array<{ model: string; bonjourFirst: boolean }> = []): AiRunner {
  return {
    async run(model: string, input: Record<string, unknown>): Promise<unknown> {
      const user = (input.messages as Array<{ role: string; content: string }>).find((m) => m.role === "user")?.content ?? "";
      const a = user.slice(user.indexOf("Change A"), user.indexOf("Change B"));
      const b = user.slice(user.indexOf("Change B"));
      log.push({ model, bonjourFirst: a.includes("bonjour") });
      const pick = picks[model];
      if (!pick) throw new Error(`model ${model} is gone`);
      const answer = pick(a, b);
      const usage = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 };
      if (typeof answer === "string") return { response: JSON.stringify({ better: answer, reason: `${model} says so` }), usage };
      if ("prose" in answer) return { response: answer.prose, usage };
      if ("fail" in answer) throw new Error(answer.fail);
      await new Promise((r) => setTimeout(r, answer.wait));
      return { response: JSON.stringify({ better: "A", reason: "late" }), usage };
    },
  };
}

const INTENT = { title: "Greet in French", why: "Users in Paris", whyBy: "person" as const, acceptance: ["greet() returns bonjour"] };
const GEMMA = "@cf/google/gemma-4-26b-a4b-it";
const GPT = "@cf/openai/gpt-oss-20b";
const GLM = "@cf/zai-org/glm-4.7-flash";
const bonjour = change("export const greet = () => 'bonjour';\n");
const hello = change("export const greet = () => 'hello there';\n");
/** Prefers whichever change says bonjour, in either order. */
const consistent: Pick = (a) => (a.includes("bonjour") ? "A" : "B");
/** Prefers whichever change is shown first. */
const positional: Pick = () => "A";

function jury(ai: AiRunner, models = [GEMMA, GPT, GLM], opts: { deadlineMs?: number; timeoutMs?: number; limiter?: CallLimiter; onVerdict?: (m: readonly JuryMember[], b: string) => void } = {}): PairJudge {
  return pairJury({ ai, models, limiter: opts.limiter ?? new CallLimiter(8, 120), intent: INTENT, deadlineMs: opts.deadlineMs ?? 5_000, ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}), ...(opts.onVerdict ? { onVerdict: opts.onVerdict } : {}) });
}

describe("the flag and the members", () => {
  it("is off when absent, on for every colony or for the ones it lists", () => {
    expect(juryEnabled(undefined, "hono")).toBe(false);
    expect(juryEnabled("", "hono")).toBe(false);
    expect(juryEnabled("off", "hono")).toBe(false);
    expect(juryEnabled("on", "hono")).toBe(true);
    expect(juryEnabled("hono, scale", "scale")).toBe(true);
    expect(juryEnabled("hono, scale", "shortlinks")).toBe(false);
  });

  it("seats one model per family, those outside the authors' families first, two to three of them", () => {
    expect(JURY_MIN).toBe(2);
    expect(JURY_MAX).toBe(3);
    const configured = [GEMMA, GPT, GLM, "@cf/qwen/qwen3.8-27b"];
    expect(juryMembers([undefined, undefined], configured)).toEqual([GEMMA, GPT, GLM]);
    // The authors' families stay out while two other families can sit, as with the judge.
    expect(juryMembers(["@cf/google/x", "@cf/openai/y"], configured)).toEqual([GLM, "@cf/qwen/qwen3.8-27b"]);
    expect(juryMembers(["@cf/google/x"], configured)).toEqual([GPT, GLM, "@cf/qwen/qwen3.8-27b"]);
    // Only one other family: a model of an author's family makes the second seat.
    expect(juryMembers(["@cf/google/x", "@cf/openai/y"], [GEMMA, GPT, GLM])).toEqual([GLM, GEMMA]);
    expect(juryMembers(["@cf/google/x", "@cf/openai/y", "@cf/zai-org/z"], [GEMMA, GPT, GLM])).toEqual([GEMMA, GPT]);
    // Two of one family are not two families: the second gemma joins only when nothing else can make two.
    expect(juryMembers([], [GEMMA, "@cf/google/gemma-small", GPT])).toEqual([GEMMA, GPT]);
    expect(juryMembers([], [GEMMA, "@cf/google/gemma-small"])).toEqual([GEMMA, "@cf/google/gemma-small"]);
    expect(juryMembers([], [GEMMA])).toEqual([GEMMA]);
    expect(juryMembers([], [])).toEqual([]);
    expect(juryMembers([], [" ", GEMMA, GEMMA])).toEqual([GEMMA]);
  });

  it("comes from the decide policy, with a default of three small models from three families and a patch of model ids", () => {
    expect(DEFAULT_POLICY.juryModels).toEqual([GEMMA, GPT, GLM]);
    expect(mergePolicy(DEFAULT_POLICY, { juryModels: [GLM, "not a model id!", GPT] }).juryModels).toEqual([GLM, GPT]);
    expect(mergePolicy(DEFAULT_POLICY, { juryModels: [] }).juryModels).toEqual(DEFAULT_POLICY.juryModels);
    expect(mergePolicy(DEFAULT_POLICY, { juryModels: "x" }).juryModels).toEqual(DEFAULT_POLICY.juryModels);
  });
});

describe("votes and the tally", () => {
  const member = (model: string, vote: JuryMember["vote"], why = vote === "neither" ? "saw no clear difference" : "r"): JuryMember => ({ model, vote, why, calls: 2 });

  it("counts a member's vote only when its two orders agree", () => {
    expect(memberVote("m", { better: "A", reason: "r1" }, { better: "B", reason: "r2" }, 2)).toEqual({ model: "m", vote: "first", why: "r1", calls: 2 });
    expect(memberVote("m", { better: "B", reason: "" }, { better: "A", reason: "r2" }, 2)).toEqual({ model: "m", vote: "second", why: "r2", calls: 2 });
    expect(memberVote("m", { better: "tie", reason: "" }, { better: "A", reason: "" }, 2)).toMatchObject({ vote: "neither", why: "saw no clear difference" });
    expect(memberVote("m", { better: "A", reason: "" }, { better: "A", reason: "" }, 2)).toMatchObject({ vote: "inconsistent", why: "preferred the change shown first in both orders" });
    expect(memberVote("m", { better: "B", reason: "" }, { better: "B", reason: "" }, 2)).toMatchObject({ vote: "inconsistent", why: "preferred the change shown second in both orders" });
  });

  it("gives the pair to the side with more consistent votes and names every vote", () => {
    const v = tally([member("m1", "first", "it greets in French"), member("m2", "inconsistent", "preferred the change shown first in both orders"), member("m3", "first", "")], "p1", "p2");
    expect(v).toEqual({ better: "first", why: "judged better by 2 of 3 jurors in both orders (m1, m3): it greets in French; m2 preferred the change shown first in both orders" });
    expect(tally([member("m1", "second", "shorter"), member("m2", "neither")], "p1", "p2")).toEqual({ better: "second", why: "judged better by 1 of 2 jurors in both orders (m1): shorter; m2 saw no clear difference" });
  });

  it("is a tie when the votes split or none is consistent", () => {
    expect(tally([member("m1", "first"), member("m2", "second"), member("m3", "inconsistent", "did not answer within 90 s")], "p1", "p2")).toEqual({
      better: "tie",
      why: "the jury of 3 split 1 to 1: m1 for p1; m2 for p2; m3 did not answer within 90 s",
    });
    expect(tally([member("m1", "inconsistent", "preferred the change shown first in both orders"), member("m2", "neither")], "p1", "p2")).toEqual({
      better: "tie",
      why: "the jury of 2 had no consistent vote: m1 preferred the change shown first in both orders; m2 saw no clear difference",
    });
  });
});

describe("the jury on a pair", () => {
  it("asks every member both orders at once, and the majority of consistent votes decides", async () => {
    const log: Array<{ model: string; bonjourFirst: boolean }> = [];
    const verdicts: Array<{ members: readonly JuryMember[]; better: string }> = [];
    const ai = fakeAi({ [GEMMA]: consistent, [GPT]: positional, [GLM]: consistent }, log);
    const v = await jury(ai, undefined, { onVerdict: (members, better) => verdicts.push({ members, better }) })(cand("x", { diffs: hello }), cand("y", { diffs: bonjour }));
    expect(v.better).toBe("second");
    expect(v.calls).toBe(6);
    expect(v.why).toBe(`judged better by 2 of 3 jurors in both orders (${GEMMA}, ${GLM}): ${GEMMA} says so; ${GPT} preferred the change shown first in both orders`);
    expect(v.jury?.map((m) => [m.model, m.vote, m.calls])).toEqual([
      [GEMMA, "second", 2],
      [GPT, "inconsistent", 2],
      [GLM, "second", 2],
    ]);
    expect(v.model).toBeUndefined();
    // Six calls: each member saw bonjour first once and second once.
    expect(log).toHaveLength(6);
    for (const m of [GEMMA, GPT, GLM]) expect(log.filter((l) => l.model === m).map((l) => l.bonjourFirst).sort()).toEqual([false, true]);
    expect(verdicts).toEqual([{ members: v.jury, better: "second" }]);
  });

  it("falls to the deterministic tie-break when the consistent votes split, exactly as a judge's tie does", async () => {
    const ai = fakeAi({ [GEMMA]: consistent, [GPT]: (a) => (a.includes("bonjour") ? "B" : "A"), [GLM]: positional });
    const v = await jury(ai)(cand("x", { diffs: hello }), cand("y", { diffs: bonjour }));
    expect(v.better).toBe("tie");
    expect(v.why).toBe(`the jury of 3 split 1 to 1: ${GEMMA} for y; ${GPT} for x; ${GLM} preferred the change shown first in both orders`);
    // Through selectWinner: the same size, so the earlier proposal wins, the reason naming the tie.
    const out = await selectWinner([cand("x", { createdAt: 1, diffs: hello }), cand("y", { createdAt: 2, diffs: bonjour })], { judge: jury(ai) });
    expect(out.winner.proposalId).toBe("x");
    expect(out.losers[0]?.why).toBe(`a tie (the jury of 3 split 1 to 1: ${GEMMA} for y; ${GPT} for x; ${GLM} preferred the change shown first in both orders), broken by proposal order: proposed first`);
    expect(out.calls).toBe(6);
  });

  it("counts a member that does not answer in time, errors or answers prose as inconsistent, and the rest still decide", async () => {
    const ai = fakeAi({ [GEMMA]: consistent, [GPT]: () => ({ wait: 400 }), [GLM]: () => ({ prose: "the second one, I think" }) });
    const v = await jury(ai, undefined, { deadlineMs: 150 })(cand("x", { diffs: hello }), cand("y", { diffs: bonjour }));
    expect(v.better).toBe("second");
    expect(v.jury?.map((m) => [m.model, m.vote])).toEqual([
      [GEMMA, "second"],
      [GPT, "inconsistent"],
      [GLM, "inconsistent"],
    ]);
    expect(v.jury?.[1]?.why).toMatch(/did not answer within 0 s/);
    expect(v.jury?.[2]?.why).toMatch(/^gave no parsable judgment/);
    expect(v.why).toBe(`judged better by 1 of 3 jurors in both orders (${GEMMA}): ${GEMMA} says so; ${GPT} did not answer within 0 s; ${GLM} gave no parsable judgment: the second one, I think`);
    // Every member out: no consistent vote, a tie for the tie-break.
    const none = fakeAi({ [GEMMA]: () => ({ fail: "model gemma is gone" }), [GPT]: positional });
    const t = await jury(none, [GEMMA, GPT])(cand("x", { diffs: hello }), cand("y", { diffs: bonjour }));
    expect(t).toMatchObject({ better: "tie", why: `the jury of 2 had no consistent vote: ${GEMMA} model gemma is gone; ${GPT} preferred the change shown first in both orders`, calls: 4 });
  });

  it("backs off and retries a throttled member within the deadline", async () => {
    let throttled = 0;
    const inner = fakeAi({ [GEMMA]: consistent, [GPT]: consistent });
    const ai: AiRunner = {
      async run(model, input) {
        if (model === GPT && throttled++ === 0) throw new Error("3040: out of capacity");
        return inner.run(model, input);
      },
    };
    const limiter = new CallLimiter(8, 120);
    const cooled: string[] = [];
    limiter.cooldown = (model: string) => void cooled.push(model);
    const v = await jury(ai, [GEMMA, GPT], { limiter })(cand("x", { diffs: bonjour }), cand("y", { diffs: hello }));
    expect(v).toMatchObject({ better: "first", calls: 5 });
    expect(cooled).toEqual([GPT]);
  });

  it("does not ask about a pair it cannot see whole, or without a member", async () => {
    const log: Array<{ model: string; bonjourFirst: boolean }> = [];
    const ai = fakeAi({ [GEMMA]: consistent }, log);
    const huge = [fileDiff("src/big.ts", null, "x\n".repeat(20_000), { maxChars: 24_000 })];
    expect(await jury(ai)(cand("x", { diffs: huge }), cand("y", { diffs: bonjour }))).toEqual({ better: "tie", why: "too large or unreadable for the jury to see whole", calls: 0 });
    expect(await jury(ai, [])(cand("x", { diffs: hello }), cand("y", { diffs: bonjour }))).toEqual({ better: "tie", why: "no jury model configured", calls: 0 });
    expect(log).toEqual([]);
  });

  it("counts each member's tokens in the judge layer of the spend, per model", async () => {
    const counters = new Map<string, number>();
    const ai = meteredAi(fakeAi({ [GEMMA]: consistent, [GPT]: positional, [GLM]: consistent }), "contest.judge", (name, delta) => counters.set(name, (counters.get(name) ?? 0) + delta));
    await jury(ai)(cand("x", { diffs: hello }), cand("y", { diffs: bonjour }));
    expect(Object.fromEntries(counters)).toEqual({
      [`contest.judge.tokensIn:${GEMMA}`]: 200,
      [`contest.judge.tokensOut:${GEMMA}`]: 20,
      [`contest.judge.tokensIn:${GPT}`]: 200,
      [`contest.judge.tokensOut:${GPT}`]: 20,
      [`contest.judge.tokensIn:${GLM}`]: 200,
      [`contest.judge.tokensOut:${GLM}`]: 20,
    });
  });
});
