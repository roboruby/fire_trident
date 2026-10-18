import { describe, expect, it } from "vitest";
import type { ColonySnapshot } from "@fire_trident/core";
import { certCounts, certTitle } from "../src/certs.ts";
import { ColonyStore } from "../src/store.ts";

/** Tests that used an API trunk certification does not support count apart: the certification view names them. */

const A = "a".repeat(40);
const B = "b".repeat(40);
const counts = { tests: 60, pass: 57, fail: 0, cancelled: 0, skipped: 0, todo: 0, suites: 3, unsupported: 3 };
const unsupportedTests = [
  { name: "a > snapshots", file: "test/a.test.ts", api: "toMatchSnapshot" },
  { name: "b > resets", file: "test/b.test.ts", api: "vi.resetModules" },
];

describe("unsupported tests in the certification view", () => {
  it("counts them and lists them in the title, from a result and from a certify event", () => {
    const s = new ColonyStore("web");
    s.setCert({ trunkSha: A, status: "green", at: 1, counts, unsupportedTests });
    const view = s.certs.get(A)!;
    expect(certCounts(view)).toBe("57/60 tests · 3 unsupported");
    expect(certTitle(view)).toBe("aaaaaaa: 57 of 60 tests pass, 3 unsupported (node:test in a Dynamic Worker)\nNot supported here, counted apart:\n• a > snapshots: toMatchSnapshot\n• b > resets: vi.resetModules\n… and 1 more");
    s.applyEvents([{ t: "certify", at: 2, trunkSha: B, status: "red", counts: { ...counts, pass: 55, fail: 2 }, failing: [{ name: "x", file: "test/x.test.ts" }], unsupportedTests }]);
    const red = s.certs.get(B)!;
    expect(certCounts(red)).toBe("2 failing · 3 unsupported");
    expect(certTitle(red)).toMatch(/^bbbbbbb: 2 of 60 tests failing \(3 unsupported\)\n• x\n… and 1 more\nNot supported here, counted apart:\n• a > snapshots: toMatchSnapshot\n/);
  });

  it("reads results without them as before", () => {
    const s = new ColonyStore("web");
    const { unsupported: _, ...old } = counts;
    s.applySnapshot({
      colony: { id: "web", name: "web", trunk: { namespace: "n", name: "t", remote: "r" }, trunkSha: A, greenSha: A, createdAt: 0, regionDepth: 1, certification: { trunkSha: A, status: "green", startedAt: 1, finishedAt: 2, counts: { ...old, tests: 57 } } },
      files: [],
      intents: [],
      rules: [],
      agents: [],
      recentLandings: [],
      violations: { total: 0, byRule: {} },
      funnel: { reflex: 0, llm: 0, human: 0 },
      metrics: {},
    } as unknown as ColonySnapshot);
    expect(certTitle(s.certs.get(A)!)).toBe("aaaaaaa: all 57 tests pass (node:test in a Dynamic Worker)");
  });
});
