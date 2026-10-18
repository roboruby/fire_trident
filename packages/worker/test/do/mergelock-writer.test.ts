import { describe, expect, it } from "vitest";
import { blobId } from "@fire_trident/core";
import type { Path, Proposal, Sha } from "@fire_trident/core";
import { DANGER_CHECK } from "../../src/decide/danger.ts";
import { isMergeHold } from "../../src/trunk/mergelock.ts";
import type { LandContext } from "../../src/trunk/TrunkDO.ts";
import { landed, withWriter, type Writer } from "./writer.ts";

/**
 * Merge locks in the real trunk writer (writer.ts: TrunkDO over a Durable Object's storage, only the network steps stood
 * in for), with text merge on: a change a person approved, one with a danger pattern a person must see and one that
 * writes a protected path never land merged with a newer trunk on their own; a person's approval given after the hold
 * lands exactly the merge it named.
 */

const F = "src/app/main.ts";

/** Six numbered lines, with some of them replaced. */
function lines(changes: Record<number, string> = {}): string {
  return Array.from({ length: 6 }, (_, i) => `${changes[i + 1] ?? `line ${i + 1}`}\n`).join("");
}

const FILES: Record<Path, string> = { [F]: lines(), "AGENTS.md": lines(), "README.md": "# lock\n" };

/** Text merge on for this writer, with `vars` besides (FT_RESOLVER, ...), as a deployment sets them. */
function merging(w: Writer, vars: Record<string, string> = {}): void {
  const t = w.trunk as unknown as { env: Record<string, unknown> };
  t.env = { ...t.env, FT_TEXT_MERGE: "on", ...vars };
}

/** The lineage context a lane passes: a person's approval of `id` at `at`. */
function approval(id: string, at: number): LandContext {
  return { decisions: { [id]: [{ kind: "triage", layer: "reflex", p: 0.9, action: "escalate", at: at - 1 }, { kind: "triage", layer: "human", p: 1, action: "approve", at }] } } as unknown as LandContext;
}

/** The blob trunk has at `path`. */
function blobAt(w: Writer, path: Path): Sha {
  return (w as unknown as { state: DurableObjectState }).state.storage.sql.exec<{ blob: string }>("SELECT blob FROM ft_files WHERE path = ?", path).one().blob;
}

/** Trunk changes line 1 of `path` (another change lands); returns the change's own edit of line 5, built on the old trunk. */
async function movedUnder(w: Writer, path: Path = F, extra: Partial<Proposal> = {}): Promise<{ p: Proposal; base: Sha; onTrunk: Sha; merged: Sha }> {
  const base = blobAt(w, path);
  const p = { ...(await w.proposal({ [path]: lines({ 5: "mine five" }) })), ...extra };
  landed(await w.land(await w.proposal({ [path]: lines({ 1: "trunk one" }) })));
  return { p, base, onTrunk: blobAt(w, path), merged: blobId(lines({ 1: "trunk one", 5: "mine five" })) };
}

