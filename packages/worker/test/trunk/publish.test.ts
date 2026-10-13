import { describe, expect, it } from "vitest";
import type { TreeEntry } from "isomorphic-git";
import git from "isomorphic-git";
import { applyTreeChanges, buildTree, ensureRepo, memoryFs, writeLocalBlob, type GitRepo, type PathChange } from "../../src/artifacts/git.ts";
import {
  PUBLISH_BACKOFF_MAX_MS,
  PUBLISH_BOUND,
  addedObjects,
  asyncPublishEnabled,
  publishBackoffMs,
  publishChain,
  settlePublish,
  withinBound,
  type RecordedCommit,
} from "../../src/trunk/publish.ts";

const enc = new TextEncoder();
const sha = (n: number): string => n.toString(16).padStart(40, "0");
const row = (n: number, parent = n - 1): RecordedCommit => ({ landingId: `lnd_${n}`, commit: sha(n), parent: sha(parent), at: 1_000 + n });

async function repo(): Promise<GitRepo> {
  const r: GitRepo = { fs: memoryFs(), dir: "/r", cache: {} };
  await ensureRepo(r, "https://example.invalid/git/ns/repo.git");
  return r;
}

/** Every tree and blob reachable from tree `oid`, the tree included. */
async function reachable(r: GitRepo, oid: string, out = new Set<string>()): Promise<Set<string>> {
  out.add(oid);
  const { tree } = await git.readTree({ fs: r.fs, dir: r.dir, oid });
  for (const e of tree) {
    if (e.type === "tree") await reachable(r, e.oid, out);
    else if (e.type === "blob") out.add(e.oid);
  }
  return out;
}

describe("asynchronous publishing flag", () => {
  it("is on for 'on' or a listed colony, off when absent, 'off' or for another colony", () => {
    expect(asyncPublishEnabled("on", "a")).toBe(true);
    expect(asyncPublishEnabled(" ON ", "a")).toBe(true);
    expect(asyncPublishEnabled("b, a", "a")).toBe(true);
    expect(asyncPublishEnabled(undefined, "a")).toBe(false);
    expect(asyncPublishEnabled("", "a")).toBe(false);
    expect(asyncPublishEnabled("off", "a")).toBe(false);
    expect(asyncPublishEnabled("b,c", "a")).toBe(false);
  });
});

describe("the publish chain", () => {
  it("takes the recorded commits that chain from the published head, in chain order", () => {
    const rows = [row(1), row(2), row(3)];
    expect(publishChain(sha(0), rows)).toEqual({ chain: rows, broken: null });
    // Order of the rows does not matter: the parent links do.
    expect(publishChain(sha(0), [row(3), row(1), row(2)]).chain.map((r) => r.commit)).toEqual([sha(1), sha(2), sha(3)]);
    // From a later published head, only what follows it.
    expect(publishChain(sha(1), [row(2), row(3)]).chain.map((r) => r.commit)).toEqual([sha(2), sha(3)]);
  });

  it("reports a row that does not chain on and never publishes it", () => {
    const stray = row(9, 7);
    const out = publishChain(sha(0), [row(1), row(2), stray]);
    expect(out.chain.map((r) => r.commit)).toEqual([sha(1), sha(2)]);
    expect(out.broken).toEqual(stray);
    // Nothing builds on the published head: an empty chain.
    expect(publishChain(sha(5), [row(1)])).toEqual({ chain: [], broken: row(1) });
    expect(publishChain(sha(0), [])).toEqual({ chain: [], broken: null });
  });

  it("stops at a loop instead of walking it forever", () => {
    const a: RecordedCommit = { landingId: "lnd_a", commit: sha(1), parent: sha(0), at: 1 };
    const b: RecordedCommit = { landingId: "lnd_b", commit: sha(0), parent: sha(1), at: 2 };
    expect(publishChain(sha(0), [a, b]).chain.map((r) => r.commit)).toEqual([sha(1), sha(0)]);
  });
});

describe("settling a publish from where main is", () => {
  const chain = [row(1), row(2), row(3)];
  it("nothing published while main is at the published head", () => {
    expect(settlePublish(sha(0), chain, sha(0))).toEqual({ kind: "none" });
  });
  it("the commits up to main when it holds one of the pushed commits (an answer was lost)", () => {
    expect(settlePublish(sha(0), chain, sha(3))).toEqual({ kind: "upTo", index: 2 });
    expect(settlePublish(sha(0), chain, sha(1))).toEqual({ kind: "upTo", index: 0 });
  });
  it("foreign when main is anywhere else, or gone", () => {
    expect(settlePublish(sha(0), chain, sha(42))).toEqual({ kind: "foreign" });
    expect(settlePublish(sha(0), chain, null)).toEqual({ kind: "foreign" });
  });
});

