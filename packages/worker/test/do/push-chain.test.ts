import { describe, expect, it } from "vitest";
import type { Path } from "@fire_trident/core";
import { landed, withPublisher } from "./publisher.ts";

/**
 * The trunk writer's own push (pushChain), publishing off, over a fake trunk repository (publisher.ts with chain: "real"):
 * a push that reached main must keep its landing whatever its reply says.
 */

const FILES: Record<Path, string> = { "src/a.ts": "export const a = 1;\n", "src/b.ts": "export const b = 1;\n" };

describe("the trunk writer's push of a cycle's chain", () => {
  it("keeps a landing whose direct push reached main but answered without main's status", async () => {
    await withPublisher(FILES, { chain: "real" }, async (w) => {
      // The direct push lands and answers like a refusal; the regular push that follows finds main already at the tip.
      w.remote.plan = ["unclear"];
      const before = w.remote.main;
      const result = await w.land(await w.proposal({ "src/a.ts": "export const a = 2;\n" }));
      const landing = landed(result);
      expect(landing.trunkSha).toBe(w.remote.main);
      expect(w.remote.moves).toEqual([{ from: before, to: landing.trunkSha, objects: expect.any(Number) }]);
      expect(w.landingCommits()).toEqual([landing.trunkSha]);
      expect(w.journal("pushing")).toEqual([]);
      expect(result.returned).toEqual([]);
    });
  });

  it("keeps a landing whose direct push reached main and lost its reply", async () => {
    await withPublisher(FILES, { chain: "real" }, async (w) => {
      w.remote.plan = ["lost"];
      const landing = landed(await w.land(await w.proposal({ "src/b.ts": "export const b = 2;\n" })));
      expect(landing.trunkSha).toBe(w.remote.main);
      expect(w.landingCommits()).toEqual([landing.trunkSha]);
    });
  });

  it("lands on the regular push when the direct push is refused before reaching main", async () => {
    await withPublisher(FILES, { chain: "real" }, async (w) => {
      w.remote.plan = ["refuse", "ok"];
      const landing = landed(await w.land(await w.proposal({ "src/a.ts": "export const a = 3;\n" })));
      expect(landing.trunkSha).toBe(w.remote.main);
      expect(w.remote.moves).toHaveLength(1);
    });
  });
});
