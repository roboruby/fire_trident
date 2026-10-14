import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { blobId, changesetId } from "@fire_trident/core";
import type { AgentInfo, InboxDirective, Landing, LineageNote, Path, Proposal, RepoRef, Sha } from "@fire_trident/core";
import { buildTree, ensureRepo, readLocalBlob, setRef, writeCommitObject, writeLocalBlob, type GitRepo } from "../../src/artifacts/git.ts";
import type { LandedOn } from "../../src/certify/culprit.ts";
import { TrunkDO } from "../../src/trunk/TrunkDO.ts";
import { addAgent, addIntent, api, colony, env, eventually, externalLanding, headSha, newColony, proposal, proposeEdit, region, rows, take, tick, trunk } from "./helpers.ts";
import { Writer, landed } from "./writer.ts";

/**
 * Text merge (FT_TEXT_MERGE) through the Durable Objects: the lane lets a change stale only on files it writes go on
 * to the trunk writer; the real trunk writer merges it and records the merged blob everywhere a landing is recorded;
 * and the colony reads the blob that landed.
 */

const F = "src/app/main.ts";

/** Six numbered lines, with some of them replaced. */
function lines(changes: Record<number, string> = {}): string {
  return Array.from({ length: 6 }, (_, i) => `${changes[i + 1] ?? `line ${i + 1}`}\n`).join("");
}

// ---------------------------------------------------------------------------
// The lane (RegionDO, with the harness's stand-in trunk writer)
// ---------------------------------------------------------------------------

/** Set FT_TEXT_MERGE as one lane sees it (the harness binds none, so text merge is off by default). */
async function setMerging(colonyId: string, name: string, value: string): Promise<void> {
  await runInDurableObject(region(colonyId, name), (instance) => {
    const i = instance as unknown as { env: Record<string, unknown> };
    i.env = { ...i.env, FT_TEXT_MERGE: value };
  });
}

/**
 * A change queued in the src lane whose written file then changed on trunk (another change landed there first).
 * `alsoRead`: a file it read too, which the same outside commit changes.
 */
async function staleWriter(alsoRead?: Path): Promise<{ colonyId: string; p: Proposal }> {
  const c = await newColony();
  const agent = await addAgent(c.id, "writer");
  await addIntent(c.id, [F], { assignedTo: agent.id });
  const a = await take(c.id, agent.id);
  const read = await trunk(c.id).baseBlobs(a.lease.baseSha, alsoRead ? [F, alsoRead] : [F]);
  const p = await proposeEdit(c.id, a, agent.id, { readSet: read });
  expect(p.status).toBe("ready");
  await externalLanding(c.id, { [F]: "console.log(2);\n", ...(alsoRead ? { [alsoRead]: "export const helper = () => 3;\n" } : {}) });
  return { colonyId: c.id, p };
}

