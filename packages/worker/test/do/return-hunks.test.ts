import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { blobId } from "@fire_trident/core";
import type { AgentInfo, ColonyEvent, Intent, MergeConflict, Path, Proposal, RepoRef, Sha } from "@fire_trident/core";
import { buildTree, ensureRepo, readLocalBlob, setRef, writeCommitObject, writeLocalBlob, type GitRepo } from "../../src/artifacts/git.ts";
import type { LastReturn } from "../../src/agents/prompt.ts";
import { quotedSentence } from "../../src/colony/returnhunks.ts";
import { TrunkDO } from "../../src/trunk/TrunkDO.ts";
import type { Assignment } from "./helpers.ts";
import { addIntent, api, colony, env, eventually, newColony, proposal, proposeEdit, region, take, tick, trunk } from "./helpers.ts";
import { Writer, landed } from "./writer.ts";

/**
 * Return hunks (FT_RETURN_HUNKS) through the Durable Objects: a change that goes back because trunk moved its files
 * carries what beat it, quoted by the trunk writer in one call before the colony writes the return: each movedBy
 * landing's diff of the files it moved and each contested region of a text merge conflict. The quotes travel with the
 * proposal (REST and the inbox), the next take's lastReturn and the review queue, not with the live event; a writer that
 * does not answer in time leaves the return as it is without the flag, and so does the flag off.
 */

const F = "src/lib/util.ts";
const SEED = "export function helper() {\n  return 1;\n}\n";
const LANDED = "export function helper() {\n  return 2;\n}\n";
const INSTRUCTION = "Keep what that landing did unless your intent says otherwise, and escalate if both cannot hold.";
const pastSharedReading = (): Promise<void> => new Promise((r) => setTimeout(r, 300));
const lastReturnOf = (a: Assignment): LastReturn | undefined => (a as Assignment & { lastReturn?: LastReturn }).lastReturn;

/** Set FT_TEXT_MERGE as one lane sees it, so a change stale on the file it writes goes on to the trunk writer. */
async function setMerging(colonyId: string, name: string, value: string): Promise<void> {
  await runInDurableObject(region(colonyId, name), (instance) => {
    const i = instance as unknown as { env: Record<string, unknown> };
    i.env = { ...i.env, FT_TEXT_MERGE: value };
  });
}

/** Set FT_RETURN_HUNKS as the colony sees it (the harness binds none). */
async function setQuoting(colonyId: string, value: string): Promise<void> {
  await runInDurableObject(colony(colonyId), (instance) => {
    const i = instance as unknown as { env: Record<string, unknown> };
    i.env = { ...i.env, FT_RETURN_HUNKS: value };
  });
}

async function agent(colonyId: string, name: string): Promise<AgentInfo> {
  const res = await api<AgentInfo>("POST", `/colonies/${colonyId}/agents`, { name, kind: "synthetic", model: `model-${name}` });
  expect(res.status).toBe(201);
  return res.body;
}

async function events(colonyId: string): Promise<ColonyEvent[]> {
  const res = await api<{ events: ColonyEvent[] }>("GET", `/colonies/${colonyId}/events?limit=5000`);
  expect(res.status).toBe(200);
  return res.body.events;
}

/** Two agents take intents on F from the same trunk; A's change (F's helper returns 2) lands first. B's change is proposed, not yet ticked. */
async function race(colonyId: string): Promise<{ b: AgentInfo; ib: Intent; pb: Proposal; landed: Proposal }> {
  const [a, b] = [await agent(colonyId, "a"), await agent(colonyId, "b")];
  await addIntent(colonyId, [F], { title: "Return two", why: "Callers need 2.", assignedTo: a.id });
  const ib = await addIntent(colonyId, [F], { title: "Rename the flag", why: "The old name misleads.", assignedTo: b.id });
  const [ta, tb] = [await take(colonyId, a.id), await take(colonyId, b.id)];
  const pa = await proposeEdit(colonyId, ta, a.id);
  await trunk(colonyId).setContents({ [pa.writeSet[0]!.blob!]: LANDED });
  await tick(colonyId, "src");
  const done = await proposal(colonyId, pa.id);
  expect(done.status).toBe("landed");
  const pb = await proposeEdit(colonyId, tb, b.id);
  return { b, ib, pb, landed: done };
}

