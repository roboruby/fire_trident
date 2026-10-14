import { describe, expect, it } from "vitest";
import type { Path } from "@fire_trident/core";
import type { LandContext } from "../../src/trunk/TrunkDO.ts";
import { landed, withWriter } from "./writer.ts";

/**
 * Protected paths in the real trunk writer (writer.ts: TrunkDO over a Durable Object's storage, only the network steps
 * stood in for): TrunkDO.protect records the colony's protected globs, every cycle checks them before it builds, and the
 * fence's answer names a change a cycle had already landed.
 */

const FILES: Record<Path, string> = {
  "src/auth/x.ts": "export const x = 1;\n",
  "src/lib/y.ts": "export const y = 1;\n",
  "README.md": "# protect\n",
};
const RECORD = { version: 1, globs: [{ glob: "src/auth/**", at: 5_000 }] };
const STOP = (path: string) => new RegExp(`^newly protected: ${path.replace(/[.*/]/g, (c) => `\\${c}`)} \\(protected by src/auth/\\*\\*\\)`);

/** The lineage context a lane passes: a person's approval of `id` at `at`, and the record the lane read (when given). */
function context(over: { approved?: [string, number]; protect?: unknown } = {}): LandContext {
  const decisions = over.approved ? { [over.approved[0]]: [{ kind: "triage", layer: "human", p: 1, action: "approve", at: over.approved[1] }] } : {};
  return { decisions, ...(over.protect ? { protect: over.protect } : {}) } as unknown as LandContext;
}

describe("protected paths in the trunk writer", () => {
  it("stops a covered change at the cycle's check unless a person approved it after the glob was protected", async () => {
    await withWriter(FILES, undefined, async (w) => {
      expect(await w.trunk.protect({ record: RECORD, proposalIds: [] })).toEqual({ landed: [], landings: [], undetermined: [] });
      const head = w.head();
      const p = await w.proposal({ "src/auth/x.ts": "export const x = 2;\n" });
      expect(await w.trunk.land([p], context({ approved: [p.id, 4_999] }))).toEqual({ returned: [{ proposalId: p.id, reason: expect.stringMatching(STOP("src/auth/x.ts")) }] });
      expect(w.head()).toBe(head);
      // Deleting a protected file counts as writing it.
      const del = await w.proposal({ "src/auth/x.ts": null });
      expect((await w.trunk.land([del])).returned).toEqual([{ proposalId: del.id, reason: expect.stringMatching(STOP("src/auth/x.ts")) }]);
      // A person's approval at or after the protection lands it; a path no glob covers needs none.
      const q = await w.proposal({ "src/auth/x.ts": "export const x = 3;\n" });
      landed(await w.trunk.land([q], context({ approved: [q.id, 5_000] })));
      landed(await w.land(await w.proposal({ "src/lib/y.ts": "export const y = 2;\n" })));
    });
  });

  it("keeps a newer record a lane passes in its lineage context, and ignores an older one", async () => {
    await withWriter(FILES, undefined, async (w) => {
      // The colony removed the glob (version 2); a lane that still read version 1 changes nothing.
      await w.trunk.protect({ record: { version: 2, globs: [] }, proposalIds: [] });
      landed(await w.trunk.land([await w.proposal({ "src/auth/x.ts": "export const x = 2;\n" })], context({ protect: RECORD })));
      // The colony's call never reached the writer, but a lane read version 3: the writer keeps it and stops by it.
      const newer = { version: 3, globs: [{ glob: "src/auth/**", at: 5_000 }] };
      const q = await w.proposal({ "src/auth/x.ts": "export const x = 3;\n" });
      expect((await w.trunk.land([q], context({ protect: newer }))).returned).toEqual([{ proposalId: q.id, reason: expect.stringMatching(STOP("src/auth/x.ts")) }]);
      const s = await w.proposal({ "src/auth/x.ts": "export const x = 4;\n" });
      expect((await w.trunk.land([s])).returned).toEqual([{ proposalId: s.id, reason: expect.stringMatching(STOP("src/auth/x.ts")) }]);
    });
  });

  it("waits for a cycle that read the old record and names its landing; a change queued behind that cycle is stopped", async () => {
    await withWriter(FILES, undefined, async (w) => {
      // Hold the push of the first cycle: it has passed its checks with nothing protected.
      let open!: () => void;
      const opened = new Promise<void>((resolve) => (open = resolve));
      let reached!: () => void;
      const atPush = new Promise<void>((resolve) => (reached = resolve));
      (w.trunk as unknown as { pushChain(chain: unknown): Promise<{ ok: true }> }).pushChain = async () => {
        reached();
        await opened;
        return { ok: true };
      };
      const p = await w.proposal({ "src/auth/x.ts": "export const x = 2;\n" });
      const first = w.trunk.land([p]);
      await atPush;
      const q = await w.proposal({ "src/auth/new.ts": "export const fresh = 1;\n" });
      const second = w.trunk.land([q]);
      // The colony protects src/auth/** and asks about both: the answer waits for the cycle in flight.
      let answered = false;
      const fencing = w.trunk.protect({ record: RECORD, proposalIds: [p.id, q.id] }).finally(() => void (answered = true));
      await new Promise((r) => setTimeout(r, 50));
      expect(answered).toBe(false);
      open();
      const answer = await fencing;
      const l = landed(await first);
      expect(answer).toEqual({ landed: [{ proposalId: p.id, landingId: l.id, trunkSha: l.trunkSha }], landings: [l], undetermined: [] });
      // q never lands: the next cycle read the record before it built.
      expect(await second).toEqual({ returned: [{ proposalId: q.id, reason: expect.stringMatching(STOP("src/auth/new.ts")) }] });
      expect(w.has("src/auth/new.ts")).toBe(false);
    });
  });
});
