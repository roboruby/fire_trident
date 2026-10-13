import { describe, expect, it } from "vitest";
import type { Rule } from "@fire_trident/core";
import { candidatePaths, changedSpecifiers, mechanicalCheck, onlySpecifiersChanged, proofAssumptions, resolveModule, specifierTarget, type SpecifierChange } from "../../src/decide/mechanical.ts";

/** Hono-like tree: src/router.ts beside the src/router/ directory, a directory with an index file. */
const TREE = new Set([
  "src/router.ts",
  "src/router/trie-router/router.ts",
  "src/router/trie-router/node.ts",
  "src/router/trie-router/index.ts",
  "src/utils/url.ts",
  "src/jsx/index.ts",
  "src/jsx/base.ts",
  "src/index.ts",
]);
const exists = (p: string): boolean => TREE.has(p);

const IMPORT_RULE: Rule = {
  id: "rul_ext",
  colonyId: "c",
  kind: "forbid-import",
  spec: { from: ["src/**/*.ts"], module: "^\\.\\.?(?:/.*)?(?<!\\.ts|\\.tsx|\\.json)$" },
  description: "Relative imports name their file",
  approvedBy: "t",
  createdAt: 0,
};

const PATTERN_RULE: Rule = {
  id: "rul_node",
  colonyId: "c",
  kind: "forbid-pattern",
  spec: { pattern: "(\\bfrom\\s*)([\"'])(fs|path)\\2", flags: "g", replacement: "$1$2node:$3$2", include: ["src/**/*.ts"] },
  description: "node: protocol",
  approvedBy: "t",
  createdAt: 0,
};

const PATH = "src/router/trie-router/router.ts";
const BEFORE = ["import type { Result, Router } from '../../router'", "import { checkOptionalParameter } from '../../utils/url'", "import { Node } from './node'", "", "export class TrieRouter {}", ""].join("\n");
const GOOD = ["import type { Result, Router } from '../../router.ts'", "import { checkOptionalParameter } from '../../utils/url.ts'", "import { Node } from './node.ts'", "", "export class TrieRouter {}", ""].join("\n");

function check(after: string, over: Partial<Parameters<typeof mechanicalCheck>[0]> = {}) {
  return mechanicalCheck({ files: [{ path: PATH, before: BEFORE, after }], residual: [], rule: IMPORT_RULE, innateOk: true, exists, ...over });
}

describe("resolution", () => {
  it("resolves like TypeScript: a file wins over a same-named directory, then index files", () => {
    expect(specifierTarget(PATH, "../../router")).toBe("src/router");
    expect(resolveModule("src/router", exists)).toBe("src/router.ts");
    expect(resolveModule("src/jsx", exists)).toBe("src/jsx/index.ts");
    expect(resolveModule(specifierTarget("src/jsx/base.ts", ".."), exists)).toBe("src/index.ts");
    expect(resolveModule("src/nothing", exists)).toBeNull();
    expect(resolveModule(specifierTarget("src/jsx/base.ts", "./index.js"), exists)).toBe("src/jsx/index.ts");
    expect(specifierTarget("src/a.ts", "../../x")).toBeNull();
  });

  it("pairs changed specifiers in order and lists the paths to look up", () => {
    expect(changedSpecifiers(PATH, BEFORE, GOOD)).toEqual([
      { line: 1, before: "../../router", after: "../../router.ts" },
      { line: 2, before: "../../utils/url", after: "../../utils/url.ts" },
      { line: 3, before: "./node", after: "./node.ts" },
    ]);
    const wanted = candidatePaths([{ path: PATH, before: BEFORE, after: GOOD }]);
    expect(wanted).toContain("src/router.ts");
    expect(wanted).toContain("src/router/index.ts");
    expect(wanted).toContain("src/router/trie-router/node.ts");
  });

  it("knows when only specifiers changed", () => {
    expect(onlySpecifiersChanged(BEFORE, GOOD, changedSpecifiers(PATH, BEFORE, GOOD))).toBe(true);
    const extra = GOOD.replace("export class TrieRouter {}", "export class TrieRouter { x = 1 }");
    expect(onlySpecifiersChanged(BEFORE, extra, changedSpecifiers(PATH, BEFORE, extra))).toBe(false);
  });
});

