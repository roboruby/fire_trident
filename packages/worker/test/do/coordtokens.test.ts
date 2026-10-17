import { describe, expect, it } from "vitest";
import type { CoordTokensReport } from "../../src/colony/coordtokens.ts";
import type { Assignment } from "./helpers.ts";
import { addAgent, addIntent, api, colony, externalLanding, newColony, proposal, proposeEdit, take, tick } from "./helpers.ts";

/**
 * Coordination tokens per take (colony/coordtokens.ts) in a real colony: every take the colony hands is counted with the
 * characters of what it carries beyond the intent, a heads-up with something to say adds its own, and GET /metrics
 * serves the estimate.
 */

type Parts = Assignment & { context?: unknown; lastReturn?: unknown; review?: unknown; guide?: unknown };

const chars = (x: unknown): number => (x === undefined ? 0 : JSON.stringify(x).length);

async function metrics(colonyId: string): Promise<{ metrics: Record<string, number>; coordTokens?: CoordTokensReport }> {
  const res = await api<{ metrics: Record<string, number>; coordTokens?: CoordTokensReport }>("GET", `/colonies/${colonyId}/metrics`);
  expect(res.status).toBe(200);
  return res.body;
}

/** Past the colony's shared field reading, which may still hold the claims cleared by the return. */
const pastSharedReading = (): Promise<void> => new Promise((r) => setTimeout(r, 300));

describe("coordination tokens: what each take hands, counted by the colony", () => {
  it("counts each take and the characters of its why-context and last return, and serves the estimate", async () => {
    const c = await newColony();
    expect((await metrics(c.id)).coordTokens).toBeUndefined();
    await addIntent(c.id, ["src/lib/util.ts"]);
    const a = await addAgent(c.id, "a");
    const first = (await take(c.id, a.id)) as Parts;
    let m = await metrics(c.id);
    expect(m.metrics["coord.takes"]).toBe(1);
    expect(m.coordTokens?.takes).toBe(1);
    expect(m.coordTokens?.estimate).toContain("characters / 4");
    // Trunk moves under the agent: its change goes back, and the next taker is handed why.
    await externalLanding(c.id, { "src/lib/util.ts": "export const changed = true;\n" });
    const p = await proposeEdit(c.id, first, a.id);
    await tick(c.id, "src");
    expect((await proposal(c.id, p.id)).status).toBe("returned");
    const b = await addAgent(c.id, "b");
    await pastSharedReading();
    const again = (await take(c.id, b.id)) as Parts;
    expect(again.lastReturn).toBeDefined();
    m = await metrics(c.id);
    expect(m.metrics["coord.takes"]).toBe(2);
    expect(m.metrics["coord.chars.lastReturn"]).toBe(chars(again.lastReturn));
    expect(m.metrics["coord.chars.context"] ?? 0).toBe(chars(first.context) + chars(again.context));
    expect(m.metrics["coord.chars.review"] ?? 0).toBe(chars(first.review) + chars(again.review));
    // Every take falls in a bucket of active agents; the buckets add up to the takes.
    expect(m.coordTokens?.byAgents.reduce((n, x) => n + x.takes, 0)).toBe(2);
    // A repeated take hands the same again, and counts again.
    await take(c.id, b.id);
    expect((await metrics(c.id)).metrics["coord.takes"]).toBe(3);
  });

  it("counts a heads-up only when it has something to say", async () => {
    const c = await newColony();
    await addIntent(c.id, ["src/lib/util.ts"]);
    const a = await addAgent(c.id, "a");
    const t = await take(c.id, a.id);
    const quiet = await colony(c.id).headsUp(a.id, { intentId: t.intent.id, baseSha: t.lease.baseSha });
    expect(quiet.report).toBeNull();
    expect((await metrics(c.id)).metrics["coord.headsUps"] ?? 0).toBe(0);
    await externalLanding(c.id, { "src/lib/util.ts": "export const moved = true;\n" });
    const told = await colony(c.id).headsUp(a.id, { intentId: t.intent.id, baseSha: t.lease.baseSha });
    expect(told.report?.moved.length).toBe(1);
    const m = await metrics(c.id);
    expect(m.metrics["coord.headsUps"]).toBe(1);
    expect(m.metrics["coord.chars.headsUp"]).toBe(JSON.stringify(told.report).length);
  });
});
