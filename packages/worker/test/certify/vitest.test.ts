import { describe, expect, it } from "vitest";
import type { TestCounts } from "@fire_trident/core";
import { classify, compile, compileVitest, configCandidates, configProblem, nearestConfig, resolveVite, rewriteVitest, runnerHints, viteCandidates } from "../../src/certify/compile.ts";
import { EXCLUDED, excludeEntries, excludeFiles, excludeTests } from "../../src/certify/exclude.ts";
import { load } from "../../src/certify/load.ts";
import { VITEST_GLOBALS_MODULE, VITEST_MODULE, buildPlan, closureOf } from "../../src/certify/plan.ts";
import { DEFAULT_POLICY, mergePolicy } from "../../src/certify/repair.ts";
import { countsLine, summarize, type RunReport } from "../../src/certify/report.ts";
import { planOf, runPlanInNode, trunkOf } from "./harness.ts";
import { VITEST_EXPECTED, VITEST_PROJECT } from "./vitest-fixture.ts";

/**
 * vitest support in trunk certification: the runner each test file is written for, vite's import resolution and
 * compilation, the vitest shim run end to end in a real Node process (the same modules a Dynamic Worker gets) against the
 * counts real vitest reports for the same files, unsupported APIs counted apart, and the policy's excluded tests.
 */

function perFile(r: RunReport): Map<string, { pass: number; fail: number; skipped: number; todo: number; unsupported: number }> {
  const out = new Map<string, { pass: number; fail: number; skipped: number; todo: number; unsupported: number }>();
  for (const f of r.files) out.set(f.path, { pass: 0, fail: 0, skipped: 0, todo: 0, unsupported: 0 });
  for (const t of r.tests) {
    const c = out.get(t.file)!;
    if (t.unsupported) c.unsupported++;
    else if (t.status === "cancelled") c.fail++;
    else c[t.status]++;
  }
  return out;
}

describe("which runner a test file is written for", () => {
  it("maps vitest to the shim, and reads imports and globals from the text", () => {
    expect(classify("vitest")).toEqual({ kind: "builtin", name: "vitest" });
    expect(classify("vitest/config")).toEqual({ kind: "package", name: "vitest" });
    expect(runnerHints('import { it } from "vitest";\nit("x", () => {});\n')).toEqual({ vitest: true, globals: false });
    expect(runnerHints("import type { Mock } from 'vitest'\n")).toEqual({ vitest: true, globals: false });
    expect(runnerHints("import { add } from './add'\n\ndescribe('add', () => {\n  it('adds', () => expect(add(1, 1)).toBe(2))\n})\n")).toEqual({ vitest: false, globals: true });
    // A runner imported from elsewhere is not vitest's globals; neither is a call in a comment.
    expect(runnerHints('import { describe, it } from "some-runner";\ndescribe("x", () => it("y", () => {}));\n').globals).toBe(false);
    expect(runnerHints("// describe('x', () => {})\nexport const a = 1\n").globals).toBe(false);
  });

  it("decides per file: node:test, vitest by import, vitest's globals only beside a vitest configuration, else left out", async () => {
    const files = {
      "src/a.ts": "export const a = 1;\n",
      "test/node.test.ts": 'import { test } from "node:test";\ntest("n", () => {});\n',
      "test/imports.test.ts": 'import { it } from "vitest";\nit("v", () => {});\n',
      "test/globals.test.ts": 'it("g", () => {});\n',
      "test/foreign.test.ts": 'import { it } from "some-runner";\nit("f", () => {});\n',
    };
    const without = await planOf(files);
    expect(without.loaded.tests).toEqual(["test/imports.test.ts", "test/node.test.ts"]);
    expect(without.loaded.unsupported).toEqual([
      { path: "test/foreign.test.ts", reason: "does not import node:test" },
      { path: "test/globals.test.ts", reason: "does not import node:test" },
    ]);
    const withConfig = await planOf({ ...files, "vitest.config.ts": "export default { test: { globals: true } }\n" });
    expect(withConfig.loaded.tests).toEqual(["test/globals.test.ts", "test/imports.test.ts", "test/node.test.ts"]);
    expect(withConfig.loaded.modules.get("test/globals.test.ts")?.runner).toBe("vitest");
    expect(withConfig.loaded.modules.get("test/node.test.ts")?.runner).toBeUndefined();
  });

  it("leaves out a test file under a vitest configuration that sets what certification does not apply", async () => {
    expect(configProblem("export default defineConfig({ test: { globals: true, environment: 'node', pool: 'forks' } })")).toBeNull();
    expect(configProblem("export default { plugins: [x()] }")).toBe("plugins");
    expect(configProblem("export default { test: { setupFiles: ['./setup.ts'] } }")).toBe("setup files");
    expect(configProblem("export default { test: { env: { NAME: 'Node' } } }")).toBe("environment variables");
    expect(configProblem("export default { test: { environment: 'jsdom' } }")).toBe("a test environment other than Node");
    expect(nearestConfig("pkg/a/test/x.test.ts", ["vitest.config.ts", "pkg/a/vitest.config.ts", "pkg/b/vitest.config.ts"])).toBe("pkg/a/vitest.config.ts");
    expect(nearestConfig("src/x.test.ts", ["vitest.config.ts", "pkg/a/vitest.config.ts"])).toBe("vitest.config.ts");
    const { loaded } = await planOf({
      "vitest.config.ts": "export default { test: { globals: true } }\n",
      "runtime/edge/vitest.config.ts": "export default { test: { env: { NAME: 'Edge' } } }\n",
      "runtime/edge/index.test.ts": 'it("e", () => {});\n',
      "src/a.test.ts": 'it("a", () => {});\n',
    });
    expect(loaded.tests).toEqual(["src/a.test.ts"]);
    expect(loaded.unsupported).toEqual([{ path: "runtime/edge/index.test.ts", reason: "runs under runtime/edge/vitest.config.ts, which sets environment variables; trunk certification does not apply vitest configurations" }]);
    expect(loaded.via.get("runtime/edge/index.test.ts")).toBe("runtime/edge/vitest.config.ts");
  });
});

