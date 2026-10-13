import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { FileVersion, Landing, Path, Proposal, RepoRef, Sha } from "@fire_trident/core";
import { blobId, changesetId } from "@fire_trident/core";
import { buildTree, ensureRepo, readLocalBlob, setRef, writeCommitObject, writeLocalBlob, type GitRepo } from "../../src/artifacts/git.ts";
import { CONTENTS_GRACE_MS, InlineContents } from "../../src/colony/inline.ts";
import type { LandResult } from "../../src/trunk/plan.ts";
import { TrunkDO } from "../../src/trunk/TrunkDO.ts";
import type { ColonyDO } from "../../src/colony/ColonyDO.ts";
import type { Env } from "../../src/env.ts";
import { addAgent, addIntent, api, colony, env, eventually, fakeSha, newColony, proposal, region, rows, take, tick } from "./helpers.ts";
import type { Assignment } from "./helpers.ts";

/**
 * Inline changes through the Durable Objects: the colony checks and keeps a change's contents, the decide stage reads
 * them, they go once the change settles, and the real trunk writer lands the change without reading any workspace.
 */

const FEATURE = "export const feature = 1;\n";

/** An inline change on `baseSha` writing these files (content null deletes). */
function inline(baseSha: Sha, files: Record<Path, string | null>): { writeSet: FileVersion[]; contents: Record<Sha, string>; headSha: Sha } {
  const writeSet: FileVersion[] = [];
  const contents: Record<Sha, string> = {};
  for (const [path, text] of Object.entries(files)) {
    const blob = text === null ? null : blobId(text);
    writeSet.push({ path, blob });
    if (text !== null && blob) contents[blob] = text;
  }
  return { writeSet, contents, headSha: changesetId(baseSha, writeSet) };
}

/** The ColonyDO.propose input of an inline change for an assignment (base: the lease's, unless given). */
function inlineInput(colonyId: string, a: Assignment, agentId: string, files: Record<Path, string | null>, baseSha = a.lease.baseSha) {
  const c = inline(baseSha, files);
  return {
    colonyId,
    intentId: a.intent.id,
    agentId,
    workspace: a.lease.repo,
    baseSha,
    headSha: c.headSha,
    writeSet: c.writeSet,
    readSet: [],
    declared: { footprint: a.intent.footprint, summary: "inline" },
    evidence: { notVerified: "Not verified: anything beyond the edit" },
    contents: c.contents,
  };
}

/** A fresh colony with one intent on `paths`, held by one agent. */
async function held(paths: Path[] = ["src/feature.ts"]): Promise<{ colonyId: string; agentId: string; a: Assignment }> {
  const c = await newColony();
  await addIntent(c.id, paths);
  const agent = await addAgent(c.id, "inline");
  return { colonyId: c.id, agentId: agent.id, a: await take(c.id, agent.id) };
}

/** Rows of the colony's contents table for a proposal. */
async function stored(colonyId: string, proposalId: string): Promise<Array<{ blob: string; text: string; settled_at: number | null }>> {
  return runInDurableObject(colony(colonyId), (_instance: unknown, state: DurableObjectState) =>
    state.storage.sql.exec("SELECT blob, text, settled_at FROM proposal_contents WHERE proposal_id = ? ORDER BY blob", proposalId).toArray(),
  ) as Promise<Array<{ blob: string; text: string; settled_at: number | null }>>;
}

