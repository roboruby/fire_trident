import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { blobId, changesetId } from "@fire_trident/core";
import type { ColonySnapshot, FileVersion, Intent, MegafileReport, Path, Proposal, Sha } from "@fire_trident/core";
import { addAgent, addIntent, api, colony, eventually, newColony, proposal, take, tick, trunk } from "./helpers.ts";
import type { Assignment } from "./helpers.ts";

/**
 * The megafile alarm (FT_MEGAFILE) through the Durable Objects: script files that grow hot among many writers get
 * one split intent and a hold; take and propose respect the hold; changes already on their way go back when it
 * begins; and each way the hold lifts.
 */

const BIG = "src/big.ts";

/** A text of `n` lines. */
function text(n: number, tag = "v"): string {
  return Array.from({ length: n }, (_, i) => `export const ${tag}${i} = ${i};\n`).join("");
}

/** Set FT_MEGAFILE as the colony object sees it (the harness binds none, so the alarm is off by default). */
async function setMegafile(colonyId: string, value: string): Promise<void> {
  await runInDurableObject(colony(colonyId), (instance) => {
    const i = instance as unknown as { env: Record<string, unknown> };
    i.env = { ...i.env, FT_MEGAFILE: value };
  });
}

/** The ColonyDO.propose input of an inline change for an assignment, writing these files (content null deletes). */
function inlineInput(colonyId: string, a: Assignment, agentId: string, files: Record<Path, string | null>) {
  const writeSet: FileVersion[] = [];
  const contents: Record<Sha, string> = {};
  for (const [path, t] of Object.entries(files)) {
    const blob = t === null ? null : blobId(t);
    writeSet.push({ path, blob });
    if (t !== null && blob) contents[blob] = t;
  }
  return {
    colonyId,
    intentId: a.intent.id,
    agentId,
    workspace: a.lease.repo,
    baseSha: a.lease.baseSha,
    headSha: changesetId(a.lease.baseSha, writeSet),
    writeSet,
    readSet: [],
    declared: { footprint: a.intent.footprint, summary: "inline" },
    evidence: { notVerified: "Not verified: anything beyond the edit" },
    contents,
  };
}

/** A new agent, holding a new intent on `footprint`: its assignment. */
async function holder(colonyId: string, name: string, footprint: Path[]): Promise<{ agentId: string; a: Assignment }> {
  const agent = await addAgent(colonyId, name);
  await addIntent(colonyId, footprint, { assignedTo: agent.id, title: `${name}: change ${footprint.join(", ")}` });
  return { agentId: agent.id, a: await take(colonyId, agent.id) };
}

/** Propose an inline change and land it through the src lane (the stand-in trunk writes the change's own text). */
async function landInline(colonyId: string, h: { agentId: string; a: Assignment }, files: Record<Path, string | null>): Promise<Proposal> {
  const input = inlineInput(colonyId, h.a, h.agentId, files);
  await trunk(colonyId).setContents(input.contents);
  const p = await colony(colonyId).propose(input);
  expect(p.status).toBe("ready");
  await tick(colonyId, "src");
  const after = await proposal(colonyId, p.id);
  expect(after.status).toBe("landed");
  return after;
}

/** The colony's megafile report (GET /megafile). */
async function report(colonyId: string): Promise<MegafileReport & { on: boolean }> {
  const res = await api<MegafileReport & { on: boolean }>("GET", `/colonies/${colonyId}/megafile`);
  expect(res.status).toBe(200);
  return res.body;
}

/** Seed BIG with 650 lines, then `appends` agents each add 45 lines to it (one landing each). */
async function grow(colonyId: string, appends: number): Promise<number> {
  let lines = 650;
  await landInline(colonyId, await holder(colonyId, "seeder", [BIG]), { [BIG]: text(lines) });
  for (let i = 1; i <= appends; i++) {
    lines += 45;
    await landInline(colonyId, await holder(colonyId, `writer-${i}`, [BIG]), { [BIG]: text(lines) });
  }
  return lines;
}

/** A colony with the alarm on whose BIG turned hot: its held report and split intent. */
async function hotColony(before?: (colonyId: string) => Promise<void>): Promise<{ colonyId: string; split: Intent; held: MegafileReport["held"][number] }> {
  const c = await newColony();
  await setMegafile(c.id, `other-colony,${c.id}`);
  await grow(c.id, 3);
  expect((await report(c.id)).held).toEqual([]);
  if (before) await before(c.id);
  await landInline(c.id, await holder(c.id, "writer-4", [BIG]), { [BIG]: text(830) });
  const r = await eventually(() => report(c.id), (x) => x.held.length > 0);
  expect(r.held).toHaveLength(1);
  const snap = (await api<ColonySnapshot>("GET", `/colonies/${c.id}`)).body;
  const split = snap.intents.find((i) => i.id === r.held[0]!.intentId)!;
  return { colonyId: c.id, split, held: r.held[0]! };
}

