import { describe, expect, it } from "vitest";
import type { Antibody, Rule } from "@fire_trident/core";
import { PREVIEW_ANTIBODIES, PREVIEW_RULES, cleanPreview, reviewPreview } from "../../src/agents/preview.ts";
import type { DetectorState } from "../../src/decide/policy.ts";
import type { StoredAntibody } from "../../src/decide/store.ts";

/** A stored antibody as DecideStore.antibodies lists it. */
function stored(id: string, paths: string[], state: DetectorState = "active", extra: Record<string, unknown> = {}): StoredAntibody {
  const antibody = { id, colonyId: "col", origin: "human-reject", matcher: { paths }, question: `Does this change repeat what ${id} caught?`, threshold: 0.7, createdAt: 0, hits: 0, falsePositives: 0, ...extra };
  return { antibody: antibody as Antibody, state, path: null, landingId: null, recurrences: 0, lastRecurrence: null };
}

function rule(id: string, spec: Record<string, unknown>, description: string, extra: Partial<Rule> = {}): Rule {
  return { id, colonyId: "col", kind: "forbid-pattern", spec: { pattern: "x", ...spec }, description, approvedBy: "t", createdAt: 0, ...extra };
}

describe("reviewPreview", () => {
  const auth = stored("ab_auth", ["src/auth/**"]);

  it("shows an antibody on src/auth/** to an intent that touches src/auth/x.ts, and not to one in docs/", () => {
    expect(reviewPreview({ footprint: ["src/auth/x.ts"] }, [auth], [])).toEqual({
      antibodies: [{ id: "ab_auth", question: "Does this change repeat what ab_auth caught?" }],
      rules: [],
    });
    expect(reviewPreview({ footprint: ["docs/guide.md"] }, [auth], [])).toBeUndefined();
    expect(reviewPreview({ footprint: ["docs/guide.md", "src/auth/session.ts"] }, [auth], [])?.antibodies).toHaveLength(1);
  });

  it("matches on paths alone: what a change will add cannot be tested before the change exists", () => {
    const docs = stored("ab_docs", ["docs/**"]);
    expect(reviewPreview({ footprint: ["docs/guide.md"] }, [docs, auth], [])?.antibodies.map((a) => a.id)).toEqual(["ab_docs"]);
  });

  it("never shows a security antibody's question: its agent is told the class, never how to slip past it", () => {
    // An antibody minted from a change that carried capability tokens matches on them too (decide/antibodies.ts securityAntibody).
    const logging = stored("ab_log", ["src/auth/**"], "active", { matcher: { paths: ["src/auth/**"], pattern: "console\\.log" }, question: "Does this change log the session token?" });
    expect(reviewPreview({ footprint: ["src/auth/x.ts"] }, [logging], [])).toBeUndefined();
    const got = reviewPreview({ footprint: ["src/auth/x.ts"] }, [logging, auth], []);
    expect(got?.antibodies.map((a) => a.id)).toEqual(["ab_auth"]);
    expect(JSON.stringify(got)).not.toContain("session token");
    // An empty pattern is no pattern: that antibody asks as usual.
    const plain = stored("ab_plain", ["src/auth/**"], "active", { matcher: { paths: ["src/auth/**"], pattern: "" } });
    expect(reviewPreview({ footprint: ["src/auth/x.ts"] }, [plain], [])?.antibodies.map((a) => a.id)).toEqual(["ab_plain"]);
  });

  it("never shows antibodies that are off or that tolerate instead of asking", () => {
    const off = stored("ab_off", ["src/auth/**"], "off");
    const tolerating = stored("ab_allow", ["src/auth/**"], "active", { allows: ["auth"] });
    expect(reviewPreview({ footprint: ["src/auth/x.ts"] }, [off, tolerating], [])).toBeUndefined();
    expect(reviewPreview({ footprint: ["src/auth/x.ts"] }, [off, auth, tolerating], [])?.antibodies.map((a) => a.id)).toEqual(["ab_auth"]);
  });

  it("puts active antibodies before advisory ones, keeps the store's newest-first order, asks each question once, and caps the list", () => {
    const list = [
      stored("ab_adv1", ["src/**"], "advisory"),
      stored("ab_act1", ["src/**"]),
      stored("ab_dup", ["src/**"], "active", { question: "  does this change repeat what ab_act1 caught?  " }),
      stored("ab_act2", ["src/auth/**"]),
      stored("ab_adv2", ["src/**"], "advisory"),
      stored("ab_act3", ["src/**"]),
      stored("ab_act4", ["src/**"]),
      stored("ab_act5", ["src/**"]),
    ];
    const got = reviewPreview({ footprint: ["src/auth/x.ts"] }, list, []);
    expect(got?.antibodies.map((a) => a.id)).toEqual(["ab_act1", "ab_act2", "ab_act3", "ab_act4", "ab_act5"]);
    expect(got?.antibodies).toHaveLength(PREVIEW_ANTIBODIES);
    const fewer = reviewPreview({ footprint: ["src/auth/x.ts"] }, list.slice(0, 3), []);
    expect(fewer?.antibodies.map((a) => a.id)).toEqual(["ab_act1", "ab_adv1"]);
  });

  it("lists the colony's other rules whose scope covers the footprint, one line each", () => {
    const rules: Rule[] = [
      rule("rul_auth", { include: ["src/auth/**"], hint: "Use the logger." }, "No console.log in auth code"),
      rule("rul_docs", { include: ["docs/**"] }, "Docs use sentence case."),
      rule("rul_own", {}, "The intent's own rule"),
      rule("rul_gone", {}, "Retracted", { retractedAt: 5 }),
      rule("rul_all", { hint: "  Prefer\n named   exports. " }, "  No default exports!  "),
      { ...rule("rul_imports", {}, "Relative imports name the .ts file"), kind: "forbid-import", spec: { from: ["src/**"], module: "^\\./" } },
    ];
    const got = reviewPreview({ footprint: ["src/auth/x.ts"], ruleId: "rul_own" }, [], rules);
    expect(got).toEqual({
      antibodies: [],
      rules: ["No console.log in auth code. Use the logger.", "No default exports! Prefer named exports.", "Relative imports name the .ts file"],
    });
    expect(reviewPreview({ footprint: ["README.md"], ruleId: "rul_own" }, [], rules)?.rules).toEqual(["No default exports! Prefer named exports."]);
    const many = Array.from({ length: PREVIEW_RULES + 3 }, (_, i) => rule(`rul_${i}`, {}, `Rule ${i}`));
    expect(reviewPreview({ footprint: ["src/a.ts"] }, [], many)?.rules).toHaveLength(PREVIEW_RULES);
  });

  it("clips long questions and skips malformed stored antibodies instead of failing the take", () => {
    const long = stored("ab_long", ["src/**"], "active", { question: `Does this change ${"really ".repeat(80)}leak?` });
    const noMatcher = { ...stored("ab_bad", []), antibody: { id: "ab_bad", question: "Is this broken?" } as unknown as Antibody };
    const noQuestion = stored("ab_mute", ["src/**"], "active", { question: 42 });
    const got = reviewPreview({ footprint: ["src/a.ts"] }, [noMatcher, noQuestion, long], []);
    expect(got?.antibodies.map((a) => a.id)).toEqual(["ab_long"]);
    expect(got!.antibodies[0]!.question.length).toBeLessThanOrEqual(300);
    expect(got!.antibodies[0]!.question.endsWith("…")).toBe(true);
    expect(reviewPreview({ footprint: [] }, [auth], [])).toBeUndefined();
  });
});

describe("cleanPreview", () => {
  it("keeps well-formed entries, capped, and drops the rest", () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ id: `ab_${i}`, question: `Question ${i}?` }));
    const got = cleanPreview({ antibodies: [{ id: 1, question: "no id?" }, { id: "ab_x" }, ...many], rules: ["A rule.", 7, "  "] });
    expect(got?.antibodies.map((a) => a.id)).toEqual(["ab_0", "ab_1", "ab_2", "ab_3", "ab_4"]);
    expect(got?.rules).toEqual(["A rule."]);
  });

  it("is undefined for a colony that sends none, or only junk", () => {
    expect(cleanPreview(undefined)).toBeUndefined();
    expect(cleanPreview("review")).toBeUndefined();
    expect(cleanPreview({ antibodies: "x", rules: null })).toBeUndefined();
    expect(cleanPreview({ antibodies: [], rules: [] })).toBeUndefined();
  });
});
