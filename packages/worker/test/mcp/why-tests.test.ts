import { describe, expect, it } from "vitest";
import type { LandingTests } from "@fire_trident/core";
import { WHY_TEST_LANDINGS, withTests } from "../../src/mcp/whytests.ts";

/** Both MCP `why` tools give the newest landings of an answer their test row, waiting a bounded time for it. */

const row = (id: string): LandingTests => ({
  colonyId: "c",
  landingId: id,
  trunkSha: "b".repeat(40),
  baseSha: "a".repeat(40),
  status: "certified",
  proof: { rungs: [{ rung: "deterministic", count: 1 }], text: "deterministic" },
  text: "60/60 at base, 60/60 certified, 0 lost · proof: deterministic",
});
const entries = (n: number) => Array.from({ length: n }, (_, i) => ({ landing: { id: `lnd_${i}` }, otherProposals: 0 }));

describe("why over MCP: test rows", () => {
  it("adds the row to the first entries only, keeping each entry as it was", async () => {
    const asked: string[] = [];
    const out = await withTests(entries(WHY_TEST_LANDINGS + 2), async (id) => (asked.push(id), row(id)));
    expect(asked).toEqual(Array.from({ length: WHY_TEST_LANDINGS }, (_, i) => `lnd_${i}`));
    expect(out[0]).toMatchObject({ landing: { id: "lnd_0" }, otherProposals: 0, tests: { landingId: "lnd_0", text: "60/60 at base, 60/60 certified, 0 lost · proof: deterministic" } });
    expect(out[WHY_TEST_LANDINGS]).not.toHaveProperty("tests");
  });

  it("says when a row was not ready in time or could not be read, and adds none for an unknown landing", async () => {
    const out = await withTests(
      entries(3),
      (id) => (id === "lnd_0" ? new Promise(() => undefined) : id === "lnd_1" ? Promise.reject(new Error("colony restarting")) : Promise.resolve(null)),
      20,
    );
    expect(out[0]!.tests).toEqual({ unavailable: "the test row was not ready within 0.02 s; GET /api/colonies/<colony>/landings/lnd_0/tests has it once the colony has read it" });
    expect(out[1]!.tests).toEqual({ unavailable: "the test row could not be read: colony restarting" });
    expect(out[2]).not.toHaveProperty("tests");
  });

  it("leaves the answer alone where the colony cannot read rows", async () => {
    expect(await withTests(entries(2), undefined)).toEqual(entries(2));
  });
});
