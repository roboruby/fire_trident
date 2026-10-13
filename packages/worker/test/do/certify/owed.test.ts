import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Certification, ColonyEvent, ColonySnapshot, EventsPage, Intent } from "@fire_trident/core";
import { api, colony, eventually, externalLanding, newColony, trunk } from "../helpers.ts";

/**
 * What certification owes (certify/owed.ts), with real Dynamic Workers running the colony's tests:
 * a repair counts only when the tests it was declared for run and pass, and `certified` never moves
 * on a run that lost a test (todo, skipped, gone, or in a file that did not run).
 */

const MATH_BUG = "export function add(a: number, b: number): number {\n  return a + b;\n}\nexport function sub(a: number, b: number): number {\n  return a + b;\n}\n";
const MATH_FIXED = "export function add(a: number, b: number): number {\n  return a + b;\n}\nexport function sub(a: number, b: number): number {\n  return a - b;\n}\n";
const MATH_TEST =
  'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { add, sub } from "../src/math.ts";\ntest("adds", () => {\n  assert.equal(add(2, 3), 5);\n});\ntest("subtracts", () => {\n  assert.equal(sub(5, 3), 2);\n});\n';
/** One line turns the failing test into a todo: node --test then counts nothing as failing. */
const MATH_TEST_TODO = MATH_TEST.replace('test("subtracts", () => {', 'test("subtracts", { todo: true }, () => {');
/** The same test skipping itself from the inside. */
const MATH_TEST_SKIP = MATH_TEST.replace('test("subtracts", () => {', 'test("subtracts", (t) => {\n  t.skip("flaky");');
const MORE_TEST = 'import { test } from "node:test";\nimport assert from "node:assert";\nimport { add } from "../src/math.ts";\ntest("adds again", () => {\n  assert.equal(add(1, 1), 2);\n});\n';

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

/** Run SQL in the colony's storage (to stand in for a landing, or for an older deployment's state). */
async function colonySql(colonyId: string, sql: string, ...args: unknown[]): Promise<void> {
  await runInDurableObject(colony(colonyId), (_instance: unknown, state: DurableObjectState) => {
    state.storage.sql.exec(sql, ...args);
  });
}

