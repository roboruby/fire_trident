import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { blobId, changesetId } from "@fire_trident/core";
import type { AgentInfo, FileVersion, InboxDirective, Intent, LineageNote, Path, Proposal, RepoRef, Sha } from "@fire_trident/core";
import { buildTree, ensureRepo, readLocalBlob, setRef, writeCommitObject, writeLocalBlob, type GitRepo } from "../../src/artifacts/git.ts";
import { TrunkDO } from "../../src/trunk/TrunkDO.ts";
import { addAgent, addIntent, api, colony, env, eventually, newColony, proposal, take, tick, trunk, type Assignment } from "./helpers.ts";
import { Writer, landed } from "./writer.ts";

/**
 * The conflict resolver through the Durable Objects (FT_RESOLVER): the real trunk writer carries a text merge conflict
 * with its return and writes the `resolves` record into the note of the change that resolves it; the colony holds the
 * returned change's intent, resolves it with one model call (a stand-in model here), proposes the merge as its
 * resolver agent, and the merge lands like any change; off, or when the merge fails its checks, the return stands.
 */

const F = "src/app/values.ts";

/** Eight numbered lines, some replaced. */
function file(changes: Record<number, string> = {}): string {
  return Array.from({ length: 8 }, (_, i) => `${changes[i + 1] ?? `export const v${i + 1} = ${i + 1};`}\n`).join("");
}

const SEED = file();
const TEXT_A = file({ 6: "export const six = 6;" });
const TEXT_B = file({ 6: "export const v6 = 66;" });
const BOTH = file({ 6: "export const six = 66;" });

// ---------------------------------------------------------------------------
// The trunk writer (the real TrunkDO; only network steps stood in, as in writer.ts)
// ---------------------------------------------------------------------------

interface Internals {
  pullBlobs(p: Proposal): Promise<Map<Path, number>>;
  pushChain(chain: unknown): Promise<{ ok: true }>;
  notesSoon(): Promise<void>;
  rebuildIndex(head: Sha): Promise<void>;
  repo(): GitRepo;
}

const TRUNK: RepoRef = { namespace: "ft-trunk", name: "resolver--trunk", remote: "https://artifacts.invalid/resolver--trunk.git" };
let seq = 0;

/** A trunk writer whose trunk holds `files`, with `vars` as its settings; `note` reads a landing's lineage note. */
async function withWriter(files: Record<Path, string>, vars: Record<string, string | undefined>, fn: (w: Writer, note: (landingId: string) => LineageNote, g: GitRepo) => Promise<void>): Promise<void> {
  const name = `resolver-${Date.now()}-${++seq}`;
  const colonyId = `col_resolver_${seq}`;
  await runInDurableObject(env.TRUNK.get(env.TRUNK.idFromName(name)), async (_instance: unknown, state: DurableObjectState) => {
    const writer = new TrunkDO(state, { ...vars } as never);
    const t = writer as unknown as Internals;
    const meta = (key: string, value: string): void => void state.storage.sql.exec("INSERT OR REPLACE INTO ft_meta (key, value) VALUES (?, ?)", key, value);
    meta("colony_id", colonyId);
    meta("trunk", JSON.stringify(TRUNK));
    const g = t.repo();
    await ensureRepo(g, TRUNK.remote);
    const tree = new Map<Path, { blob: Sha; mode: string }>();
    for (const [path, text] of Object.entries(files)) tree.set(path, { blob: await writeLocalBlob(g, new TextEncoder().encode(text)), mode: "100644" });
    const head = await writeCommitObject(g, { tree: await buildTree(g, tree), parents: [], message: "init\n", at: Date.now() });
    await setRef(g, "refs/heads/main", head);
    await t.rebuildIndex(head);
    t.pullBlobs = async (p) => {
      const sizes = new Map<Path, number>();
      for (const w of p.writeSet) if (w.blob !== null) sizes.set(w.path, (await readLocalBlob(g, w.blob)).length);
      return sizes;
    };
    t.pushChain = async () => ({ ok: true });
    t.notesSoon = async () => undefined;
    const note = (landingId: string): LineageNote => JSON.parse(state.storage.sql.exec<{ note: string }>("SELECT note FROM ft_notes WHERE landing_id = ?", landingId).one().note) as LineageNote;
    await fn(new Writer(writer, g, state, colonyId), note, g);
  });
}