describe("vite's resolution and compilation", () => {
  it("resolves extensionless paths, .js names of .ts files and directories, as vite does", () => {
    const files = new Set(["src/a.ts", "src/dir/index.ts", "src/b.js", "src/d.json", "src/both.js", "src/both.ts"]);
    expect(resolveVite("test/x.test.ts", "../src/a", files)).toBe("src/a.ts");
    expect(resolveVite("test/x.test.ts", "../src/a.js", files)).toBe("src/a.ts");
    expect(resolveVite("test/x.test.ts", "../src/dir", files)).toBe("src/dir/index.ts");
    expect(resolveVite("src/dir/index.ts", "..", files)).toBeNull();
    expect(resolveVite("test/x.test.ts", "../src/b", files)).toBe("src/b.js");
    expect(resolveVite("test/x.test.ts", "../src/both", files)).toBe("src/both.js");
    expect(resolveVite("test/x.test.ts", "../src/d.json", files)).toBe("src/d.json");
    expect(resolveVite("src/z.js", "./a.js", files)).toBeNull();
    expect(resolveVite("test/x.test.ts", "../src/none", files)).toBeNull();
    expect(viteCandidates("test/x.test.ts", "../src/a.js")).toEqual(["src/a.js", "src/a.ts", "src/a.js.mjs", "src/a.js.js", "src/a.js.ts", "src/a.js.json", "src/a.js/index.mjs", "src/a.js/index.js", "src/a.js/index.ts", "src/a.js/index.json"]);
    expect(configCandidates(["src/x.test.ts"])).toContain("vitest.config.ts");
    expect(configCandidates(["src/x.test.ts"])).toContain("src/vite.config.mjs");
  });

  it("compiles TypeScript as vite does: unused and type-only imports dropped, enums and parameter properties compiled", () => {
    const c = compileVitest(
      "src/a.ts",
      "import { Mock, vi } from 'vitest'\nimport type { T } from './t'\nexport { T }\nexport enum Op { Add = 'add' }\nexport class P { constructor(private x = 1) {} }\nexport const f = vi.fn()\n",
    );
    expect(c.error).toBeUndefined();
    expect(c.unsupported).toBeUndefined();
    expect(c.imports).toEqual(["vitest"]);
    expect(c.code).not.toMatch(/\bMock\b|\bT\b/);
    expect(c.code).toMatch(/Op\["Add"\]/);
    // Node's own stripping refuses the enum: the node:test compilation keeps saying so.
    expect(compile("src/a.ts", "export enum Op { Add = 'add' }\n").error).toMatch(/declares an enum/);
  });

  it("keeps a class field named get or set a field once its type is erased", () => {
    const source = "export class A {\n  get!: () => void\n  set: Setter<\n    string\n  > = () => {}\n  post!: number\n}\n";
    for (const c of [compileVitest("src/a.ts", source), compile("src/a.ts", source)]) {
      expect(c.code).toMatch(/^ {2}"get"$/m);
      expect(c.code).toMatch(/^ {2}"set"$/m);
      expect(() => new Function(c.code!.replace(/export /g, ""))).not.toThrow();
    }
  });

  it("names what this runner cannot run: JSX, a namespace with values, module mocking, a vitest export the shim lacks", () => {
    expect(compileVitest("src/a.tsx", "export const A = () => <div />\n").unsupported).toBe("src/a.tsx is JSX, which trunk certification does not compile");
    expect(compileVitest("src/n.ts", "export namespace JSX { export type E = string }\nexport const x = 1\n").unsupported).toBeUndefined();
    expect(compileVitest("src/n.ts", "// values\nexport namespace N {\n  export const x = 1\n}\n").unsupported).toBe("src/n.ts declares a namespace with values (line 2), which trunk certification does not compile");
    expect(compileVitest("test/m.test.ts", "import { vi } from 'vitest'\nvi.mock('../src/a', () => ({}))\n").unsupported).toBe("test/m.test.ts uses vi.mock (module mocking), which trunk certification does not support");
    expect(compileVitest("test/m.test.ts", "import { it, createApp } from 'vitest'\nit('x', () => createApp())\n").unsupported).toBe("test/m.test.ts imports createApp from vitest, which trunk certification does not provide");
    // A syntax error is the code's own: the file fails, as under vitest.
    const bad = compileVitest("test/b.test.ts", "it('x', () => {\n");
    expect(bad.unsupported).toBeUndefined();
    expect(bad.error).toMatch(/^SyntaxError: test\/b\.test\.ts/);
  });

  it("rewrites the imports vite resolves differently, only where the module imports them", () => {
    const code = "import { a } from './a'\nexport * from './dir'\nconst s = \"import x from './a'\"\nconst m = await import('./a')\nimport { it } from 'vitest'\n";
    const out = rewriteVitest(code, "../__ft_certify__/node-test.js", "../__ft_certify__/vitest.js", new Map([["./a", "./a.ts"], ["./dir", "./dir/index.ts"]]));
    expect(out.split("\n")).toEqual([
      "import { a } from './a.ts'",
      "export * from './dir/index.ts'",
      "const s = \"import x from './a'\"",
      "const m = await import('./a.ts')",
      "import { it } from '../__ft_certify__/vitest.js'",
      "",
    ]);
  });
});