describe("ColonyDO.propose with contents", () => {
  it("accepts a valid inline change and keeps its contents apart from the proposal", async () => {
    const { colonyId, agentId, a } = await held();
    const input = inlineInput(colonyId, a, agentId, { "src/feature.ts": FEATURE });
    const p = await colony(colonyId).propose(input);
    expect(p).toMatchObject({ status: "ready", headSha: input.headSha, writeSet: input.writeSet });
    expect(p).not.toHaveProperty("contents");
    expect(await proposal(colonyId, p.id)).not.toHaveProperty("contents");
    const row = (await runInDurableObject(colony(colonyId), (_i: unknown, state: DurableObjectState) => state.storage.sql.exec("SELECT data FROM proposals WHERE id = ?", p.id).one())) as { data: string };
    expect(row.data).not.toContain(FEATURE.trim());
    expect(await stored(colonyId, p.id)).toEqual([{ blob: blobId(FEATURE), text: FEATURE, settled_at: null }]);
    // The lane carries no text either.
    const lane = await rows<{ data: string }>(region(colonyId, "src"), "SELECT data FROM lane WHERE id = ?", p.id);
    expect(lane).toHaveLength(1);
    expect(lane[0]!.data).not.toContain(FEATURE.trim());
    // A retry of the same change is the same proposal (its head names its content).
    expect((await colony(colonyId).propose(input)).id).toBe(p.id);
  });

  it("refuses a text that does not hash to its blob, a head that is not the changeset id, and a change over the limits", async () => {
    const { colonyId, agentId, a } = await held();
    const good = inlineInput(colonyId, a, agentId, { "src/feature.ts": FEATURE });
    const big = inlineInput(colonyId, a, agentId, { "src/feature.ts": "x".repeat(256 * 1024 + 1) });
    const { contents: _contents, ...bare } = good;
    // Called on the object itself, as the in-platform agents' RPC reaches it.
    await runInDurableObject(colony(colonyId), async (instance: ColonyDO) => {
      await expect(instance.propose({ ...good, contents: { [blobId(FEATURE)]: "export const feature = 2;\n" } })).rejects.toThrow(/^\[ft:400\] inline change refused: the contents of src\/feature\.ts hash to [0-9a-f]{12}, not its blob/);
      await expect(instance.propose({ ...good, headSha: fakeSha() })).rejects.toThrow(/^\[ft:400\] inline change refused: the head of an inline change is the changeset id of its base and write set/);
      await expect(instance.propose(big)).rejects.toThrow(/^\[ft:400\] inline change refused: src\/feature\.ts is 262145 bytes, over the 262144-byte limit/);
      // The changeset id of a write set with no contents is not a commit: refused too.
      await expect(instance.propose(bare)).rejects.toThrow(/^\[ft:400\] headSha is the changeset id of an inline change: send its contents/);
    });
    const snap = await api<{ metrics: Record<string, number> }>("GET", `/colonies/${colonyId}`);
    expect(snap.body.metrics["proposals"] ?? 0).toBe(0);
  });

  it("leaves a pushed change as it was, and the API refuses contents where FT_INLINE is off", async () => {
    const { colonyId, agentId, a } = await held();
    const res = await api<Proposal>("POST", `/colonies/${colonyId}/proposals`, inlineInput(colonyId, a, agentId, { "src/feature.ts": FEATURE }));
    expect(res.status).toBe(409);
    expect((res.body as unknown as { error: string }).error).toMatch(/inline changes are off for this colony \(FT_INLINE\)/);
    const pushed = await api<Proposal>("POST", `/colonies/${colonyId}/proposals`, {
      intentId: a.intent.id,
      agentId,
      workspace: a.lease.repo,
      baseSha: a.lease.baseSha,
      headSha: fakeSha(),
      writeSet: [{ path: "src/feature.ts", blob: fakeSha() }],
      readSet: [],
    });
    expect(pushed.status).toBe(201);
    expect(await stored(colonyId, pushed.body.id)).toEqual([]);
  });
});

