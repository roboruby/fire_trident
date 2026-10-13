import { describe, expect, it } from "vitest";
import type { Certification, ColonyEvent, NoteCertification } from "@fire_trident/core";
import { colors, formatEvent, formatStatus, formatWhy, noteCertLine, testsPhrase, trunkLine } from "../src/format.ts";

const plain = colors(false);
const clock = () => "12:00:00";
const HEAD = "a".repeat(40);
const GREEN = "b".repeat(40);
const counts = (pass: number, fail: number) => ({ tests: pass + fail, pass, fail, cancelled: 0, skipped: 0, todo: 0, suites: 0 });
const cert = (over: Partial<Certification>): Certification => ({ trunkSha: HEAD, status: "green", startedAt: 0, ...over });

describe("trunk certification in the CLI", () => {
  it("phrases test counts", () => {
    expect(testsPhrase({ counts: counts(60, 0) })).toBe("60/60 tests");
    expect(testsPhrase({ counts: counts(62, 5) })).toBe("5 of 67 failing");
    expect(testsPhrase({ counts: { ...counts(3, 0), tests: 5, skipped: 1, todo: 1 } })).toBe("3/5 tests · 1 skipped · 1 todo");
    expect(testsPhrase({ counts: { ...counts(58, 0), tests: 60, skipped: 2 } })).toBe("58/60 tests · 2 skipped");
    expect(testsPhrase({ counts: { ...counts(58, 0), tests: 60, skipped: 2 } }, "pass")).toBe("58/60 tests pass · 2 skipped");
    expect(testsPhrase({ counts: { ...counts(62, 5), tests: 68, todo: 1 } })).toBe("5 of 68 failing · 1 todo");
  });

  it("names skipped and todo tests wherever it prints counts", () => {
    const skipped = { ...counts(58, 0), tests: 60, skipped: 2 };
    expect(trunkLine({ trunkSha: HEAD, greenSha: HEAD, certification: cert({ counts: skipped }) }, plain)).toBe("aaaaaaa  ✓ green, 58/60 tests · 2 skipped");
    expect(noteCertLine({ runner: "x", status: "green", counts: skipped, durationMs: 1_234 }, plain)).toBe("✓ 58/60 tests pass · 2 skipped in 1.2 s");
    expect(formatEvent({ t: "certify", at: 0, trunkSha: HEAD, status: "green", counts: { ...skipped, todo: 1, tests: 61 } }, plain, clock)).toMatch(/✓ green, 58\/61 tests · 2 skipped · 1 todo$/);
  });

  it("shows the head's tests and the newest green commit on the trunk row", () => {
    expect(trunkLine({ trunkSha: HEAD }, plain)).toBe("aaaaaaa  not certified yet");
    expect(trunkLine({ trunkSha: HEAD, greenSha: HEAD, certification: cert({ counts: counts(60, 0) }) }, plain)).toBe("aaaaaaa  ✓ green, 60/60 tests");
    const red = cert({ status: "red", counts: counts(62, 5), failing: [{ name: "A6: DELETE requires admin token", file: "test/acceptance.test.ts" }, { name: "KvStore", file: "test/store.kv.test.ts" }] });
    expect(trunkLine({ trunkSha: HEAD, greenSha: GREEN, certification: red }, plain)).toBe('aaaaaaa  ✗ red, 5 of 67 failing "A6: DELETE requires admin token", "KvStore"  green bbbbbbb');
    expect(trunkLine({ trunkSha: HEAD, certification: { ...red, failing: [] } }, plain)).toBe("aaaaaaa  ✗ red, 5 of 67 failing  never green yet");
    expect(trunkLine({ trunkSha: HEAD, greenSha: GREEN, certification: cert({ status: "running" }) }, plain)).toBe("aaaaaaa  testing…  green bbbbbbb");
    expect(trunkLine({ trunkSha: HEAD, certification: cert({ status: "skipped", detail: "no test files (*.test.ts or *.test.js)" }) }, plain)).toBe("aaaaaaa  no test files (*.test.ts or *.test.js)");
    expect(trunkLine({ trunkSha: HEAD, greenSha: GREEN, certification: cert({ status: "error", detail: "the test run used up its CPU or time limit" }) }, plain)).toBe(
      "aaaaaaa  tests could not run: the test run used up its CPU or time limit  green bbbbbbb",
    );
    // Trunk moved on since the last result.
    expect(trunkLine({ trunkSha: HEAD, greenSha: GREEN, certification: cert({ trunkSha: GREEN, counts: counts(60, 0) }) }, plain)).toBe(
      "aaaaaaa  ✓ green, 60/60 tests (certified bbbbbbb; head not yet)  green bbbbbbb",
    );
    const colony = { id: "x", name: "x", trunk: { namespace: "n", name: "x", remote: "r" }, trunkSha: HEAD, greenSha: HEAD, createdAt: 0, regionDepth: 1, certification: cert({ counts: counts(60, 0) }) };
    expect(formatStatus({ colony }, plain, 0)).toContain("trunk      aaaaaaa  ✓ green, 60/60 tests");
  });

  it("prints certify events in ft watch", () => {
    const e = (over: Partial<Extract<ColonyEvent, { t: "certify" }>>): ColonyEvent => ({ t: "certify", at: 0, trunkSha: HEAD, status: "running", ...over });
    expect(formatEvent(e({}), plain, clock)).toMatch(/^12:00:00 certify\s+aaaaaaa testing…$/);
    expect(formatEvent(e({ status: "green", counts: counts(60, 0) }), plain, clock)).toMatch(/certify\s+aaaaaaa ✓ green, 60\/60 tests$/);
    expect(formatEvent(e({ status: "red", counts: counts(1, 1), failing: [{ name: "subtracts", file: "t.ts" }], greenSha: GREEN }), plain, clock)).toMatch(
      /certify\s+aaaaaaa ✗ red, 1 of 2 failing "subtracts" · green bbbbbbb$/,
    );
    expect(formatEvent(e({ status: "skipped", detail: "no test files" }), plain, clock)).toMatch(/certify\s+aaaaaaa skipped: no test files$/);
  });

  it("shows a landing's certification in ft why", () => {
    const note: NoteCertification = { runner: "x", status: "red", counts: counts(1, 1), failing: [{ name: "subtracts", file: "t.ts" }], durationMs: 1_234 };
    expect(noteCertLine(note, plain)).toBe('✗ 1 of 2 failing "subtracts" in 1.2 s');
    expect(noteCertLine({ ...note, status: "green", counts: counts(2, 0), failing: [], reusedFrom: GREEN }, plain)).toBe("✓ 2/2 tests pass in 1.2 s (same tested files as bbbbbbb)");
    const entries = [{ landing: { id: "lnd_1", trunkSha: HEAD, parentSha: GREEN, at: 1 }, note: { proposals: [], certification: note } }] as unknown as Parameters<typeof formatWhy>[1];
    expect(formatWhy({ path: "src/a.ts" }, entries, {}, plain, 0)).toContain('  tests    ✗ 1 of 2 failing "subtracts" in 1.2 s');
  });
});

