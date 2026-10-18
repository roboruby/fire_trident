import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Intent, IntentClosure, Landing, Path, Proposal, RepoRef, Sha } from "@fire_trident/core";
import { buildTree, ensureRepo, readLocalBlob, setRef, writeCommitObject, writeLocalBlob, type GitRepo } from "../../src/artifacts/git.ts";
import { TrunkDO } from "../../src/trunk/TrunkDO.ts";
import type { LandResult } from "../../src/trunk/plan.ts";
import { addAgent, addIntent, api, colony, env, fakeSha, newColony, proposal, region, rows, take, tick, trunk, type Assignment } from "./helpers.ts";
import { Writer, landed } from "./writer.ts";

/**
 * Already on trunk (FT_ALREADY_ON_TRUNK) through the Durable Objects: two agents write the same edit from the same base.
 * The first lands; the second would change nothing. With the flag its lane sends it on to the trunk writer instead of
 * back as stale, the trunk writer lands no commit for it and names where the content came from, and the colony closes
 * its intent with the closure cause already_on_trunk and tells its agent there is nothing to do. Off: as before.
 */

const F = "src/app/main.ts";

/** Six numbered lines, with some of them replaced. */
function lines(changes: Record<number, string> = {}): string {
  return Array.from({ length: 6 }, (_, i) => `${changes[i + 1] ?? `line ${i + 1}`}\n`).join("");
}

// ---------------------------------------------------------------------------
// The lane and the colony (RegionDO and ColonyDO, with the harness's stand-in trunk writer)
// ---------------------------------------------------------------------------

/** Set FT_ALREADY_ON_TRUNK as one lane sees it (the harness binds none, so it is off by default). */
async function setLane(colonyId: string, name: string, value: string): Promise<void> {
  await runInDurableObject(region(colonyId, name), (instance) => {
    const i = instance as unknown as { env: Record<string, unknown> };
    i.env = { ...i.env, FT_ALREADY_ON_TRUNK: value };
  });
}

/** Propose writing `blob` at F on the assignment's base. */
async function proposeBlob(colonyId: string, a: Assignment, agentId: string, blob: Sha): Promise<Proposal> {
  const read = await trunk(colonyId).baseBlobs(a.lease.baseSha, [F]);
  const res = await api<Proposal>("POST", `/colonies/${colonyId}/proposals`, {
    intentId: a.intent.id,
    agentId,
    workspace: a.lease.repo,
    baseSha: a.lease.baseSha,
    headSha: fakeSha(),
    writeSet: [{ path: F, blob }],
    readSet: read,
    declared: { footprint: [F], summary: "the same fix" },
  });
  expect(res.status).toBe(201);
  return res.body;
}

async function intentOf(colonyId: string, intentId: string): Promise<{ intent: Intent; closures?: IntentClosure[] }> {
  const res = await api<{ intent: Intent; closures?: IntentClosure[] }>("GET", `/colonies/${colonyId}/intents/${intentId}`);
  expect(res.status).toBe(200);
  return res.body;
}

async function metrics(colonyId: string): Promise<Record<string, number>> {
  return (await api<{ metrics: Record<string, number> }>("GET", `/colonies/${colonyId}`)).body.metrics;
}

/**
 * Two agents, each handed an intent on F, take from the same trunk and write the same blob there. The lane lands the
 * first; the second waits in it, now stale against the first's landing, and its writes all on trunk.
 */
async function sameEdit(): Promise<{ colonyId: string; first: Proposal; second: Proposal; firstLanding: Landing; secondIntent: Intent; secondAgent: string }> {
  const c = await newColony();
  const one = await addAgent(c.id, "first");
  const two = await addAgent(c.id, "second");
  await addIntent(c.id, [F], { title: "Fix the greeting", assignedTo: one.id });
  const secondIntent = await addIntent(c.id, [F], { title: "Fix the greeting too", assignedTo: two.id });
  const a = await take(c.id, one.id);
  const b = await take(c.id, two.id);
  expect(b.lease.baseSha).toBe(a.lease.baseSha);
  const blob = fakeSha();
  const first = await proposeBlob(c.id, a, one.id, blob);
  const second = await proposeBlob(c.id, b, two.id, blob);
  expect([first.status, second.status]).toEqual(["ready", "ready"]);
  // One lane batch takes one of two changes to one file: the first lands.
  await tick(c.id, "src");
  expect((await proposal(c.id, first.id)).status).toBe("landed");
  expect((await proposal(c.id, second.id)).status).toBe("ready");
  const firstLanding = (await trunk(c.id).state()).landings.at(-1)!;
  expect(firstLanding.proposalIds).toEqual([first.id]);
  return { colonyId: c.id, first, second, firstLanding, secondIntent, secondAgent: two.id };
}