describe("the decide stage reads an inline change's stored contents", () => {
  it("decides from them: a network call new in an agent's change goes to a person, no model asked", async () => {
    const c = await newColony();
    await addIntent(c.id, ["src/hook.ts"], { source: "agent", title: "Deliver order webhooks", why: "Send a webhook to the partner when an order is created." });
    const agent = await addAgent(c.id, "inline");
    const a = await take(c.id, agent.id);
    // A Workers AI binding turns the decide stage on; this one must not be needed.
    const calls: unknown[] = [];
    await runInDurableObject(colony(c.id), (instance: unknown) => {
      const o = instance as { env: Env; decideEngine: unknown };
      o.env = { ...o.env, AI: { run: async (...args: unknown[]) => (calls.push(args), Promise.reject(new Error("no model in this test"))) } } as unknown as Env;
      o.decideEngine = null;
    });
    const hook = "export async function deliver(url: string, body: string) {\n  await fetch(url, { method: 'POST', body });\n}\n";
    const p = await colony(c.id).propose(inlineInput(c.id, a, agent.id, { "src/hook.ts": hook }));
    expect(p.status).toBe("checking");
    // The harness has no workspace binding: read from a workspace, the new file would be unreadable and its fetch call unseen.
    const done = await eventually(() => proposal(c.id, p.id), (x) => x.status !== "checking", 10_000);
    expect(done.status).toBe("escalated");
    expect(done.reason).toContain("capability (network)");
    expect(calls).toEqual([]);
    const queue = await api<Array<Proposal & { review?: { files: Array<{ path: string; status: string; hunks: string }> } }>>("GET", `/colonies/${c.id}/review`);
    const view = queue.body.find((x) => x.id === p.id)?.review;
    expect(view?.files).toEqual([expect.objectContaining({ path: "src/hook.ts", status: "added" })]);
    expect(view?.files[0]!.hunks).toContain("+  await fetch(url, { method: 'POST', body });");
    // Waiting for a person: the contents stay.
    expect(await stored(c.id, p.id)).toHaveLength(1);
  });

  it("builds the reviewer's view from them, with no workspace to read", async () => {
    const { colonyId, agentId, a } = await held();
    const text = "export function feature(url: string) {\n  return fetch(url);\n}\n";
    const p = await colony(colonyId).propose(inlineInput(colonyId, a, agentId, { "src/feature.ts": text }));
    await colony(colonyId).updateProposals([{ id: p.id, patch: { status: "escalated", reason: "escalated by test" } }]);
    // Waiting for a person: the contents stay.
    expect(await stored(colonyId, p.id)).toHaveLength(1);
    const built = await runInDurableObject(colony(colonyId), async (instance: unknown) => (instance as { decider(): { backfillReview(id: string): Promise<boolean> } }).decider().backfillReview(p.id));
    expect(built).toBe(true);
    const queue = await api<Array<Proposal & { review?: { files: Array<{ path: string; status: string; hunks: string }>; danger: Array<{ cls: string; line: number }> } }>>("GET", `/colonies/${colonyId}/review`);
    const item = queue.body.find((x) => x.id === p.id)!;
    // The harness has no workspace binding: a view read from a workspace would show the file unreadable.
    expect(item.review?.files).toEqual([expect.objectContaining({ path: "src/feature.ts", status: "added" })]);
    expect(item.review?.files[0]!.hunks).toContain("+  return fetch(url);");
    expect(item.review?.danger.map((d) => d.cls)).toEqual(["capability"]);
    expect(JSON.stringify(queue.body)).not.toContain('"contents"');
  });
});