describe("a script file that grows hot (FT_MEGAFILE)", () => {
  it("gets one split intent and a hold, listed in the colony's status", async () => {
    const { colonyId, split, held } = await hotColony();
    expect(held).toMatchObject({ path: BIG, by: "colony", signal: "growth", lines: 830, baseline: 650, agents: 5, returns: 0 });
    expect(split).toMatchObject({
      title: "Split src/big.ts into smaller modules",
      source: "system",
      priority: 8,
      status: "open",
      createdBy: "megafile",
      footprint: ["src/big.ts", "src/*", "src/big/**"],
    });
    expect(split.why).toContain("src/big.ts has 830 lines, up from 650 (28%) in the last 30 minutes, and changes from 5 agents landed on it in that time.");
    expect(split.acceptance).toEqual(["Every name src/big.ts exports today is still exported from src/big.ts (re-export what moved), so no import of it changes", "The tests pass"]);
    const snap = (await api<ColonySnapshot>("GET", `/colonies/${colonyId}`)).body;
    expect(snap.megafiles?.held).toEqual([expect.objectContaining({ path: BIG, intentId: split.id, lines: 830 })]);
    expect(snap.intents.filter((i) => i.source === "system")).toHaveLength(1);
  });

  it("is not alarmed while FT_MEGAFILE is off: no intent, no hold, nothing in the status", async () => {
    const c = await newColony();
    await grow(c.id, 5);
    const snap = (await api<ColonySnapshot>("GET", `/colonies/${c.id}`)).body;
    expect(snap.intents.filter((i) => i.source === "system")).toEqual([]);
    expect(snap.megafiles).toBeUndefined();
    expect(await report(c.id)).toMatchObject({ on: false, held: [], lifted: [] });
    // Work on the file goes on as before: offered and landed.
    const next = await holder(c.id, "late", [BIG]);
    await landInline(c.id, next, { [BIG]: text(950) });
    await setMegafile(c.id, "other-colony");
    expect(await report(c.id)).toMatchObject({ on: false });
  });
});

describe("the hold", () => {
  it("keeps take from offering another intent that covers the file, but offers its split", async () => {
    const { colonyId, split } = await hotColony();
    await addIntent(colonyId, [BIG], { title: "Add one more helper" });
    await addIntent(colonyId, ["src/"], { title: "Tidy src" });
    const splitter = await addAgent(colonyId, "splitter");
    expect((await take(colonyId, splitter.id)).intent.id).toBe(split.id);
    const other = await addAgent(colonyId, "other");
    const res = await api<{ wait: true; reason: string }>("POST", `/colonies/${colonyId}/agents/${other.id}/take`);
    expect(res.body).toMatchObject({ wait: true, reason: `every open intent covers a file being split: src/big.ts is being split by intent ${split.id}; take again after it lands` });
    // Work elsewhere is still offered.
    const elsewhere = await addIntent(colonyId, ["src/lib/util.ts"], { title: "Elsewhere" });
    expect((await take(colonyId, other.id)).intent.id).toBe(elsewhere.id);
  });

  it("sends back a change that writes the file at propose, and the split's own change lands and lifts it", async () => {
    let early: { agentId: string; a: Assignment } | null = null;
    const { colonyId, split } = await hotColony(async (id) => {
      // An agent took work on the file before it turned hot.
      early = await holder(id, "early", [BIG]);
    });
    const p = await colony(colonyId).propose(inlineInput(colonyId, early!.a, early!.agentId, { [BIG]: text(900) }));
    expect(p).toMatchObject({ status: "returned", reason: `src/big.ts is being split by intent ${split.id}; take again after it lands` });
    // Its intent is open again, but waits for the split.
    const snap = (await api<ColonySnapshot>("GET", `/colonies/${colonyId}`)).body;
    expect(snap.intents.find((i) => i.id === early!.a.intent.id)?.status).toBe("open");
    // The split: the code moves to a new module and the file re-exports it.
    const splitter = await addAgent(colonyId, "splitter");
    const a = await take(colonyId, splitter.id);
    expect(a.intent.id).toBe(split.id);
    const landed = await landInline(colonyId, { agentId: splitter.id, a }, { [BIG]: 'export * from "./big-values.ts";\n', "src/big-values.ts": text(830) });
    // Its evidence, which the landing's lineage note keeps, has the file's lines before and after.
    expect(landed.evidence.checks).toContainEqual({ name: "megafile: split", ok: true, ms: 0, detail: "src/big.ts: 830 lines when it was held (650 when its window opened); 1 line after this change" });
    const r = await eventually(() => report(colonyId), (x) => x.lifted.length > 0);
    expect(r.held).toEqual([]);
    expect(r.lifted[0]).toMatchObject({ path: BIG, intentId: split.id, lifted: "landed", lines: 830, linesAfter: 1 });
    // The file's work is offered again (once the shared field reading from the splitter's take, which still shows its claim, is replaced).
    const back = await addAgent(colonyId, "back");
    const got = await eventually(
      () => api<{ intent?: Intent; wait?: true }>("POST", `/colonies/${colonyId}/agents/${back.id}/take`),
      (res) => res.body.intent !== undefined,
    );
    expect(got.body.intent?.id).toBe(early!.a.intent.id);
  });

  it("sends back the changes already on their way that write the file when it begins", async () => {
    let queued: Proposal | null = null;
    const { colonyId, split } = await hotColony(async (id) => {
      // A change that writes the file waits in the docs lane (most of what it writes is there; the test never ticks it).
      const h = await holder(id, "queued", [BIG, "docs/a.md", "docs/b.md"]);
      queued = await colony(id).propose(inlineInput(id, h.a, h.agentId, { [BIG]: text(700), "docs/a.md": "a\n", "docs/b.md": "b\n" }));
      expect(queued.status).toBe("ready");
    });
    const after = await eventually(() => proposal(colonyId, queued!.id), (x) => x.status === "returned");
    expect(after).toMatchObject({ status: "returned", reason: `src/big.ts is being split by intent ${split.id}; take again after it lands` });
    expect((await trunk(colonyId).state()).landings.some((l) => l.proposalIds.includes(queued!.id))).toBe(false);
  });
});

