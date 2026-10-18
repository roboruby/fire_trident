import { describe, expect, it } from "vitest";
import { tokensEqual } from "../../src/api/app.ts";
import { CreateColonyBody, DecisionBody, IntentBody, ProposalBody, RuleBody, SwarmBody, WhyQuery, isHttpsUrl } from "../../src/api/schemas.ts";

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

  it("accepts a contest of 2 to 4 agents on an intent (1 is one holder)", () => {
    const base = { title: "t", footprint: ["a.ts"] };
    for (const contest of [1, 2, 3, 4]) expect(IntentBody.parse({ ...base, contest }).contest).toBe(contest);
    expect(IntentBody.parse(base)).not.toHaveProperty("contest");
    for (const contest of [0, 5, 2.5, "3"]) expect(IntentBody.safeParse({ ...base, contest }).success).toBe(false);
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

  it("takes an agent's preview link only as an https URL, and says so plainly otherwise", () => {
    const sha = "c".repeat(40);
    const base = { intentId: "i", agentId: "a", workspace: { namespace: "n", name: "w", remote: "r" }, baseSha: sha, headSha: sha, writeSet: [{ path: "a", blob: sha }] };
    const preview = (previewUrl: string) => ProposalBody.safeParse({ ...base, evidence: { previewUrl } });
    expect(preview("https://preview.example.com/pr/1?x=1").data?.evidence?.previewUrl).toBe("https://preview.example.com/pr/1?x=1");
    for (const bad of ["javascript:alert(1)", "data:text/html,<script>alert(1)</script>", "http://preview.example.com/", "JavaScript:alert(1)", "https://", " https://a.example/", "https://a.exa\nmple/", "vbscript:x"]) {
      const r = preview(bad);
      expect(r.success).toBe(false);
      expect(r.error?.issues).toEqual([
        expect.objectContaining({
          path: ["evidence", "previewUrl"],
          message: "the preview link must be an https:// URL (javascript:, data:, http: and other schemes are refused); send the https address of the preview, or leave previewUrl out",
        }),
      ]);
    }
    expect(ProposalBody.safeParse({ ...base, evidence: { notVerified: "n" } }).success).toBe(true);
    expect(isHttpsUrl("HTTPS://A.EXAMPLE/")).toBe(true);
  });
});

describe("tokensEqual", () => {
  it("compares secrets by digest", async () => {
    expect(await tokensEqual("abc", "abc")).toBe(true);
    expect(await tokensEqual("abc", "abd")).toBe(false);
    expect(await tokensEqual("", "abc")).toBe(false);
  });
});
