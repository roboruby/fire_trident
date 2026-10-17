import { describe, expect, it } from "vitest";
import type { Certification, TrunkHealth } from "@fire_trident/core";
import { api, eventually, externalLanding, newColony } from "../helpers.ts";

/**
 * Trunk health (certify/health.ts) inside workerd: real certification runs after landings, and GET /metrics serves
 * what they cost as `trunkHealth`.
 */

const MATH_BUG = "export function sub(a: number, b: number): number {\n  return a + b;\n}\n";
const MATH_FIXED = "export function sub(a: number, b: number): number {\n  return a - b;\n}\n";
const MATH_TEST = 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { sub } from "../src/math.ts";\ntest("subtracts", () => {\n  assert.equal(sub(5, 3), 2);\n});\n';

async function settled(colonyId: string, sha: string): Promise<Certification> {
  const state = await eventually(
    async () => (await api<{ results: Certification[] }>("GET", `/colonies/${colonyId}/certifications`)).body,
    (s) => s.results.some((r) => r.trunkSha === sha && r.status !== "running"),
    30_000,
  );
  const found = state.results.find((r) => r.trunkSha === sha);
  if (!found || found.status === "running") throw new Error(`no certification of ${sha} yet`);
  return found;
}

async function health(colonyId: string): Promise<TrunkHealth | undefined> {
  const res = await api<{ trunkHealth?: TrunkHealth }>("GET", `/colonies/${colonyId}/metrics`);
  expect(res.status).toBe(200);
  return res.body.trunkHealth;
}

describe("trunk health on GET /metrics", () => {
  it("counts the red episode, the landing built on red and the fix, from real certification runs", async () => {
    const c = await newColony();
    expect(await health(c.id)).toMatchObject({ status: "none", text: "trunk health not measured yet: no certification has judged trunk" });

    const sha1 = await externalLanding(c.id, { "src/math.ts": MATH_BUG, "test/math.test.ts": MATH_TEST });
    expect(await settled(c.id, sha1)).toMatchObject({ status: "red" });
    const red = await health(c.id);
    expect(red).toMatchObject({ status: "measured", episodes: { count: 1, open: 1 }, builtOnRed: { landings: 0, afterRedKnown: 0, repairs: 0 }, repair: { intents: 1 } });
    expect(red?.text).toMatch(/^red 1 time in 1 landing, red now for \d+ s, 0 landings built on red$/);

    // An unrelated landing on the red trunk, then the fix.
    const sha2 = await externalLanding(c.id, { "README.md": "# demo, changed\n" });
    expect(await settled(c.id, sha2)).toMatchObject({ status: "red" });
    const sha3 = await externalLanding(c.id, { "src/math.ts": MATH_FIXED });
    expect(await settled(c.id, sha3)).toMatchObject({ status: "green" });
    const h = await health(c.id);
    if (h?.status !== "measured") throw new Error(`not measured: ${JSON.stringify(h)}`);
    expect(h.episodes).toEqual({ count: 1, open: 0, per100Landings: 33.33 });
    expect(h.window.landings).toBe(3);
    expect(h.red.since).toBeUndefined();
    expect(h.red.toGreen.episodes).toBe(1);
    // The README landing was built on the red trunk after the red result; the fix made the green commit.
    expect(h.builtOnRed).toEqual({ landings: 1, afterRedKnown: 1, repairs: 1 });
    expect(h.text).toMatch(/^red 1 time in 3 landings, \d+ s to green at p50, 1 landing built on red$/);
    expect(h.certifiedWithin.map((w) => [w.minutes, w.certified, w.landings])).toEqual([
      [5, 3, 3],
      [15, 3, 3],
      [60, 3, 3],
    ]);
  });

  it("says a colony with no test this platform can run has no numbers", async () => {
    const c = await newColony();
    const sha = await externalLanding(c.id, { "src/math.ts": MATH_FIXED });
    expect(await settled(c.id, sha)).toMatchObject({ status: "skipped" });
    expect(await health(c.id)).toEqual({
      status: "no-tests",
      reason: "no test files (*.test.ts or *.test.js)",
      text: "trunk health not measured: certification found no test this platform can run",
    });
  });
});