describe("the vitest shim, run end to end", () => {
  it("counts each file as real vitest does, runs node:test beside it, and counts unsupported APIs apart", async () => {
    const { loaded, plan } = await planOf(VITEST_PROJECT);
    expect(loaded.unsupported).toEqual([{ path: "test/mocked.test.ts", reason: "test/mocked.test.ts uses vi.mock (module mocking), which trunk certification does not support" }]);
    expect(loaded.tests).toEqual(["test/basics.test.ts", "test/globals.test.ts", "test/matchers.test.ts", "test/mocks.test.ts", "test/node.test.ts", "test/only.test.ts", "test/unsupported.test.ts"]);
    // Extensionless and .js imports resolve to the TypeScript files; the vitest shim sits beside each file's node:test shim.
    expect(closureOf("test/basics.test.ts", loaded.modules)).toEqual(["test/basics.test.ts", "src/math.ts", "src/index.ts", "src/helpers.ts"]);
    expect(Object.keys(plan.modules)).toContain(`t0/${VITEST_MODULE}`);
    expect(Object.keys(plan.modules)).toContain(`t0/${VITEST_GLOBALS_MODULE}`);
    expect(Object.keys(plan.modules)).not.toContain(`t4/${VITEST_MODULE}`);

    const report = runPlanInNode(plan) as RunReport;
    const got = perFile(report);
    for (const [file, want] of Object.entries(VITEST_EXPECTED)) {
      if (file === "test/mocked.test.ts") continue;
      const c = got.get(file)!;
      // Unsupported tests pass under vitest (a snapshot is written, a module registry reset): here they are counted apart.
      expect({ ...c, pass: c.pass + c.unsupported, unsupported: 0 }, file).toEqual({ ...want, unsupported: 0 });
    }
    expect(got.get("test/unsupported.test.ts")).toEqual({ pass: 2, fail: 0, skipped: 0, todo: 0, unsupported: 2 });
    expect(got.get("test/node.test.ts")).toEqual({ pass: 1, fail: 0, skipped: 0, todo: 0, unsupported: 0 });

    const s = summarize(report);
    expect(s.status).toBe("red");
    expect(s.counts.unsupported).toBe(2);
    expect(s.unsupported).toEqual([
      { name: "unsupported > uses a snapshot", file: "test/unsupported.test.ts", api: "toMatchSnapshot" },
      { name: "unsupported > resets modules", file: "test/unsupported.test.ts", api: "vi.resetModules" },
    ]);
    expect(countsLine(s.counts)).toBe("10 failing · 7 skipped · 1 todo · 2 unsupported");
    const errors = new Map(s.failing.map((f) => [f.name, f.error]));
    expect(errors.get("math > fails on purpose")).toBe("AssertionError: expected 3 to be 4 // Object.is equality (at test/basics.test.ts:26)");
    expect(errors.get("mocks > fails a mock assertion")).toMatch(/^AssertionError: expected "vi\.fn\(\)" to be called with \[ 'b' \], calls: \[ \[ 'a' \] \] \(at test\/mocks\.test\.ts:90\)$/);
    expect(errors.get("a failing beforeAll (suite)")).toMatch(/^Error: setup failed/);
    expect(s.failing.map((f) => f.name)).not.toContain("a failing beforeAll > never runs");
  }, 60_000);

  it("gives the same counts when the files share one module copy", async () => {
    const { loaded } = await planOf(VITEST_PROJECT);
    const config = { testTimeoutMs: 2_000, budgetMs: 20_000 };
    const isolated = summarize(runPlanInNode(buildPlan({ tests: loaded.tests, modules: loaded.modules, config })) as RunReport);
    const shared = buildPlan({ tests: loaded.tests, modules: loaded.modules, config, isolate: false });
    expect(new Set(shared.files.map((f) => f.prefix))).toEqual(new Set(["t0/", "t1/"]));
    expect(summarize(runPlanInNode(shared) as RunReport).counts).toEqual(isolated.counts);
  }, 60_000);

  it("counts a file that uses an unsupported API as it loads as unsupported, not failing", async () => {
    const { plan } = await planOf({
      "vitest.config.ts": "export default {}\n",
      "test/a.test.ts": "vi.resetModules()\nit('never runs', () => {})\n",
    });
    const s = summarize(runPlanInNode(plan) as RunReport);
    expect(s).toMatchObject({ status: "green", counts: { tests: 1, pass: 0, fail: 0, unsupported: 1 } });
    expect(s.unsupported).toEqual([{ name: "test/a.test.ts", file: "test/a.test.ts", api: "vi.resetModules" }]);
  }, 60_000);
});

