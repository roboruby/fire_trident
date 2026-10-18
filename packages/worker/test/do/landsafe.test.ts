import { describe, expect, it } from "vitest";
import type { Path, Proposal, Sha } from "@fire_trident/core";
import type { LandResult } from "../../src/trunk/plan.ts";
import { TrunkDO } from "../../src/trunk/TrunkDO.ts";
import { PULL_FILE_BYTES } from "../../src/trunk/pullcap.ts";
import { landed, withPublisher, type Publisher } from "./publisher.ts";

/**
 * The landing layer's safety checks in the real trunk writer, over publisher.ts's fake trunk repository: byte caps on
 * what a cycle pulls from workspaces (trunk/pullcap.ts), the structure check on system commits (trunk/structure.ts), and
 * journal recovery that asks the trunk repository's ref advertisement where main is (trunk/recovery.ts).
 */

/** The private parts of TrunkDO these tests stand in for or call. */
interface Internals {
  env: Record<string, unknown>;
  pullBlobs(p: Proposal): Promise<Map<Path, number>>;
  remoteHead(): Promise<Sha | null>;
  trunkRefs(): Promise<Array<{ ref: string; oid: string }>>;
  mainLog(limit: number): Promise<Sha[]>;
  recipeHost(): { files(): Array<{ path: string }> };
}

const FILES: Record<Path, string> = { "src/a.ts": "export const a = 1;\n", "src/b.ts": "export const b = 1;\n" };
const inside = (t: TrunkDO): Internals => t as unknown as Internals;

/** A workspace binding (WS0) whose one repository answers readBlob from `blobs`, or with `read` when it is set. */
function workspace(t: TrunkDO, blobs: Map<Sha, Blob>, read?: (hash: Sha) => Promise<Blob | null>): void {
  const repo = { readBlob: (hash: Sha) => (read ? read(hash) : Promise.resolve(blobs.get(hash) ?? null)) };
  const x = inside(t);
  x.env.WS0 = { get: async () => repo };
  // The real pull, which the publisher stands in for.
  x.pullBlobs = (TrunkDO.prototype as unknown as Internals).pullBlobs.bind(t);
}

/** A proposal writing `changes`, whose texts its workspace (`blobs`) serves. */
async function served(w: Publisher, blobs: Map<Sha, Blob>, changes: Record<Path, string>): Promise<Proposal> {
  const p = await w.proposal(changes);
  for (const f of p.writeSet) if (f.blob) blobs.set(f.blob, new Blob([changes[f.path]!]));
  return p;
}

function returnedOf(r: LandResult): Record<string, string> {
  return Object.fromEntries(r.returned.map((x) => [x.proposalId, x.reason]));
}

describe("byte caps on blobs pulled from workspaces", () => {
  it("sends back only the change with a file over the cap; the change batched with it lands", async () => {
    await withPublisher(FILES, {}, async (w) => {
      const blobs = new Map<Sha, Blob>();
      workspace(w.trunk, blobs);
      const innocent = await served(w, blobs, { "src/a.ts": "export const a = 2;\n" });
      const big = await served(w, blobs, { "src/b.ts": "export const b = 2;\n" });
      // Its workspace holds a 3 MB file under that blob id: refused by its size, before it is read or hashed.
      blobs.set(big.writeSet[0]!.blob!, new Blob([new Uint8Array(PULL_FILE_BYTES + 1_000_000)]));
      const result = await w.land(innocent, big);
      expect(returnedOf(result)).toEqual({ [big.id]: expect.stringMatching(/^src\/b\.ts is 3 MB, larger than 2 MB, the most the trunk writer takes from a workspace for one file: /) });
      expect(result.landing?.proposalIds).toEqual([innocent.id]);
      expect(w.remote.main).toBe(result.landing!.trunkSha);
    });
  });

  it("sends back a change whose files together are over the change cap, and one the workspace will not hand over", async () => {
    await withPublisher(FILES, {}, async (w) => {
      const blobs = new Map<Sha, Blob>();
      workspace(w.trunk, blobs);
      const chunk = (n: number): string => `${n}`.repeat(1_900_000);
      const many: Record<Path, string> = {};
      for (let n = 1; n <= 5; n++) many[`data/part${n}.txt`] = chunk(n);
      const wide = await served(w, blobs, many);
      expect(returnedOf(await w.land(wide))).toEqual({
        [wide.id]: "this change's new files come to more than 8 MB, the most the trunk writer takes from a workspace for one change: split it into smaller changes and propose each",
      });
      // The workspace service refuses to buffer the blob (Artifacts MEMORY_LIMIT): the same answer as a file over the cap.
      const huge = await served(w, blobs, { "src/a.ts": "export const a = 3;\n" });
      workspace(w.trunk, blobs, async () => {
        throw Object.assign(new Error("object too large to buffer"), { code: "MEMORY_LIMIT" });
      });
      expect(returnedOf(await w.land(huge))[huge.id]).toMatch(/^src\/a\.ts is larger than 2 MB, the most the trunk writer takes from a workspace for one file: /);
      expect(w.landingCommits()).toEqual([]);
    });
  });
});