describe("already on trunk in the lane and the colony (FT_ALREADY_ON_TRUNK)", () => {
  it("off: the second change goes back as stale, as before", async () => {
    const s = await sameEdit();
    await tick(s.colonyId, "src");
    const after = await proposal(s.colonyId, s.second.id);
    expect(after.status).toBe("returned");
    expect(after.reason).toMatch(/^stale: 1 path changed on trunk since read: src\/app\/main\.ts/);
    expect(after.onTrunk).toBeUndefined();
    expect((await intentOf(s.colonyId, s.secondIntent.id)).intent.status).toBe("open");
  });

  it("on: the lane sends it to the trunk writer, and the colony closes it as already on trunk, naming the first landing", async () => {
    const s = await sameEdit();
    await setLane(s.colonyId, "src", `other-colony,${s.colonyId}`);
    // The stand-in trunk writer closes it as the real one does (the real one is tested below).
    await trunk(s.colonyId).onTrunkOnLand([s.second.id]);
    await tick(s.colonyId, "src");
    const after = await proposal(s.colonyId, s.second.id);
    expect(after.status).toBe("already_on_trunk");
    expect(after.reason).toMatch(/^Your change is already on trunk: /);
    expect(after.onTrunk).toEqual({ trunkSha: s.firstLanding.trunkSha, landingId: s.firstLanding.id, proposalId: s.first.id, intentId: s.first.intentId, agentId: s.first.agentId });
    expect(after.landingId).toBeUndefined();
    // Nothing landed for it: one landing, the first change's.
    const state = await trunk(s.colonyId).state();
    expect(state.landings.map((l) => l.proposalIds)).toEqual([[s.first.id]]);
    // It left the lane.
    expect(await rows(region(s.colonyId, "src"), "SELECT id FROM lane")).toEqual([]);
    // Its intent's need is met, with the closure cause naming where the content came from.
    const h = await intentOf(s.colonyId, s.secondIntent.id);
    expect(h.intent.status).toBe("landed");
    expect(h.intent.closure).toMatchObject({ cause: "already_on_trunk", status: "landed", agentId: s.secondAgent, onTrunk: { landingId: s.firstLanding.id } });
    expect(h.closures?.[0]).toMatchObject({ cause: "already_on_trunk", status: "landed", agentId: s.secondAgent, onTrunk: { landingId: s.firstLanding.id, proposalId: s.first.id } });
    // Its agent is idle and free for other work.
    expect(await colony(s.colonyId).getAgent(s.secondAgent)).toMatchObject({ state: "idle" });
    // Counted apart: one landed change, one already on trunk, none back.
    const m = await metrics(s.colonyId);
    expect(m).toMatchObject({ landedProposals: 1, alreadyOnTrunk: 1, returned: 0, landedIntents: 1 });
    const report = (await api<{ closures: { byKind: Record<string, { counts: Record<string, number> }> } }>("GET", `/colonies/${s.colonyId}/metrics`)).body.closures;
    expect(report.byKind.synthetic?.counts).toMatchObject({ landed: 1, already_on_trunk: 1 });
  });

  it("on: a second report of the same close changes nothing (final, counted once)", async () => {
    const s = await sameEdit();
    await setLane(s.colonyId, "src", "on");
    await trunk(s.colonyId).onTrunkOnLand([s.second.id]);
    await tick(s.colonyId, "src");
    const once = await proposal(s.colonyId, s.second.id);
    const res = await runInDurableObject(colony(s.colonyId), async (instance) => {
      const c = instance as unknown as { updateProposals(items: Array<{ id: string; patch: Partial<Proposal> }>): Promise<void> };
      await c.updateProposals([{ id: s.second.id, patch: { status: "already_on_trunk", reason: "again", onTrunk: { trunkSha: "f".repeat(40) } } }]);
      await c.updateProposals([{ id: s.second.id, patch: { status: "returned", reason: "stale: late" } }]);
    });
    expect(res).toBeUndefined();
    expect(await proposal(s.colonyId, s.second.id)).toEqual(once);
    expect((await metrics(s.colonyId)).alreadyOnTrunk).toBe(1);
  });
});

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

const TRUNK: RepoRef = { namespace: "ft-trunk", name: "ontrunk--trunk", remote: "https://artifacts.invalid/ontrunk--trunk.git" };
let seq = 0;

/** A trunk writer whose trunk holds `files`, with `vars` as its settings; `count` reads how many landings it recorded. */
async function withWriter(files: Record<Path, string>, vars: Record<string, string | undefined>, fn: (w: Writer, count: () => number) => Promise<void>): Promise<void> {
  const name = `on-trunk-${Date.now()}-${++seq}`;
  const colonyId = `col_ontrunk_${seq}`;
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
    const count = (): number => state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM ft_landings").one().n;
    await fn(new Writer(writer, g, state, colonyId), count);
  });
}

