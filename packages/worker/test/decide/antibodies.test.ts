import { describe, expect, it } from "vitest";
import type { Antibody } from "@fire_trident/core";
import {
  antibodyFile,
  antibodyMatches,
  antibodyPath,
  antibodyQuestionId,
  calibrateThreshold,
  cleanQuestion,
  deriveMatcher,
  fallbackQuestion,
  parseAntibodyFile,
} from "../../src/decide/antibodies.ts";
import { DEFAULT_POLICY, mergePolicy, modelFamily, pickSecondOpinion, probationState } from "../../src/decide/policy.ts";
import { worse } from "../../src/decide/store.ts";

describe("deriveMatcher", () => {
  it("covers the directory subtree of each written path and the capability tokens of the added lines", () => {
    const m = deriveMatcher(["src/core/list.ts", "src/core/archive.ts", "package.json"], ["console.log('[debug] token', process.env.GITHUB_TOKEN);"]);
    expect(m.paths).toEqual(["src/core/**", "package.json"]);
    expect(m.pattern).toBeDefined();
    const re = new RegExp(m.pattern!);
    expect(re.test("console.error('creds', process.env.NPM_TOKEN)")).toBe(true);
    expect(re.test("import path from 'node:path';")).toBe(false);
  });

  it("has no pattern when the added lines carry no capability", () => {
    expect(deriveMatcher(["src/a.ts"], ["import fs from 'node:fs';"]).pattern).toBeUndefined();
  });
});

describe("antibodyMatches", () => {
  const ab = { matcher: deriveMatcher(["src/core/list.ts"], ["console.log(process.env.GITHUB_TOKEN)"]) };

  it("needs a path match and, with a pattern, a matching added line", () => {
    expect(antibodyMatches(ab, ["src/core/archive.ts"], ["console.debug(`auth=${process.env.NPM_TOKEN}`)"])).toBe(true);
    expect(antibodyMatches(ab, ["src/core/archive.ts"], ["import path from 'node:path';"])).toBe(false);
    expect(antibodyMatches(ab, ["docs/readme.md"], ["console.log(process.env.X_TOKEN)"])).toBe(false);
  });

  it("matches on paths alone without a pattern, and ignores a broken pattern", () => {
    expect(antibodyMatches({ matcher: { paths: ["src/**"] } }, ["src/x/y.ts"], [])).toBe(true);
    expect(antibodyMatches({ matcher: { paths: ["src/**"], pattern: "(" } }, ["src/x/y.ts"], ["anything"])).toBe(true);
  });
});

describe("questions and thresholds", () => {
  it("falls back to a yes/no question built from the reason", () => {
    expect(fallbackQuestion("Prints the API token to the logs.")).toBe("Does this change repeat a problem a reviewer rejected before: Prints the API token to the logs?");
  });

  it("cleans a model's question", () => {
    expect(cleanQuestion("  Does this change log a secret  ")).toBe("Does this change log a secret?");
    expect(cleanQuestion("short")).toBeNull();
    expect(cleanQuestion(42)).toBeNull();
  });

  it("calibrates the threshold on the rejected change itself", () => {
    expect(calibrateThreshold(0.95)).toEqual({ threshold: 0.81, state: "active" });
    expect(calibrateThreshold(1)).toEqual({ threshold: 0.85, state: "active" });
    expect(calibrateThreshold(0.4)).toEqual({ threshold: 0.5, state: "advisory" });
    expect(calibrateThreshold(null)).toEqual({ threshold: 0.7, state: "active" });
  });

  it("builds Clef-safe question ids and trunk paths", () => {
    expect(antibodyQuestionId("ab_0mfk1x2abc")).toBe("ab.ab_0mfk1x2abc");
    expect(antibodyPath("ab_1")).toBe(".firetrident/antibodies/ab_1.json");
  });
});

describe("antibody files", () => {
  const ab: Antibody = {
    id: "ab_1",
    colonyId: "c",
    origin: "human-reject",
    matcher: { paths: ["src/core/**"], pattern: "process\\.env" },
    question: "Does this change print a secret?",
    threshold: 0.8,
    createdAt: Date.UTC(2026, 9, 12),
    createdFrom: "prp_1",
    hits: 3,
    falsePositives: 1,
  };

  it("round-trips through the trunk file (counters stay in the colony)", () => {
    const text = antibodyFile(ab, { reason: "prints a token", by: "matt", proposalId: "prp_1" });
    expect(text.endsWith("\n")).toBe(true);
    expect(JSON.parse(text)).toMatchObject({ schema: "firetrident.antibody/v1", rejected: { proposal: "prp_1", reason: "prints a token", by: "matt" } });
    expect(parseAntibodyFile(text, "c")).toEqual({ ...ab, hits: 0, falsePositives: 0 });
    expect(parseAntibodyFile("{}", "c")).toBeNull();
    expect(parseAntibodyFile("not json", "c")).toBeNull();
  });
});

describe("probation", () => {
  const p = DEFAULT_POLICY.probation;

  it("needs enough fires before it judges", () => {
    expect(probationState(4, 4, p)).toBe("active");
  });

  it("goes advisory at 10% not useful and off above 25%", () => {
    expect(probationState(20, 1, p)).toBe("active");
    expect(probationState(20, 2, p)).toBe("advisory");
    expect(probationState(20, 5, p)).toBe("advisory");
    expect(probationState(20, 6, p)).toBe("off");
  });

  it("never makes a detector louder than it was minted", () => {
    expect(worse("advisory", "active")).toBe("advisory");
    expect(worse("active", "off")).toBe("off");
  });
});

describe("policy", () => {
  it("merges and clamps a partial policy", () => {
    const p = mergePolicy(DEFAULT_POLICY, { confidence: 2, alertsPerHour: 5.7, bogus: 1, probation: { minFires: 0 } });
    expect(p.confidence).toBe(1);
    expect(p.alertsPerHour).toBe(5);
    expect(p.probation.minFires).toBe(1);
    expect(p.reflexModel).toBe("@cf/cloudflare/clef");
  });

  it("picks a second opinion from a different model family than the author", () => {
    expect(modelFamily("@cf/openai/gpt-oss-120b")).toBe("openai");
    expect(modelFamily("@cf/zai-org/glm-5.3-flash")).toBe("zai-org");
    expect(modelFamily("claude-sonnet-5")).toBe("anthropic");
    const c = DEFAULT_POLICY.secondOpinionModels;
    expect(pickSecondOpinion("@cf/zai-org/glm-5.3-flash", c)).toBe("@cf/openai/gpt-oss-120b");
    expect(pickSecondOpinion("@cf/openai/gpt-oss-20b", c)).toBe("@cf/zai-org/glm-5.3");
    expect(pickSecondOpinion(undefined, c)).toBe("@cf/openai/gpt-oss-120b");
  });
});