describe("the trunk writer and the conflict resolver", () => {
  it("on: a change sent back for overlapping hunks carries them (path, blobs, lines) with its reason", async () => {
    await withWriter({ [F]: SEED }, { FT_TEXT_MERGE: "on", FT_RESOLVER: "on" }, async (w) => {
      const a = await w.proposal({ [F]: TEXT_A });
      const b = await w.proposal({ [F]: TEXT_B });
      landed(await w.land(a));
      const r = await w.land(b);
      expect(r.landing).toBeUndefined();
      expect(r.returned).toEqual([
        {
          proposalId: b.id,
          reason: `stale: ${F} (expected ${blobId(SEED)}, trunk has ${blobId(TEXT_A)}); text merge of ${F}: 1 conflicting hunk, at line 6 of its base`,
          conflicts: [{ path: F, base: blobId(SEED), trunk: blobId(TEXT_A), theirs: blobId(TEXT_B), lines: [6] }],
        },
      ]);
    });
  });

  it("off (or on for another colony): the same return carries only its reason", async () => {
    for (const setting of [undefined, "other-colony"]) {
      await withWriter({ [F]: SEED }, { FT_TEXT_MERGE: "on", FT_RESOLVER: setting }, async (w) => {
        const a = await w.proposal({ [F]: TEXT_A });
        const b = await w.proposal({ [F]: TEXT_B });
        landed(await w.land(a));
        const r = await w.land(b);
        expect(r.returned).toHaveLength(1);
        expect(r.returned[0]).toEqual({ proposalId: b.id, reason: expect.stringMatching(/; text merge of src\/app\/values\.ts: 1 conflicting hunk, at line 6 of its base$/) });
      });
    }
  });

  it("writes the colony's resolves record into the note entry of the change it names, and only there", async () => {
    await withWriter({ [F]: SEED, "README.md": "# r\n" }, {}, async (w, note) => {
      const c = await w.proposal({ [F]: BOTH });
      const d = await w.proposal({ "README.md": "# r2\n" });
      const resolves = { proposalId: "prp_returned", landingIds: ["lnd_first"], paths: [F] };
      const r = await w.trunk.land([c, d], { resolves: { [c.id]: resolves, prp_other: { proposalId: "x", landingIds: [], paths: [] } } });
      const l = landed(r);
      const entries = note(l.id).proposals;
      expect(entries.find((e) => e.id === c.id)?.resolves).toEqual(resolves);
      expect(entries.find((e) => e.id === d.id)).not.toHaveProperty("resolves");
    });
  });
});

// ---------------------------------------------------------------------------
// The colony (the real ColonyDO and lanes, the harness's stand-in trunk writer)
// ---------------------------------------------------------------------------

/** The colony's model and flag: FT_RESOLVER as given (null: unset) and a stand-in Workers AI answering `reply(user message)`; review off. */
async function resolverOn(colonyId: string, reply: (user: string) => string, setting: string | null = "on"): Promise<{ calls: number }> {
  const flag = setting ?? undefined;
  const seen = { calls: 0 };
  await colony(colonyId).setDecidePolicy({ enabled: false });
  await runInDurableObject(colony(colonyId), (instance) => {
    const self = instance as unknown as { env: object };
    const ai = {
      async run(_model: string, input: { messages: Array<{ role: string; content: string }> }): Promise<unknown> {
        seen.calls++;
        const user = input.messages.find((m) => m.role === "user")?.content ?? "";
        return { response: reply(user), usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } };
      },
    };
    self.env = new Proxy(self.env, { get: (t, k) => (k === "AI" ? ai : k === "FT_RESOLVER" ? flag : Reflect.get(t, k)) });
  });
  return seen;
}

/** An inline change on the assignment's base writing F. */
function inlineInput(colonyId: string, a: Assignment, agentId: string, text: string) {
  const writeSet: FileVersion[] = [{ path: F, blob: blobId(text) }];
  return {
    colonyId,
    intentId: a.intent.id,
    agentId,
    workspace: a.lease.repo,
    baseSha: a.lease.baseSha,
    headSha: changesetId(a.lease.baseSha, writeSet),
    writeSet,
    readSet: [{ path: F, blob: blobId(SEED) }],
    declared: { footprint: [F], summary: "edit" },
    evidence: { notVerified: "Not verified: anything beyond the edit" },
    contents: { [blobId(text)]: text },
  };
}

/** Resolver jobs, read from the colony's storage. */
async function jobs(colonyId: string): Promise<Array<{ proposal_id: string; state: string; resolution_id: string | null; reason: string | null }>> {
  return (await runInDurableObject(colony(colonyId), (_i: unknown, state: DurableObjectState) =>
    state.storage.sql.exec("SELECT proposal_id, state, resolution_id, reason FROM resolver_jobs").toArray(),
  )) as Array<{ proposal_id: string; state: string; resolution_id: string | null; reason: string | null }>;
}

async function inbox(colonyId: string, agentId: string): Promise<InboxDirective[]> {
  const res = await api<Array<Proposal | InboxDirective>>("GET", `/colonies/${colonyId}/agents/${agentId}/inbox`);
  expect(res.status).toBe(200);
  return res.body.filter((x): x is InboxDirective => (x as InboxDirective).status === "directive" && (x as InboxDirective).directive.kind === "resolution");
}

