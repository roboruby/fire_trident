import { describe, expect, it } from "vitest";
import type { NoteCheck, NotesVerification } from "@fire_trident/core";
import { parseCommand, helpText } from "../src/args.ts";
import { planRequest } from "../src/api.ts";
import { colors, formatVerify, verifyFailed } from "../src/format.ts";
import { main, type Io } from "../src/run.ts";

/** `ft verify <colony>`: the newest lineage notes on the trunk repository against the FT-Note trailers of their commits. */

const plain = colors(false);
const NOW = 1_000_000_000;
const sha = (c: string): string => c.repeat(40);
const check = (landingId: string, status: NoteCheck["status"], extra: Partial<NoteCheck> = {}): NoteCheck => ({ landingId, trunkSha: sha(landingId.slice(-1)), at: NOW - 120_000, status, ...extra });

const report: NotesVerification = {
  colonyId: "web",
  notesTip: sha("9"),
  notes: [
    check("lnd_1", "pending", { detail: "the note is not on the trunk repository yet (its push is due)" }),
    check("lnd_2", "altered", { ownCopy: true, detail: "the note hashes to 0123456789ab, the commit's trailer says ba9876543210" }),
    check("lnd_3", "intact", { ownCopy: true }),
    check("lnd_4", "missing", { ownCopy: false, detail: "the trunk repository has no note for this commit" }),
    check("lnd_5", "no-trailer"),
  ],
  counts: { pending: 1, altered: 1, intact: 1, missing: 1, "no-trailer": 1 },
  at: NOW,
};

describe("parsing and the request", () => {
  it("takes a colony and an optional limit", () => {
    expect(parseCommand(["verify", "web"])).toMatchObject({ ok: true, command: { name: "verify", colony: "web" } });
    expect(parseCommand(["verify", "web", "--limit", "50"])).toMatchObject({ ok: true, command: { name: "verify", colony: "web", limit: 50 } });
    for (const bad of [["verify"], ["verify", "web", "extra"], ["verify", "web", "--limit", "0"], ["verify", "web", "--limit", "201"], ["verify", "web", "--limit", "x"]]) {
      expect(parseCommand(bad).ok).toBe(false);
    }
    expect(helpText("verify")).toContain("FT-Note trailer");
    expect(helpText()).toContain("verify <colony>");
  });

  it("asks the notes check route", () => {
    expect(planRequest({ name: "verify", colony: "web" }, "me")).toEqual({ method: "GET", path: "/api/colonies/web/notes/verify" });
    expect(planRequest({ name: "verify", colony: "web", limit: 50 }, "me")).toEqual({ method: "GET", path: "/api/colonies/web/notes/verify?limit=50" });
  });
});

describe("formatVerify", () => {
  it("counts each status, then lists each note that is not intact with why", () => {
    expect(formatVerify("web", report, plain, NOW).split("\n")).toEqual([
      "web lineage notes on the trunk repository against each commit's FT-Note trailer (newest 5 landings; notes commit 9999999)",
      "  ✓ 1 intact · ✗ 1 altered · ✗ 1 missing · … 1 not pushed yet · - 1 landed before commits carried the note's digest",
      "  ✗ lnd_2 2222222 2m ago  the note hashes to 0123456789ab, the commit's trailer says ba9876543210; FireTrident's own copy still matches the trailer",
      "  ✗ lnd_4 4444444 2m ago  the trunk repository has no note for this commit; FireTrident's own copy does not match the trailer",
      "  … lnd_1 1111111 2m ago  the note is not on the trunk repository yet (its push is due)",
      "  A commit's trailer cannot change without changing the commit: the note on the repository is what changed.",
    ]);
  });

  it("reads an empty or odd answer without failing, and lists at most ten notes of a status", () => {
    expect(formatVerify("web", { colonyId: "web", notesTip: null, notes: [], counts: {}, at: 0 }, plain, NOW)).toBe(
      "web lineage notes on the trunk repository against each commit's FT-Note trailer (newest 0 landings; the trunk repository has no notes)\n  no landings yet",
    );
    expect(formatVerify("web", null, plain, NOW)).toContain("no landings yet");
    const odd = formatVerify("web", { notes: [null, 3, { landingId: "lnd_x", trunkSha: sha("x"), status: "smudged" }] }, plain, NOW);
    expect(odd).toContain("? 1 smudged");
    expect(odd).toContain("  ? lnd_x xxxxxxx  smudged");
    const many = formatVerify("web", { ...report, notes: Array.from({ length: 13 }, (_, i) => check(`lnd_${i}`, "missing")) }, plain, NOW);
    expect(many).toContain("✗ 13 missing");
    expect(many).toContain("    +3 more");
  });

  it("fails only on an altered or missing note", () => {
    expect(verifyFailed(report)).toBe(true);
    expect(verifyFailed({ notes: [check("a", "intact"), check("b", "pending"), check("c", "no-trailer"), check("d", "unreadable")] })).toBe(false);
    expect(verifyFailed(null)).toBe(false);
  });
});

describe("ft verify against a server", () => {
  function io(body: unknown): Io & { out: string[]; paths: string[] } {
    const out: string[] = [];
    const paths: string[] = [];
    const fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      paths.push(`${url.pathname}${url.search}`);
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof globalThis.fetch;
    return {
      env: { FT_URL: "https://ft.test", NO_COLOR: "1" },
      stdout: (l) => void out.push(l),
      stderr: () => {},
      isTTY: false,
      fetch,
      readFile: async () => "",
      sleep: async () => {},
      now: () => NOW,
      WebSocket: globalThis.WebSocket,
      onInterrupt: () => {},
      out,
      paths,
    };
  }

  it("exits 1 when a note was altered or is missing, and 0 otherwise, as text or JSON", async () => {
    const bad = io(report);
    expect(await main(["verify", "web", "--limit", "5"], bad)).toBe(1);
    expect(bad.paths).toEqual(["/api/colonies/web/notes/verify?limit=5"]);
    expect(bad.out.join("\n")).toContain("✗ 1 altered");
    const good = io({ ...report, notes: [check("lnd_3", "intact")] });
    expect(await main(["verify", "web"], good)).toBe(0);
    const json = io(report);
    expect(await main(["verify", "web", "--json"], json)).toBe(1);
    expect(JSON.parse(json.out.join("\n"))).toEqual(report);
  });
});
