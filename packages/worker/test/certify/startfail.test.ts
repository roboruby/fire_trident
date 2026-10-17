import { describe, expect, it } from "vitest";
import { MAIN_MODULE, SHIM_MODULE, type Plan } from "../../src/certify/plan.ts";
import { summarize } from "../../src/certify/report.ts";
import { MIN_RERUN_MS, PROBE_MODULE, afterFailedStart, findUncompilable, probeModules, startError, withoutUncompilable, type ProbeModule, type StartProbe } from "../../src/certify/startfail.ts";
import { planOf, runPlanInNode } from "./harness.ts";

/**
 * Modules the test runtime cannot compile (certify/startfail.ts): the probes that find them by halves without running
 * anything, the stand-in that throws each one's error where a test file loads it, and the run that starts again.
 */

const mods = (n: number): ProbeModule[] => Array.from({ length: n }, (_, i) => ({ path: `src/m${String(i).padStart(2, "0")}.ts`, js: `export const v${i} = ${i};\n` }));

/** A runtime that refuses to start any set holding a module of `bad` (its error names the first), and counts its starts. */
function runtime(bad: Record<string, string>, opts: { failWhenOver?: number } = {}): { start: StartProbe; starts: number } {
  const r = {
    starts: 0,
    start: async (set: readonly ProbeModule[]): Promise<string | null> => {
      r.starts++;
      if (opts.failWhenOver !== undefined && set.length > opts.failWhenOver) return "Worker exceeded its startup limits";
      const hit = set.find((m) => bad[m.path] !== undefined);
      return hit ? bad[hit.path]! : null;
    },
  };
  return r;
}

const limits = { deadline: Date.now() + 60_000, now: () => Date.now() };

describe("finding the modules that stop the test Worker", () => {
  it("names one module among many, with its own error, in a few probes", async () => {
    const all = mods(40);
    const rt = runtime({ "src/m27.ts": "Identifier 'assert' has already been declared" });
    const found = await findUncompilable(all, rt.start, limits);
    expect(found?.bad).toEqual(new Map([["src/m27.ts", "Identifier 'assert' has already been declared"]]));
    expect(found!.probes).toBe(rt.starts);
    expect(found!.probes).toBeLessThanOrEqual(2 * Math.ceil(Math.log2(40)) + 2);
  });

  it("names every module that does not compile, each with its own error", async () => {
    const rt = runtime({ "src/m03.ts": "Unexpected token ';'", "src/m11.ts": "Identifier 'x' has already been declared", "src/m12.ts": "Unexpected end of input" });
    const found = await findUncompilable(mods(16), rt.start, limits);
    expect(found?.bad).toEqual(
      new Map([
        ["src/m03.ts", "Unexpected token ';'"],
        ["src/m11.ts", "Identifier 'x' has already been declared"],
        ["src/m12.ts", "Unexpected end of input"],
      ]),
    );
  });

  it("names nothing when every module compiles, or when the failure is not any single module's", async () => {
    expect(await findUncompilable(mods(8), runtime({}).start, limits)).toBeNull();
    // The whole set is too big to start while each half starts: no module is to blame, so the run's error stands.
    expect(await findUncompilable(mods(8), runtime({}, { failWhenOver: 4 }).start, limits)).toBeNull();
    expect(await findUncompilable([], runtime({}).start, limits)).toBeNull();
  });

  it("stops at the probe budget and at the run's deadline", async () => {
    const rt = runtime({ "src/m05.ts": "Unexpected token" });
    expect(await findUncompilable(mods(64), rt.start, { ...limits, maxProbes: 3 })).toBeNull();
    expect(rt.starts).toBe(3);
    let t = 0;
    const late = runtime({ "src/m05.ts": "Unexpected token" });
    const slow: StartProbe = async (set, ms) => {
      t += 5_000;
      return late.start(set, ms);
    };
    expect(await findUncompilable(mods(64), slow, { deadline: 3 * 5_000 + MIN_RERUN_MS, now: () => t })).toBeNull();
    expect(late.starts).toBeLessThanOrEqual(4);
  });
});

describe("the runtime's compile error", () => {
  it("is one plain line, with the line it names in the module", () => {
    expect(startError("Failed to start Worker:\nUncaught SyntaxError: Identifier 'assert' has already been declared\n  at test/a.test.ts:3", "test/a.test.ts")).toEqual({
      text: "Identifier 'assert' has already been declared",
      line: 3,
    });
    expect(startError("Uncaught SyntaxError: Unexpected token ';'\n  at src/b.ts:1:17", "src/c.ts")).toEqual({ text: "Unexpected token ';'" });
    expect(startError("Identifier 'assert' has already been declared")).toEqual({ text: "Identifier 'assert' has already been declared" });
    expect(startError("")).toEqual({ text: "the module does not compile" });
  });
});

