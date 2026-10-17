import { describe, expect, it } from "vitest";
import type { Certification, ColonySnapshot, Intent } from "@fire_trident/core";
import { api, eventually, externalLanding, newColony } from "../helpers.ts";

/**
 * A test file the runtime cannot compile, with real Dynamic Workers (certify/startfail.ts): the test Worker compiles
 * every module when it starts, so one file with a duplicate declaration used to stop the whole run ("error"). Now the
 * run is red the way `node --test` is: that file fails with its compile error, a file whose named import does not exist
 * fails with its link error, and every other file runs and passes. What a green run proved is still owed afterwards.
 */

const MATH = "export function add(a: number, b: number): number {\n  return a + b;\n}\nexport function sub(a: number, b: number): number {\n  return a - b;\n}\n";
const MATH_TEST =
  'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { add, sub } from "../src/math.ts";\ntest("adds", () => {\n  assert.equal(add(2, 3), 5);\n});\ntest("subtracts", () => {\n  assert.equal(sub(5, 3), 2);\n});\n';
/** Two files with the same top-level names: each test file is its own module, so neither sees the other's. */
const DUP_OK = 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nconst label = "dup";\ntest("dups", () => {\n  assert.equal(label, "dup");\n});\n';
const FMT_OK = 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nconst label = "fmt";\ntest("formats", () => {\n  assert.equal(label, "fmt");\n});\n';
/** As agents wrote them on staging: the same binding imported twice, and a named export the module does not have. */
const DUP_BAD = 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { strict as assert } from "node:assert";\ntest("dups", () => {\n  assert.equal(1, 1);\n});\n';
const FMT_BAD = 'import { test } from "node:test";\nimport { assert } from "node:assert/strict";\ntest("formats", () => {\n  assert.equal(1, 1);\n});\n';
/** Fixed, but the test that passed on certified is gone. */
const DUP_RENAMED = 'import { test } from "node:test";\nimport assert from "node:assert/strict";\ntest("dups again", () => {\n  assert.equal(1, 1);\n});\n';

type CertState = { greenSha: string | null; results: Certification[] };

async function certs(colonyId: string): Promise<CertState> {
  const res = await api<CertState>("GET", `/colonies/${colonyId}/certifications`);
  expect(res.status).toBe(200);
  return res.body;
}

async function settled(colonyId: string, sha: string): Promise<Certification> {
  const state = await eventually(
    () => certs(colonyId),
    (s) => s.results.some((r) => r.trunkSha === sha && r.status !== "running"),
    30_000,
  );
  const found = state.results.find((r) => r.trunkSha === sha);
  if (!found || found.status === "running") throw new Error(`no certification of ${sha} yet`);
  return found;
}

async function repairs(colonyId: string): Promise<Intent[]> {
  const snap = (await api<ColonySnapshot>("GET", `/colonies/${colonyId}`)).body;
  return snap.intents.filter((i) => i.source === "certify");
}

describe("a test file the test runtime cannot compile (Dynamic Workers)", () => {
  it("fails that file and the one with a missing export, runs the rest, and keeps what certified owes", async () => {
    const c = await newColony();
    const sha1 = await externalLanding(c.id, { "src/math.ts": MATH, "test/math.test.ts": MATH_TEST, "test/dup.test.ts": DUP_OK, "test/fmt.test.ts": FMT_OK });
    expect(await settled(c.id, sha1)).toMatchObject({ status: "green", files: 3, counts: { tests: 4, pass: 4 } });

    // Both files break: red, not error. Each is named with its own error; the math tests pass.
    const sha2 = await externalLanding(c.id, { "test/dup.test.ts": DUP_BAD, "test/fmt.test.ts": FMT_BAD });
    const red = await settled(c.id, sha2);
    expect(red).toMatchObject({ status: "red", greenSha: sha1, files: 3, counts: { tests: 4, pass: 2, fail: 2 } });
    expect(red.detail ?? "").not.toMatch(/runner failed/);
    const failing = new Map((red.failing ?? []).map((f) => [f.file, f]));
    expect(failing.get("test/dup.test.ts")).toMatchObject({ name: "test/dup.test.ts" });
    expect(failing.get("test/dup.test.ts")?.error).toMatch(/^SyntaxError: test\/dup\.test\.ts(:3)?: Identifier 'assert' has already been declared$/);
    expect(failing.get("test/fmt.test.ts")).toMatchObject({ name: "test/fmt.test.ts" });
    expect(failing.get("test/fmt.test.ts")?.error).toMatch(/does not provide an export named 'assert'/);
    expect(failing.has("test/math.test.ts")).toBe(false);
    // A file that fails to load is red for itself, not lost; the repair intent owes both files and names their errors.
    expect(red.lost).toBeUndefined();
    const repair = (await repairs(c.id)).find((i) => i.id === red.repairIntentId);
    expect(repair?.why).toContain("Identifier 'assert' has already been declared");
    expect(repair?.why).toContain("does not provide an export named 'assert'");
    expect((await certs(c.id)).greenSha).toBe(sha1);

    // Both load again, but the test that passed on certified is gone: still red, with the loss named.
    const sha3 = await externalLanding(c.id, { "test/dup.test.ts": DUP_RENAMED, "test/fmt.test.ts": FMT_OK });
    const lost = await settled(c.id, sha3);
    expect(lost).toMatchObject({ status: "red", greenSha: sha1, counts: { tests: 4, pass: 4, fail: 0 } });
    expect(lost.lost).toEqual([{ file: "test/dup.test.ts", name: "dups", why: "not defined any more", since: sha1 }]);

    // Put back: green again.
    const sha4 = await externalLanding(c.id, { "test/dup.test.ts": DUP_OK });
    expect(await settled(c.id, sha4)).toMatchObject({ status: "green", greenSha: sha4, counts: { tests: 4, pass: 4 } });
  });

  it("fails every test file that loads a source module that does not compile, and only those", async () => {
    const c = await newColony();
    const util = "export function twice(n: number): number {\n  return n * 2;\n}\n";
    const utilTest = (name: string): string =>
      `import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { twice } from "../src/util.ts";\ntest(${JSON.stringify(name)}, () => {\n  assert.equal(twice(2), 4);\n});\n`;
    // b takes the default export too, so the stand-in for the broken module must export both names to reach its error.
    const bTest = utilTest("b").replace('import { twice } from "../src/util.ts";', 'import half, { twice } from "../src/util.ts";').replace("assert.equal(twice(2), 4);", "assert.equal(half(twice(2)), 2);");
    const utilWithDefault = `${util}export default function half(n: number): number {\n  return n / 2;\n}\n`;
    const sha1 = await externalLanding(c.id, { "src/math.ts": MATH, "src/util.ts": utilWithDefault, "test/math.test.ts": MATH_TEST, "test/a.test.ts": utilTest("a"), "test/b.test.ts": bTest });
    expect(await settled(c.id, sha1)).toMatchObject({ status: "green", counts: { tests: 4, pass: 4 } });

    const sha2 = await externalLanding(c.id, { "src/util.ts": `${utilWithDefault}let twice = 1;\n` });
    const red = await settled(c.id, sha2);
    expect(red).toMatchObject({ status: "red", greenSha: sha1, counts: { tests: 4, pass: 2, fail: 2 } });
    expect((red.failing ?? []).map((f) => f.file).sort()).toEqual(["test/a.test.ts", "test/b.test.ts"]);
    for (const f of red.failing ?? []) expect(f.error).toMatch(/^SyntaxError: src\/util\.ts(:\d+)?: Identifier 'twice' has already been declared$/);
  });
});
