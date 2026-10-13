import { describe, expect, it } from "vitest";
import type { Certification } from "@fire_trident/core";
import { DEFAULT_POLICY, REPAIR_PRIORITY, mergePolicy, repairAction, repairIntent, type RepairRow } from "../../src/certify/repair.ts";
import { parseIntentSpec } from "../../src/agents/create.ts";

const HOUR = 60 * 60_000;
const red: Certification = {
  trunkSha: "abcdef0123456789abcdef0123456789abcdef01",
  status: "red",
  startedAt: 0,
  counts: { tests: 67, pass: 62, fail: 5, cancelled: 0, skipped: 0, todo: 0, suites: 4 },
  failing: [
    { name: "A6: DELETE /api/links/:slug requires admin token", file: "test/acceptance.test.ts", error: "AssertionError (strictEqual): actual 405, expected 401 (at test/acceptance.test.ts:36)" },
    { name: "readJson > rejects an empty body as invalid_json", file: "test/http.test.ts", error: "ReferenceError: expect is not defined (at test/http.test.ts:90)" },
    { name: "KvStore", file: "test/store.kv.test.ts", error: "Error: 1 subtest failed" },
    { name: "KvStore > hit increments clicks and returns true", file: "test/store.kv.test.ts", error: "TypeError: Cannot read properties of undefined (reading 'strictEqual')" },
  ],
};
const row = (id: string, status: RepairRow["status"], createdAt: number): RepairRow => ({ id, status, createdAt });

