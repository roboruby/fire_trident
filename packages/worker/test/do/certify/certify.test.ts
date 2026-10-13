import { describe, expect, it } from "vitest";
import type { Certification, ColonyEvent, ColonySnapshot, EventsPage, Intent } from "@fire_trident/core";
import { api, eventually, externalLanding, newColony, trunk } from "../helpers.ts";

/**
 * Trunk certification inside workerd: the real ColonyDO, the trunk stand-in, and real Dynamic
 * Workers (Worker Loader) running the colony's tests after landings.
 */

const MATH_BUG = "export function add(a: number, b: number): number {\n  return a + b;\n}\nexport function sub(a: number, b: number): number {\n  return a + b;\n}\n";
const MATH_FIXED = "export function add(a: number, b: number): number {\n  return a + b;\n}\nexport function sub(a: number, b: number): number {\n  return a - b;\n}\n";
const MATH_TEST =
  'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { add, sub } from "../src/math.ts";\ntest("adds", () => {\n  assert.equal(add(2, 3), 5);\n});\ntest("subtracts", () => {\n  assert.equal(sub(5, 3), 2);\n});\n';

type CertState = { on: boolean; running: boolean; pending: boolean; greenSha: string | null; results: Certification[] };

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
  if (!found || found.status === "running") throw new Error(`no certification of ${sha} yet: ${JSON.stringify(state.results.map((r) => [r.trunkSha.slice(0, 7), r.status]))}`);
  return found;
}

async function repairs(colonyId: string): Promise<Intent[]> {
  const snap = (await api<ColonySnapshot>("GET", `/colonies/${colonyId}`)).body;
  return snap.intents.filter((i) => i.source === "certify");
}

