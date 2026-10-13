import { describe, expect, it } from "vitest";
import { BUILTINS, TEST_FILE, classify, compile, resolveExact, rewriteSpecifiers, usesNodeTest } from "../../src/certify/compile.ts";
import { MAIN_MODULE, SHIM_MODULE, buildPlan, closureOf, harnessSource } from "../../src/certify/plan.ts";
import { NODE_TEST_SHIM } from "../../src/certify/shim.ts";
import { testFiles } from "../../src/certify/load.ts";
import { planOf, trunkOf } from "./harness.ts";

describe("compile: TypeScript the way Node runs it", () => {
  it("erases types and keeps every import that is not `import type`", () => {
    const c = compile(
      "test/a.test.ts",
      'import { test } from "node:test";\nimport type { Link } from "../src/types.ts";\nimport { Store, type Other } from "../src/store.ts";\nconst x: number = 1 as number;\ntest("x", () => { const l: Link | null = null; void l; void x; });\n',
    );
    expect(c.error).toBeUndefined();
    expect(c.code).not.toMatch(/: number|as number|Link \|/);
    expect(c.code).toContain('import { Store, } from "../src/store.ts";');
    expect(c.code).not.toContain("../src/types.ts");
    // Lines stay where they were, so errors point at the trunk file's own lines.
    expect(c.code!.split("\n")[4]).toContain('test("x"');
    expect(c.imports).toEqual(["node:test", "../src/store.ts"]);
    expect(usesNodeTest(c)).toBe(true);
  });

  it("fails what Node fails: syntax errors, TypeScript that stripping cannot run, bad JSON", () => {
    expect(compile("src/a.ts", "export const = 1;\n")).toMatchObject({ code: null, error: expect.stringMatching(/^SyntaxError: src\/a\.ts: Unexpected token/) });
    expect(compile("src/e.ts", "export enum Color {\n  Red,\n}\n")).toMatchObject({ code: null, error: expect.stringContaining("type stripping cannot run: line 1 declares an enum") });
    expect(compile("src/p.ts", "export class A {\n  constructor(private x: number) {}\n}\n").error).toContain("parameter property");
    expect(compile("data/x.json", "{ nope")).toMatchObject({ kind: "json", code: null, error: expect.stringContaining("not valid JSON") });
    expect(compile("data/x.json", '{ "a": [1, 2] }')).toMatchObject({ kind: "json", json: { a: [1, 2] }, imports: [] });
  });

  it("keeps JavaScript as written and finds its imports", () => {
    const c = compile("lib/a.test.js", 'import test from "node:test";\nconst m = await import("./m.js");\nexport { x } from "./x.mjs";\n');
    expect(c.code).toContain("await import");
    expect(c.imports).toEqual(["node:test", "./m.js", "./x.mjs"]);
  });
});