describe("tests the colony's policy excludes", () => {
  it("validates the list and merges it into the policy", () => {
    expect(excludeEntries(["src/a.test.ts", " src/a.test.ts ", "src/b.test.ts > suite > one"])).toEqual(["src/a.test.ts", "src/b.test.ts > suite > one"]);
    expect(excludeEntries("src/a.test.ts")).toMatch(/^excludeTests must be a list/);
    expect(excludeEntries([""])).toMatch(/^excludeTests must be a list/);
    const merged = mergePolicy(DEFAULT_POLICY, { excludeTests: ["src/a.test.ts"] });
    expect(merged).toEqual({ policy: { ...DEFAULT_POLICY, excludeTests: ["src/a.test.ts"] } });
    expect(mergePolicy("policy" in merged ? merged.policy : DEFAULT_POLICY, { excludeTests: [] })).toEqual({ policy: DEFAULT_POLICY });
  });

  it("leaves excluded files out before the run and counts excluded tests as unsupported", async () => {
    const t = trunkOf({ "test/a.test.ts": 'import { test } from "node:test";\ntest("x", () => {});\n', "test/b.test.ts": 'import { test } from "node:test";\ntest("y", () => {});\n' });
    const loaded = await load(t.index, t.read);
    excludeFiles(loaded, ["test/a.test.ts", "test/b.test.ts > y"]);
    expect(loaded.tests).toEqual(["test/b.test.ts"]);
    expect(loaded.unsupported).toEqual([{ path: "test/a.test.ts", reason: EXCLUDED }]);
    const report: RunReport = { runner: "r", files: [{ path: "test/b.test.ts", ms: 0, tests: 2, loadError: null }], tests: [{ name: "y", file: "test/b.test.ts", status: "fail", error: "no" }, { name: "z", file: "test/b.test.ts", status: "pass" }], suites: [], ms: 0 };
    const out = excludeTests(report, ["test/b.test.ts > y"]);
    expect(report.tests[0]!.status).toBe("fail");
    const s = summarize(out);
    expect(s.status).toBe("green");
    expect(s.counts).toEqual({ tests: 2, pass: 1, fail: 0, cancelled: 0, skipped: 0, todo: 0, suites: 0, unsupported: 1 } satisfies TestCounts);
    expect(s.unsupported).toEqual([{ name: "y", file: "test/b.test.ts", api: EXCLUDED }]);
  });
});
