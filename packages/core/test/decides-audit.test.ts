import { describe, expect, it } from "vitest";
import { decidesAuditOf, decidesOf } from "../src/decides.ts";

/** The audit sample's line in how a colony decides (GET /api/colonies/:id/decides `audit`), read defensively. */
describe("the decides report's audit line", () => {
  const report = (audit?: unknown) => ({ preset: "central-development", split: { days: 30, counts: {} }, ...(audit === undefined ? {} : { audit }) });

  it("reads the line and its numbers", () => {
    const a = decidesAuditOf({ line: "audited 12 of 400 landings without a person: 0 should not have landed (0–24%)", rate: 0.03, landed: 400, audited: 12, wrong: 0, lo: 0, hi: 0.242, pending: 1, canaries: "canaries off" });
    expect(a).toEqual({ line: "audited 12 of 400 landings without a person: 0 should not have landed (0–24%)", rate: 0.03, landed: 400, audited: 12, wrong: 0, lo: 0, hi: 0.242, pending: 1, canaries: "canaries off" });
    expect(decidesOf(report({ line: "audit sample off", canaries: "canaries off" }))?.audit).toMatchObject({ line: "audit sample off", hi: 1, landed: 0 });
  });

  it("leaves it out for an older server or an answer that is not one", () => {
    expect(decidesOf(report())).not.toHaveProperty("audit");
    expect(decidesOf(report({ line: "" }))).not.toHaveProperty("audit");
    expect(decidesAuditOf("audited")).toBeNull();
    expect(decidesAuditOf({ line: "x\u0007y", rate: 7, hi: -1, landed: -3 })).toMatchObject({ line: "x y", rate: 1, hi: 0, landed: 0 });
  });
});