async function intent(colonyId: string, id: string): Promise<Intent> {
  const res = await api<{ intent: Intent }>("GET", `/colonies/${colonyId}/intents/${id}`);
  expect(res.status).toBe(200);
  return res.body.intent;
}

async function metrics(colonyId: string): Promise<Record<string, number>> {
  return (await api<{ metrics: Record<string, number> }>("GET", `/colonies/${colonyId}/metrics`)).body.metrics;
}

/**
 * Two agents change line 6 of F from the same trunk: A's change lands, B's comes back from the trunk writer with the
 * text merge conflict (the lane's report, as RegionDO sends it after the writer returned it).
 */
async function scene(colonyId: string): Promise<{ a: AgentInfo; b: AgentInfo; ia: Intent; ib: Intent; pb: Proposal; landingA: string }> {
  const before = (await trunk(colonyId).state()).head;
  const { sha } = await trunk(colonyId).commitExternal({ [F]: SEED }, { realBlobs: true });
  await colony(colonyId).onLanding({ id: `lnd_seed_${sha.slice(0, 8)}`, colonyId, trunkSha: sha, parentSha: before, proposalIds: [], intentIds: [], paths: [F], regions: ["src"], at: Date.now() - 1_000 });
  const [a, b] = [await addAgent(colonyId, "a"), await addAgent(colonyId, "b")];
  const ia = await addIntent(colonyId, [F], { title: "Rename v6 to six", why: "Shorter names read better.", assignedTo: a.id });
  const ib = await addIntent(colonyId, [F], { title: "Set v6 to 66", why: "Callers need the larger value.", assignedTo: b.id });
  const [ta, tb] = [await take(colonyId, a.id), await take(colonyId, b.id)];
  expect(ta.lease.baseSha).toBe(sha);
  expect(tb.lease.baseSha).toBe(sha);
  const pa = await colony(colonyId).propose(inlineInput(colonyId, ta, a.id, TEXT_A));
  await trunk(colonyId).setContents({ [blobId(TEXT_A)]: TEXT_A });
  await tick(colonyId, "src");
  const la = await proposal(colonyId, pa.id);
  expect(la.status).toBe("landed");
  const pb = await colony(colonyId).propose(inlineInput(colonyId, tb, b.id, TEXT_B));
  expect(pb.status).toBe("ready");
  await colony(colonyId).updateProposals([
    {
      id: pb.id,
      patch: {
        status: "returned",
        reason: `stale: ${F} (expected ${blobId(SEED)}, trunk has ${blobId(TEXT_A)}); text merge of ${F}: 1 conflicting hunk, at line 6 of its base`,
        mergeConflicts: [{ path: F, base: blobId(SEED), trunk: blobId(TEXT_A), theirs: blobId(TEXT_B), lines: [6] }],
      },
    },
  ]);
  return { a, b, ia, ib, pb, landingA: la.landingId! };
}

describe("the lane and the conflict resolver", () => {
  it("hands a trunk writer return's conflicts to the colony with the return (FT_RESOLVER off here: the intent reopens)", async () => {
    const c = await newColony();
    const agent = await addAgent(c.id, "writer");
    await addIntent(c.id, [F], { assignedTo: agent.id });
    const a = await take(c.id, agent.id);
    const p = await colony(c.id).propose({ ...inlineInput(c.id, a, agent.id, TEXT_B), readSet: [] });
    expect(p.status).toBe("ready");
    const conflict = { path: F, base: "1".repeat(40), trunk: "2".repeat(40), theirs: blobId(TEXT_B), lines: [6] };
    await trunk(c.id).returnOnLand([p.id], { [p.id]: [conflict] });
    await tick(c.id, "src");
    const back = await proposal(c.id, p.id);
    expect(back).toMatchObject({ status: "returned", reason: "conflict at land time: src/lib/util.ts", mergeConflicts: [conflict] });
    expect((await intent(c.id, a.intent.id)).status).toBe("open");
    expect(await jobs(c.id)).toEqual([]);
  });
});