describe("the bound on unpublished landings", () => {
  const bound = { landings: 3, ageMs: 1_000, waitMs: 10 };
  it("lets a cycle go on below both limits, and stops it at either", () => {
    expect(withinBound({ unpublished: 0, oldestAt: null }, 5_000, bound)).toBe(true);
    expect(withinBound({ unpublished: 2, oldestAt: 4_500 }, 5_000, bound)).toBe(true);
    expect(withinBound({ unpublished: 3, oldestAt: 4_900 }, 5_000, bound)).toBe(false);
    expect(withinBound({ unpublished: 1, oldestAt: 4_000 }, 5_000, bound)).toBe(false);
  });
  it("defaults to 2,000 landings or a minute", () => {
    expect(PUBLISH_BOUND.landings).toBe(2_000);
    expect(PUBLISH_BOUND.ageMs).toBe(60_000);
    expect(withinBound({ unpublished: 1_999, oldestAt: 0 }, 59_999)).toBe(true);
    expect(withinBound({ unpublished: 2_000, oldestAt: 0 }, 1)).toBe(false);
    expect(withinBound({ unpublished: 1, oldestAt: 0 }, 60_000)).toBe(false);
  });
});

describe("publish backoff", () => {
  it("doubles from a second with jitter and stays under the cap", () => {
    expect(publishBackoffMs(1, () => 0.5)).toBe(1_000);
    expect(publishBackoffMs(2, () => 0.5)).toBe(2_000);
    expect(publishBackoffMs(4, () => 0.5)).toBe(8_000);
    expect(publishBackoffMs(1, () => 0)).toBe(750);
    expect(publishBackoffMs(50, () => 0.999)).toBe(PUBLISH_BACKOFF_MAX_MS);
    expect(publishBackoffMs(0, () => 0.5)).toBe(1_000);
  });
});

describe("the objects a commit adds", () => {
  it("carries every new tree and blob, and nothing still at the same path", async () => {
    const r = await repo();
    const blob = (s: string) => writeLocalBlob(r, enc.encode(s));
    const files = new Map<string, { blob: string; mode: string }>();
    for (let d = 0; d < 4; d++) for (let f = 0; f < 3; f++) files.set(`src/r${d}/f${f}.ts`, { blob: await blob(`${d}-${f}`), mode: "100644" });
    files.set("README.md", { blob: await blob("readme"), mode: "100644" });
    const before = await buildTree(r, files);
    const steps: Array<Map<string, PathChange>> = [
      new Map([["src/r1/new.ts", { blob: await blob("new"), mode: "100644" }]]),
      new Map<string, PathChange>([["src/r2/f0.ts", null], ["src/r2/f1.ts", { blob: await blob("changed"), mode: "100644" }]]),
      new Map<string, PathChange>([["src/r3/f0.ts", null], ["src/r3/f1.ts", null], ["src/r3/f2.ts", null]]),
      new Map([["deep/a/b/c.ts", { blob: await blob("deep"), mode: "100644" }]]),
    ];
    let parent = before;
    for (const changes of steps) {
      const after = await applyTreeChanges(r, parent, changes);
      const out = new Set<string>();
      await addedObjects(r, new Map<string, TreeEntry[]>(), parent, after, out);
      const old = await reachable(r, parent);
      const all = await reachable(r, after);
      // Complete: every object the new tree reaches that the old one does not.
      for (const oid of all) if (!old.has(oid)) expect(out.has(oid)).toBe(true);
      // Nothing outside the new tree, and no unchanged subtree.
      for (const oid of out) expect(all.has(oid)).toBe(true);
      expect(out.has(files.get("README.md")!.blob)).toBe(false);
      parent = after;
    }
  });

  it("is empty for an unchanged tree and the whole tree from nothing", async () => {
    const r = await repo();
    const files = new Map([["a/b.txt", { blob: await writeLocalBlob(r, enc.encode("b")), mode: "100644" }]]);
    const root = await buildTree(r, files);
    const same = new Set<string>();
    await addedObjects(r, new Map(), root, root, same);
    expect(same.size).toBe(0);
    const all = new Set<string>();
    await addedObjects(r, new Map(), null, root, all);
    expect(all).toEqual(await reachable(r, root));
  });
});