describe("a return quotes what beat it (FT_RETURN_HUNKS)", () => {
  it("on: the landing's diff rides with the proposal, the inbox, the next take and the review card, not the live event", async () => {
    const c = await newColony();
    await setQuoting(c.id, "on");
    const r = await race(c.id);
    await tick(c.id, "src");
    const back = await proposal(c.id, r.pb.id);
    const landing = (await trunk(c.id).state()).landings.find((l) => l.id === r.landed.landingId)!;
    expect(back.status).toBe("returned");
    expect(back.movedBy).toHaveLength(1);
    expect(back.movedBy![0]!.hunks).toEqual([{ path: F, trunkSha: landing.trunkSha, diff: "@@ -1,3 +1,3 @@\n export function helper() {\n-  return 1;\n+  return 2;\n }", truncated: false }]);
    expect(back.reason!.endsWith(`${INSTRUCTION} ${quotedSentence(true, false)}`)).toBe(true);
    expect((await trunk(c.id).state()).quoteAsks).toHaveLength(1);

    // The live event names the landing as before, without the quote.
    const event = await eventually(
      async () => (await events(c.id)).find((e) => e.t === "proposal" && e.proposalId === r.pb.id && e.status === "returned"),
      (e) => e !== undefined,
    );
    expect(event && "movedBy" in event ? event.movedBy?.[0] : undefined).toMatchObject({ landingId: landing.id });
    expect(event && "movedBy" in event ? event.movedBy?.[0] : undefined).not.toHaveProperty("hunks");

    // The agent's inbox and its next take carry it.
    const inbox = await api<Array<Proposal & { kind?: string }>>("GET", `/colonies/${c.id}/agents/${r.b.id}/inbox`);
    expect(inbox.body.find((e) => e.id === r.pb.id)?.movedBy?.[0]?.hunks).toEqual(back.movedBy![0]!.hunks);
    await pastSharedReading();
    const again = await take(c.id, r.b.id);
    expect(again.intent.id).toBe(r.ib.id);
    expect(lastReturnOf(again)?.movedBy?.[0]?.hunks).toEqual(back.movedBy![0]!.hunks);

    // The review card of its next change shows what beat the last one, quoted.
    const next = await proposeEdit(c.id, again, r.b.id);
    await colony(c.id).updateProposals([{ id: next.id, patch: { status: "escalated", reason: "needs a person" } }]);
    const queue = (await api<Array<Proposal & { lastReturn?: LastReturn }>>("GET", `/colonies/${c.id}/review`)).body;
    expect(queue.find((p) => p.id === next.id)?.lastReturn?.movedBy?.[0]?.hunks).toEqual(back.movedBy![0]!.hunks);
  });

  it("a text merge conflict quotes each contested region with the base line where it starts", async () => {
    const c = await newColony();
    await setQuoting(c.id, "on");
    const r = await race(c.id);
    await setMerging(c.id, "src", "on");
    const theirs = "export function helper() {\n  return 3;\n}\n";
    await trunk(c.id).setContents({ [blobId(SEED)]: SEED, [blobId(LANDED)]: LANDED, [blobId(theirs)]: theirs });
    const conflict: MergeConflict = { path: F, base: blobId(SEED), trunk: blobId(LANDED), theirs: blobId(theirs), lines: [2] };
    await trunk(c.id).returnOnLand([r.pb.id], { [r.pb.id]: [conflict] });
    await tick(c.id, "src");
    const back = await proposal(c.id, r.pb.id);
    expect(back.status).toBe("returned");
    expect(back.contested).toEqual([{ path: F, line: 2, base: ["  return 1;"], trunk: ["  return 2;"], own: ["  return 3;"] }]);
    expect(back.reason!.startsWith("conflict at land time: src/lib/util.ts. Landing ")).toBe(true);
    expect(back.reason!.endsWith(quotedSentence(true, true))).toBe(true);
  });

  it("a trunk writer too slow to quote in time leaves the return as it goes out today", async () => {
    const c = await newColony();
    await setQuoting(c.id, "on");
    const r = await race(c.id);
    await trunk(c.id).holdQuotes(2_500);
    const t0 = Date.now();
    await tick(c.id, "src");
    expect(Date.now() - t0).toBeLessThan(2_400);
    const back = await proposal(c.id, r.pb.id);
    expect(back.status).toBe("returned");
    expect(back.movedBy?.[0]?.landingId).toBe(r.landed.landingId);
    expect(back.movedBy?.[0]).not.toHaveProperty("hunks");
    expect(back.reason!.endsWith(INSTRUCTION)).toBe(true);
  });

  it("off: nothing is asked of the trunk writer and the return reads as before", async () => {
    const c = await newColony();
    const r = await race(c.id);
    await tick(c.id, "src");
    const back = await proposal(c.id, r.pb.id);
    expect(back.reason!.endsWith(INSTRUCTION)).toBe(true);
    expect(back.movedBy?.[0]).not.toHaveProperty("hunks");
    expect(back).not.toHaveProperty("contested");
    expect((await trunk(c.id).state()).quoteAsks).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The real trunk writer (TrunkDO; only network steps stood in, as in writer.ts)
// ---------------------------------------------------------------------------

interface Internals {
  pullBlobs(p: Proposal): Promise<Map<Path, number>>;
  pushChain(chain: unknown): Promise<{ ok: true }>;
  notesSoon(): Promise<void>;
  rebuildIndex(head: Sha): Promise<void>;
  repo(): GitRepo;
}

const TRUNK: RepoRef = { namespace: "ft-trunk", name: "hunks--trunk", remote: "https://artifacts.invalid/hunks--trunk.git" };
let seq = 0;

/** A real trunk writer whose trunk holds `files`, with `vars` as its settings. */
async function withWriter(files: Record<Path, string>, vars: Record<string, string | undefined>, fn: (w: Writer) => Promise<void>): Promise<void> {
  const name = `hunks-${Date.now()}-${++seq}`;
  const colonyId = `col_hunks_${seq}`;
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
    await fn(new Writer(writer, g, state, colonyId));
  });
}

/** Eight numbered lines, some replaced. */
function file(changes: Record<number, string> = {}): string {
  return Array.from({ length: 8 }, (_, i) => `${changes[i + 1] ?? `export const v${i + 1} = ${i + 1};`}\n`).join("");
}

describe("the real trunk writer quotes for return hunks", () => {
  it("on: a conflict travels with its return (the resolver off), and the writer quotes the landing's diff and the region", async () => {
    const V = "src/app/values.ts";
    const SEEDED = file();
    const A = file({ 6: "export const six = 6;" });
    const B = file({ 6: "export const v6 = 66;" });
    await withWriter({ [V]: SEEDED }, { FT_TEXT_MERGE: "on", FT_RETURN_HUNKS: "on" }, async (w) => {
      const a = await w.proposal({ [V]: A });
      const b = await w.proposal({ [V]: B });
      const first = landed(await w.land(a));
      const r = await w.land(b);
      const conflicts = r.returned[0]?.conflicts ?? [];
      expect(conflicts).toEqual([{ path: V, base: blobId(SEEDED), trunk: blobId(A), theirs: blobId(B), lines: [6] }]);
      const quoted = await w.trunk.returnHunks({ diffs: [{ landingId: first.id, path: V }], conflicts, budgetMs: 1_000 });
      expect(quoted.diffs).toEqual([
        { landingId: first.id, path: V, trunkSha: first.trunkSha, diff: "@@ -4,5 +4,5 @@\n export const v4 = 4;\n export const v5 = 5;\n-export const v6 = 6;\n+export const six = 6;\n export const v7 = 7;\n export const v8 = 8;", truncated: false },
      ]);
      expect(quoted.conflicts).toEqual([
        { path: V, base: blobId(SEEDED), trunk: blobId(A), theirs: blobId(B), regions: [{ path: V, line: 6, base: ["export const v6 = 6;"], trunk: ["export const six = 6;"], own: ["export const v6 = 66;"] }] },
      ]);
    });
  });

  it("off: the same return carries only its reason", async () => {
    const V = "src/app/values.ts";
    await withWriter({ [V]: file() }, { FT_TEXT_MERGE: "on" }, async (w) => {
      const a = await w.proposal({ [V]: file({ 6: "export const six = 6;" }) });
      const b = await w.proposal({ [V]: file({ 6: "export const v6 = 66;" }) });
      landed(await w.land(a));
      const r = await w.land(b);
      expect(r.returned).toHaveLength(1);
      expect(r.returned[0]).not.toHaveProperty("conflicts");
    });
  });
});
