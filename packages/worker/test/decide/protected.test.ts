import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, MAX_PROTECTED_PATHS, globProblem, mergePolicy, normalizeGlob, policyProblems } from "../../src/decide/policy.ts";
import { protectedHits } from "../../src/decide/signals.ts";

describe("protected paths: which writes they cover", () => {
  const globs = ["src/auth/**", "db/migrations", "*.lock", "config/{prod,staging}.json"];

  it("covers a matching write with the glob that protects it, and leaves the rest alone", () => {
    expect(protectedHits(["src/auth/login.ts", "src/app.ts"], globs)).toEqual([{ path: "src/auth/login.ts", glob: "src/auth/**" }]);
    expect(protectedHits(["src/authz.ts", "README.md", "src/a.lock"], globs)).toEqual([]);
    expect(protectedHits(["config/prod.json", "config/dev.json", "yarn.lock"], globs)).toEqual([
      { path: "config/prod.json", glob: "config/{prod,staging}.json" },
      { path: "yarn.lock", glob: "*.lock" },
    ]);
  });

  it("covers everything under a directory a glob names", () => {
    expect(protectedHits(["db/migrations/001_init.sql", "db/migrations/v2/002.sql", "db/seed.sql"], globs)).toEqual([
      { path: "db/migrations/001_init.sql", glob: "db/migrations" },
      { path: "db/migrations/v2/002.sql", glob: "db/migrations" },
    ]);
  });

  it("counts deletions and both ends of a rename: the write set lists every path a change touches", () => {
    // A rename is a deletion (blob null) plus a write: into a protected path, and out of one.
    expect(protectedHits(["src/session.ts", "src/auth/session.ts"], globs)).toEqual([{ path: "src/auth/session.ts", glob: "src/auth/**" }]);
    expect(protectedHits(["src/auth/old.ts", "src/old.ts"], globs)).toEqual([{ path: "src/auth/old.ts", glob: "src/auth/**" }]);
    expect(protectedHits(["db/migrations/001_init.sql"], globs)).toHaveLength(1);
  });

  it("lists a path once, with the first glob that covers it, and costs nothing with no globs", () => {
    expect(protectedHits(["src/auth/a.ts", "src/auth/a.ts"], ["src/**", "src/auth/**"])).toEqual([{ path: "src/auth/a.ts", glob: "src/**" }]);
    expect(protectedHits(["src/auth/a.ts"], [])).toEqual([]);
  });
});

describe("protected paths and the comment-only proof in the decide policy", () => {
  it("defaults to the comment-only proof on and nothing protected", () => {
    expect(DEFAULT_POLICY).toMatchObject({ commentProof: true, protectedPaths: [] });
    // Policies stored before these fields existed read as the defaults.
    expect(mergePolicy(DEFAULT_POLICY, { deterministic: true })).toMatchObject({ commentProof: true, protectedPaths: [] });
  });

  it("merges them: normalized globs, each once, at most 50, the unusable dropped", () => {
    const p = mergePolicy(DEFAULT_POLICY, { commentProof: false, protectedPaths: [" src/auth/** ", "./db/migrations/", "src/auth/**", "", 7, "x\ny"] });
    expect(p.commentProof).toBe(false);
    expect(p.protectedPaths).toEqual(["src/auth/**", "db/migrations"]);
    expect(mergePolicy(p, { commentProof: "no", protectedPaths: "src/**" })).toMatchObject({ commentProof: false, protectedPaths: ["src/auth/**", "db/migrations"] });
    expect(mergePolicy(p, { protectedPaths: [] }).protectedPaths).toEqual([]);
    const lots = Array.from({ length: 80 }, (_, i) => `dir${i}/**`);
    expect(mergePolicy(DEFAULT_POLICY, { protectedPaths: lots }).protectedPaths).toHaveLength(MAX_PROTECTED_PATHS);
  });

  it("says why a glob cannot protect anything", () => {
    expect(normalizeGlob("  /src/auth/ ")).toBe("src/auth");
    expect(globProblem("src/auth/**")).toBeNull();
    expect(globProblem("{src,lib}/{auth,admin}/**/*.{ts,js}")).toBeNull();
    expect(globProblem("{x}")).toBeNull();
    expect(globProblem(" ./ ")).toBe("a protected path cannot be empty");
    expect(globProblem("a".repeat(301))).toBe("a protected path has at most 300 characters");
    expect(globProblem("src/\nauth")).toBe("a protected path is one line of text");
    // The matcher gives up on a glob with more than 256 alternatives: it would protect nothing.
    expect(globProblem("{a,b}{c,d}{e,f}{g,h}{i,j}{k,l}{m,n}{o,p}{q,r}")).toBe("a protected path with this many {a,b} alternatives would match nothing");
  });

  it("refuses a patch that would be dropped silently, field by field", () => {
    expect(policyProblems({ commentProof: false, protectedPaths: ["src/auth/**"], confidence: 0.9 })).toEqual([]);
    expect(policyProblems({ commentProof: "off" })).toEqual(["commentProof: must be true or false"]);
    expect(policyProblems({ protectedPaths: "src/**" })).toEqual(["protectedPaths: must be a list of globs"]);
    expect(policyProblems({ protectedPaths: ["src/**", "", 3] })).toEqual(["protectedPaths.1: a protected path cannot be empty", "protectedPaths.2: must be a string"]);
    expect(policyProblems({ protectedPaths: Array.from({ length: 51 }, (_, i) => `d${i}`) })).toEqual(["protectedPaths: at most 50 globs, got 51"]);
  });
});
