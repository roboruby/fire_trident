import { describe, expect, it } from "vitest";
import { tokensEqual } from "../../src/api/app.ts";
import { CreateColonyBody, DecisionBody, IntentBody, ProposalBody, RuleBody, SwarmBody, WhyQuery } from "../../src/api/schemas.ts";

describe("request bodies", () => {
  it("accepts the CLI's colony bodies (import with pool, new without source)", () => {
    expect(CreateColonyBody.parse({ name: "demo", source: { url: "https://git.example.com/org/repo.git" }, pool: 200, regionDepth: 3 })).toEqual({
      name: "demo",
      source: { url: "https://git.example.com/org/repo.git" },
      pool: 200,
      regionDepth: 3,
    });
    expect(CreateColonyBody.parse({ name: "fresh", poolTarget: 8 })).toEqual({ name: "fresh", poolTarget: 8 });
    expect(CreateColonyBody.safeParse({ name: "x", regionDepth: 0 }).success).toBe(false);
  });

  it("strips colonyId from intent and rule bodies and fills defaults", () => {
    expect(IntentBody.parse({ colonyId: "c", title: "t", footprint: ["a.ts"] })).toEqual({ title: "t", why: "", footprint: ["a.ts"], priority: 1, source: "human" });
    expect(RuleBody.parse({ colonyId: "c", kind: "forbid-pattern", spec: { pattern: "x", replacement: "y" }, description: "d", approvedBy: "m" })).toEqual({
      kind: "forbid-pattern",
      spec: { pattern: "x", replacement: "y" },
      description: "d",
      approvedBy: "m",
    });
  });

  it("needs a swarm size under either name", () => {
    expect(SwarmBody.parse({ agents: 5 })).toEqual({ agents: 5 });
    expect(SwarmBody.parse({ count: 2, kind: "synthetic" })).toEqual({ count: 2, kind: "synthetic" });
    expect(SwarmBody.safeParse({}).success).toBe(false);
    expect(SwarmBody.safeParse({ count: 1001 }).success).toBe(false);
  });

  it("validates proposals and decisions", () => {
    const sha = "c".repeat(40);
    const base = { intentId: "i", agentId: "a", workspace: { namespace: "n", name: "w", remote: "r" }, baseSha: sha, headSha: sha, writeSet: [{ path: "a", blob: sha }] };
    expect(ProposalBody.parse(base)).toMatchObject({ readSet: [], declared: { footprint: [], summary: "" } });
    expect(ProposalBody.safeParse({ ...base, baseSha: "main" }).success).toBe(false);
    expect(ProposalBody.safeParse({ ...base, writeSet: [{ path: "a", blob: null }] }).success).toBe(true);
    expect(DecisionBody.parse({ decision: "return" })).toEqual({ decision: "return", reason: "" });
    expect(WhyQuery.parse({ path: "src/a.ts", line: "12" })).toEqual({ path: "src/a.ts", line: 12 });
    expect(WhyQuery.safeParse({ path: "src/a.ts", line: "0" }).success).toBe(false);
  });
});

describe("tokensEqual", () => {
  it("compares secrets by digest", async () => {
    expect(await tokensEqual("abc", "abc")).toBe(true);
    expect(await tokensEqual("abc", "abd")).toBe(false);
    expect(await tokensEqual("", "abc")).toBe(false);
  });
});
