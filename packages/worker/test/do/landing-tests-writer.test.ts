import { describe, expect, it } from "vitest";
import type { Decision } from "@fire_trident/core";
import { landed, withWriter } from "./writer.ts";

/**
 * A landing's test row through the real trunk writer: where commits sit on trunk's chain (TrunkDO.commitOrder) and who
 * changed each test file up to a commit (TrunkDO.testLineage), from its landing log and the notes it wrote.
 */

const TEST = 'import { test } from "node:test";\ntest("a", () => {});\n';

describe("TrunkDO: the trunk writer's half of a landing's test row", () => {
  it("places commits on the chain and reads each test file's changes from the notes it wrote", async () => {
    await withWriter({ "src/a.ts": "export const a = 1;\n", "test/inherited.test.ts": TEST, "test/edited.test.ts": TEST }, undefined, async (w) => {
      const initial = w.head();
      const first = landed(await w.land(await w.proposal({ "test/new.test.ts": TEST, "src/a.ts": "export const a = 2;\n" })));
      const p = await w.proposal({ "test/edited.test.ts": `${TEST}// edited\n` });
      const approve = [{ kind: "triage", layer: "human", p: 1, action: "approve", by: "Lee" }] as unknown as Array<Pick<Decision, "kind" | "layer" | "p" | "action">>;
      const second = landed(await w.trunk.land([p], { decisions: { [p.id]: approve } }));

      expect(await w.trunk.commitOrder([initial, first.trunkSha, second.trunkSha, "f".repeat(40)])).toEqual({ [initial]: 0, [first.trunkSha]: 1, [second.trunkSha]: 2 });

      const paths = ["test/inherited.test.ts", "test/edited.test.ts", "test/new.test.ts"];
      const all = await w.trunk.testLineage({ paths, upTo: second.trunkSha });
      expect(all["test/inherited.test.ts"]).toEqual({ changes: [], more: false });
      expect(all["test/new.test.ts"]).toEqual({ changes: [{ landingId: first.id, by: "agent", added: true }], more: false });
      expect(all["test/edited.test.ts"]).toEqual({ changes: [{ landingId: second.id, by: "person", name: "Lee" }], more: false });
      // Up to the first landing, the edit had not happened yet.
      expect((await w.trunk.testLineage({ paths, upTo: first.trunkSha }))["test/edited.test.ts"]).toEqual({ changes: [], more: false });
    });
  });
});