describe("the structure check on system commits", () => {
  it("refuses to retarget a symbolic link or add a second spelling of a trunk file, and commits nothing", async () => {
    await withPublisher({ ...FILES, "src/link.ts": "a.ts" }, { publish: "on" }, async (w) => {
      // src/link.ts is a symbolic link in trunk (its blob is where it points).
      w.state.storage.sql.exec("UPDATE ft_files SET mode = '120000' WHERE path = 'src/link.ts'");
      await expect(w.systemCommit("src/link.ts", "b.ts")).rejects.toThrow(/^\[ft:422\] nothing was committed: src\/link\.ts is a symbolic link in trunk, and a change cannot change where it points/);
      await expect(w.systemCommit("SRC/a.ts", "export const a = 9;\n")).rejects.toThrow(/^\[ft:422\] nothing was committed: SRC\/a\.ts differs from the trunk file src\/a\.ts only in letter case/);
      await expect(w.systemCommit("src/a.ts/x.ts", "x\n")).rejects.toThrow(/^\[ft:422\] nothing was committed: src\/a\.ts is a file in trunk/);
      expect(w.landingCommits()).toEqual([]);
      expect(w.journal("pending_note")).toEqual([]);
      // Other files commit as before, and a recipe never reads the link as a file to transform.
      const ok = await w.systemCommit(".firetrident/note.md", "remember\n");
      expect(w.landingCommits()).toEqual([ok.trunkSha]);
      expect(inside(w.trunk).recipeHost().files().map((f) => f.path).sort()).toEqual([".firetrident/note.md", "src/a.ts", "src/b.ts"]);
    });
  });
});

/** Stand in for the trunk repository's two reads: its ref advertisement (`head`, or a failure) and the binding's log of main. */
function reads(w: Publisher, head: () => Sha | Error, log: () => Sha[]): void {
  const x = inside(w.trunk);
  x.remoteHead = (TrunkDO.prototype as unknown as Internals).remoteHead.bind(w.trunk);
  x.trunkRefs = async () => {
    const h = head();
    if (h instanceof Error) throw h;
    return [
      { ref: "HEAD", oid: h },
      { ref: "refs/heads/main", oid: h },
    ];
  };
  x.mainLog = async () => log();
}