describe("a run without the modules that do not compile", () => {
  const FILES: Record<string, string> = {
    "src/util.ts": "export function twice(n: number): number {\n  return n * 2;\n}\nexport default function half(n: number): number {\n  return n / 2;\n}\n",
    "test/util.test.ts":
      'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport half, { twice } from "../src/util.ts";\ntest("twice", () => {\n  assert.equal(half(twice(2)), 2);\n});\n',
    "test/dup.test.ts": 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nconst label = "dup";\ntest("dup", () => {\n  assert.equal(label, "dup");\n});\n',
    // The same top-level name as dup.test.ts: each test file is its own module.
    "test/ok.test.ts": 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nconst label = "ok";\ntest("ok", () => {\n  assert.equal(label, "ok");\n});\n',
  };

  it("lists each module once under its trunk path, without the harness", async () => {
    const { plan } = await planOf(FILES);
    expect(probeModules(plan).map((m) => m.path).sort()).toEqual(["src/util.ts", "test/dup.test.ts", "test/ok.test.ts", "test/util.test.ts"]);
  });

  it("fails each file that loads a broken module with that module's error, and runs every other file", async () => {
    const { plan } = await planOf(FILES);
    const bad = new Map([
      ["test/dup.test.ts", "Failed to start Worker:\nUncaught SyntaxError: Identifier 'assert' has already been declared\n  at test/dup.test.ts:3"],
      ["src/util.ts", "Unexpected token '}'"],
    ]);
    const again = withoutUncompilable(plan, bad, 20_000);
    // Every copy of a broken module is replaced; the others, the shims and the harness's files are as they were.
    for (const [key, m] of Object.entries(plan.modules)) {
      const path = key.replace(/^t\d+\//, "");
      if (key === MAIN_MODULE) continue;
      if (bad.has(path)) expect(again.modules[key]).not.toEqual(m);
      else expect(again.modules[key]).toEqual(m);
    }
    expect(Object.keys(again.modules).filter((k) => k.endsWith(SHIM_MODULE))).toHaveLength(plan.files.length);
    expect(again.files).toEqual(plan.files);
    const s = summarize(runPlanInNode(again));
    expect(s).toMatchObject({ status: "red", counts: { tests: 3, pass: 1, fail: 2 } });
    expect(s.failing).toEqual([
      { name: "test/dup.test.ts", file: "test/dup.test.ts", error: "SyntaxError: test/dup.test.ts:3: Identifier 'assert' has already been declared" },
      // The stand-in exports what the test imports from it (a default and a named export), so the test sees the error.
      { name: "test/util.test.ts", file: "test/util.test.ts", error: "SyntaxError: src/util.ts: Unexpected token '}'" },
    ]);
  });

  it("finishes the harness within the time left", async () => {
    const { plan } = await planOf(FILES, { testTimeoutMs: 2_000, budgetMs: 20_000 });
    const again = withoutUncompilable(plan, new Map([["test/dup.test.ts", "x"]]), 9_000);
    expect(again.config).toEqual({ testTimeoutMs: 2_000, budgetMs: 6_000 });
    expect((again.modules[MAIN_MODULE] as { js: string }).js).toContain('const CONFIG = {"testTimeoutMs":2000,"budgetMs":6000};');
    // A plan without its limits (an older caller) keeps its harness.
    const bare = { ...plan, config: undefined } as unknown as Plan;
    expect(withoutUncompilable(bare, new Map([["test/dup.test.ts", "x"]]), 9_000).modules[MAIN_MODULE]).toEqual(plan.modules[MAIN_MODULE]);
  });
});

describe("after a failed start", () => {
  /** A Worker Loader stand-in that refuses to start code holding a module marked broken, and records what it loads. */
  function loaderOf(): WorkerLoader & { loads: WorkerLoaderWorkerCode[] } {
    const loads: WorkerLoaderWorkerCode[] = [];
    const load = (code: WorkerLoaderWorkerCode): WorkerStub => {
      loads.push(code);
      const broken = Object.entries(code.modules).find(([, m]) => typeof m === "object" && m !== null && "js" in m && String((m as { js: string }).js).includes("/* broken */"));
      const entrypoint = {
        fetch: async () => {
          if (broken) throw new SyntaxError("Identifier 'assert' has already been declared");
          return new Response("started");
        },
      };
      return { getEntrypoint: () => entrypoint } as unknown as WorkerStub;
    };
    return { loads, load } as unknown as WorkerLoader & { loads: WorkerLoaderWorkerCode[] };
  }

  it("probes with Workers that run nothing, then hands back the plan without the broken module", async () => {
    const { plan } = await planOf({
      "test/a.test.ts": 'import { test } from "node:test";\ntest("a", () => {});\n',
      "test/b.test.ts": 'import { test } from "node:test";\n/* broken */\ntest("b", () => {});\n',
      "test/c.test.ts": 'import { test } from "node:test";\ntest("c", () => {});\n',
    });
    const loader = loaderOf();
    const again = await afterFailedStart(plan, loader, { deadline: Date.now() + 30_000, compatibilityDate: "2026-08-01", maxCpuMs: 30_000 });
    expect(again).not.toBeNull();
    // Every probe is a main module that imports nothing beside modules under their trunk paths: no harness, no shim.
    for (const code of loader.loads) {
      expect(code.mainModule).toBe(PROBE_MODULE);
      expect(code.globalOutbound).toBeNull();
      expect(Object.keys(code.modules).every((k) => k === PROBE_MODULE || !k.startsWith("__ft_certify__/"))).toBe(true);
    }
    const s = summarize(runPlanInNode(again!));
    expect(s).toMatchObject({ status: "red", counts: { tests: 3, pass: 2, fail: 1 } });
    expect(s.failing).toEqual([{ name: "test/b.test.ts", file: "test/b.test.ts", error: "SyntaxError: test/b.test.ts: Identifier 'assert' has already been declared" }]);
  });

  it("is null when everything starts, or when no time is left to run again", async () => {
    const { plan } = await planOf({ "test/a.test.ts": 'import { test } from "node:test";\ntest("a", () => {});\n' });
    expect(await afterFailedStart(plan, loaderOf(), { deadline: Date.now() + 30_000, compatibilityDate: "2026-08-01", maxCpuMs: 30_000 })).toBeNull();
    const broken = await planOf({ "test/b.test.ts": 'import { test } from "node:test";\n/* broken */\ntest("b", () => {});\n' });
    const loader = loaderOf();
    expect(await afterFailedStart(broken.plan, loader, { deadline: Date.now() + MIN_RERUN_MS - 1, compatibilityDate: "2026-08-01", maxCpuMs: 30_000 })).toBeNull();
    expect(loader.loads).toEqual([]);
  });
});