describe("an inline change's contents go once it settles", () => {
  it("at landing: trunk holds the blobs", async () => {
    const { colonyId, agentId, a } = await held();
    const p = await colony(colonyId).propose(inlineInput(colonyId, a, agentId, { "src/feature.ts": FEATURE }));
    await tick(colonyId, "src");
    expect((await proposal(colonyId, p.id)).status).toBe("landed");
    expect(await stored(colonyId, p.id)).toEqual([]);
    expect(await colony(colonyId).inlineContents([p.id])).toEqual({ contents: {}, more: [] });
  });

  it("after a grace period when it goes back or is rejected; while a person decides they stay", async () => {
    const { colonyId, agentId, a } = await held(["src/feature.ts", "src/other.ts"]);
    const stub = colony(colonyId);
    const back = await stub.propose(inlineInput(colonyId, a, agentId, { "src/feature.ts": FEATURE }));
    await stub.recall(agentId, back.id, "redo it");
    const rejected = await stub.propose(inlineInput(colonyId, a, agentId, { "src/other.ts": "export const other = 1;\n" }));
    await stub.updateProposals([{ id: rejected.id, patch: { status: "escalated" } }]);
    expect((await stored(colonyId, rejected.id))[0]!.settled_at).toBeNull();
    await stub.decide(rejected.id, "reject", "not this", "matt");
    const settledAt = (await stored(colonyId, back.id))[0]!.settled_at;
    expect(typeof settledAt).toBe("number");
    expect(typeof (await stored(colonyId, rejected.id))[0]!.settled_at).toBe("number");
    // Within the grace period the trunk writer still gets them (a cycle that read the old direction may land the change).
    expect(Object.keys((await stub.inlineContents([back.id, rejected.id])).contents).sort()).toEqual([back.id, rejected.id].sort());
    await runInDurableObject(stub, (instance: unknown) => {
      (instance as { inline(): InlineContents }).inline().sweep(settledAt! + CONTENTS_GRACE_MS - 1, true);
    });
    expect(await stored(colonyId, back.id)).toHaveLength(1);
    await runInDurableObject(stub, (instance: unknown) => {
      (instance as { inline(): InlineContents }).inline().sweep(Date.now() + CONTENTS_GRACE_MS, true);
    });
    expect(await stored(colonyId, back.id)).toEqual([]);
    expect(await stored(colonyId, rejected.id)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The real trunk writer
// ---------------------------------------------------------------------------

/** TrunkDO's private steps the tests stand in for (the pushes) or use to set trunk up. */
interface Internals {
  pushChain(chain: unknown): Promise<{ ok: true }>;
  notesSoon(): Promise<void>;
  rebuildIndex(head: Sha): Promise<void>;
  repo(): GitRepo;
}

/** An Artifacts binding that records and refuses every repo it is asked for: no workspace may be read. */
function trap(opened: string[]): unknown {
  return {
    get: async (name: string) => {
      opened.push(name);
      throw new Error(`workspace ${name} must not be read`);
    },
  };
}

/** What a test drives the real writer with. */
interface Writer {
  trunk: TrunkDO;
  colonyId: string;
  head(): Sha;
  text(path: Path): Promise<string | null>;
  /** Workspace repos the writer asked a binding for. */
  opened: string[];
}

let seq = 0;

/**
 * The real trunk writer over a fresh object's storage whose trunk holds `files`. Every Artifacts binding refuses (and
 * records) a read, the pushes always succeed, and `COLONY` is the colony namespace it fetches inline contents from.
 */
async function withWriter(files: Record<Path, string>, colonyId: string, COLONY: unknown, fn: (w: Writer) => Promise<void>): Promise<void> {
  const remote: RepoRef = { namespace: "ft-trunk", name: `${colonyId}--trunk`, remote: `https://artifacts.invalid/${colonyId}--trunk.git` };
  const opened: string[] = [];
  await runInDurableObject(env.TRUNK.get(env.TRUNK.idFromName(`inline-writer-${Date.now()}-${++seq}`)), async (_instance: unknown, state: DurableObjectState) => {
    const bindings = { ARTIFACTS: trap(opened), WS0: trap(opened), WS1: trap(opened), WS2: trap(opened), WS3: trap(opened), SESSIONS: trap(opened) };
    const trunk = new TrunkDO(state, { ...bindings, COLONY } as never);
    const t = trunk as unknown as Internals;
    const meta = (key: string, value: string): void => void state.storage.sql.exec("INSERT OR REPLACE INTO ft_meta (key, value) VALUES (?, ?)", key, value);
    meta("colony_id", colonyId);
    meta("trunk", JSON.stringify(remote));
    const g = t.repo();
    await ensureRepo(g, remote.remote);
    const tree = new Map<Path, { blob: Sha; mode: string }>();
    for (const [path, text] of Object.entries(files)) tree.set(path, { blob: await writeLocalBlob(g, new TextEncoder().encode(text)), mode: "100644" });
    const head = await writeCommitObject(g, { tree: await buildTree(g, tree), parents: [], message: "init\n", at: Date.now() });
    await setRef(g, "refs/heads/main", head);
    await t.rebuildIndex(head);
    t.pushChain = async () => ({ ok: true });
    t.notesSoon = async () => undefined;
    const indexBlob = (path: Path): Sha | null => (state.storage.sql.exec("SELECT blob FROM ft_files WHERE path = ?", path).toArray()[0] as { blob?: Sha } | undefined)?.blob ?? null;
    await fn({
      trunk,
      colonyId,
      opened,
      head: () => (state.storage.sql.exec("SELECT value FROM ft_meta WHERE key = 'trunk_sha'").one() as { value: Sha }).value,
      text: async (path) => {
        const blob = indexBlob(path);
        return blob === null ? null : new TextDecoder().decode(await readLocalBlob(g, blob));
      },
    });
  });
}

/** A proposal as a lane hands it to the writer (no contents: the colony keeps them). */
function laneProposal(id: string, baseSha: Sha, files: Record<Path, string | null>, extra: Partial<Proposal> = {}): { p: Proposal; contents: Record<Sha, string> } {
  const c = inline(baseSha, files);
  return {
    contents: c.contents,
    p: {
      id,
      colonyId: "col_inline",
      intentId: `int_${id}`,
      agentId: "agt_test",
      workspace: { namespace: "ft-ws-1", name: `col_inline--ws-${id}`, remote: "https://artifacts.invalid/ws.git" },
      baseSha,
      headSha: c.headSha,
      writeSet: c.writeSet,
      readSet: [],
      declared: { footprint: Object.keys(files), summary: id },
      evidence: { checks: [] },
      status: "ready",
      createdAt: Date.now(),
      ...extra,
    },
  };
}

/** A colony namespace that answers inline-contents fetches from `texts` (by proposal id), recording each call. */
function colonyNamespace(texts: Map<string, Record<Sha, string>>, answer?: (ids: string[], call: number) => { contents: Record<string, Record<Sha, string>>; more: string[] }) {
  const calls: string[][] = [];
  const stub = {
    inlineContents: async (ids: string[]) => {
      calls.push(ids);
      if (answer) return answer(ids, calls.length);
      return { contents: Object.fromEntries(ids.filter((id) => texts.has(id)).map((id) => [id, texts.get(id)!])), more: [] };
    },
  };
  return { ns: { idFromName: (name: string) => name, get: () => stub }, calls };
}

const TRUNK_FILES: Record<Path, string> = { "src/lib/util.ts": "export const util = 1;\n", "README.md": "# readme\n" };

describe("the trunk writer lands inline changes without reading a workspace", () => {
  it("fetches a cycle's texts from the colony in one call, checks them and lands every change", async () => {
    const texts = new Map<string, Record<Sha, string>>();
    const { ns, calls } = colonyNamespace(texts);
    await withWriter(TRUNK_FILES, "col_inline", ns, async (w) => {
      const base = w.head();
      const edit = laneProposal("prp_edit", base, { "src/lib/util.ts": "export const util = 2;\n" });
      const add = laneProposal("prp_add", base, { "src/new.ts": "export const fresh = 3;\n" });
      const swap = laneProposal("prp_swap", base, { "README.md": null, "docs/guide.md": "# guide\n" });
      for (const x of [edit, add, swap]) texts.set(x.p.id, x.contents);
      const r: LandResult = await w.trunk.land([edit.p, add.p, swap.p]);
      expect(r.returned).toEqual([]);
      expect(r.landing?.proposalIds).toEqual(["prp_edit", "prp_add", "prp_swap"]);
      expect(r.landing?.paths).toEqual(["README.md", "docs/guide.md", "src/lib/util.ts", "src/new.ts"]);
      expect(await w.text("src/lib/util.ts")).toBe("export const util = 2;\n");
      expect(await w.text("src/new.ts")).toBe("export const fresh = 3;\n");
      expect(await w.text("docs/guide.md")).toBe("# guide\n");
      expect(await w.text("README.md")).toBeNull();
      expect(w.head()).toBe(r.landing?.trunkSha);
      expect(calls).toEqual([["prp_edit", "prp_add", "prp_swap"]]);
      expect(w.opened).toEqual([]);
    });
  });

  it("sends back a change whose text does not hash to its blob or is missing, and writes nothing of it", async () => {
    const texts = new Map<string, Record<Sha, string>>();
    const { ns } = colonyNamespace(texts);
    await withWriter(TRUNK_FILES, "col_inline", ns, async (w) => {
      const base = w.head();
      const forged = laneProposal("prp_forged", base, { "src/a.ts": "export const a = 1;\n" });
      texts.set("prp_forged", { [forged.p.writeSet[0]!.blob!]: "export const a = 666;\n" });
      const gone = laneProposal("prp_gone", base, { "src/b.ts": "export const b = 1;\n" });
      const r = await w.trunk.land([forged.p, gone.p]);
      expect(r.landing).toBeUndefined();
      expect(r.returned).toEqual([
        { proposalId: "prp_forged", reason: expect.stringMatching(/^the text for src\/a\.ts hashes to [0-9a-f]{40}, not [0-9a-f]{40}$/) },
        { proposalId: "prp_gone", reason: expect.stringMatching(/^no text for src\/b\.ts \(blob [0-9a-f]{40}\) in this inline change; propose it again$/) },
      ]);
      expect(w.head()).toBe(base);
      expect(await w.text("src/a.ts")).toBeNull();
      expect(w.opened).toEqual([]);
    });
  });

  it("defers when the colony does not answer, and fetches past the byte budget in more calls", async () => {
    const texts = new Map<string, Record<Sha, string>>();
    const down = colonyNamespace(texts, () => {
      throw new Error("colony unavailable");
    });
    await withWriter(TRUNK_FILES, "col_inline", down.ns, async (w) => {
      const one = laneProposal("prp_one", w.head(), { "src/one.ts": "export const one = 1;\n" });
      const r = await w.trunk.land([one.p]);
      expect(r.returned).toEqual([]);
      expect(r.deferred).toEqual([{ proposalId: "prp_one", reason: expect.stringMatching(/^inline contents not fetched from the colony: .*colony unavailable/) }]);
      expect(w.opened).toEqual([]);
    });
    // An answer holding one change at a time (the rest in `more`), as the colony answers past its budget.
    const paged = colonyNamespace(texts, (ids) => ({ contents: { [ids[0]!]: texts.get(ids[0]!)! }, more: ids.slice(1) }));
    await withWriter(TRUNK_FILES, "col_inline", paged.ns, async (w) => {
      const base = w.head();
      const xs = ["prp_p1", "prp_p2", "prp_p3"].map((id) => laneProposal(id, base, { [`src/${id}.ts`]: `export const ${id} = 1;\n` }));
      for (const x of xs) texts.set(x.p.id, x.contents);
      const r = await w.trunk.land(xs.map((x) => x.p));
      expect(r.landing?.proposalIds).toEqual(["prp_p1", "prp_p2", "prp_p3"]);
      expect(paged.calls).toEqual([["prp_p1", "prp_p2", "prp_p3"], ["prp_p2", "prp_p3"], ["prp_p3"]]);
      expect(w.opened).toEqual([]);
    });
    // An answer that moves nothing on is not asked again in the same cycle.
    const stuck = colonyNamespace(texts, (ids) => ({ contents: {}, more: ids }));
    await withWriter(TRUNK_FILES, "col_inline", stuck.ns, async (w) => {
      const s = laneProposal("prp_stuck", w.head(), { "src/s.ts": "export const s = 1;\n" });
      const r = await w.trunk.land([s.p]);
      expect(r.deferred).toEqual([{ proposalId: "prp_stuck", reason: "inline contents not fetched: the colony sent none" }]);
      expect(stuck.calls).toHaveLength(1);
    });
  });

  it("uses texts that come with the batch without asking the colony; a deletion needs none", async () => {
    const texts = new Map<string, Record<Sha, string>>();
    const { ns, calls } = colonyNamespace(texts);
    await withWriter(TRUNK_FILES, "col_inline", ns, async (w) => {
      const base = w.head();
      const carried = laneProposal("prp_carried", base, { "src/c.ts": "export const c = 1;\n" });
      const del = laneProposal("prp_del", base, { "README.md": null });
      // Texts that do not cover every new blob are not enough: the colony's are fetched.
      const partial = laneProposal("prp_partial", base, { "src/p.ts": "export const p = 1;\n", "src/q.ts": "export const q = 1;\n" });
      texts.set("prp_partial", partial.contents);
      const some = { [partial.p.writeSet[0]!.blob!]: "export const p = 1;\n" };
      const r = await w.trunk.land([{ ...carried.p, contents: carried.contents }, del.p, { ...partial.p, contents: some }]);
      expect(r.landing?.proposalIds).toEqual(["prp_carried", "prp_del", "prp_partial"]);
      expect(await w.text("src/c.ts")).toBe("export const c = 1;\n");
      expect(await w.text("src/q.ts")).toBe("export const q = 1;\n");
      expect(calls).toEqual([["prp_partial"]]);
      expect(w.opened).toEqual([]);
    });
  });

  it("still reads a pushed change from its workspace (the trap sees it), beside an inline change that lands", async () => {
    const texts = new Map<string, Record<Sha, string>>();
    const { ns } = colonyNamespace(texts);
    await withWriter(TRUNK_FILES, "col_inline", ns, async (w) => {
      const base = w.head();
      const x = laneProposal("prp_inline", base, { "src/x.ts": "export const x = 1;\n" });
      texts.set(x.p.id, x.contents);
      const pushed = laneProposal("prp_pushed", base, { "src/y.ts": "export const y = 1;\n" }, { headSha: fakeSha() });
      const r = await w.trunk.land([x.p, pushed.p]);
      expect(r.landing?.proposalIds).toEqual(["prp_inline"]);
      expect(r.deferred).toEqual([{ proposalId: "prp_pushed", reason: expect.stringMatching(/^blob pull failed: .*must not be read/) }]);
      expect(w.opened).toEqual([pushed.p.workspace.name]);
    });
  });
});

describe("an inline change from propose to landing", () => {
  it("goes from the colony through the lane to the real trunk writer, which fetches its text from the colony; then the text goes", async () => {
    const { colonyId, agentId, a } = await held(["src/feature.ts", "src/lib/util.ts"]);
    let id = "";
    let landing: Landing | undefined;
    let opened: string[] = [];
    await withWriter(TRUNK_FILES, colonyId, env.COLONY, async (w) => {
      // The agent built its change on the writer's trunk.
      const p = await colony(colonyId).propose(inlineInput(colonyId, a, agentId, { "src/feature.ts": FEATURE, "src/lib/util.ts": "export const util = 7;\n" }, w.head()));
      id = p.id;
      expect(p.status).toBe("ready");
      // What the lane hands the trunk writer: the proposal as queued, with no text in it.
      const queued = await rows<{ data: string }>(region(colonyId, "src"), "SELECT data FROM lane WHERE id = ?", p.id);
      const batch = queued.map((r) => JSON.parse(r.data) as Proposal);
      expect(batch[0]).not.toHaveProperty("contents");
      const r = await w.trunk.land(batch);
      expect(r.returned).toEqual([]);
      landing = r.landing;
      expect(landing?.proposalIds).toEqual([p.id]);
      expect(await w.text("src/feature.ts")).toBe(FEATURE);
      expect(await w.text("src/lib/util.ts")).toBe("export const util = 7;\n");
      opened = w.opened;
    });
    expect(opened).toEqual([]);
    // The lane reports the landing to the colony; the change is landed and its text is gone (trunk has it).
    expect(await stored(colonyId, id)).toHaveLength(2);
    await colony(colonyId).onLanding(landing!);
    expect((await proposal(colonyId, id)).status).toBe("landed");
    expect(await stored(colonyId, id)).toEqual([]);
  });
});
