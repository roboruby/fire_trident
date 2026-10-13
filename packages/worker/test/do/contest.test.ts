import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ColonyEvent, Directive, Intent, Proposal } from "@fire_trident/core";
import type { TakeResult } from "../../src/colony/ColonyDO.ts";
import { fileDiff, type FileDiff } from "../../src/decide/diff.ts";
import type { Assignment } from "./helpers.ts";
import { addAgent, addIntent, api, colony, eventually, fakeSha, newColony, proposal, proposeEdit, region, take, tick, trunk } from "./helpers.ts";

/**
 * Contest mode: an intent with `contest: n` seats up to n agents at once. Each builds its own change;
 * ready changes wait for the contest; one goes to its lane and the others go back superseded, kept as
 * alternatives in the winner's lineage. Self-assignment is deterministic here, and the harness has no
 * Workers AI binding, so the deterministic order decides unless a test supplies a judge.
 */
const MAIN = "src/app/main.ts";

async function tryTake(colonyId: string, agentId: string): Promise<TakeResult> {
  const res = await api<TakeResult>("POST", `/colonies/${colonyId}/agents/${agentId}/take`);
  expect(res.status).toBe(200);
  return res.body;
}

async function laneSize(colonyId: string, name: string): Promise<number> {
  return ((await region(colonyId, name).status()) as { lane: number }).lane;
}

async function events(colonyId: string): Promise<ColonyEvent[]> {
  const res = await api<{ events: ColonyEvent[] }>("GET", `/colonies/${colonyId}/events?limit=5000`);
  expect(res.status).toBe(200);
  return res.body.events;
}

async function agentState(colonyId: string, agentId: string): Promise<{ state: string; intentId?: string }> {
  return (await colony(colonyId).getAgent(agentId)) as { state: string; intentId?: string };
}

/** Rows of a table inside the ColonyDO. */
async function colonyRows<T>(colonyId: string, sql: string, ...args: unknown[]): Promise<T[]> {
  const out: unknown = await runInDurableObject(colony(colonyId), (_i: unknown, state: DurableObjectState): unknown => state.storage.sql.exec(sql, ...args).toArray());
  return out as T[];
}