describe("ft certify", () => {
  it("parses the command and plans its requests", async () => {
    const { parseCommand } = await import("../src/args.ts");
    const { planRequest } = await import("../src/api.ts");
    const show = parseCommand(["certify", "web"]);
    expect(show).toMatchObject({ ok: true, command: { name: "certify", colony: "web", action: "show" } });
    const cmd = (argv: string[]) => {
      const p = parseCommand(argv);
      if (!p.ok) throw new Error(p.error);
      return planRequest(p.command, "me");
    };
    expect(cmd(["certify", "web"])).toEqual({ method: "GET", path: "/api/colonies/web/certifications?limit=10" });
    expect(cmd(["certify", "web", "--now"])).toEqual({ method: "POST", path: "/api/colonies/web/certify" });
    expect(cmd(["certify", "web", "--off"])).toEqual({ method: "POST", path: "/api/colonies/web/certify/policy", body: { enabled: false } });
    expect(parseCommand(["certify", "web", "--on", "--off"])).toMatchObject({ ok: false, error: expect.stringContaining("choose one") });
    expect(parseCommand(["watch", "web", "--only", "certify"])).toMatchObject({ ok: true, command: { only: ["certify"] } });
  });

  it("prints the state and the latest results", async () => {
    const { formatCertify } = await import("../src/format.ts");
    const text = formatCertify(
      "web",
      "show",
      {
        on: true,
        running: false,
        greenSha: GREEN,
        policy: { enabled: true, repair: true, repairsPerHour: 3 },
        results: [
          cert({ status: "red", counts: counts(1, 1), failing: [{ name: "subtracts", file: "t.ts" }], durationMs: 120, repairIntentId: "int_1", startedAt: 0 }),
          cert({ trunkSha: GREEN, counts: counts(2, 0), durationMs: 80, cached: 1, startedAt: 0 }),
        ],
      },
      plain,
      0,
    );
    expect(text.split("\n")).toEqual([
      "web trunk certification on",
      "green      bbbbbbb",
      "repairs    on, at most 3 an hour",
      '  aaaaaaa just now  ✗ 1 of 2 failing "subtracts"  (120 ms, repair int_1)',
      "  bbbbbbb just now  ✓ 2/2 tests  (80 ms, 1 file reused)",
    ]);
    expect(formatCertify("web", "now", { started: false, reason: "certification is off for this colony (policy)" }, plain, 0)).toBe("! not started: certification is off for this colony (policy)");
    expect(formatCertify("web", "off", { enabled: false }, plain, 0)).toBe("✓ trunk certification off for web");
  });

  it("says in its help what the certified branch holds and to deploy from it", async () => {
    const { helpText } = await import("../src/args.ts");
    const help = helpText("certify").replace(/\s+/g, " ");
    expect(help).toContain("A green run moves the trunk's certified branch to that commit: every test file it could run passed and no test that passed before was lost.");
    expect(help).toContain("main holds every landing, tested or not; deploy, release and pin from certified (git clone -b certified <url>).");
  });
});
