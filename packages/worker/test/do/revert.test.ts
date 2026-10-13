import { describe, expect, it } from "vitest";
import type { ColonyEvent, Intent, Landing, Proposal } from "@fire_trident/core";
import { addAgent, addIntent, api, colony, fakeSha, newColony, proposal, proposeEdit, take, tick, trunk, type Assignment } from "./helpers.ts";

type Reverted = { landing: Landing; reverted: Landing; redo: string[]; proposal?: string };

/** One intent on `path`, taken by `agentId`, proposed and landed through the lane; returns its landing id. */
async function landOn(colonyId: string, agentId: string, path: string): Promise<{ intent: Intent; landingId: string }> {
  const intent = await addIntent(colonyId, [path]);
  const p = await proposeEdit(colonyId, await take(colonyId, agentId), agentId);
  expect(await tick(colonyId, "src")).toBe(true);
  const landed = await proposal(colonyId, p.id);
  expect(landed.status).toBe("landed");
  return { intent, landingId: landed.landingId! };
}

/** Land one file with this exact content through the lane; returns its landing id. */
async function landText(colonyId: string, agentId: string, path: string, content: string): Promise<string> {
  await addIntent(colonyId, [path]);
  const a = await take(colonyId, agentId);
  const blob = fakeSha();
  await trunk(colonyId).setContents({ [blob]: content });
  const res = await api<Proposal>("POST", `/colonies/${colonyId}/proposals`, {
    intentId: a.intent.id,
    agentId,
    workspace: a.lease.repo,
    baseSha: a.lease.baseSha,
    headSha: fakeSha(),
    writeSet: [{ path, blob }],
    readSet: await trunk(colonyId).baseBlobs(a.lease.baseSha, [path]),
    declared: { footprint: [path], summary: "edit" },
  });
  expect(res.status).toBe(201);
  expect(await tick(colonyId, "src")).toBe(true);
  const landed = await proposal(colonyId, res.body.id);
  expect(landed.status).toBe("landed");
  return landed.landingId!;
}