describe("trunk certification (Dynamic Workers)", () => {
  it("runs a landing's tests: red keeps the last green and declares one repair intent, green satisfies it", async () => {
    const c = await newColony();
    expect((await certs(c.id)).on).toBe(true);

    const sha1 = await externalLanding(c.id, { "src/math.ts": MATH_BUG, "test/math.test.ts": MATH_TEST });
    const red = await settled(c.id, sha1);
    expect(red).toMatchObject({ status: "red", files: 1, counts: { tests: 2, pass: 1, fail: 1, cancelled: 0 } });
    expect(red.failing).toEqual([{ name: "subtracts", file: "test/math.test.ts", error: "AssertionError (strictEqual): actual 8, expected 2 (at test/math.test.ts:8)" }]);
    expect(red.greenSha).toBeUndefined();
    expect(red.repairIntentId).toMatch(/^int_/);

    const declared = await repairs(c.id);
    expect(declared).toHaveLength(1);
    expect(declared[0]).toMatchObject({ id: red.repairIntentId, source: "certify", status: "open", priority: 10, footprint: ["test/math.test.ts", "src/math.ts"], title: "Make the failing tests pass: subtracts" });
    expect(declared[0]!.why).toContain("test/math.test.ts > subtracts: AssertionError (strictEqual): actual 8, expected 2");
    const snap = (await api<ColonySnapshot>("GET", `/colonies/${c.id}`)).body;
    expect(snap.colony.certification).toMatchObject({ trunkSha: sha1, status: "red" });

    // Still red after an unrelated landing: the verdict is reused (same tested files), no second repair intent.
    const sha2 = await externalLanding(c.id, { "README.md": "# demo, changed\n" });
    const again = await settled(c.id, sha2);
    expect(again).toMatchObject({ status: "red", reusedFrom: sha1, counts: { fail: 1 } });
    expect(await repairs(c.id)).toHaveLength(1);

    // The fix lands: green moves greenSha and satisfies the repair intent.
    const sha3 = await externalLanding(c.id, { "src/math.ts": MATH_FIXED });
    const green = await settled(c.id, sha3);
    expect(green).toMatchObject({ status: "green", greenSha: sha3, counts: { tests: 2, pass: 2, fail: 0 } });
    const state = await certs(c.id);
    expect(state.greenSha).toBe(sha3);
    const after = await eventually(
      () => repairs(c.id),
      (list) => list[0]?.status === "withdrawn",
    );
    expect(after[0]).toMatchObject({ status: "withdrawn", withdrawnReason: `satisfied: trunk ${sha3.slice(0, 7)} passes 2 of 2 tests` });

    // The certified landings' lineage notes carry the results.
    const notes = (await trunk(c.id).state()).annotations ?? {};
    expect(notes[`lnd_external_${sha1.slice(0, 8)}`]).toMatchObject({ certification: { status: "red", counts: { fail: 1 } } });
    expect(notes[`lnd_external_${sha3.slice(0, 8)}`]).toMatchObject({ certification: { status: "green", counts: { pass: 2 } } });

    // The event record (replays) has every step.
    const page = (await api<EventsPage>("GET", `/colonies/${c.id}/events?limit=5000`)).body;
    const seen = page.events.filter((e): e is Extract<ColonyEvent, { t: "certify" }> & { seq: number } => e.t === "certify").map((e) => `${e.trunkSha.slice(0, 7)}:${e.status}`);
    expect(seen).toEqual([`${sha1.slice(0, 7)}:running`, `${sha1.slice(0, 7)}:red`, `${sha2.slice(0, 7)}:red`, `${sha3.slice(0, 7)}:running`, `${sha3.slice(0, 7)}:green`]);
  });

  it("re-runs only the test files whose inputs changed", async () => {
    const c = await newColony();
    const sha1 = await externalLanding(c.id, { "src/math.ts": MATH_FIXED, "test/math.test.ts": MATH_TEST });
    const first = await settled(c.id, sha1);
    expect(first).toMatchObject({ status: "green", files: 1, counts: { tests: 2, pass: 2 } });
    expect(first.cached).toBeUndefined();
    const more = 'import { test } from "node:test";\nimport assert from "node:assert";\nimport { add } from "../src/math.ts";\ntest("adds again", () => {\n  assert.equal(add(1, 1), 2);\n});\n';
    const sha2 = await externalLanding(c.id, { "test/more.test.ts": more });
    expect(await settled(c.id, sha2)).toMatchObject({ status: "green", files: 2, cached: 1, counts: { tests: 3, pass: 3 } });
    // A source file both test files load: both run again.
    const sha3 = await externalLanding(c.id, { "src/math.ts": `${MATH_FIXED}export const zero = 0;\n` });
    const third = await settled(c.id, sha3);
    expect(third).toMatchObject({ status: "green", files: 2, counts: { tests: 3, pass: 3 } });
    expect(third.cached).toBeUndefined();
  });

  it("certifies only the newest trunk when landings come faster than runs, one run at a time", async () => {
    const c = await newColony();
    await api("POST", `/colonies/${c.id}/certify/policy`, { minIntervalMs: 300 });
    const shas: string[] = [];
    shas.push(await externalLanding(c.id, { "src/math.ts": MATH_FIXED, "test/math.test.ts": MATH_TEST }));
    for (let i = 0; i < 5; i++) shas.push(await externalLanding(c.id, { "docs/guide.md": `guide ${i}\n` }));
    const head = shas[shas.length - 1]!;
    await settled(c.id, head);
    const done = await eventually(
      () => certs(c.id),
      (s) => !s.running && !s.pending,
    );
    // The first landing's run, then one run for everything that landed meanwhile.
    const certified = done.results.map((r) => r.trunkSha);
    expect(certified.length).toBeLessThanOrEqual(2);
    expect(certified[0]).toBe(head);
    expect(done.results.every((r) => r.status === "green")).toBe(true);
    // A landing reported while a run is still reading trunk can ask for one more run, which finds the head certified and stops.
    expect((await trunk(c.id).state()).certifyReads).toBeLessThanOrEqual(3);
  });

  it("stops when the colony's policy turns it off, and runs again on request once it is back on", async () => {
    const c = await newColony();
    const off = await api<{ enabled: boolean }>("POST", `/colonies/${c.id}/certify/policy`, { enabled: false });
    expect(off.body.enabled).toBe(false);
    const sha = await externalLanding(c.id, { "src/math.ts": MATH_BUG, "test/math.test.ts": MATH_TEST });
    await new Promise((r) => setTimeout(r, 500));
    expect((await certs(c.id)).results).toEqual([]);
    const refused = await api<{ started: boolean; reason: string }>("POST", `/colonies/${c.id}/certify`);
    expect(refused.status).toBe(409);
    expect(refused.body.reason).toMatch(/off for this colony/);
    expect((await api("POST", `/colonies/${c.id}/certify/policy`, { repair: "yes" })).status).toBe(400);

    await api("POST", `/colonies/${c.id}/certify/policy`, { enabled: true, repair: false });
    const red = await settled(c.id, sha);
    expect(red.status).toBe("red");
    expect(red.repairIntentId).toBeUndefined();
    expect(await repairs(c.id)).toEqual([]);
  });

  it("reads nothing while a trunk has no tests and no test file lands", async () => {
    const c = await newColony();
    const sha1 = await externalLanding(c.id, { "src/math.ts": MATH_FIXED });
    expect(await settled(c.id, sha1)).toMatchObject({ status: "skipped", detail: "no test files (*.test.ts or *.test.js)" });
    const reads = (await trunk(c.id).state()).certifyReads ?? 0;
    await externalLanding(c.id, { "docs/guide.md": "more\n" });
    await new Promise((r) => setTimeout(r, 300));
    expect((await trunk(c.id).state()).certifyReads ?? 0).toBe(reads);
    const sha3 = await externalLanding(c.id, { "test/math.test.ts": MATH_TEST });
    expect(await settled(c.id, sha3)).toMatchObject({ status: "green", counts: { tests: 2, pass: 2 } });
  });

  it("skips a trunk whose tests it cannot run, and says why", async () => {
    const c = await newColony();
    const sha = await externalLanding(c.id, {
      "test/other.test.ts": 'import { describe, it } from "some-runner";\ndescribe("x", () => it("y", () => {}));\n',
    });
    const skipped = await settled(c.id, sha);
    expect(skipped).toMatchObject({ status: "skipped", detail: "no test file imports node:test (1 test file)" });
    expect((await certs(c.id)).greenSha).toBeNull();
  });
});
