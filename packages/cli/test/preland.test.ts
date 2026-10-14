import { describe, expect, it } from "vitest";
import type { PrelandRun } from "@fire_trident/core";
import { colors, formatWhy } from "../src/format.ts";
import { prelandLine } from "../src/preland.ts";

const plain = colors(false);
const BASE = "a".repeat(40);

describe("tests before landing in ft why", () => {
  it("says what ran on the change's base and how it went, or why nothing was checked", () => {
    const run: PrelandRun = { status: "passed", trunkSha: BASE, files: ["test/math.test.ts"], reached: 3, tests: 2, passed: 1, failed: 1, known: 1, ms: 182 };
    expect(prelandLine(run, plain)).toBe("✓ 1 of 2 tests passed in 1 test file on its base aaaaaaa (182ms); 1 failing test did not pass on trunk either; 2 more test files left to certification");
    expect(prelandLine({ status: "unchecked", files: [], tests: 0, passed: 0, failed: 0, ms: 2_250, reason: "the tests took longer than 2 s" }, plain)).toBe(
      "not checked: the tests took longer than 2 s (2.3s)",
    );
    expect(prelandLine({ status: "failed", trunkSha: BASE, files: ["t.ts"], tests: 1, passed: 0, failed: 1, broke: [{ file: "t.ts", name: "subtracts", error: "actual 8,\nexpected 2" }], ms: 90 }, plain)).toBe(
      '✗ "subtracts" (t.ts): actual 8, expected 2 passed on trunk and failed with the change on its base aaaaaaa (90ms)',
    );
    expect(prelandLine(undefined, plain)).toBeNull();
    expect(prelandLine("passed", plain)).toBeNull();
  });

  it("prints the line under the checks of a landed change, and nothing for a note without it", () => {
    const proposal = (evidence: Record<string, unknown>) => ({ id: "prp_1", agentId: "agt_1", agentKind: "external", intent: { id: "int_1", title: "Fix", why: "" }, writeSet: [{ path: "src/a.ts", blob: "b" }], readSet: [], decisions: [], evidence });
    const landing = { id: "lnd_1", trunkSha: BASE, parentSha: BASE, at: 1 };
    const run: PrelandRun = { status: "passed", trunkSha: BASE, files: ["test/a.test.ts"], tests: 3, passed: 3, failed: 0, ms: 120 };
    const tested = [{ landing, note: { proposals: [proposal({ checks: [{ name: "tests before landing", ok: true, ms: 120 }], preland: run })] } }] as unknown as Parameters<typeof formatWhy>[1];
    expect(formatWhy({ path: "src/a.ts" }, tested, {}, plain, 0)).toContain("  tested   ✓ 3 of 3 tests passed in 1 test file on its base aaaaaaa (120ms)");
    const before = [{ landing, note: { proposals: [proposal({ checks: [] })] } }] as unknown as Parameters<typeof formatWhy>[1];
    expect(formatWhy({ path: "src/a.ts" }, before, {}, plain, 0)).not.toContain("tested");
  });
});
