import { describe, expect, it } from "vitest";
import type { Certification } from "@fire_trident/core";
import { colors, formatCertify, noteCertLine, testsPhrase, trunkLine } from "../src/format.ts";

/** Tests that used an API trunk certification does not support (vitest snapshots, module mocking) count apart: the CLI names them. */

const plain = colors(false);
const HEAD = "a".repeat(40);
const counts = { tests: 60, pass: 57, fail: 0, cancelled: 0, skipped: 0, todo: 0, suites: 3, unsupported: 3 };
const cert = (over: Partial<Certification>): Certification => ({ trunkSha: HEAD, status: "green", startedAt: 0, ...over });

describe("unsupported tests in the CLI", () => {
  it("counts them wherever certification counts are printed", () => {
    expect(testsPhrase({ counts })).toBe("57/60 tests · 3 unsupported");
    expect(testsPhrase({ counts: { ...counts, pass: 55, fail: 2 } })).toBe("2 of 60 failing · 3 unsupported");
    expect(trunkLine({ trunkSha: HEAD, greenSha: HEAD, certification: cert({ counts }) }, plain)).toBe("aaaaaaa  ✓ green, 57/60 tests · 3 unsupported");
    expect(noteCertLine({ runner: "x", status: "green", counts }, plain)).toBe("✓ 57/60 tests pass · 3 unsupported");
    // Results recorded before unsupported tests existed read as before.
    const { unsupported: _, ...old } = counts;
    expect(testsPhrase({ counts: { ...old, tests: 57 } })).toBe("57/57 tests");
  });

  it("lists the newest result's unsupported tests and the policy's excluded tests in ft certify", () => {
    const unsupportedTests = [
      { name: "a > snapshots", file: "test/a.test.ts", api: "toMatchSnapshot" },
      { name: "b > resets", file: "test/b.test.ts", api: "vi.resetModules" },
    ];
    const text = formatCertify(
      "web",
      "show",
      {
        on: true,
        greenSha: HEAD,
        policy: { enabled: true, repair: false, excludeTests: ["src/request.test.ts > clones"] },
        results: [cert({ counts, unsupportedTests }), cert({ trunkSha: "b".repeat(40), counts, unsupportedTests })],
      },
      plain,
      0,
    );
    const lines = text.split("\n");
    expect(lines).toContain('excluded   "src/request.test.ts > clones" (counted as unsupported)');
    expect(lines).toContain('    unsupported  "a > snapshots" (toMatchSnapshot), "b > resets" (vi.resetModules) +1');
    expect(lines.filter((l) => l.includes("unsupported  "))).toHaveLength(1);
  });
});