const FILES: Record<Path, string> = { [F]: lines(), "README.md": "# on trunk\n" };
const FIX = lines({ 2: "the same fix" });

describe("already on trunk in the trunk writer (FT_ALREADY_ON_TRUNK)", () => {
  for (const merge of ["on", undefined]) {
    it(`on (text merge ${merge ?? "off"}): a change from the same base as a landed one with the same edit lands no commit, naming that landing`, async () => {
      await withWriter(FILES, { FT_ALREADY_ON_TRUNK: "on", FT_TEXT_MERGE: merge }, async (w, count) => {
        const a = await w.proposal({ [F]: FIX });
        const b = await w.proposal({ [F]: FIX });
        const la = landed(await w.land(a));
        const head = w.head();
        const rb = await w.land(b);
        expect(rb.landing).toBeUndefined();
        expect(rb.returned).toEqual([]);
        expect(rb.onTrunk).toEqual([
          {
            proposalId: b.id,
            source: { trunkSha: la.trunkSha, landingId: la.id, proposalId: a.id, intentId: a.intentId, agentId: a.agentId },
            reason: `Your change is already on trunk: what it writes is there already, landed by agent ${a.agentId} in ${la.id} (commit ${la.trunkSha.slice(0, 7)}, intent ${a.intentId}, proposal ${a.id}). Nothing landed for it and it was not sent back, so there is nothing to redo: take your next intent.`,
          },
        ]);
        // No commit and no note: trunk did not move, and the landing log holds only the first.
        expect(w.head()).toBe(head);
        expect(count()).toBe(1);
        const cycles = await w.cycles();
        expect(cycles.at(-1)).toMatchObject({ landings: 0, landed: 0, returned: 0, alreadyOnTrunk: 1 });
        // A retry of the change that did land still gets its landing.
        const again = await w.land(a);
        expect(again.prior?.map((l) => l.id)).toEqual([la.id]);
        expect(again.onTrunk).toBeUndefined();
      });
    });
  }

  it("on: two changes with the same edit in one cycle: the first lands, the second names it as landed in the same cycle", async () => {
    await withWriter(FILES, { FT_ALREADY_ON_TRUNK: "on" }, async (w, count) => {
      const a = await w.proposal({ [F]: FIX });
      const b = await w.proposal({ [F]: FIX });
      const [ra, rb] = await Promise.all([w.land(a), w.land(b)]);
      const la = landed(ra);
      expect(await w.cycles()).toHaveLength(1);
      expect(rb.landing).toBeUndefined();
      expect(rb.onTrunk?.map((o) => o.source)).toEqual([{ trunkSha: la.trunkSha, landingId: la.id, proposalId: a.id, intentId: a.intentId, agentId: a.agentId, sameCycle: true }]);
      expect(rb.onTrunk?.[0]?.reason).toContain(`in ${la.id} (commit ${la.trunkSha.slice(0, 7)}, intent ${a.intentId}, proposal ${a.id}) in the same trunk cycle.`);
      expect(count()).toBe(1);
    });
  });

  it("on: content no landing wrote (trunk had it from the start) names the trunk head", async () => {
    await withWriter(FILES, { FT_ALREADY_ON_TRUNK: "on" }, async (w, count) => {
      const p = await w.proposal({ "README.md": "# on trunk\n" });
      const r = await w.land(p);
      expect(r.onTrunk?.map((o) => o.source)).toEqual([{ trunkSha: w.head() }]);
      expect(count()).toBe(0);
    });
  });

  it("off: the change lands as an empty commit with text merge on, and goes back stale with it off, as before", async () => {
    for (const merge of ["on", undefined]) {
      await withWriter(FILES, { FT_TEXT_MERGE: merge }, async (w, count) => {
        const a = await w.proposal({ [F]: FIX });
        const b = await w.proposal({ [F]: FIX });
        const la = landed(await w.land(a));
        const rb: LandResult = await w.land(b);
        expect(rb.onTrunk).toBeUndefined();
        if (merge === "on") {
          expect(landed(rb).paths).toEqual([]);
          expect(count()).toBe(2);
        } else {
          expect(rb.returned.map((r) => r.reason)).toEqual([expect.stringMatching(/^stale: src\/app\/main\.ts \(expected /)]);
          expect(count()).toBe(1);
        }
        expect(la.paths).toEqual([F]);
        expect((await w.cycles()).every((c) => c.alreadyOnTrunk === undefined)).toBe(true);
      });
    }
  });
});