describe("the colony's conflict resolver", () => {
  it("resolves a returned change keeping both intents; the merge lands with what it resolves in its note context", async () => {
    const c = await newColony();
    const model = await resolverOn(c.id, () => `<file n="1">\n${BOTH}</file>`);
    const { b, ib, pb, landingA } = await scene(c.id);

    // The intent is held for the resolver's agent, not reopened; B's agent stands down and is told.
    const held = await intent(c.id, ib.id);
    expect(held.status).toBe("proposed");
    const agents = (await api<{ agents: AgentInfo[] }>("GET", `/colonies/${c.id}/agents?all=1`)).body.agents;
    const resolver = agents.find((x) => x.name === "resolver");
    expect(resolver).toMatchObject({ kind: "internal" });
    expect(held.assignedTo).toBe(resolver!.id);
    expect(agents.find((x) => x.id === b.id)?.state).toBe("idle");
    expect((await inbox(c.id, b.id)).map((d) => d.reason)).toEqual([expect.stringMatching(/^Directive from resolver about intent .*: Your change prp_\w+ came back because text merge found overlapping hunks \(src\/app\/values\.ts at line 6\)/)]);
    expect((await proposal(c.id, pb.id)).mergeConflicts).toHaveLength(1);

    // One model call, then the merge is proposed as the resolver's change and waits in its lane.
    const proposed = await eventually(() => jobs(c.id), (js) => js[0]?.state === "proposed", 10_000);
    expect(model.calls).toBe(1);
    const r = await proposal(c.id, proposed[0]!.resolution_id!);
    const head = (await trunk(c.id).state()).head;
    expect(r).toMatchObject({ agentId: resolver!.id, intentId: ib.id, status: "ready", baseSha: head, writeSet: [{ path: F, blob: blobId(BOTH) }], readSet: [{ path: F, blob: blobId(TEXT_A) }] });
    expect(r.evidence.checks.find((x) => x.name === "agent model usage")?.detail).toBe("test-model: 1 call(s), 100 input / 20 output tokens");

    // It lands like any change: the lane's context names what it resolves; the intent lands; B's agent is told.
    await tick(c.id, "src");
    const done = await eventually(() => jobs(c.id), (js) => js[0]?.state === "landed", 10_000);
    expect(done[0]).toMatchObject({ proposal_id: pb.id, state: "landed" });
    const contexts = ((await trunk(c.id).state()).contexts ?? []).map((x) => JSON.parse(x) as { resolves?: Record<string, unknown>; agents?: Record<string, { kind: string }> } | null);
    const ctx = contexts.findLast((x) => x?.resolves !== undefined);
    expect(ctx?.resolves).toEqual({ [r.id]: { proposalId: pb.id, landingIds: [landingA], paths: [F] } });
    expect(ctx?.agents?.[resolver!.id]).toMatchObject({ kind: "internal" });
    expect((await intent(c.id, ib.id)).status).toBe("landed");
    const notes = await inbox(c.id, b.id);
    expect(notes[0]!.reason).toMatch(new RegExp(`the merge landed \\(${r.id} in lnd_\\w+\\), so intent ${ib.id} is done\\.$`));
    const m = await metrics(c.id);
    expect(m["resolver.attempted"]).toBe(1);
    expect(m["resolver.landed"]).toBe(1);
    expect(m["resolver.failed"] ?? 0).toBe(0);
    // Its one call counts in the colony's spend, per model (colony/spend.ts).
    expect(m["resolver.tokensIn:test-model"]).toBe(100);
    expect(m["resolver.tokensOut:test-model"]).toBe(20);
  });

  it("off: the same return reopens the intent as today, and no model is called", async () => {
    const c = await newColony();
    const model = await resolverOn(c.id, () => `<file n="1">\n${BOTH}</file>`, null);
    const { b, ib } = await scene(c.id);
    expect((await intent(c.id, ib.id)).status).toBe("open");
    expect(await inbox(c.id, b.id)).toEqual([]);
    expect(await jobs(c.id)).toEqual([]);
    expect(model.calls).toBe(0);
    const agents = (await api<{ agents: AgentInfo[] }>("GET", `/colonies/${c.id}/agents?all=1`)).body.agents;
    expect(agents.some((x) => x.name === "resolver")).toBe(false);
  });

  it("a merge that drops a side's change is never proposed: the return stands and the intent reopens", async () => {
    const c = await newColony();
    await resolverOn(c.id, () => `<file n="1">\n${TEXT_B}</file>`);
    const { b, ib } = await scene(c.id);
    const failed = await eventually(() => jobs(c.id), (js) => js[0]?.state === "failed", 10_000);
    expect(failed[0]!.resolution_id).toBeNull();
    expect(failed[0]!.reason).toBe("the merge of src/app/values.ts takes the change's version of the conflicting hunk at line 6 of the base whole, which drops the edit that landed first");
    expect((await intent(c.id, ib.id)).status).toBe("open");
    const notes = await inbox(c.id, b.id);
    expect(notes[0]!.reason).toMatch(/could not merge your change prp_\w+: the merge of src\/app\/values\.ts takes the change's version .* Its return stands, and intent int_\w+ is open again for the next agent\.$/);
    expect((await metrics(c.id))["resolver.failed"]).toBe(1);
    // The intent can be taken again (by B's agent, or any other).
    const again = await take(c.id, b.id);
    expect(again.intent.id).toBe(ib.id);
  });
});