describe("specifiers", () => {
  it("classifies relative paths, built-ins the runner provides, packages and built-ins it does not", () => {
    expect(classify("./a.ts")).toEqual({ kind: "relative" });
    expect(classify("../a.ts")).toEqual({ kind: "relative" });
    expect(classify("node:test")).toEqual({ kind: "builtin", name: "test" });
    expect(classify("node:assert/strict")).toEqual({ kind: "builtin", name: "assert/strict" });
    expect(classify("assert")).toEqual({ kind: "builtin", name: "assert" });
    expect(classify("node:fs")).toEqual({ kind: "unsupported", name: "node:fs" });
    expect(classify("test")).toEqual({ kind: "package", name: "test" });
    expect(classify("@scope/pkg/sub")).toEqual({ kind: "package", name: "@scope/pkg" });
    expect(classify("some-lib/sub")).toEqual({ kind: "package", name: "some-lib" });
    expect(BUILTINS.has("fs")).toBe(false);
  });

  it("resolves relative imports exactly as written (no extension guessing, no index files)", () => {
    const files = new Set(["src/http.ts", "src/store/index.ts", "src/data.json"]);
    expect(resolveExact("test/http.test.ts", "../src/http.ts", files)).toBe("src/http.ts");
    expect(resolveExact("test/http.test.ts", "../src/http", files)).toBeNull();
    expect(resolveExact("test/http.test.ts", "../src/http.js", files)).toBeNull();
    expect(resolveExact("test/http.test.ts", "../src/store", files)).toBeNull();
    expect(resolveExact("src/a.ts", "./data.json", files)).toBe("src/data.json");
    expect(resolveExact("a.ts", "../outside.ts", files)).toBeNull();
    expect(resolveExact("a.ts", "/src/http.ts", files)).toBeNull();
  });

  it("points node:test at the shim and gives bare built-ins their node: prefix, nothing else", () => {
    const code = [
      'import { test } from "node:test";',
      "import assert from 'assert';",
      'import { inspect } from "node:util";',
      'import x from "../src/x.ts";',
      'const t = await import("node:test");',
      'const s = "from node:test is just text";',
      'export * from "./y.ts";',
    ].join("\n");
    const out = rewriteSpecifiers(code, "../__ft_certify__/node-test.js").split("\n");
    expect(out).toEqual([
      'import { test } from "../__ft_certify__/node-test.js";',
      "import assert from 'node:assert';",
      'import { inspect } from "node:util";',
      'import x from "../src/x.ts";',
      'const t = await import("../__ft_certify__/node-test.js");',
      'const s = "from node:test is just text";',
      'export * from "./y.ts";',
    ]);
  });

  it("finds test files under test/ and anywhere else, leaving dependencies and dot directories out", () => {
    const index = ["test/a.test.ts", "src/b.test.js", "c.test.ts", "test/helper.ts", "node_modules/x/y.test.js", ".firetrident/z.test.ts", "src/x.test.mjs", "test/d.spec.ts"].map((path) => ({
      path,
      blob: path,
      size: 1,
    }));
    expect(testFiles(index).map((f) => f.path)).toEqual(["c.test.ts", "src/b.test.js", "test/a.test.ts"]);
    expect(TEST_FILE.test("test/deep/dir/x.test.ts")).toBe(true);
  });
});