describe("merge locks in the trunk writer", () => {
  it("sends a person-approved change whose file moved to a person with the trunk delta; an approval after that lands the merge", async () => {
    await withWriter(FILES, undefined, async (w) => {
      merging(w);
      const before = Date.now() - 60_000;
      const { p, base, onTrunk, merged } = await movedUnder(w);
      const head = w.head();
      const held = await w.trunk.land([p], approval(p.id, before));
      expect(held.landing).toBeUndefined();
      expect(held.returned).toHaveLength(1);
      const reason = held.returned[0]!.reason;
      expect(isMergeHold(reason)).toBe(true);
      expect(reason).toBe(
        `A person approved this change against an older trunk; trunk has since changed ${F} (${base.slice(0, 10)} at its base, ${onTrunk.slice(0, 10)} on trunk, merged as ${merged.slice(0, 10)}), ` +
          "so it was not merged automatically. Review the merged result or the trunk change, both shown with it for review: approving it lands exactly this merge, and returning it sends it to its agent to redo on the new trunk.",
      );
      expect(held.returned[0]!.conflicts).toBeUndefined();
      // What the person reads goes with the return: each file's blobs, trunk's change and the merged result against the approved version.
      expect(held.returned[0]!.held).toEqual([
        {
          path: F,
          base,
          trunk: onTrunk,
          theirs: p.writeSet[0]!.blob,
          result: merged,
          trunkDiff: { hunks: "@@ -1,3 +1,3 @@\n-line 1\n+trunk one\n line 2\n line 3", added: 1, removed: 1, truncated: false },
          mergedDiff: { hunks: "@@ -1,3 +1,3 @@\n-line 1\n+trunk one\n line 2\n line 3", added: 1, removed: 1, truncated: false },
        },
      ]);
      expect(w.head()).toBe(head);
      expect(blobAt(w, F)).toBe(onTrunk);
      // The same approval again (given before the hold) is still not an approval of the merge.
      expect(isMergeHold((await w.trunk.land([p], approval(p.id, before))).returned[0]?.reason)).toBe(true);
      // A person approves after the hold: exactly that merge lands, recorded as a merge.
      const l = landed(await w.trunk.land([p], approval(p.id, Date.now() + 1)));
      expect(l.merged).toEqual([{ proposalId: p.id, path: F, blob: merged }]);
      expect(blobAt(w, F)).toBe(merged);
    });
  });

  it("holds again when trunk moved once more after the hold, naming the new version", async () => {
    await withWriter(FILES, undefined, async (w) => {
      merging(w);
      const { p } = await movedUnder(w);
      expect(isMergeHold((await w.trunk.land([p], approval(p.id, Date.now() - 60_000))).returned[0]?.reason)).toBe(true);
      const approvedAt = Date.now() + 1;
      landed(await w.land(await w.proposal({ [F]: lines({ 1: "trunk one", 2: "trunk two" }) })));
      const again = blobAt(w, F);
      const r = await w.trunk.land([p], approval(p.id, approvedAt));
      expect(r.landing).toBeUndefined();
      expect(r.returned[0]!.reason).toContain(`${again.slice(0, 10)} on trunk, merged as ${blobId(lines({ 1: "trunk one", 2: "trunk two", 5: "mine five" })).slice(0, 10)}`);
    });
  });

  it("reads the approval the change carries (approvedAt) when its lane passed no lineage context", async () => {
    await withWriter(FILES, undefined, async (w) => {
      merging(w);
      const { p } = await movedUnder(w, F, { approvedAt: Date.now() - 60_000 });
      const r = await w.land(p);
      expect(r.landing).toBeUndefined();
      expect(r.returned[0]!.reason).toMatch(/^A person approved this change against an older trunk; trunk has since changed src\/app\/main\.ts /);
    });
  });

  it("holds a change whose decision found a danger pattern a person must see (here governance: AGENTS.md)", async () => {
    await withWriter(FILES, undefined, async (w) => {
      merging(w);
      const evidence = { checks: [{ name: DANGER_CHECK, ok: false, ms: 0, detail: "needs a human: governance:agent-instructions in AGENTS.md" }] };
      const { p } = await movedUnder(w, "AGENTS.md", { evidence });
      const r = await w.land(p);
      expect(r.landing).toBeUndefined();
      expect(r.returned[0]!.reason).toMatch(/^This change has a danger pattern a person must see and was decided against an older trunk; trunk has since changed AGENTS\.md /);
    });
  });

  it("holds a change to a protected path a person approved after the glob was protected", async () => {
    await withWriter(FILES, undefined, async (w) => {
      merging(w);
      const { p } = await movedUnder(w);
      await w.trunk.protect({ record: { version: 1, globs: [{ glob: "src/app/**", at: 5_000 }] }, proposalIds: [] });
      // Approved after the glob was protected, it passes the protection check, and its merge is held.
      const r = await w.trunk.land([p], approval(p.id, 6_000));
      expect(r.landing).toBeUndefined();
      expect(isMergeHold(r.returned[0]?.reason)).toBe(true);
    });
  });

  it("still merges an agent's ordinary change, and lands a person-approved change whose files did not move with its own blobs", async () => {
    await withWriter(FILES, undefined, async (w) => {
      merging(w);
      const { p, merged } = await movedUnder(w);
      expect(landed(await w.land(p)).merged).toEqual([{ proposalId: p.id, path: F, blob: merged }]);
      const q = await w.proposal({ [F]: lines({ 1: "trunk one", 3: "approved three", 5: "mine five" }) });
      const l = landed(await w.trunk.land([q], approval(q.id, Date.now() - 60_000)));
      expect(l.merged).toBeUndefined();
      expect(blobAt(w, F)).toBe(q.writeSet[0]!.blob);
    });
  });

  it("with the conflict resolver on, a locked change whose merge conflicts goes back without its conflicts", async () => {
    await withWriter(FILES, undefined, async (w) => {
      merging(w, { FT_RESOLVER: "on" });
      const mine = await w.proposal({ [F]: lines({ 1: "mine one" }) });
      const theirs = await w.proposal({ [F]: lines({ 1: "other one" }) });
      landed(await w.land(await w.proposal({ [F]: lines({ 1: "trunk one" }) })));
      const locked = await w.trunk.land([mine], approval(mine.id, Date.now() - 60_000));
      expect(locked.returned[0]!.reason).toMatch(/^stale: src\/app\/main\.ts .*; text merge of src\/app\/main\.ts: 1 conflicting hunk, at line 1 of its base$/);
      expect(locked.returned[0]!.conflicts).toBeUndefined();
      const open = await w.land(theirs);
      expect(open.returned[0]!.conflicts).toHaveLength(1);
    });
  });

  it("fails closed: when the locks cannot be read, the cycle merges nothing and a stale change goes back as without text merge", async () => {
    await withWriter(FILES, undefined, async (w) => {
      merging(w);
      const { p, base, onTrunk } = await movedUnder(w);
      // The protected paths read fine for the cycle's protection check (which holds the cycle when they cannot be read,
      // trunk/protect.ts) and fail for the merge locks' read after it.
      const t = w.trunk as unknown as { sql: SqlStorage };
      const real = t.sql;
      let reads = 0;
      t.sql = {
        exec: (q: string, ...b: unknown[]) => {
          if (/FROM ft_protected/.test(q) && ++reads > 1) throw new Error("no such table: ft_protected");
          return real.exec(q, ...b);
        },
      } as unknown as SqlStorage;
      try {
        expect(await w.land(p)).toEqual({ returned: [{ proposalId: p.id, reason: `stale: ${F} (expected ${base}, trunk has ${onTrunk})` }] });
        expect(reads).toBe(2);
      } finally {
        t.sql = real;
      }
    });
  });
});
