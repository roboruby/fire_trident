import { describe, expect, it } from "vitest";
import type { ColonySnapshot, MegafileHold } from "@fire_trident/core";
import { helpText, parseCommand } from "../src/args.ts";
import { planRequest } from "../src/api.ts";
import { colors, formatStatus } from "../src/format.ts";
import { formatMegafile, holdNumbers, megafileLines } from "../src/megafile.ts";
import { main } from "../src/run.ts";
import type { Io } from "../src/run.ts";

/** The megafile alarm in the CLI: held files in ft status, and ft megafile to list them or hold or release one. */

const c = colors(false);
const NOW = 10_000_000;
const MIN = 60_000;
const colony = { id: "web", name: "web", trunk: { namespace: "n", name: "x", remote: "r" }, trunkSha: "a".repeat(40), createdAt: 0, regionDepth: 1 } as ColonySnapshot["colony"];

const held: MegafileHold = {
  path: "src/big.ts",
  intentId: "int_split",
  by: "colony",
  at: NOW - 6 * MIN,
  until: NOW + 54 * MIN,
  signal: "growth",
  lines: 830,
  baseline: 650,
  growth: 180 / 650,
  agents: 5,
  returns: 0,
  windowMs: 30 * MIN,
};
const lifted: MegafileHold = { ...held, path: "src/hub.ts", intentId: "int_old", liftedAt: NOW - 12 * MIN, lifted: "landed", linesAfter: 40 };

function ok(argv: string[]) {
  const r = parseCommand(argv);
  if (!r.ok) throw new Error(`expected success, got: ${r.error}`);
  return r.command;
}

function err(argv: string[]): string {
  const r = parseCommand(argv);
  if (r.ok) throw new Error(`expected a usage error for ${argv.join(" ")}`);
  return r.error;
}

describe("ft megafile: parsing and requests", () => {
  it("lists, holds or releases", () => {
    expect(ok(["megafile", "web"])).toEqual({ name: "megafile", colony: "web", release: false });
    expect(ok(["megafile", "web", "./src/big.ts", "--by", "maya"])).toEqual({ name: "megafile", colony: "web", path: "src/big.ts", release: false, by: "maya" });
    expect(ok(["megafile", "web", "src/big.ts", "--release"])).toEqual({ name: "megafile", colony: "web", path: "src/big.ts", release: true });
    expect(err(["megafile"])).toMatch(/missing <colony>/);
    expect(err(["megafile", "web", "--release"])).toMatch(/name the file to release/);
    expect(err(["megafile", "web", "a.ts", "b.ts"])).toMatch(/unexpected argument "b.ts"/);
    expect(helpText("megafile")).toMatch(/^ft megafile <colony>/);
    expect(helpText()).toContain("megafile <colony> [path]");
  });

  it("asks the colony's megafile route", () => {
    expect(planRequest(ok(["megafile", "web"]), "matt")).toEqual({ method: "GET", path: "/api/colonies/web/megafile" });
    expect(planRequest(ok(["megafile", "web", "src/big.ts"]), "matt")).toEqual({ method: "POST", path: "/api/colonies/web/megafile", body: { path: "src/big.ts", action: "hold", by: "matt" } });
    expect(planRequest(ok(["megafile", "web", "src/big.ts", "--release", "--by", "maya"]), "matt")).toEqual({
      method: "POST",
      path: "/api/colonies/web/megafile",
      body: { path: "src/big.ts", action: "release", by: "maya" },
    });
  });
});

describe("ft megafile and ft status: output", () => {
  it("lists each held file with its split, when the hold lifts, its numbers and the release command; then lifted holds", () => {
    expect(holdNumbers(held)).toBe("growth: 830 lines, from 650 (+28%) in 30m, 5 agents, 0 returns");
    expect(megafileLines({ held: [held], lifted: [lifted] }, "web", c, NOW)).toEqual([
      "megafiles  1 held for a split",
      "  src/big.ts  split by int_split, lifts in 54m  growth: 830 lines, from 650 (+28%) in 30m, 5 agents, 0 returns",
      "        → release it: ft megafile web src/big.ts --release",
      "  lifted 12m ago: src/hub.ts (landed, 830 → 40 lines)",
    ]);
    expect(megafileLines({ held: [], lifted: [] }, "web", c, NOW)).toEqual(["megafiles  none held"]);
  });

  it("shows the held files in ft status only when the server sends them", () => {
    expect(formatStatus({ colony, megafiles: { at: NOW, held: [held], lifted: [] } }, c, NOW)).toContain("megafiles  1 held for a split");
    expect(formatStatus({ colony }, c, NOW)).not.toContain("megafiles");
  });

  it("answers a hold, a hold already standing, a release, and an alarm that is off", () => {
    expect(formatMegafile({ colony: "web", path: "src/big.ts", release: false }, { hold: held, already: false }, c, NOW).split("\n")[0]).toBe("Held src/big.ts for its split: intent int_split");
    expect(formatMegafile({ colony: "web", path: "src/big.ts", release: false }, { hold: held, already: true }, c, NOW)).toMatch(/^Already held src\/big\.ts/);
    expect(formatMegafile({ colony: "web", path: "src/big.ts", release: true }, { released: { ...held, lifted: "released by maya" } }, c, NOW)).toBe(
      "Released src/big.ts (released by maya)\n  Its split intent int_split stays open for any agent.",
    );
    expect(formatMegafile({ colony: "web", release: false }, { on: false, held: [], lifted: [] }, c, NOW)).toMatch(/the megafile alarm is off for web/);
  });

  it("keeps server text on one line", () => {
    expect(megafileLines({ held: [{ ...held, path: "src/a\u001b[31m.ts" }], lifted: [] }, "web", c, NOW)[1]).toContain("src/a [31m.ts");
  });
});

describe("ft megafile: running", () => {
  it("holds a file through the API", async () => {
    const out: string[] = [];
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    const fake: Io = {
      env: { FT_URL: "https://ft.test", FT_TOKEN: "t", FT_USER: "matt" },
      stdout: (line) => out.push(line),
      stderr: (line) => out.push(line),
      isTTY: false,
      fetch: (async (url: string, init?: RequestInit) => {
        calls.push({ method: init?.method ?? "GET", url, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
        return new Response(JSON.stringify({ hold: held, already: false }), { status: 201, headers: { "content-type": "application/json" } });
      }) as typeof fetch,
      readFile: async () => "",
      sleep: async () => undefined,
      now: () => NOW,
      WebSocket: globalThis.WebSocket,
      onInterrupt: () => undefined,
    };
    expect(await main(["megafile", "web", "src/big.ts"], fake)).toBe(0);
    expect(calls).toEqual([{ method: "POST", url: "https://ft.test/api/colonies/web/megafile", body: { path: "src/big.ts", action: "hold", by: "matt" } }]);
    expect(out.join("\n")).toContain("Held src/big.ts for its split: intent int_split");
  });
});
