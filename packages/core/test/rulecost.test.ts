import { describe, expect, it } from "vitest";
import { MAX_RULE_LINE, MAX_RULE_PATTERN, checkFile, nestedQuantifier, ruleLine, validateRule } from "../src/morph.ts";
import type { Rule, RuleKind } from "../src/types.ts";

/**
 * What a rule's pattern may cost: agents write the text rules scan, so a pattern is capped in length, one that repeats a
 * group holding a quantifier (exponential backtracking) is refused, and a line is tested on at most MAX_RULE_LINE characters.
 */

const rule = (kind: RuleKind, spec: Record<string, unknown>): Rule => ({ id: "r1", colonyId: "col", kind, spec, description: "A rule", approvedBy: "user", createdAt: 0 });
const pattern = (p: string): Rule => rule("forbid-pattern", { pattern: p });

describe("nestedQuantifier", () => {
  it("finds a repeated group that holds a quantifier, at any depth, lazy or not", () => {
    expect(nestedQuantifier("^(a+)+$")).toBe("(a+)+");
    expect(nestedQuantifier("(a*)*b")).toBe("(a*)*");
    expect(nestedQuantifier("x(\\w*\\s?)*;")).toBe("(\\w*\\s?)*");
    expect(nestedQuantifier("(?:x+y){2,}")).toBe("(?:x+y){2,}");
    expect(nestedQuantifier("((ab)*c)+")).toBe("((ab)*c)+");
    expect(nestedQuantifier("(a|b+)*")).toBe("(a|b+)*");
    expect(nestedQuantifier("(?<word>[a-z]+)+$")).toBe("(?<word>[a-z]+)+");
    expect(nestedQuantifier("(a+?)+?")).toBe("(a+?)+?");
    expect(nestedQuantifier("(a{1,9})*")).toBe("(a{1,9})*");
    expect(nestedQuantifier("((a+))+")).toBe("((a+))+");
    // Safe, but refused by a check this simple: the repetitions can be written out.
    expect(nestedQuantifier("(\\d+\\.){3}\\d+")).toBe("(\\d+\\.){3}");
  });

  it("leaves single repetitions, fixed counts, optional groups, classes and escapes alone", () => {
    for (const p of [
      "console\\.log\\(",
      "^(\\.\\./)*db(/|$)",
      "^\\.\\.?(?:/.*)?(?<!\\.ts|\\.tsx|\\.json)$",
      "^\\.\\.?/(?!.*\\.ts$)",
      "(\\d+)?x",
      "\\w+\\s*=\\s*\\w+;",
      "(ab)+",
      "(a{2})+",
      "x{3,}",
      "[(a+)+]",
      "\\(a+\\)+",
      "(\\bfrom\\s*|\\bimport\\s*\\(\\s*|\\brequire\\(\\s*)([\"'])",
      "^(node:|(fs|path|os)(/|$))",
      "TODO(?!\\()",
      "a{,3}+",
    ]) {
      expect(nestedQuantifier(p), p).toBeNull();
    }
  });
});

describe("validateRule: what a pattern may cost", () => {
  it("refuses a nested quantifier, with a sentence that says what to do", () => {
    const [problem] = validateRule(pattern("(a+)+$"));
    expect(problem).toBe("spec.pattern repeats a group that holds a quantifier of its own ((a+)+), which can take exponential time on a long line; write it without the nested repetition");
    expect(validateRule(rule("forbid-import", { module: "^(\\w+/)*db$" }))[0]).toMatch(/^spec\.module repeats a group/);
  });

  it("refuses a pattern longer than MAX_RULE_PATTERN, and takes one at the cap", () => {
    expect(validateRule(pattern("a".repeat(MAX_RULE_PATTERN)))).toEqual([]);
    expect(validateRule(pattern("a".repeat(MAX_RULE_PATTERN + 1)))).toEqual([`spec.pattern is ${MAX_RULE_PATTERN + 1} characters long; at most ${MAX_RULE_PATTERN} are allowed`]);
  });

  it("still takes the rules the demos and docs add", () => {
    // The Node built-ins rule the OpenSpec colonies hold: rules stored before the cap are scanned against it too.
    const builtins = String.raw`(\bfrom\s*|\bimport\s*\(\s*|\brequire\(\s*)(["\x27])(path|fs/promises|fs|os|module|child_process|crypto|url|http|https|util|events|stream|readline|zlib|assert|buffer|net|tty|worker_threads|perf_hooks|timers|v8|vm|dns|querystring|string_decoder|async_hooks)\2`;
    expect(builtins.length).toBe(258);
    expect(validateRule(rule("forbid-pattern", { pattern: builtins, flags: "g" }))).toEqual([]);
    for (const p of ["console\\.log\\(", "TODO(?!\\()", ":\\s*any\\b", "new Date\\(|\\.getTime\\(\\)", "Math\\.random\\(|Date\\.now\\(", "new Response\\(\\s*JSON\\.stringify|Response\\.json\\("]) {
      expect(validateRule(pattern(p)), p).toEqual([]);
    }
    for (const m of ["^\\.\\.?/(?!.*\\.ts$)", "^(node-fetch|undici)$", "^(\\.\\./)*db(/|$)", "(^|/)store/", "^\\.\\.?(?:/.*)?(?<!\\.ts|\\.tsx|\\.json)$"]) {
      expect(validateRule(rule("forbid-import", { module: m })), m).toEqual([]);
    }
  });
});

describe("checkFile on long lines", () => {
  it("a catastrophic pattern never runs: checkFile refuses it at once, even against a long line", () => {
    const line = `${"a".repeat(50_000)}!`;
    const t0 = Date.now();
    expect(() => checkFile(pattern("^(a+)+$"), "src/a.ts", line)).toThrow(/rule r1: spec\.pattern repeats a group/);
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  it("tests a long line on its first MAX_RULE_LINE characters, so an accepted pattern stays cheap", () => {
    // Untruncated, `\s*x` tries every start of five million spaces, each to the end: about 10^13 steps.
    const spaces = " ".repeat(5_000_000);
    const t0 = Date.now();
    expect(checkFile(pattern("\\s*x"), "src/a.ts", `${spaces}\n`)).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(ruleLine(spaces)).toHaveLength(MAX_RULE_LINE);
    expect(ruleLine("short")).toBe("short");
  });

  it("finds what sits inside the prefix and not what sits past it", () => {
    const evalRule = pattern("eval\\(");
    expect(checkFile(evalRule, "src/a.ts", `${"x".repeat(MAX_RULE_LINE - 5)}eval(1)\n`).map((v) => v.line)).toEqual([1]);
    expect(checkFile(evalRule, "src/a.ts", `${"x".repeat(MAX_RULE_LINE)}eval(1)\nok\neval(2)\n`).map((v) => v.line)).toEqual([3]);
    const noDb = rule("forbid-import", { module: "db$" });
    expect(checkFile(noDb, "src/a.ts", `import "${"x".repeat(MAX_RULE_LINE)}/db";\nimport "../db";\n`).map((v) => v.line)).toEqual([2]);
  });
});