describe("revert", () => {
  it("undoes a landing as a new trunk commit, brings its intent back, and records who and why", async () => {
    const c = await newColony();
    const a = await addAgent(c.id, "a");
    const original = (await trunk(c.id).state()).files["src/lib/util.ts"]!.content;
    const { intent, landingId } = await landOn(c.id, a.id, "src/lib/util.ts");
    expect((await trunk(c.id).state()).files["src/lib/util.ts"]!.content).not.toBe(original);

    const res = await api<Reverted>("POST", `/colonies/${c.id}/landings/${landingId}/revert`, { reason: "breaks the helper", by: "matt" });
    expect(res.status).toBe(200);
    expect(res.body.reverted.id).toBe(landingId);
    expect(res.body.landing.paths).toEqual(["src/lib/util.ts"]);
    expect((await trunk(c.id).state()).files["src/lib/util.ts"]!.content).toBe(original);
    expect((await colony(c.id).getColony())!.trunkSha).toBe(res.body.landing.trunkSha);

    // The intent comes back as a new one: parent is the reverted intent, the why starts with the reason.
    expect(res.body.redo).toHaveLength(1);
    const redo = (await api<{ intent: Intent }>("GET", `/colonies/${c.id}/intents/${res.body.redo[0]}`)).body.intent;
    expect(redo).toMatchObject({ status: "open", parentId: intent.id, source: "human", createdBy: "matt", footprint: ["src/lib/util.ts"], title: `Redo after revert: ${intent.title}` });
    expect(redo.why.startsWith(`matt reverted ${landingId} (`)).toBe(true);
    expect(redo.why).toContain("breaks the helper");

    const events = (await api<{ events: ColonyEvent[] }>("GET", `/colonies/${c.id}/events?limit=5000`)).body.events;
    expect(events.find((e) => e.t === "reverted")).toMatchObject({ of: landingId, landingId: res.body.landing.id, by: "matt", reason: "breaks the helper", redo: res.body.redo, paths: ["src/lib/util.ts"] });
    expect(events.some((e) => e.t === "landing" && e.landingId === res.body.landing.id)).toBe(true);

    // A revert can itself be undone, by the commit it made; --no-redo declares nothing, and the
    // intent the first revert declared again is withdrawn, since its change is back.
    const again = await api<Reverted>("POST", `/colonies/${c.id}/landings/${res.body.landing.trunkSha.slice(0, 10)}/revert`, { reason: "it was fine", redo: false });
    expect(again.status).toBe(200);
    expect(again.body.redo).toEqual([]);
    expect((await trunk(c.id).state()).files["src/lib/util.ts"]!.content).not.toBe(original);
    const gone = (await api<{ intent: Intent }>("GET", `/colonies/${c.id}/intents/${res.body.redo[0]}`)).body.intent;
    expect(gone).toMatchObject({ status: "withdrawn" });
    expect(gone.withdrawnReason).toBe(`${res.body.landing.id} was itself reverted by unknown: it was fine`);
  });

  it("refuses when work landed on top, naming the path and the landing, and changes nothing", async () => {
    const c = await newColony();
    const a = await addAgent(c.id, "a");
    const first = await landOn(c.id, a.id, "src/lib/util.ts");
    const second = await landOn(c.id, a.id, "src/lib/util.ts");
    const head = (await trunk(c.id).state()).head;
    const res = await api<{ error: string }>("POST", `/colonies/${c.id}/landings/${first.landingId}/revert`, { reason: "too early" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe(`work landed on top of ${first.landingId}: src/lib/util.ts changed since, last by ${second.landingId}`);
    expect((await trunk(c.id).state()).head).toBe(head);
    const events = (await api<{ events: ColonyEvent[] }>("GET", `/colonies/${c.id}/events?limit=5000`)).body.events;
    expect(events.some((e) => e.t === "reverted")).toBe(false);
  });

  it("refuses to delete a file that later work imports, naming the importer, until that work is undone", async () => {
    const c = await newColony();
    const a = await addAgent(c.id, "a");
    const created = await landText(c.id, a.id, "src/lib/fresh.ts", "export const fresh = 1;\n");
    const importer = await landText(c.id, a.id, "src/app/main.ts", 'import { fresh } from "../lib/fresh.ts";\nconsole.log(fresh);\n');
    const head = (await trunk(c.id).state()).head;

    const refused = await api<{ error: string }>("POST", `/colonies/${c.id}/landings/${created}/revert`, { reason: "not needed", by: "matt" });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe(`work landed on top of ${created}: src/lib/fresh.ts is imported by src/app/main.ts (last changed by ${importer})`);
    expect((await trunk(c.id).state()).head).toBe(head);
    expect((await trunk(c.id).state()).files["src/lib/fresh.ts"]).toBeDefined();

    // Undo the importer first; then the file can go.
    expect((await api("POST", `/colonies/${c.id}/landings/${importer}/revert`, { reason: "back out", by: "matt", redo: false })).status).toBe(200);
    const done = await api<Reverted>("POST", `/colonies/${c.id}/landings/${created}/revert`, { reason: "not needed", by: "matt", redo: false });
    expect(done.status).toBe(200);
    expect(done.body.landing.paths).toEqual(["src/lib/fresh.ts"]);
    expect((await trunk(c.id).state()).files["src/lib/fresh.ts"]).toBeUndefined();
  });

  it("needs a reason, a known landing and the operator token", async () => {
    const c = await newColony();
    expect((await api("POST", `/colonies/${c.id}/landings/lnd_nope/revert`, { reason: "" })).status).toBe(400);
    const missing = await api<{ error: string }>("POST", `/colonies/${c.id}/landings/lnd_nope/revert`, { reason: "r" });
    expect(missing.status).toBe(404);
    expect(missing.body.error).toContain("no landing lnd_nope");
    expect((await api("POST", `/colonies/${c.id}/landings/lnd_nope/revert`, { reason: "r" }, {})).status).toBe(401);
  });
});

/** Propose this exact text for `path` under an assignment (the stand-in trunk lands that text). */
async function proposeText(colonyId: string, a: Assignment, agentId: string, path: string, content: string): Promise<Proposal> {
  const blob = fakeSha();
  await trunk(colonyId).setContents({ [blob]: content });
  const res = await api<Proposal>("POST", `/colonies/${colonyId}/proposals`, {
    intentId: a.intent.id,
    agentId,
    workspace: a.lease.repo,
    baseSha: a.lease.baseSha,
    headSha: fakeSha(),
    writeSet: [{ path, blob }],
    readSet: await trunk(colonyId).baseBlobs(a.lease.baseSha, [path]),
    declared: { footprint: [path], summary: "edit" },
  });
  expect(res.status).toBe(201);
  return res.body;
}

type Landed = { intent: Intent; proposal: Proposal };

/**
 * Two intents on two files of the src region, taken by two agents and landed by one lane tick: one
 * landing that carries two proposals. A file given with text lands as that text, else as a new blob.
 */
async function landTogether(colonyId: string, first: [string, string?], second: [string, string?]): Promise<{ landingId: string; a: Landed; b: Landed }> {
  const ia = await addIntent(colonyId, [first[0]], { priority: 3 });
  const ib = await addIntent(colonyId, [second[0]], { priority: 2 });
  const [agentA, agentB] = [await addAgent(colonyId, "a"), await addAgent(colonyId, "b")];
  const [ta, tb] = [await take(colonyId, agentA.id), await take(colonyId, agentB.id)];
  expect([ta.intent.id, tb.intent.id]).toEqual([ia.id, ib.id]);
  const propose = (t: Assignment, agentId: string, [path, text]: [string, string?]) => (text === undefined ? proposeEdit(colonyId, t, agentId) : proposeText(colonyId, t, agentId, path, text));
  const [pa, pb] = [await propose(ta, agentA.id, first), await propose(tb, agentB.id, second)];
  expect(await tick(colonyId, "src")).toBe(true);
  const [ra, rb] = [await proposal(colonyId, pa.id), await proposal(colonyId, pb.id)];
  expect([ra.status, rb.status]).toEqual(["landed", "landed"]);
  expect(rb.landingId).toBe(ra.landingId);
  return { landingId: ra.landingId!, a: { intent: ia, proposal: ra }, b: { intent: ib, proposal: rb } };
}

describe("revert one proposal of a landing", () => {
  it("puts back only the files it wrote and declares only its intent again; the other proposal's files and intent stay", async () => {
    const c = await newColony();
    const before = (await trunk(c.id).state()).files;
    const { landingId, a, b } = await landTogether(c.id, ["src/lib/util.ts"], ["src/app/main.ts"]);
    const landed = (await trunk(c.id).state()).files;
    expect(landed["src/lib/util.ts"]!.blob).not.toBe(before["src/lib/util.ts"]!.blob);

    const res = await api<Reverted>("POST", `/colonies/${c.id}/landings/${landingId}/revert`, { reason: "the helper change broke it", by: "matt", proposal: a.proposal.id });
    expect(res.status).toBe(200);
    expect(res.body.proposal).toBe(a.proposal.id);
    expect(res.body.reverted.id).toBe(landingId);
    expect([...res.body.reverted.proposalIds].sort()).toEqual([a.proposal.id, b.proposal.id].sort());
    expect(res.body.landing.paths).toEqual(["src/lib/util.ts"]);
    const after = (await trunk(c.id).state()).files;
    expect(after["src/lib/util.ts"]).toEqual(before["src/lib/util.ts"]);
    expect(after["src/app/main.ts"]).toEqual(landed["src/app/main.ts"]);
    expect((await colony(c.id).getColony())!.trunkSha).toBe(res.body.landing.trunkSha);

    // Only the undone proposal's intent comes back; the other stays landed.
    expect(res.body.redo).toHaveLength(1);
    const redo = (await api<{ intent: Intent }>("GET", `/colonies/${c.id}/intents/${res.body.redo[0]}`)).body.intent;
    expect(redo).toMatchObject({ status: "open", parentId: a.intent.id, createdBy: "matt", footprint: ["src/lib/util.ts"], title: `Redo after revert: ${a.intent.title}` });
    expect(redo.why.startsWith(`matt reverted ${a.proposal.id} of ${landingId} (`)).toBe(true);
    expect((await api<{ intent: Intent }>("GET", `/colonies/${c.id}/intents/${b.intent.id}`)).body.intent.status).toBe("landed");

    // The event and the revert commit's lineage note name the proposal.
    const events = (await api<{ events: ColonyEvent[] }>("GET", `/colonies/${c.id}/events?limit=5000`)).body.events;
    expect(events.find((e) => e.t === "reverted")).toMatchObject({ of: landingId, landingId: res.body.landing.id, proposal: a.proposal.id, paths: ["src/lib/util.ts"], redo: res.body.redo, by: "matt" });
    const note = JSON.parse((await trunk(c.id).state()).notes![res.body.landing.id]!) as { revert: Record<string, unknown> };
    expect(note.revert).toMatchObject({ of: landingId, commit: res.body.reverted.trunkSha, by: "matt", reason: "the helper change broke it", proposal: a.proposal.id });

    // Its file now holds the revert: undoing it again is refused, and so is the whole landing.
    const again = await api<{ error: string }>("POST", `/colonies/${c.id}/landings/${landingId}/revert`, { reason: "again", proposal: a.proposal.id });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe(`work landed on top of ${a.proposal.id} of ${landingId}: src/lib/util.ts changed since, last by ${res.body.landing.id}`);
    expect((await api("POST", `/colonies/${c.id}/landings/${landingId}/revert`, { reason: "all of it" })).status).toBe(409);

    // The other proposal can still go on its own.
    const other = await api<Reverted>("POST", `/colonies/${c.id}/landings/${landingId}/revert`, { reason: "this one too", proposal: b.proposal.id, redo: false });
    expect(other.status).toBe(200);
    expect(other.body).toMatchObject({ proposal: b.proposal.id, redo: [], landing: { paths: ["src/app/main.ts"] } });
    expect((await trunk(c.id).state()).files["src/app/main.ts"]).toEqual(before["src/app/main.ts"]);
  });

  it("undoing that revert brings the proposal's change back and withdraws the intent it declared again", async () => {
    const c = await newColony();
    const { landingId, a } = await landTogether(c.id, ["src/lib/util.ts"], ["src/app/main.ts"]);
    const landed = (await trunk(c.id).state()).files;
    const first = await api<Reverted>("POST", `/colonies/${c.id}/landings/${landingId}/revert`, { reason: "broke it", proposal: a.proposal.id });
    expect(first.status).toBe(200);
    const back = await api<Reverted>("POST", `/colonies/${c.id}/landings/${first.body.landing.id}/revert`, { reason: "it was fine", redo: false });
    expect(back.status).toBe(200);
    expect((await trunk(c.id).state()).files["src/lib/util.ts"]).toEqual(landed["src/lib/util.ts"]);
    expect((await api<{ intent: Intent }>("GET", `/colonies/${c.id}/intents/${first.body.redo[0]}`)).body.intent.status).toBe("withdrawn");
  });

  it("refuses it while later work changed its files, and still undoes the other proposal", async () => {
    const c = await newColony();
    const { landingId, a, b } = await landTogether(c.id, ["src/lib/util.ts"], ["src/app/main.ts"]);
    // The agent that wrote util.ts still holds its claim on it, so it writes the later change too.
    const later = await landOn(c.id, a.proposal.agentId, "src/lib/util.ts");
    const head = (await trunk(c.id).state()).head;
    const refused = await api<{ error: string }>("POST", `/colonies/${c.id}/landings/${landingId}/revert`, { reason: "r", proposal: a.proposal.id });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe(`work landed on top of ${a.proposal.id} of ${landingId}: src/lib/util.ts changed since, last by ${later.landingId}`);
    expect((await trunk(c.id).state()).head).toBe(head);
    const ok = await api<Reverted>("POST", `/colonies/${c.id}/landings/${landingId}/revert`, { reason: "r", proposal: b.proposal.id });
    expect(ok.status).toBe(200);
    expect(ok.body.landing.paths).toEqual(["src/app/main.ts"]);
  });

  it("refuses to delete a file it created while another file imports it, even one from the same landing", async () => {
    const c = await newColony();
    const { landingId, a } = await landTogether(c.id, ["src/lib/kit.ts", "export const kit = 1;\n"], ["src/app/main.ts", 'import { kit } from "../lib/kit.ts";\nconsole.log(kit);\n']);
    const head = (await trunk(c.id).state()).head;
    const refused = await api<{ error: string }>("POST", `/colonies/${c.id}/landings/${landingId}/revert`, { reason: "r", proposal: a.proposal.id });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe(`work landed on top of ${a.proposal.id} of ${landingId}: src/lib/kit.ts is imported by src/app/main.ts`);
    expect((await trunk(c.id).state()).head).toBe(head);
    // The whole landing takes its importer back with it.
    const whole = await api<Reverted>("POST", `/colonies/${c.id}/landings/${landingId}/revert`, { reason: "r", redo: false });
    expect(whole.status).toBe(200);
    expect((await trunk(c.id).state()).files["src/lib/kit.ts"]).toBeUndefined();
  });

  it("answers 404 for a proposal that did not land in that landing, naming where it did", async () => {
    const c = await newColony();
    const a = await addAgent(c.id, "a");
    const first = await landOn(c.id, a.id, "src/lib/util.ts");
    const second = await landOn(c.id, a.id, "src/app/main.ts");
    const landings = (await trunk(c.id).state()).landings;
    const [p1, p2] = [first, second].map((x) => landings.find((l) => l.id === x.landingId)!.proposalIds[0]!);
    const wrong = await api<{ error: string }>("POST", `/colonies/${c.id}/landings/${first.landingId}/revert`, { reason: "r", proposal: p2 });
    expect(wrong.status).toBe(404);
    expect(wrong.body.error).toBe(`proposal ${p2} did not land in ${first.landingId} (it landed in ${second.landingId})`);
    const unknown = await api<{ error: string }>("POST", `/colonies/${c.id}/landings/${first.landingId}/revert`, { reason: "r", proposal: "prp_nope" });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error).toBe(`proposal prp_nope did not land in ${first.landingId}`);
    expect((await api("POST", `/colonies/${c.id}/landings/${first.landingId}/revert`, { reason: "r", proposal: "" })).status).toBe(400);
    expect((await api("POST", `/colonies/${c.id}/landings/${first.landingId}/revert`, { reason: "", proposal: p1 })).status).toBe(400);
    expect((await api("POST", `/colonies/${c.id}/landings/${first.landingId}/revert`, { reason: "r", proposal: p1 }, {})).status).toBe(401);
    // The only proposal of its landing: undoing it undoes the landing.
    const alone = await api<Reverted>("POST", `/colonies/${c.id}/landings/${first.landingId}/revert`, { reason: "r", proposal: p1 });
    expect(alone.status).toBe(200);
    expect(alone.body).toMatchObject({ proposal: p1, landing: { paths: ["src/lib/util.ts"] } });
    expect(alone.body.redo).toHaveLength(1);
  });
});