describe("the hold lifts", () => {
  it("when its split intent is withdrawn", async () => {
    const { colonyId, split } = await hotColony();
    const res = await api("POST", `/colonies/${colonyId}/intents/${split.id}/withdraw`, { reason: "not now" });
    expect(res.status).toBe(200);
    const r = await report(colonyId);
    expect(r.held).toEqual([]);
    expect(r.lifted[0]).toMatchObject({ path: BIG, lifted: "withdrawn" });
    const late = await holder(colonyId, "late", [BIG]);
    expect((await colony(colonyId).propose(inlineInput(colonyId, late.a, late.agentId, { [BIG]: text(900) }))).status).toBe("ready");
  });

  it("when its split is reported to a person", async () => {
    const { colonyId, split } = await hotColony();
    const splitter = await addAgent(colonyId, "splitter");
    expect((await take(colonyId, splitter.id)).intent.id).toBe(split.id);
    await colony(colonyId).escalate(splitter.id, { intentId: split.id, kind: "impossible", report: "The file is generated; it cannot be split by hand." });
    const r = await report(colonyId);
    expect(r.held).toEqual([]);
    expect(r.lifted[0]).toMatchObject({ path: BIG, lifted: "escalated" });
  });

  it("after an hour", async () => {
    const { colonyId, held } = await hotColony();
    await runInDurableObject(colony(colonyId), (_i: unknown, state: DurableObjectState) => {
      state.storage.sql.exec("UPDATE megafile_holds SET ends_at = ? WHERE path = ?", Date.now() - 1, BIG);
    });
    const r = await report(colonyId);
    expect(r.held).toEqual([]);
    expect(r.lifted[0]).toMatchObject({ path: BIG, lifted: "expired", at: held.at });
  });

  it("when a person releases it; a person can hold a file too", async () => {
    const { colonyId, split } = await hotColony();
    expect((await api("POST", `/colonies/${colonyId}/megafile`, { path: BIG, action: "release" }, {})).status).toBe(401);
    const released = await api<{ released: { lifted: string } }>("POST", `/colonies/${colonyId}/megafile`, { path: BIG, action: "release", by: "maya" });
    expect(released.status).toBe(200);
    expect(released.body.released).toMatchObject({ path: BIG, intentId: split.id, lifted: "released by maya" });
    expect((await report(colonyId)).held).toEqual([]);
    expect((await api("POST", `/colonies/${colonyId}/megafile`, { path: BIG, action: "release" })).status).toBe(404);
    // Its split intent stays open; holding the file again waits for that same intent.
    const again = await api<{ hold: { intentId: string; by: string }; already: boolean }>("POST", `/colonies/${colonyId}/megafile`, { path: BIG, action: "hold", by: "sam" });
    expect(again.status).toBe(201);
    expect(again.body).toMatchObject({ already: false, hold: { intentId: split.id, by: "sam", signal: "person" } });
    expect((await api<{ already: boolean }>("POST", `/colonies/${colonyId}/megafile`, { path: BIG, action: "hold" })).body.already).toBe(true);
    // A file nobody grew: its own split intent.
    const util = await api<{ hold: { intentId: string; lines: number } }>("POST", `/colonies/${colonyId}/megafile`, { path: "src/lib/util.ts", action: "hold", by: "sam" });
    expect(util.status).toBe(201);
    expect(util.body.hold).toMatchObject({ path: "src/lib/util.ts", lines: 3 });
    expect(util.body.hold.intentId).not.toBe(split.id);
    expect((await api("POST", `/colonies/${colonyId}/megafile`, { path: "src/nope.ts", action: "hold" })).status).toBe(404);
    expect((await api("POST", `/colonies/${colonyId}/megafile`, { path: "src/*.ts", action: "hold" })).status).toBe(400);
    expect((await api("POST", `/colonies/${colonyId}/megafile`, { path: BIG, action: "lock" })).status).toBe(400);
  });

  it("refuses a person's hold while FT_MEGAFILE is off for the colony", async () => {
    const c = await newColony();
    const res = await api<{ error: string }>("POST", `/colonies/${c.id}/megafile`, { path: "src/lib/util.ts", action: "hold" });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/the megafile alarm is off for this colony/);
  });
});