describe("text merge in the lane (FT_TEXT_MERGE)", () => {
  it("off: a change whose written file moved goes back as stale", async () => {
    const { colonyId, p } = await staleWriter();
    await tick(colonyId, "src");
    const after = await proposal(colonyId, p.id);
    expect(after.status).toBe("returned");
    expect(after.reason).toMatch(/^stale: 1 path changed on trunk since read: src\/app\/main\.ts/);
    expect((await trunk(colonyId).state()).landings.some((l) => l.proposalIds.includes(p.id))).toBe(false);
  });

  it("on for the colony: a change stale only on a file it writes goes on to the trunk writer", async () => {
    const { colonyId, p } = await staleWriter();
    await setMerging(colonyId, "src", `other-colony,${colonyId}`);
    await tick(colonyId, "src");
    expect((await trunk(colonyId).state()).landings.some((l) => l.proposalIds.includes(p.id))).toBe(true);
    expect((await proposal(colonyId, p.id)).status).toBe("landed");
  });

  it("on: a change also stale on a file it only reads goes back as today, and so does one on for another colony only", async () => {
    const reads = await staleWriter("src/lib/util.ts");
    await setMerging(reads.colonyId, "src", "on");
    await tick(reads.colonyId, "src");
    expect((await proposal(reads.colonyId, reads.p.id)).status).toBe("returned");
    const other = await staleWriter();
    await setMerging(other.colonyId, "src", "other-colony");
    await tick(other.colonyId, "src");
    expect((await proposal(other.colonyId, other.p.id)).status).toBe("returned");
  });

  it("on: a candidate the trunk writer sends back (a conflict) is a stale return caused by the landing that moved the file", async () => {
    const { colonyId, p } = await staleWriter();
    await setMerging(colonyId, "src", "on");
    await trunk(colonyId).returnOnLand([p.id]);
    await tick(colonyId, "src");
    expect((await proposal(colonyId, p.id)).status).toBe("returned");
    const causes = await eventually(
      () => rows<{ id: string; cause_id: string | null }>(region(colonyId, "src"), "SELECT id, cause_id FROM causes WHERE id = ?", `ret:${p.id}`),
      (rs) => rs.length === 1,
    );
    expect(causes[0]!.cause_id).toMatch(/^land:lnd_external_/);
  });

  it("indexes a merged file at the blob that landed, so a later stale return names that landing as its cause", async () => {
    const c = await newColony();
    const p = { id: "prp_m", intentId: "int_m", writeSet: [{ path: F, blob: "a".repeat(40) }, { path: "src/app/b.ts", blob: "b".repeat(40) }] } as Proposal;
    const merged = "c".repeat(40);
    const landing: Landing = { id: "lnd_m", colonyId: c.id, trunkSha: "d".repeat(40), parentSha: "e".repeat(40), proposalIds: [p.id], intentIds: [p.intentId], paths: [F, "src/app/b.ts"], regions: ["src"], at: Date.now(), merged: [{ proposalId: p.id, path: F, blob: merged }] };
    await runInDurableObject(region(c.id, "src"), (instance) => (instance as unknown as { recordLanding(l: Landing, batch: Proposal[], now: number): void }).recordLanding(landing, [p], Date.now()));
    const indexed = await rows<{ path: string; blob: string; event_id: string }>(region(c.id, "src"), "SELECT path, blob, event_id FROM path_landing ORDER BY path");
    expect(indexed).toEqual([
      { path: "src/app/b.ts", blob: "b".repeat(40), event_id: "land:lnd_m:prp_m" },
      { path: F, blob: merged, event_id: "land:lnd_m:prp_m" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// The trunk writer (the real TrunkDO; only network steps stood in, as in writer.ts)
// ---------------------------------------------------------------------------

/** The private steps the test stands in for, and the ones it calls to set trunk up. */
interface Internals {
  pullBlobs(p: Proposal): Promise<Map<Path, number>>;
  pushChain(chain: unknown): Promise<{ ok: true }>;
  notesSoon(): Promise<void>;
  rebuildIndex(head: Sha): Promise<void>;
  repo(): GitRepo;
}

/** What the trunk writer recorded, read from its storage. */
class Records {
  constructor(
    private readonly state: DurableObjectState,
    private readonly g: GitRepo,
  ) {}

  blob(path: Path): Sha {
    return this.state.storage.sql.exec<{ blob: string }>("SELECT blob FROM ft_files WHERE path = ?", path).one().blob;
  }

  size(path: Path): number {
    return this.state.storage.sql.exec<{ size: number }>("SELECT size FROM ft_files WHERE path = ?", path).one().size;
  }

  async text(path: Path): Promise<string> {
    return new TextDecoder().decode(await readLocalBlob(this.g, this.blob(path)));
  }

  paths(landingId: string): Array<{ path: string; before_blob: string | null; after_blob: string | null }> {
    return this.state.storage.sql
      .exec<{ path: string; before_blob: string | null; after_blob: string | null }>("SELECT path, before_blob, after_blob FROM ft_landing_paths WHERE landing_id = ? ORDER BY path", landingId)
      .toArray();
  }

  note(landingId: string): LineageNote {
    return JSON.parse(this.state.storage.sql.exec<{ note: string }>("SELECT note FROM ft_notes WHERE landing_id = ?", landingId).one().note) as LineageNote;
  }
}

const TRUNK: RepoRef = { namespace: "ft-trunk", name: "merge--trunk", remote: "https://artifacts.invalid/merge--trunk.git" };
let seq = 0;

/** A trunk writer whose trunk holds `files`, with `vars` as its settings (FT_TEXT_MERGE, ...). */
async function withWriter(files: Record<Path, string>, vars: Record<string, string | undefined>, fn: (w: Writer, r: Records) => Promise<void>): Promise<void> {
  const name = `text-merge-${Date.now()}-${++seq}`;
  const colonyId = `col_merge_${seq}`;
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
    // The network steps.
    t.pullBlobs = async (p) => {
      const sizes = new Map<Path, number>();
      for (const w of p.writeSet) if (w.blob !== null) sizes.set(w.path, (await readLocalBlob(g, w.blob)).length);
      return sizes;
    };
    t.pushChain = async () => ({ ok: true });
    t.notesSoon = async () => undefined;
    await fn(new Writer(writer, g, state, colonyId), new Records(state, g));
  });
}

const FILES: Record<Path, string> = { [F]: lines(), "README.md": "# merge\n" };

describe("text merge in the trunk writer (FT_TEXT_MERGE)", () => {
  it("lands a change to other lines of a file that changed since its base, recording the merged blob in every record", async () => {
    await withWriter(FILES, { FT_TEXT_MERGE: "on" }, async (w, r) => {
      const base = r.blob(F);
      const a = await w.proposal({ [F]: lines({ 1: "a one" }) });
      const b = await w.proposal({ [F]: lines({ 5: "b five" }) });
      const la = landed(await w.land(a));
      const A = r.blob(F);
      const lb = landed(await w.land(b));
      const text = lines({ 1: "a one", 5: "b five" });
      const merged = blobId(text);
      // Trunk holds the merged text, from a blob the local store has (the push and the publish loop read it there).
      expect(r.blob(F)).toBe(merged);
      expect(await r.text(F)).toBe(text);
      expect(r.size(F)).toBe(new TextEncoder().encode(text).length);
      expect(lb.parentSha).toBe(la.trunkSha);
      expect(lb.paths).toEqual([F]);
      expect(lb.merged).toEqual([{ proposalId: b.id, path: F, blob: merged }]);
      expect(la.merged).toBeUndefined();
      expect(r.paths(lb.id)).toEqual([{ path: F, before_blob: A, after_blob: merged }]);
      const note = r.note(lb.id).proposals[0]!;
      expect(note.writeSet).toEqual([{ path: F, blob: merged }]);
      expect(note.merged).toEqual([{ path: F, base, trunk: A, theirs: b.writeSet[0]!.blob, result: merged }]);
      expect(r.note(la.id).proposals[0]!.merged).toBeUndefined();
      const cycles = await w.cycles();
      expect(cycles.map((c) => c.merged)).toEqual([undefined, 1]);
      expect(cycles.every((c) => c.ms.merges !== undefined)).toBe(true);
      // Blame follows each line to the landing that wrote it.
      expect((await w.trunk.why(F, 1))[0]!.landing.id).toBe(la.id);
      expect((await w.trunk.why(F, 5))[0]!.landing.id).toBe(lb.id);
    });
  });

  it("merges two changes to one file landing in one cycle: the second commit starts from the first one's version", async () => {
    await withWriter(FILES, { FT_TEXT_MERGE: "on" }, async (w, r) => {
      const base = r.blob(F);
      const a = await w.proposal({ [F]: lines({ 2: "a two" }) });
      const b = await w.proposal({ [F]: lines({ 6: "b six" }) });
      // Both requests wait for the same cycle: two batches, two chained commits.
      const [ra, rb] = await Promise.all([w.land(a), w.land(b)]);
      const la = landed(ra);
      const lb = landed(rb);
      expect(await w.cycles()).toHaveLength(1);
      const A = a.writeSet[0]!.blob!;
      const merged = blobId(lines({ 2: "a two", 6: "b six" }));
      expect(lb.parentSha).toBe(la.trunkSha);
      expect(r.paths(la.id)).toEqual([{ path: F, before_blob: base, after_blob: A }]);
      expect(r.paths(lb.id)).toEqual([{ path: F, before_blob: A, after_blob: merged }]);
      expect(r.blob(F)).toBe(merged);
      expect(r.note(lb.id).proposals[0]!.merged).toEqual([{ path: F, base, trunk: A, theirs: b.writeSet[0]!.blob, result: merged }]);
      expect((await w.trunk.why(F, 2))[0]!.landing.id).toBe(la.id);
      expect((await w.trunk.why(F, 6))[0]!.landing.id).toBe(lb.id);
    });
  });

  it("merges an inline change (its texts carried with it) the same way", async () => {
    await withWriter(FILES, { FT_TEXT_MERGE: "on" }, async (w, r) => {
      const a = await w.proposal({ [F]: lines({ 1: "a one" }) });
      const text = lines({ 4: "inline four" });
      const b = await w.proposal({ [F]: text });
      const inline: Proposal = { ...b, headSha: changesetId(b.baseSha, b.writeSet), contents: { [b.writeSet[0]!.blob!]: text } };
      landed(await w.land(a));
      const lb = landed(await w.land(inline));
      expect(await r.text(F)).toBe(lines({ 1: "a one", 4: "inline four" }));
      expect(lb.merged).toEqual([{ proposalId: b.id, path: F, blob: r.blob(F) }]);
    });
  });

  it("lands a change whose edit is already on trunk as a commit that changes nothing, its merge recorded", async () => {
    await withWriter(FILES, { FT_TEXT_MERGE: "on" }, async (w, r) => {
      const a = await w.proposal({ [F]: lines({ 2: "the same fix" }) });
      const b = await w.proposal({ [F]: lines({ 2: "the same fix" }) });
      const la = landed(await w.land(a));
      const A = r.blob(F);
      const lb = landed(await w.land(b));
      expect(lb.parentSha).toBe(la.trunkSha);
      expect(lb.paths).toEqual([]);
      expect(lb.merged).toEqual([{ proposalId: b.id, path: F, blob: A }]);
      expect(r.paths(lb.id)).toEqual([]);
      expect(r.blob(F)).toBe(A);
      expect(w.head()).toBe(lb.trunkSha);
    });
  });

  it("returns a change whose edit conflicts with trunk's, naming the hunk, and leaves trunk as it was", async () => {
    await withWriter(FILES, { FT_TEXT_MERGE: "on" }, async (w, r) => {
      const base = r.blob(F);
      const a = await w.proposal({ [F]: lines({ 3: "a three" }) });
      const b = await w.proposal({ [F]: lines({ 3: "b three" }) });
      landed(await w.land(a));
      const A = r.blob(F);
      const head = w.head();
      expect(await w.land(b)).toEqual({
        returned: [{ proposalId: b.id, reason: `stale: ${F} (expected ${base}, trunk has ${A}); text merge of ${F}: 1 conflicting hunk, at line 3 of its base` }],
      });
      expect(w.head()).toBe(head);
      expect(r.blob(F)).toBe(A);
      expect((await w.cycles()).map((c) => c.merged)).toEqual([undefined, undefined]);
    });
  });

  it("returns the change as before when text merge is off, or on for another colony only", async () => {
    for (const setting of [undefined, "off", "col_other"]) {
      await withWriter(FILES, { FT_TEXT_MERGE: setting }, async (w, r) => {
        const base = r.blob(F);
        const a = await w.proposal({ [F]: lines({ 1: "a one" }) });
        const b = await w.proposal({ [F]: lines({ 5: "b five" }) });
        landed(await w.land(a));
        const A = r.blob(F);
        expect(await w.land(b)).toEqual({ returned: [{ proposalId: b.id, reason: `stale: ${F} (expected ${base}, trunk has ${A})` }] });
        expect((await w.cycles()).some((c) => c.ms.merges !== undefined)).toBe(false);
      });
    }
  });
});

// ---------------------------------------------------------------------------
// The colony reads the blob that landed
// ---------------------------------------------------------------------------

async function external(colonyId: string, name: string): Promise<AgentInfo> {
  const res = await api<AgentInfo>("POST", `/colonies/${colonyId}/agents`, { name, kind: "external" });
  expect(res.status).toBe(201);
  return res.body;
}

async function landingNotices(colonyId: string, agentId: string): Promise<InboxDirective[]> {
  const res = await api<Array<InboxDirective | { kind?: undefined }>>("GET", `/colonies/${colonyId}/agents/${agentId}/inbox`);
  expect(res.status).toBe(200);
  return res.body.filter((e): e is InboxDirective => e.kind === "directive" && (e as InboxDirective).directive.kind === "landing");
}

describe("the colony reads the blob that landed (text merge)", () => {
  it("culprit finding names the merged blob as what the proposal landed", async () => {
    const c = await newColony();
    const agent = await addAgent(c.id, "writer");
    await addIntent(c.id, [F], { assignedTo: agent.id });
    const a = await take(c.id, agent.id);
    const p = await proposeEdit(c.id, a, agent.id);
    const merged = blobId("merged\n");
    const parent = await headSha(c.id);
    await colony(c.id).onLanding({ id: "lnd_merge_1", colonyId: c.id, trunkSha: parent, parentSha: parent, proposalIds: [p.id], intentIds: [p.intentId], paths: [F], regions: ["src"], at: Date.now(), merged: [{ proposalId: p.id, path: F, blob: merged }] });
    const found = await runInDurableObject(colony(c.id), (instance) => (instance as unknown as { suspectLandings(paths: Path[]): Promise<LandedOn[]> }).suspectLandings([F]));
    expect(found.map((l) => ({ landingId: l.landingId, proposalId: l.proposalId, wrote: l.wrote }))).toEqual([{ landingId: "lnd_merge_1", proposalId: p.id, wrote: { [F]: merged } }]);
  });

  it("landing notices leave out a file a merged landing left as it was, and other landings notify as before", async () => {
    const c = await newColony();
    const e = await external(c.id, "laptop");
    await addIntent(c.id, [F], { title: "Hold the file", assignedTo: e.id });
    // A commit that leaves F as it was (the harness's trunk keeps each commit's blobs).
    const parent = await headSha(c.id);
    const { sha } = await trunk(c.id).commitExternal({ "docs/guide.md": "changed\n" });
    const base = { colonyId: c.id, trunkSha: sha, parentSha: parent, proposalIds: [], intentIds: [], paths: [F, "docs/guide.md"], regions: [], at: Date.now() };
    const fBlob = (await trunk(c.id).state()).files[F]!.blob;
    await colony(c.id).onLanding({ ...base, id: "lnd_merged_noop", merged: [{ proposalId: "prp_gone", path: F, blob: fBlob }] });
    await colony(c.id).onLanding({ ...base, id: "lnd_plain" });
    const notices = await eventually(
      () => landingNotices(c.id, e.id),
      (l) => l.length > 0,
    );
    expect(notices.map((n) => n.directive.landing?.landingId)).toEqual(["lnd_plain"]);
  });
});