describe("journal recovery when the binding's log lags a push", () => {
  it("records a landing that reached main although the binding's log does not show it yet", async () => {
    await withPublisher(FILES, { chain: "real" }, async (w) => {
      // The push lands and its reply is lost, and main cannot be read then: the landing's journal row stays.
      w.remote.plan = ["lost"];
      w.remote.headFails = true;
      const p = await w.proposal({ "src/a.ts": "export const a = 2;\n" });
      await expect(w.land(p)).rejects.toThrow(/journal kept for recovery/);
      expect(w.journal("pushing")).toHaveLength(1);
      const tip = w.remote.main;
      expect(tip).not.toBe(w.initial);
      // The ref advertisement says main is at the landing; the binding's log still shows the commit before it.
      reads(w, () => w.remote.main, () => [w.initial]);
      const known = await w.trunk.landingsOf([p.id]);
      expect(known[p.id]?.trunkSha).toBe(tip);
      expect(w.landingCommits()).toEqual([tip]);
      expect(w.journal("pushing")).toEqual([]);
      expect(w.head()).toBe(tip);
    });
  });

  it("keeps a landing while neither read can tell, lands nothing on top of it, and records it once the log shows it", async () => {
    await withPublisher(FILES, { chain: "real" }, async (w) => {
      w.remote.plan = ["lost"];
      w.remote.headFails = true;
      const p = await w.proposal({ "src/a.ts": "export const a = 2;\n" });
      await expect(w.land(p)).rejects.toThrow(/journal kept for recovery/);
      const tip = w.remote.main;
      let log = [w.initial];
      reads(w, () => new Error("advertisement unavailable"), () => log);
      await expect(w.trunk.landingsOf([p.id])).rejects.toThrow(/whether a landing reached trunk main is not known yet .*the journal keeps it and the next cycle settles it/);
      expect(w.journal("pushing")).toHaveLength(1);
      // A cycle meanwhile builds nothing on a trunk that may be under main.
      const next = await w.proposal({ "src/b.ts": "export const b = 2;\n" });
      await expect(w.land(next)).rejects.toThrow(/not known yet/);
      expect(w.remote.moves).toHaveLength(1);
      // The binding's log catches up: recorded.
      log = [tip, w.initial];
      expect((await w.trunk.landingsOf([p.id]))[p.id]?.trunkSha).toBe(tip);
      expect(w.landingCommits()).toEqual([tip]);
    });
  });

  it("drops a landing whose push never moved main, and the next change lands", async () => {
    await withPublisher(FILES, { chain: "real" }, async (w) => {
      // Both pushes fail before reaching main, and main cannot be read: the journal row stays.
      w.remote.plan = ["fail", "fail"];
      w.remote.headFails = true;
      const p = await w.proposal({ "src/a.ts": "export const a = 2;\n" });
      await expect(w.land(p)).rejects.toThrow(/journal kept for recovery/);
      expect(w.remote.main).toBe(w.initial);
      reads(w, () => w.remote.main, () => [w.initial]);
      w.remote.headFails = false;
      expect(await w.trunk.landingsOf([p.id])).toEqual({});
      expect(w.journal("pushing")).toEqual([]);
      const again = landed(await w.land(await w.proposal({ "src/a.ts": "export const a = 3;\n" })));
      expect(w.landingCommits()).toEqual([again.trunkSha]);
    });
  });

  it("keeps the journal when a push's outcome is unknown and main is somewhere else, instead of dropping it", async () => {
    await withPublisher(FILES, { chain: "real" }, async (w) => {
      const elsewhere = "e".repeat(40);
      // The direct push fails before reaching main; as the regular push starts, main moves to a commit this writer did not make, and that push fails too.
      w.remote.plan = ["fail", "fail"];
      w.remote.onPush = () => {
        if (w.remote.attempts === 2) w.remote.main = elsewhere;
      };
      const p = await w.proposal({ "src/a.ts": "export const a = 2;\n" });
      await expect(w.land(p)).rejects.toThrow(/trunk push outcome unknown \(trunk main is at e{40}\), journal kept for recovery/);
      expect(w.journal("pushing")).toHaveLength(1);
      // Once the binding's log has caught up with main and does not list the landing, it is dropped.
      reads(w, () => w.remote.main, () => [elsewhere, w.initial]);
      expect(await w.trunk.landingsOf([p.id])).toEqual({});
      expect(w.journal("pushing")).toEqual([]);
      expect(w.landingCommits()).toEqual([]);
    });
  });
});