const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("contest mode", () => {
  it("seats three agents on one intent, lands one change and supersedes the other two with reasons", async () => {
    const c = await newColony();
    const x = await addIntent(c.id, [MAIN], { contest: 3, title: "Greet in French" });
    expect(x.contest).toBe(3);
    const [a, b, d] = [await addAgent(c.id, "a"), await addAgent(c.id, "b"), await addAgent(c.id, "d")];
    // Lateral inhibition and admission let every contestant onto the intent's own file.
    const ta = await take(c.id, a.id);
    const tb = await take(c.id, b.id);
    const td = await take(c.id, d.id);
    expect([ta.intent.id, tb.intent.id, td.intent.id]).toEqual([x.id, x.id, x.id]);
    expect(new Set([ta.lease.repo.name, tb.lease.repo.name, td.lease.repo.name]).size).toBe(3);
    // A fourth agent finds every seat taken (and the contestants' claims inhibit it as usual).
    const e = await addAgent(c.id, "e");
    expect(await tryTake(c.id, e.id)).toMatchObject({ wait: true });
    // A taken again hands back its own seat.
    expect((await take(c.id, a.id)).lease.repo.name).toBe(ta.lease.repo.name);

    // A writes outside the footprint; B and D stay inside it, B first.
    const pa = await proposeEdit(c.id, ta, a.id, { paths: [MAIN, "docs/extra.md"] });
    await pause(5);
    const pb = await proposeEdit(c.id, tb, b.id);
    // Held for the contest, not queued: D has not proposed yet.
    await pause(50);
    expect((await proposal(c.id, pa.id)).status).toBe("ready");
    expect((await proposal(c.id, pb.id)).status).toBe("ready");
    expect(await laneSize(c.id, "src")).toBe(0);
    await pause(5);
    const pd = await proposeEdit(c.id, td, d.id);

    // Every live contestant is in: B wins (nothing outside the footprint, proposed before D).
    await eventually(() => laneSize(c.id, "src"), (n) => n === 1, 5_000);
    const [ra, rd] = [await proposal(c.id, pa.id), await proposal(c.id, pd.id)];
    expect(ra).toMatchObject({ status: "returned", supersededBy: pb.id });
    expect(ra.reason).toBe(`superseded: contest for ${x.id} won by ${pb.id} (0 paths outside the footprint against 1)`);
    expect(rd).toMatchObject({ status: "returned", supersededBy: pb.id });
    expect(rd.reason).toMatch(new RegExp(`^superseded: contest for ${x.id} won by ${pb.id} \\(a tie \\(no judge model is bound\\), broken by proposal order`));
    // The losers' agents stand down; nothing reopened the intent.
    expect(await agentState(c.id, a.id)).toMatchObject({ state: "idle" });
    expect(await agentState(c.id, d.id)).toMatchObject({ state: "idle" });
    expect(((await colony(c.id).getIntent(x.id)) as Intent).status).toBe("proposed");

    // The winner lands, carrying the alternatives into its lineage.
    await tick(c.id, "src");
    expect((await proposal(c.id, pb.id)).status).toBe("landed");
    expect(((await colony(c.id).getIntent(x.id)) as Intent).status).toBe("landed");
    const ctx = (await colony(c.id).landContext([x.id], [b.id], [pb.id])) as { alternatives?: Record<string, Array<{ proposalId: string; agentId: string; reason: string }>> };
    expect(ctx.alternatives?.[pb.id]).toEqual([
      { proposalId: pa.id, agentId: a.id, reason: "0 paths outside the footprint against 1" },
      { proposalId: pd.id, agentId: d.id, reason: expect.stringMatching(/^a tie \(no judge model is bound\), broken by proposal order/) },
    ]);
    // The lane passed them on to the trunk writer.
    const passed = JSON.parse((await trunk(c.id).state()).contexts?.at(-1) ?? "null") as { alternatives?: Record<string, unknown[]> } | null;
    expect(passed?.alternatives?.[pb.id]).toHaveLength(2);
    // The winner's evidence says how it won.
    expect((await proposal(c.id, pb.id)).evidence.checks.find((ch) => ch.name === "contest")?.detail).toMatch(/^won the contest for .* against 2 other changes/);
    // One contest event, with the winner and both losers.
    const contest = (await events(c.id)).filter((ev): ev is Extract<ColonyEvent, { t: "contest" }> => ev.t === "contest");
    expect(contest).toHaveLength(1);
    expect(contest[0]).toMatchObject({ intentId: x.id, title: "Greet in French", winner: pb.id });
    expect(new Set(contest[0]!.losers)).toEqual(new Set([pa.id, pd.id]));
  });

  it("does not wait for a contestant that was stopped", async () => {
    const c = await newColony();
    await addIntent(c.id, [MAIN], { contest: 2 });
    const [a, b] = [await addAgent(c.id, "a"), await addAgent(c.id, "b")];
    const ta = await take(c.id, a.id);
    await take(c.id, b.id);
    const pa = await proposeEdit(c.id, ta, a.id);
    await pause(50);
    expect(await laneSize(c.id, "src")).toBe(0);
    expect((await api("POST", `/colonies/${c.id}/agents/${b.id}/stop`, {})).status).toBe(200);
    // Stopped, B no longer counts: A's change goes to its lane within the next look at open contests.
    await eventually(() => laneSize(c.id, "src"), (n) => n === 1, 5_000);
    await tick(c.id, "src");
    expect((await proposal(c.id, pa.id)).status).toBe("landed");
  });

  it("decides at the deadline while a contestant is still working, and stands that contestant down", async () => {
    const c = await newColony();
    const x = await addIntent(c.id, [MAIN], { contest: 2 });
    const [a, b] = [await addAgent(c.id, "a"), await addAgent(c.id, "b")];
    const ta = await take(c.id, a.id);
    const tb = await take(c.id, b.id);
    const pa = await proposeEdit(c.id, ta, a.id);
    // B is alive and still working: the contest waits (its clock runs to the deadline, ten minutes out).
    await pause(1_300);
    expect(await laneSize(c.id, "src")).toBe(0);
    const [round] = await colonyRows<{ state: string; deadline: number; opened_at: number }>(c.id, "SELECT state, deadline, opened_at FROM contests WHERE intent_id = ?", x.id);
    expect(round).toMatchObject({ state: "open" });
    expect(round!.deadline - round!.opened_at).toBe(10 * 60_000);
    // The deadline passes: the alarm decides with the changes that are ready.
    await colonyRows(c.id, "UPDATE contests SET deadline = ? WHERE intent_id = ?", Date.now() - 1, x.id);
    expect(await runDurableObjectAlarm(colony(c.id))).toBe(true);
    await eventually(() => laneSize(c.id, "src"), (n) => n === 1, 5_000);
    // B stands down: told in its inbox, idle, and its late change is refused with the reason.
    expect(await agentState(c.id, b.id)).toMatchObject({ state: "idle" });
    const inbox = (await api<Array<{ status: string; reason: string; directive?: Directive }>>("GET", `/colonies/${c.id}/agents/${b.id}/inbox`)).body;
    expect(inbox.find((x2) => x2.status === "directive")?.directive).toMatchObject({ kind: "withdrawal", intentId: x.id, message: expect.stringMatching(/contest for this intent was decided/) });
    const late = await api<{ error: string }>("POST", `/colonies/${c.id}/proposals`, {
      intentId: x.id,
      agentId: b.id,
      workspace: tb.lease.repo,
      baseSha: tb.lease.baseSha,
      headSha: fakeSha(),
      writeSet: [{ path: MAIN, blob: fakeSha() }],
      readSet: [],
    });
    expect(late.status).toBe(409);
    expect(late.body.error).toMatch(/contest was decided/);
    await tick(c.id, "src");
    expect((await proposal(c.id, pa.id)).status).toBe("landed");
  });

  it("lets a contestant join although the region is full and the intent's file is claimed", async () => {
    const c = await newColony();
    const x = await addIntent(c.id, [MAIN], { contest: 2 });
    const [a, b] = [await addAgent(c.id, "a"), await addAgent(c.id, "b")];
    expect((await take(c.id, a.id)).intent.id).toBe(x.id);
    // Three other agents now work in the region: admission would turn a new forager away.
    const now = Date.now();
    await region(c.id, "src").deposit(["src/x1.ts", "src/x2.ts", "src/x3.ts"].map((path, i) => ({ kind: "claim" as const, path, strength: 1, at: now, agentId: `agt_other${i}`, intentId: `int_other${i}` })));
    await pause(300); // past the colony's shared field reading
    const tb = await take(c.id, b.id);
    expect(tb.intent.id).toBe(x.id);
    // An ordinary intent on the same file is still inhibited for a third agent.
    const y = await addIntent(c.id, [MAIN, "src/app/y.ts"], { priority: 5 });
    const e = await addAgent(c.id, "e");
    const got = await tryTake(c.id, e.id);
    expect("intent" in got && got.intent.id === y.id).toBe(false);
  });

  it("sends back a change ready after the decision, and seats a new round when the winner does not land", async () => {
    const c = await newColony();
    const x = await addIntent(c.id, [MAIN], { contest: 2 });
    const [a, b] = [await addAgent(c.id, "a"), await addAgent(c.id, "b")];
    const ta = await take(c.id, a.id);
    const tb = await take(c.id, b.id);
    const pa = await proposeEdit(c.id, ta, a.id);
    await pause(5);
    const pb = await proposeEdit(c.id, tb, b.id);
    await eventually(() => laneSize(c.id, "src"), (n) => n === 1, 5_000);
    expect((await proposal(c.id, pb.id)).supersededBy).toBe(pa.id);
    // A won and waits in its lane; another change of its own arrives after the decision and goes back.
    const again = await proposeEdit(c.id, ta, a.id);
    const late = await eventually(() => proposal(c.id, again.id), (p) => p.status === "returned", 5_000);
    expect(late).toMatchObject({ supersededBy: pa.id, reason: `superseded: contest for ${x.id} won by ${pa.id} (ready after the contest was decided)` });
    expect(await laneSize(c.id, "src")).toBe(1);
    // The winner does not land (a conflict at land time): the intent reopens, and a new contestant takes a seat.
    await trunk(c.id).returnOnLand([pa.id]);
    await tick(c.id, "src");
    expect((await proposal(c.id, pa.id)).status).toBe("returned");
    await pause(300);
    const d = await addAgent(c.id, "d");
    expect((await take(c.id, d.id)).intent.id).toBe(x.id);
  });

  it("tells every contestant when the intent is amended or withdrawn, and frees a seat given back", async () => {
    const c = await newColony();
    const x = await addIntent(c.id, [MAIN], { contest: 2 });
    const [a, b, d] = [await addAgent(c.id, "a"), await addAgent(c.id, "b"), await addAgent(c.id, "d")];
    await take(c.id, a.id);
    await take(c.id, b.id);
    const directives = async (agentId: string): Promise<Directive[]> =>
      (await api<Array<{ status: string; directive?: Directive }>>("GET", `/colonies/${c.id}/agents/${agentId}/inbox`)).body.flatMap((e) => (e.directive ? [e.directive] : []));

    // An amendment reaches both contestants, not only the intent row's holder.
    expect((await api("PATCH", `/colonies/${c.id}/intents/${x.id}`, { why: "Say bonjour", reason: "French UI" })).status).toBe(200);
    for (const id of [a.id, b.id]) expect((await directives(id)).map((dd) => dd.kind)).toContain("revision");

    // B gives its seat back (the MCP `release` tool): its claims go, and D can take the seat.
    await colony(c.id).abandon(b.id, "giving it back");
    expect(await agentState(c.id, b.id)).toMatchObject({ state: "idle" });
    await pause(300);
    expect((await take(c.id, d.id)).intent.id).toBe(x.id);

    // A withdrawal stops both contestants.
    expect((await api("POST", `/colonies/${c.id}/intents/${x.id}/withdraw`, { reason: "not needed" })).status).toBe(200);
    for (const id of [a.id, d.id]) {
      expect((await directives(id)).map((dd) => dd.kind)).toContain("withdrawal");
      expect(await agentState(c.id, id)).toMatchObject({ state: "idle" });
    }
  });

  it("leaves ordinary intents as they were: one holder, straight to the lane", async () => {
    const c = await newColony();
    const x = await addIntent(c.id, [MAIN]);
    expect(x.contest).toBeUndefined();
    const one = await addIntent(c.id, ["docs/guide.md"], { contest: 1 });
    expect(one.contest).toBeUndefined();
    const [a, b] = [await addAgent(c.id, "a"), await addAgent(c.id, "b")];
    const ta = await take(c.id, a.id);
    expect(ta.intent.id).toBe(x.id);
    // The second agent cannot share X (held), and takes the other intent instead.
    expect((await take(c.id, b.id)).intent.id).toBe(one.id);
    const p = await proposeEdit(c.id, ta, a.id);
    expect(await laneSize(c.id, "src")).toBe(1);
    await tick(c.id, "src");
    expect((await proposal(c.id, p.id)).status).toBe("landed");
    expect(await colonyRows(c.id, "SELECT * FROM contests")).toEqual([]);
    expect(await colonyRows(c.id, "SELECT * FROM contest_entries")).toEqual([]);
    expect((await colony(c.id).landContext([x.id], [a.id], [p.id])) as object).not.toHaveProperty("alternatives");
  });

  it("refuses a contest outside 1 to 4 agents", async () => {
    const c = await newColony();
    for (const contest of [0, 5, 2.5]) {
      const res = await api("POST", `/colonies/${c.id}/intents`, { title: "t", why: "w", footprint: [MAIN], contest });
      expect(res.status).toBe(400);
    }
    // Other callers than the API are checked by the colony itself.
    await runInDurableObject(colony(c.id), async (instance) => {
      const stub = instance as unknown as { addIntent(i: Omit<Intent, "id" | "status" | "createdAt">): Promise<Intent> };
      await expect(stub.addIntent({ colonyId: c.id, title: "t", why: "w", footprint: [MAIN], source: "human", priority: 1, createdBy: "test", contest: 7 })).rejects.toThrow(/contest must be 2 to 4 agents/);
    });
  });

  it("asks a second-opinion model in both orders, lands the change it prefers, and breaks a position-swap tie by the smaller diff", async () => {
    const c = await newColony();
    await colony(c.id).setDecidePolicy({ enabled: false }); // changes skip the reflex arc and are ready at once
    const calls: Array<{ model: string; a: string; b: string }> = [];
    let biased = false;
    const texts = new Map<string, string>();
    await runInDurableObject(colony(c.id), (instance) => {
      const self = instance as unknown as { env: object; contestDiffs: (p: Proposal) => Promise<FileDiff[]> };
      const ai = {
        async run(model: string, input: { messages: Array<{ role: string; content: string }> }): Promise<unknown> {
          const user = input.messages.find((m) => m.role === "user")?.content ?? "";
          const a = user.slice(user.indexOf("Change A"), user.indexOf("Change B"));
          const b = user.slice(user.indexOf("Change B"));
          calls.push({ model, a, b });
          if (biased) return { response: JSON.stringify({ better: "A", reason: "the first one reads better" }) };
          return { response: JSON.stringify({ better: a.includes("bonjour") ? "A" : "B", reason: "it greets in French as asked" }) };
        },
      };
      self.env = new Proxy(self.env, { get: (t, k) => (k === "AI" ? ai : Reflect.get(t, k)) });
      self.contestDiffs = async (p: Proposal) => p.writeSet.map((w) => fileDiff(w.path, 'console.log("hello");\n', texts.get(p.agentId) ?? "", { maxChars: 24_000 }));
    });

    const run = async (contestants: Array<{ name: string; text: string }>): Promise<{ ids: string[]; intent: Intent }> => {
      await pause(300); // past the colony's shared field reading, which may hold the last round's claims
      const x = await addIntent(c.id, [MAIN], { contest: 2, title: "Greet in French", acceptance: ["prints bonjour"] });
      const agents = [];
      for (const k of contestants) agents.push(await addAgent(c.id, k.name));
      const taken: Assignment[] = [];
      for (const ag of agents) taken.push(await take(c.id, ag.id));
      const ids: string[] = [];
      for (const [i, ag] of agents.entries()) {
        texts.set(ag.id, contestants[i]!.text);
        ids.push((await proposeEdit(c.id, taken[i]!, ag.id)).id);
        await pause(5);
      }
      await eventually(() => laneSize(c.id, "src"), (n) => n === 1, 5_000);
      return { ids, intent: x };
    };

    // The first change says hello, the second bonjour: the judge prefers the second in both orders.
    const first = await run([
      { name: "a", text: 'console.log("hello there");\n' },
      { name: "b", text: 'console.log("bonjour");\n' },
    ]);
    expect(calls).toHaveLength(2);
    expect(new Set(calls.map((x) => x.model))).toEqual(new Set(["@cf/google/gemma-4-26b-a4b-it"]));
    // The same pair, both orders: what was change A the first time is change B the second.
    expect(calls[0]!.a.includes("bonjour")).toBe(!calls[1]!.a.includes("bonjour"));
    const [loser1, winner1] = [await proposal(c.id, first.ids[0]!), await proposal(c.id, first.ids[1]!)];
    expect(winner1.status).toBe("ready");
    expect(loser1).toMatchObject({ status: "returned", supersededBy: winner1.id });
    expect(loser1.reason).toMatch(/judged better by @cf\/google\/gemma-4-26b-a4b-it in both orders: it greets in French as asked/);
    await tick(c.id, "src");
    expect((await proposal(c.id, winner1.id)).status).toBe("landed");

    // A judge that always picks the change shown first disagrees with itself: a tie, and the smaller diff wins
    // although it was proposed second.
    biased = true;
    calls.length = 0;
    const second = await run([
      { name: "c", text: 'console.log("bonjour");\nconsole.log("et bienvenue");\nconsole.log("à tous");\n' },
      { name: "d", text: 'console.log("salut");\n' },
    ]);
    expect(calls).toHaveLength(2);
    const [big, small] = [await proposal(c.id, second.ids[0]!), await proposal(c.id, second.ids[1]!)];
    expect(small.status).toBe("ready");
    expect(big).toMatchObject({ status: "returned", supersededBy: small.id });
    expect(big.reason).toMatch(/a tie \(@cf\/google\/gemma-4-26b-a4b-it preferred the change shown first in both orders\), broken by the smaller diff: 2 lines against 4/);
  });
});