describe("the module map", () => {
  const FILES: Record<string, string> = {
    "src/types.ts": "export interface A { x: number }\n",
    "src/util.ts": 'import type { A } from "./types.ts";\nexport function f(a: A): number {\n  return a.x;\n}\n',
    "src/conf.json": '{ "n": 1 }\n',
    "src/main.ts": 'import { f } from "./util.ts";\nimport conf from "./conf.json" with { type: "json" };\nexport const v = f({ x: conf.n });\n',
    "test/main.test.ts": 'import { test } from "node:test";\nimport { v } from "../src/main.ts";\ntest("v", () => { if (v !== 1) throw new Error("v"); });\n',
    "test/util.test.ts": 'import { test } from "node:test";\nimport { f } from "../src/util.ts";\ntest("f", () => { f({ x: 1 }); });\n',
    "src/broken.ts": "export const = ;\n",
    "test/broken.test.ts": 'import { test } from "node:test";\nimport "../src/broken.ts";\ntest("b", () => {});\n',
  };

  it("walks the runtime import graph (type-only imports erased) nearest first", async () => {
    const { loaded } = await planOf(FILES);
    expect(closureOf("test/main.test.ts", loaded.modules)).toEqual(["test/main.test.ts", "src/main.ts", "src/util.ts", "src/conf.json"]);
    expect(loaded.modules.has("src/types.ts")).toBe(false);
  });

  it("gives every test file its own prefix with its own shim, and one harness that runs them in order", async () => {
    const { plan } = await planOf(FILES);
    expect(plan.mainModule).toBe(MAIN_MODULE);
    expect(plan.files).toEqual([
      { path: "test/broken.test.ts", prefix: "t0/" },
      { path: "test/main.test.ts", prefix: "t1/" },
      { path: "test/util.test.ts", prefix: "t2/" },
    ]);
    expect(Object.keys(plan.modules).sort()).toEqual(
      [
        MAIN_MODULE,
        `t0/${SHIM_MODULE}`,
        "t0/src/broken.ts",
        "t0/test/broken.test.ts",
        `t1/${SHIM_MODULE}`,
        "t1/src/conf.json",
        "t1/src/main.ts",
        "t1/src/util.ts",
        "t1/test/main.test.ts",
        `t2/${SHIM_MODULE}`,
        "t2/src/util.ts",
        "t2/test/util.test.ts",
      ].sort(),
    );
    expect(plan.modules[`t1/${SHIM_MODULE}`]).toEqual({ js: NODE_TEST_SHIM });
    expect(plan.modules["t1/src/conf.json"]).toEqual({ json: { n: 1 } });
    expect((plan.modules["t1/test/main.test.ts"] as { js: string }).js).toContain('from "../__ft_certify__/node-test.js"');
    expect((plan.modules["t0/src/broken.ts"] as { js: string }).js).toMatch(/^throw new SyntaxError\("SyntaxError: src\/broken\.ts: /);
    const main = (plan.modules[MAIN_MODULE] as { js: string }).js;
    expect(main).toContain('main: () => import("../t1/test/main.test.ts")');
    expect(main).toContain('shim: () => import("../t1/__ft_certify__/node-test.js")');
    expect(main.indexOf("t0/test/broken")).toBeLessThan(main.indexOf("t2/test/util"));
    const shared = buildPlan({ tests: plan.files.map((f) => f.path), modules: (await planOf(FILES)).loaded.modules, config: { testTimeoutMs: 1, budgetMs: 1 }, isolate: false });
    expect(new Set(shared.files.map((f) => f.prefix))).toEqual(new Set(["t0/"]));
  });

  it("keeps compiled modules between runs, so a later run reads only the files that changed", async () => {
    const { load } = await import("../../src/certify/load.ts");
    const memo = new Map();
    const t = trunkOf(FILES);
    const first = await load(t.index, t.read, undefined, memo);
    expect(t.reads.flat().length).toBeGreaterThan(0);
    const again = trunkOf(FILES);
    const second = await load(again.index, again.read, undefined, memo);
    expect(again.reads).toEqual([]);
    expect(second.tests).toEqual(first.tests);
    // One file changes (a new blob id): only it is read.
    const changed = trunkOf({ ...FILES, "src/util.ts": `${FILES["src/util.ts"]}export const two = 2;\n` });
    changed.index.find((f) => f.path === "src/util.ts")!.blob = "b:src/util.ts#2";
    const read = async (blobs: string[]) => changed.read(blobs.map((b) => (b.endsWith("#2") ? "b:src/util.ts" : b)));
    await load(changed.index, read, undefined, memo);
    expect(changed.reads).toEqual([["b:src/util.ts"]]);
  });

  it("writes the run's limits into the harness", () => {
    expect(harnessSource([], { testTimeoutMs: 1234, budgetMs: 5678 })).toContain('const CONFIG = {"testTimeoutMs":1234,"budgetMs":5678};');
  });

  it("reads only what the tests reach, level by level, and respects the caps", async () => {
    const t = trunkOf({ ...FILES, "docs/big.ts": "x".repeat(10) });
    const { load } = await import("../../src/certify/load.ts");
    const loaded = await load(t.index, t.read);
    expect(t.reads.flat()).not.toContain("b:docs/big.ts");
    expect(t.reads[0]).toEqual(["b:test/broken.test.ts", "b:test/main.test.ts", "b:test/util.test.ts"]);
    const capped = await load(t.index, t.read, { maxModules: 4, maxBytes: 1 << 20, maxFileBytes: 1 << 20 });
    expect(capped.truncated).toBe(true);
    expect(capped.unsupported.map((u) => u.path)).toContain("test/main.test.ts");
    expect(capped.unsupported.find((u) => u.path === "test/main.test.ts")?.reason).toMatch(/past the run's size cap/);
    const small = 'import { test } from "node:test";\nimport { big } from "../src/big.ts";\ntest("b", () => big());\n';
    const b = trunkOf({ "test/x.test.ts": small, "src/big.ts": `export function big() {}\n${"// padding\n".repeat(20)}` });
    const big = await load(b.index, b.read, { maxModules: 100, maxBytes: 1 << 20, maxFileBytes: small.length });
    expect(big.unsupported).toEqual([{ path: "test/x.test.ts", reason: "reaches src/big.ts, larger than one run reads" }]);
    const tiny = await load(b.index, b.read, { maxModules: 100, maxBytes: 1 << 20, maxFileBytes: 10 });
    expect(tiny.unsupported).toEqual([{ path: "test/x.test.ts", reason: "larger than one run reads (10 bytes)" }]);
    expect(loaded.truncated).toBe(false);
  });
});