describe("repair loop rules", () => {
  it("declares a repair intent for a red trunk when none is open", () => {
    expect(repairAction(red, [], DEFAULT_POLICY, 10 * HOUR)).toEqual({ kind: "declare" });
    expect(repairAction(red, [row("i1", "landed", 9 * HOUR)], DEFAULT_POLICY, 10 * HOUR)).toEqual({ kind: "declare" });
  });

  it("keeps at most one open: open, claimed and proposed all count", () => {
    for (const status of ["open", "claimed", "proposed"] as const) {
      expect(repairAction(red, [row("i1", status, 0)], DEFAULT_POLICY, 10 * HOUR)).toEqual({ kind: "none", reason: "repair intent i1 is still open" });
    }
  });

  it("declares at most repairsPerHour in any hour", () => {
    const recent = [row("a", "landed", 9.2 * HOUR), row("b", "withdrawn", 9.5 * HOUR), row("c", "abandoned", 9.9 * HOUR)];
    expect(repairAction(red, recent, DEFAULT_POLICY, 10 * HOUR)).toMatchObject({ kind: "none", reason: expect.stringContaining("cap 3") });
    expect(repairAction(red, recent, DEFAULT_POLICY, 10.3 * HOUR)).toEqual({ kind: "declare" });
    expect(repairAction(red, recent, { repair: true, repairsPerHour: 4 }, 10 * HOUR)).toEqual({ kind: "declare" });
  });

  it("does nothing when repairs are off, for errors and skips, or without a named failure", () => {
    expect(repairAction(red, [], { ...DEFAULT_POLICY, repair: false }, 0)).toMatchObject({ kind: "none" });
    expect(repairAction({ ...red, status: "error" }, [], DEFAULT_POLICY, 0)).toMatchObject({ kind: "none" });
    expect(repairAction({ ...red, status: "skipped" }, [], DEFAULT_POLICY, 0)).toMatchObject({ kind: "none" });
    expect(repairAction({ ...red, failing: [] }, [], DEFAULT_POLICY, 0)).toEqual({ kind: "none", reason: "no failing test is named" });
  });

  it("green satisfies every open repair intent and leaves the rest alone", () => {
    const rows = [row("open1", "open", 0), row("held", "claimed", 1), row("done", "landed", 2), row("gone", "withdrawn", 3)];
    expect(repairAction({ ...red, status: "green", failing: [] }, rows, DEFAULT_POLICY, 4)).toEqual({ kind: "satisfy", ids: ["open1", "held"] });
    expect(repairAction({ ...red, status: "green", failing: [] }, [], DEFAULT_POLICY, 4)).toMatchObject({ kind: "none" });
  });

  it("builds the intent: failing files and what they load in the footprint, the rest as context, the spec carried", () => {
    const reach: Record<string, string[]> = {
      "test/acceptance.test.ts": ["test/acceptance.test.ts", "src/index.ts", "src/store/memory.ts", "src/router.ts", "src/http.ts", "src/routes/links.ts", "src/routes/create.ts"],
      "test/http.test.ts": ["test/http.test.ts", "src/http.ts"],
      "test/store.kv.test.ts": ["test/store.kv.test.ts", "src/store/kv.ts", "test/helpers.test.ts"],
    };
    const intent = repairIntent({ cert: red, reach: (f) => reach[f] ?? [f], isTest: (p) => p.endsWith(".test.ts"), spec: "## Module contracts\n...", sourceLabel: "demo/new-project-spec.md" });
    expect(intent.title).toBe("Make the failing tests pass: A6: DELETE /api/links/:slug requires admin token; rejects an empty body as invalid_json; KvStore and 1 more");
    expect(intent).toMatchObject({ source: "certify", priority: REPAIR_PRIORITY, createdBy: "certify" });
    expect(intent.footprint).toEqual(["test/acceptance.test.ts", "test/http.test.ts", "test/store.kv.test.ts", "src/index.ts", "src/store/memory.ts", "src/router.ts"]);
    const spec = parseIntentSpec(intent.why);
    expect(spec.buildsOn).toEqual(["src/http.ts", "src/routes/links.ts", "src/routes/create.ts", "src/store/kv.ts"]);
    expect(spec.model).toBe("default");
    expect(spec.spec).toBe("## Module contracts\n...");
    expect(spec.source).toBe("demo/new-project-spec.md");
    expect(spec.why).toContain("Trunk abcdef0 fails 5 of its 67 tests");
    expect(spec.why).toContain("- test/acceptance.test.ts > A6: DELETE /api/links/:slug requires admin token: AssertionError (strictEqual): actual 405, expected 401");
    expect(intent.acceptance.join(" ")).toMatch(/never delete or skip one/);
  });

  it("names a file that fails to load, and fits a long list in the title", () => {
    const many: Certification = { ...red, failing: Array.from({ length: 30 }, (_, i) => ({ name: `case number ${i} with a fairly long descriptive name`, file: "test/a.test.ts" })) };
    const intent = repairIntent({ cert: many, reach: (f) => [f], isTest: () => true });
    expect(intent.title.length).toBeLessThan(260);
    expect(intent.title).toMatch(/and \d+ more$/);
    expect(intent.why).toContain("- and 10 more");
    const load = repairIntent({ cert: { ...red, failing: [{ name: "test/x.test.ts", file: "test/x.test.ts", error: "SyntaxError: x" }] }, reach: (f) => [f], isTest: () => true });
    expect(load.why).toContain("- test/x.test.ts > (the file fails to load): SyntaxError: x");
    expect(load.footprint).toEqual(["test/x.test.ts"]);
  });
});

describe("certification policy", () => {
  it("merges partial changes and refuses bad ones", () => {
    expect(mergePolicy(DEFAULT_POLICY, { enabled: false })).toEqual({ policy: { ...DEFAULT_POLICY, enabled: false } });
    expect(mergePolicy(DEFAULT_POLICY, { repairsPerHour: 1, timeoutMs: 30_000 })).toEqual({ policy: { ...DEFAULT_POLICY, repairsPerHour: 1, timeoutMs: 30_000 } });
    expect(mergePolicy(DEFAULT_POLICY, { enabled: "no" })).toEqual({ error: "enabled must be true or false" });
    expect(mergePolicy(DEFAULT_POLICY, { timeoutMs: 1 })).toEqual({ error: "timeoutMs must be a number from 5000 to 300000" });
    expect(mergePolicy(DEFAULT_POLICY, { other: 1 })).toEqual({ error: "unknown policy field other" });
    expect(mergePolicy(DEFAULT_POLICY, [])).toEqual({ error: "policy must be an object" });
  });
});
