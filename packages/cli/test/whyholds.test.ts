import { describe, expect, it } from "vitest";
import type { Landing, LineageNote, WhyHolds, WhyWalk } from "@fire_trident/core";
import { colors, formatWhy } from "../src/format.ts";
import { main, type Io } from "../src/run.ts";

/**
 * `ft why` about today: under a line's heading, how the walk found the landing that wrote it (formatting-only landings
 * skipped, code moved from another file followed), and on each landing a holds row that says whether it still holds,
 * ended with the current certification of the tests that cover it.
 */

const plain = colors(false);
const SHA = "e".repeat(40);
const landing = (id: string, at: number, paths: string[]): Landing => ({ id, colonyId: "web", trunkSha: "b".repeat(40), parentSha: "a".repeat(40), proposalIds: [`prp_${id}`], intentIds: [], paths, regions: ["src"], at });
const note = (id: string, path: string): LineageNote =>
  ({
    schema: "firetrident.lineage/v1",
    landingId: id,
    colonyId: "web",
    proposals: [{ id: `prp_${id}`, agentId: "agt_1", agentKind: "internal", intent: { id: `int_${id}`, title: `change ${id}`, why: "" }, writeSet: [{ path, blob: "c".repeat(40) }], readSet: [], decisions: [], evidence: { checks: [] } }],
  }) as unknown as LineageNote;
const holds = (path: string, state: "same" | "changed", by?: string): WhyHolds => ({ wrote: { path, state, ...(by ? { by, landings: 1 } : {}) }, others: { files: 0, changed: 0, list: [] } });
const walk: WhyWalk = {
  landingId: "lnd_old",
  path: "src/util.ts",
  line: 7,
  skipped: [{ landingId: "lnd_fmt", path: "src/total.ts" }],
  moved: [{ landingId: "lnd_move", from: "src/util.ts", to: "src/total.ts", line: 7 }],
};
// As the trunk writer answers a line: the landing that wrote it (in the other file) first, then the file's own, newest first.
const ENTRIES = [
  { landing: landing("lnd_old", 1_000, ["src/util.ts"]), note: note("lnd_old", "src/util.ts"), holds: holds("src/util.ts", "changed", "lnd_move"), walk },
  { landing: landing("lnd_fmt", 3_000, ["src/total.ts"]), note: note("lnd_fmt", "src/total.ts"), holds: holds("src/total.ts", "same") },
  { landing: landing("lnd_move", 2_000, ["src/util.ts", "src/total.ts"]), note: note("lnd_move", "src/total.ts"), holds: holds("src/total.ts", "changed", "lnd_fmt") },
];

describe("ft why: does it still hold", () => {
  it("prints the walk under the heading and a holds row on each landing", () => {
    const text = formatWhy({ path: "src/total.ts", line: 4 }, ENTRIES, { certification: { trunkSha: SHA, status: "green" } }, plain, 10_000);
    expect(text).toContain(
      [
        "src/total.ts:4  3 landings, the landing that wrote line 4 first, then newest first",
        "  line 4 written by lnd_old at src/util.ts:7",
        "  moved from src/util.ts:7 by lnd_move",
        "  skipped 1 formatting-only landing: lnd_fmt",
      ].join("\n"),
    );
    expect(text).toContain("  holds    src/util.ts changed since by lnd_move · trunk tests green at eeeeeee\n");
    expect(text).toContain("  holds    src/total.ts as it wrote it · trunk tests green at eeeeeee\n");
    // The landing that wrote the line in the other file shows the change that wrote that file.
    expect(text).toContain('intent   int_lnd_old "change lnd_old"');
    expect(text).not.toContain("other proposal(s) in this landing touched other files");
  });

  it("uses the closure data of a landing's test row for the tests that cover it", () => {
    const tests = {
      lnd_fmt: { colonyId: "web", landingId: "lnd_fmt", trunkSha: SHA, baseSha: SHA, status: "certified" as const, proof: { rungs: [], text: "deterministic" }, text: "row", reach: { earlier: 2, own: 0, later: 0, earlierFiles: ["test/a.test.ts", "test/b.test.ts"], ownFiles: [], checked: 4 } },
    };
    const red = { trunkSha: SHA, status: "red" as const, failing: [{ name: "adds", file: "test/b.test.ts" }] };
    const text = formatWhy({ path: "src/total.ts", line: 4 }, ENTRIES, { tests, certification: red }, plain, 10_000);
    expect(text).toContain("  holds    src/total.ts as it wrote it · covered by 2 test files, 1 failing at eeeeeee: test/b.test.ts\n");
    expect(text).toContain("  holds    src/util.ts changed since by lnd_move · trunk tests red at eeeeeee (1 test file failing)\n");
  });

  it("keeps the old reading for a server before the walk and holds", () => {
    const old = ENTRIES.map(({ landing: l, note: n }) => ({ landing: l, note: n }));
    const text = formatWhy({ path: "src/total.ts", line: 4 }, old, {}, plain, 10_000);
    expect(text).toContain("src/total.ts:4  3 landings, the landing that wrote line 4 first, then newest first");
    expect(text).not.toContain("holds ");
    expect(text).not.toContain("formatting-only");
  });

  it("reads the latest certification with the lineage and ends each holds row with it", async () => {
    const out: string[] = [];
    const seen: string[] = [];
    const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const fetcher = (async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      seen.push(url.pathname);
      if (url.pathname === "/api/colonies/web/why") return reply(200, ENTRIES);
      if (url.pathname === "/api/colonies/web") return reply(200, { colony: { id: "web", name: "web", trunkSha: SHA, certification: { trunkSha: SHA, status: "green", startedAt: 0, counts: { tests: 9, pass: 9, fail: 0, cancelled: 0, skipped: 0, todo: 0, suites: 1 } } }, intents: [], rules: [] });
      return reply(404, { error: "no row" });
    }) as typeof fetch;
    const io: Io = {
      env: { FT_URL: "http://ft.test", FT_USER: "tester", NO_COLOR: "1" },
      stdout: (l) => void out.push(l),
      stderr: () => undefined,
      isTTY: false,
      fetch: fetcher,
      readFile: async () => "",
      sleep: async () => undefined,
      now: () => 10_000,
      WebSocket: globalThis.WebSocket,
      onInterrupt: () => undefined,
    };
    expect(await main(["why", "web", "src/total.ts:4"], io)).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("  line 4 written by lnd_old at src/util.ts:7");
    expect(text).toContain("  holds    src/total.ts as it wrote it · trunk tests green at eeeeeee (9/9)");
    expect(seen).toContain("/api/colonies/web");
  });
});