describe("what certification owes (Dynamic Workers)", () => {
  it("counts a repair only when its tests pass: a todo leaves trunk red and the repair open", async () => {
    const c = await newColony();
    const sha1 = await externalLanding(c.id, { "src/math.ts": MATH_BUG, "test/math.test.ts": MATH_TEST });
    const red = await settled(c.id, sha1);
    expect(red.status).toBe("red");
    const repairId = red.repairIntentId!;
    expect(repairId).toMatch(/^int_/);

    // The failing test becomes a todo: every test that ran passed, but not the one the repair is for.
    const sha2 = await externalLanding(c.id, { "test/math.test.ts": MATH_TEST_TODO });
    const held = await settled(c.id, sha2);
    expect(held).toMatchObject({ status: "red", counts: { tests: 2, pass: 1, fail: 0, cancelled: 0, todo: 1 } });
    expect(held.lost).toEqual([{ file: "test/math.test.ts", name: "subtracts", why: "todo now", since: sha1, repairIntentId: repairId }]);
    expect(held.failing).toContainEqual({ name: "subtracts", file: "test/math.test.ts", error: `lost: todo now (repair ${repairId} was declared for it on trunk ${sha1.slice(0, 7)})` });
    const why = `Every test that ran passed, but 1 test repair ${repairId} was declared for did not run: test/math.test.ts > subtracts (todo now)`;
    expect(held.detail).toBe(why);
    expect(held.greenSha).toBeUndefined();
    // Not satisfied, and no second repair: the first is still open.
    expect(held.repairIntentId).toBeUndefined();
    expect(await repairs(c.id)).toMatchObject([{ id: repairId, status: "open" }]);
    expect((await certs(c.id)).greenSha).toBeNull();
    // A person sees why in the event stream.
    const page = (await api<EventsPage>("GET", `/colonies/${c.id}/events?limit=5000`)).body;
    const event = page.events.find((e): e is Extract<ColonyEvent, { t: "certify" }> & { seq: number } => e.t === "certify" && e.trunkSha === sha2 && e.status === "red");
    expect(event?.detail).toBe(why);

    // The code is fixed and the test runs again: now the repair counts.
    const sha3 = await externalLanding(c.id, { "src/math.ts": MATH_FIXED, "test/math.test.ts": MATH_TEST });
    expect(await settled(c.id, sha3)).toMatchObject({ status: "green", greenSha: sha3 });
    const done = await eventually(
      () => repairs(c.id),
      (list) => list[0]?.status === "withdrawn",
    );
    expect(done[0]).toMatchObject({ id: repairId, withdrawnReason: `satisfied: every test it was declared for passes on trunk ${sha3.slice(0, 7)} (2/2 tests)` });
    const moved = await eventually(
      () => trunk(c.id).state(),
      (st) => (st.certified ?? []).length > 0,
    );
    expect(moved.certified).toEqual([sha3]);
  });

  it("keeps trunk red when a repair landed by turning its test into a todo, and asks for the test back", async () => {
    const c = await newColony();
    const sha1 = await externalLanding(c.id, { "src/math.ts": MATH_BUG, "test/math.test.ts": MATH_TEST });
    const repairId = (await settled(c.id, sha1)).repairIntentId!;
    // The repair's change lands: the test is a todo now and the code is still wrong.
    await colonySql(c.id, "UPDATE intents SET status = 'landed' WHERE id = ?", repairId);
    const sha2 = await externalLanding(c.id, { "test/math.test.ts": MATH_TEST_TODO });
    const held = await settled(c.id, sha2);
    expect(held).toMatchObject({ status: "red", lost: [{ file: "test/math.test.ts", name: "subtracts", why: "todo now", repairIntentId: repairId }] });
    expect(held.greenSha).toBeUndefined();
    // The next repair puts the test back (its file is in the footprint) and fixes the code.
    const follow = (await repairs(c.id)).find((i) => i.id === held.repairIntentId);
    expect(follow).toMatchObject({ status: "open", title: "Restore the lost tests: subtracts", footprint: ["test/math.test.ts", "src/math.ts"] });
    expect(follow!.why).toContain(`- test/math.test.ts > subtracts: todo now (repair ${repairId} was declared for it on trunk ${sha1.slice(0, 7)})`);
    expect((await trunk(c.id).state()).certified ?? []).toEqual([]);
  });

  it("never moves certified on lost tests: a skipped test, a file the runner leaves out, a deleted file; a person accepts a loss by withdrawing its repair", async () => {
    const c = await newColony();
    const sha1 = await externalLanding(c.id, { "src/math.ts": MATH_FIXED, "test/math.test.ts": MATH_TEST, "test/more.test.ts": MORE_TEST });
    expect(await settled(c.id, sha1)).toMatchObject({ status: "green", files: 2, counts: { tests: 3, pass: 3 } });

    // A test that passed on certified skips itself now.
    const sha2 = await externalLanding(c.id, { "test/math.test.ts": MATH_TEST_SKIP });
    const skipped = await settled(c.id, sha2);
    expect(skipped).toMatchObject({ status: "red", greenSha: sha1, counts: { tests: 3, pass: 2, fail: 0, skipped: 1 } });
    expect(skipped.lost).toEqual([{ file: "test/math.test.ts", name: "subtracts", why: "skipped now", since: sha1 }]);
    expect(skipped.detail).toBe(`Every test that ran passed, but 1 test that passed on certified ${sha1.slice(0, 7)} did not run: test/math.test.ts > subtracts (skipped now)`);
    const restore = (await repairs(c.id)).find((i) => i.id === skipped.repairIntentId);
    expect(restore).toMatchObject({ title: "Restore the lost tests: subtracts", footprint: ["test/math.test.ts", "src/math.ts"] });

    // Put back: green again.
    const sha3 = await externalLanding(c.id, { "test/math.test.ts": MATH_TEST });
    expect(await settled(c.id, sha3)).toMatchObject({ status: "green", greenSha: sha3 });

    // A test file the runner cannot load any more is lost as a whole, with the runner's reason.
    const sha4 = await externalLanding(c.id, { "test/more.test.ts": `import "zod";\n${MORE_TEST}` });
    const leftOut = await settled(c.id, sha4);
    expect(leftOut).toMatchObject({ status: "red", greenSha: sha3, files: 1, counts: { tests: 2, pass: 2 } });
    expect(leftOut.lost).toEqual([{ file: "test/more.test.ts", why: "did not run: imports the package zod (test/more.test.ts); nothing is installed", since: sha3 }]);
    const fixIt = (await repairs(c.id)).find((i) => i.id === leftOut.repairIntentId);
    expect(fixIt).toMatchObject({ status: "open", footprint: ["test/more.test.ts", "src/math.ts"] });

    // Deleting the file is a loss too: a green run included it.
    const sha5 = await externalLanding(c.id, { "test/more.test.ts": null });
    const deleted = await settled(c.id, sha5);
    expect(deleted).toMatchObject({ status: "red", greenSha: sha3, lost: [{ file: "test/more.test.ts", why: "deleted from trunk", since: sha3 }] });
    // greenSha is the green mark; the certified branch follows it and never took a red commit.
    const marks = (await trunk(c.id).state()).certified ?? [];
    for (const red of [sha2, sha4, sha5]) expect(marks).not.toContain(red);

    // A person accepts the loss by withdrawing the repair declared for it; the next run certifies without the file.
    expect((await api("POST", `/colonies/${c.id}/intents/${leftOut.repairIntentId}/withdraw`, { reason: "more.test.ts was folded into math.test.ts" })).status).toBe(200);
    expect((await api("POST", `/colonies/${c.id}/certify`)).status).toBe(202);
    const accepted = await eventually(
      () => certs(c.id),
      (s) => s.greenSha === sha5,
      30_000,
    );
    expect(accepted.results.find((r) => r.trunkSha === sha5)).toMatchObject({ status: "green", files: 1, counts: { tests: 2, pass: 2 } });
    const moved = await eventually(
      () => trunk(c.id).state(),
      (st) => (st.certified ?? []).includes(sha5),
    );
    expect(moved.certified).toContain(sha5);
  });

  it("holds a repair declared before certification kept records to the tests of the result that declared it", async () => {
    const c = await newColony();
    const sha1 = await externalLanding(c.id, { "src/math.ts": MATH_BUG, "test/math.test.ts": MATH_TEST });
    const repairId = (await settled(c.id, sha1)).repairIntentId!;
    // As an older deployment left it: the repair intent, with no record of its tests.
    await colonySql(c.id, "DELETE FROM certify_repairs");
    const sha2 = await externalLanding(c.id, { "test/math.test.ts": MATH_TEST_TODO });
    expect(await settled(c.id, sha2)).toMatchObject({ status: "red", lost: [{ name: "subtracts", why: "todo now", repairIntentId: repairId }] });
    expect(await repairs(c.id)).toMatchObject([{ id: repairId, status: "open" }]);
  });
});