describe("mechanicalCheck", () => {
  it("proves a correct rewrite (the 12 false returns were of this kind)", () => {
    const r = check(GOOD);
    expect(r.verdict).toBe("pass");
    expect(r.facts[0]).toContain("src/router.ts exists and is the file the old specifier resolved to (same module)");
    expect(r.checks.map((c) => [c.name, c.ok])).toEqual([
      ["deterministic: imports resolve", true],
      ["deterministic: mechanical proof", true],
    ]);
  });

  it("fails a specifier that names a file that does not exist", () => {
    const r = check(GOOD.replace("'../../router.ts'", "'../../router/index.ts'"));
    expect(r.verdict).toBe("fail");
    expect(r.reasons[0]).toContain("src/router/index.ts does not exist");
  });

  it("fails a rewrite that points at a different module", () => {
    const r = check(GOOD.replace("'./node.ts'", "'./index.ts'"));
    expect(r.verdict).toBe("fail");
    expect(r.reasons[0]).toContain("moves from src/router/trie-router/node.ts to src/router/trie-router/index.ts");
  });

  it("is inconclusive when the change does more than rewrite specifiers", () => {
    const r = check(GOOD.replace("export class TrieRouter {}", "console.log(process.env.TOKEN)\nexport class TrieRouter {}"));
    expect(r.verdict).toBe("inconclusive");
  });

  it("is inconclusive outside the footprint, on sensitive paths, without a rule, or when the rule re-check fails", () => {
    expect(check(GOOD, { residual: ["src/other.ts"] }).verdict).toBe("inconclusive");
    expect(check(GOOD, { rule: null }).verdict).toBe("inconclusive");
    expect(check(GOOD, { innateOk: false }).verdict).toBe("inconclusive");
    const pkg = mechanicalCheck({ files: [{ path: "package.json", before: "{}\n", after: '{"a":1}\n' }], residual: [], rule: IMPORT_RULE, innateOk: true, exists });
    expect(pkg.verdict).toBe("inconclusive");
  });

  it("proves an exact application of a pattern rule's replacement", () => {
    const before = "import fs from 'fs';\nimport path from 'path';\nexport {};\n";
    const after = "import fs from 'node:fs';\nimport path from 'node:path';\nexport {};\n";
    const ok = mechanicalCheck({ files: [{ path: "src/a.ts", before, after }], residual: [], rule: PATTERN_RULE, innateOk: true, exists });
    expect(ok.verdict).toBe("pass");
    const off = mechanicalCheck({ files: [{ path: "src/a.ts", before, after: after.replace("node:path", "node:os") }], residual: [], rule: PATTERN_RULE, innateOk: true, exists });
    expect(off.verdict).toBe("inconclusive");
  });

  it("counts a file the change itself adds as existing", () => {
    const before = "import { a } from './a'\n";
    const after = "import { a } from './a.ts'\nimport { b } from './b.ts'\n";
    const r = mechanicalCheck({
      files: [{ path: "src/x.ts", before, after }],
      residual: [],
      rule: IMPORT_RULE,
      innateOk: true,
      exists: (p) => p === "src/a.ts" || p === "src/b.ts",
      existed: (p) => p === "src/a.ts",
    });
    expect(r.verdict).toBe("inconclusive");
    expect(r.facts.join(" ")).toContain("new import './b.ts': src/b.ts exists");
  });
});

describe("mechanicalCheck: the comment-only proof", () => {
  const before = "// Adds.\nexport function add(a: number, b: number): number {\n  return a + b;\n}\n";
  const after = before.replace("// Adds.", "/** Adds two numbers; never rounds. */");
  const one = (over: Partial<Parameters<typeof mechanicalCheck>[0]> = {}) =>
    mechanicalCheck({ files: [{ path: "src/add.ts", before, after }], residual: [], rule: null, innateOk: true, exists, ...over });

  it("proves a comment-only change without a rule, as its own deterministic confirmation", () => {
    const r = one();
    expect(r.verdict).toBe("pass");
    expect(r.reasons).toEqual([expect.stringMatching(/^1 file proven comment-only \(src\/add\.ts\).*; inside the footprint; no sensitive path; the innate checks pass$/)]);
    expect(r.facts).toEqual(["src/add.ts: outside comments and whitespace the code is unchanged (the same tokens, with line breaks in the same places)"]);
    expect(r.checks).toEqual([{ name: "deterministic: mechanical proof", ok: true, ms: 0, detail: expect.stringContaining("pass: 1 file proven comment-only") }]);
    // With a rule as well: a comment-only change is proven whatever the rule asks.
    expect(one({ rule: IMPORT_RULE }).verdict).toBe("pass");
  });

  it("is off when the colony policy turns it off", () => {
    const r = one({ commentProof: false });
    expect(r).toMatchObject({ verdict: "inconclusive", reasons: ["the intent has no rule to prove against"], facts: [] });
  });

  it("says why a comment-only change is still not proven", () => {
    expect(one({ innateOk: false }).reasons).toContain("only comments and whitespace changed, but the rule re-check or another innate check failed");
    expect(one({ residual: ["src/add.ts"] }).reasons).toContain("only comments and whitespace changed, but it writes outside the footprint (src/add.ts)");
    const auth = mechanicalCheck({ files: [{ path: "src/auth/add.ts", before, after }], residual: [], rule: null, innateOk: true, exists });
    expect(auth.verdict).toBe("inconclusive");
    expect(auth.reasons.at(-1)).toContain("but it touches sensitive paths (src/auth/add.ts)");
    const directive = one({ files: [{ path: "src/add.ts", before, after: before.replace("// Adds.", "// eslint-disable-next-line") }] });
    expect(directive.verdict).toBe("inconclusive");
    expect(directive.reasons.at(-1)).toBe('only comments and whitespace changed, but src/add.ts holds a directive comment that tools read ("eslint")');
  });

  it("leaves code changes and failed imports to the import proof", () => {
    expect(one({ files: [{ path: "src/add.ts", before, after: after.replace("a + b", "b + a") }] })).toMatchObject({ verdict: "inconclusive", facts: [] });
    const r = check(GOOD.replace("'./node.ts'", "'./missing.ts'"));
    expect(r.verdict).toBe("fail");
    expect(r.reasons.join(" ")).not.toContain("comment");
  });
});

describe("proofAssumptions", () => {
  it("lists the resolved relative targets outside the change's own writes, once each, sorted", () => {
    const changes: SpecifierChange[] = [
      { path: "src/b.ts", line: 2, before: null, after: "./util.ts", was: null, now: "src/util.ts", relative: true },
      { path: "src/a.ts", line: 1, before: "./util", after: "./util.ts", was: "src/util.ts", now: "src/util.ts", relative: true },
      { path: "src/a.ts", line: 3, before: "./x", after: "./x.ts", was: "src/x.ts", now: "src/x.ts", relative: true },
      { path: "src/b.ts", line: 3, before: null, after: "./new.ts", was: null, now: "src/new.ts", relative: true },
      { path: "src/b.ts", line: 4, before: null, after: "./missing.ts", was: null, now: null, relative: true },
      { path: "src/b.ts", line: 5, before: "fs", after: "node:fs", was: null, now: null, relative: false },
    ];
    expect(proofAssumptions(changes, new Set(["src/new.ts"]))).toEqual(["src/util.ts", "src/x.ts"]);
  });
});
