import { describe, expect, it } from "vitest";
import type { ColonyEvent, Landing } from "@fire_trident/core";
import type { Command } from "../src/args.ts";
import { helpText, parseCommand } from "../src/args.ts";
import { planRequest, revertRequest } from "../src/api.ts";
import { colors, formatEvent, formatRevert } from "../src/format.ts";
import { main } from "../src/run.ts";
import type { Io } from "../src/run.ts";

const c = colors(false);
const sha = (ch: string): string => ch.repeat(40);

/** A landing of three proposals, and the commit that reverted one of them. */
const landing: Landing = {
  id: "lnd_1",
  colonyId: "web",
  trunkSha: sha("b"),
  parentSha: sha("a"),
  proposalIds: ["prp_1", "prp_2", "prp_3"],
  intentIds: ["int_1", "int_2", "int_3"],
  paths: ["src/a.ts", "src/b.ts", "src/c.ts"],
  regions: ["src"],
  at: 0,
};
const revertCommit: Landing = { id: "lnd_2", colonyId: "web", trunkSha: sha("c"), parentSha: sha("b"), proposalIds: [], intentIds: [], paths: ["src/a.ts"], regions: ["src"], at: 1 };

function revertCommand(argv: string[]): Extract<Command, { name: "revert" }> {
  const r = parseCommand(argv);
  if (!r.ok || r.command.name !== "revert") throw new Error(`expected a revert command for ${argv.join(" ")}`);
  return r.command;
}

describe("ft revert <colony> <proposal>", () => {
  it("parses a proposal id where a landing goes, and plans it as two calls", () => {
    const cmd = revertCommand(["revert", "web", "prp_1", "--reason", "only this broke it", "--by", "matt"]);
    expect(cmd).toEqual({ name: "revert", colony: "web", ref: "prp_1", reason: "only this broke it", redo: true, by: "matt" });
    // Its landing is read first, so it is not one call; the revert then names the proposal.
    expect(planRequest(cmd, "me")).toBeNull();
    expect(revertRequest(cmd, "me", "lnd_1")).toEqual({
      method: "POST",
      path: "/api/colonies/web/landings/lnd_1/revert",
      body: { reason: "only this broke it", by: "matt", redo: true, proposal: "prp_1" },
    });
    // A landing or a commit stays one call, with no proposal in the body.
    expect(revertRequest(revertCommand(["revert", "web", "97b1036", "--reason", "r", "--no-redo"]), "me")).toEqual({
      method: "POST",
      path: "/api/colonies/web/landings/97b1036/revert",
      body: { reason: "r", by: "me", redo: false },
    });
    expect(helpText("revert")).toContain("ft revert <colony> <landing|commit|proposal>");
    expect(helpText("revert")).toContain("ft revert hono prp_");
    expect(helpText()).toContain("revert <colony> <landing|prp>    Undo a landing or one proposal of it");
  });

  it("prints the proposal undone, its files, and the proposals of its landing that stayed", () => {
    expect(formatRevert("prp_1", "breaks it", { landing: revertCommit, reverted: landing, redo: ["int_9"], proposal: "prp_1" }, c)).toBe(
      [
        "Reverted prp_1 of lnd_1 (bbbbbbb) as lnd_2 (ccccccc): breaks it",
        "  undone  src/a.ts",
        "  stayed  prp_2, prp_3 (the rest of lnd_1, untouched)",
        "  1 intent declared again: int_9",
      ].join("\n"),
    );
    const alone = formatRevert("prp_1", "r", { landing: revertCommit, reverted: { ...landing, proposalIds: ["prp_1"] }, redo: [], proposal: "prp_1" }, c);
    expect(alone).toContain("  stayed  nothing else: it was the only proposal of lnd_1");
    // A whole landing: every file it undid, and no "stayed" line.
    expect(formatRevert("lnd_1", "r", { landing: { ...revertCommit, paths: landing.paths }, reverted: landing, redo: [] }, c)).toBe(
      ["Reverted lnd_1 (bbbbbbb) as lnd_2 (ccccccc): r", "  undone  src/a.ts, src/b.ts, src/c.ts"].join("\n"),
    );
    // Many files and proposals are cut short.
    const wide = formatRevert("prp_1", "r", { landing: { ...revertCommit, paths: Array.from({ length: 7 }, (_, i) => `src/f${i}.ts`) }, reverted: { ...landing, proposalIds: Array.from({ length: 8 }, (_, i) => `prp_${i + 1}`) }, proposal: "prp_1" }, c);
    expect(wide).toContain("  undone  src/f0.ts, src/f1.ts, src/f2.ts, src/f3.ts, src/f4.ts +2");
    expect(wide).toContain("  stayed  prp_2, prp_3, prp_4, prp_5, prp_6 +2 (the rest of lnd_1, untouched)");
  });

  it("names the proposal in the event line", () => {
    const e = { t: "reverted", at: 0, landingId: "lnd_2", of: "lnd_1", trunkSha: sha("c"), paths: ["src/a.ts"], reason: "breaks it", by: "matt", redo: [], proposal: "prp_1" } as ColonyEvent;
    expect(formatEvent(e, c, () => "12:00:00")).toBe("12:00:00 reverted   prp_1 of lnd_1 by matt: breaks it as lnd_2");
  });
});

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

/** An Io whose fetch answers from `route` and records every call (no network). */
function io(route: (call: Call) => { status: number; body: unknown }): Io & { out: string[]; err: string[]; calls: Call[] } {
  const out: string[] = [];
  const err: string[] = [];
  const calls: Call[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = { method: init?.method ?? "GET", path: new URL(String(input)).pathname };
    if (typeof init?.body === "string") call.body = JSON.parse(init.body);
    calls.push(call);
    const answer = route(call);
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  return {
    env: { FT_URL: "https://ft.test", FT_TOKEN: "tok", FT_USER: "tester", NO_COLOR: "1" },
    stdout: (l) => void out.push(l),
    stderr: (l) => void err.push(l),
    isTTY: false,
    fetch,
    readFile: async () => "",
    sleep: async () => {},
    now: () => 0,
    WebSocket: globalThis.WebSocket,
    onInterrupt: () => {},
    out,
    err,
    calls,
  };
}

/** The server side of these tests: prp_1 landed in lnd_1, prp_7 went back; reverts answer like ColonyDO.revertLanding. */
function server(call: Call): { status: number; body: unknown } {
  const key = `${call.method} ${call.path}`;
  if (key === "GET /api/colonies/web/proposals/prp_1") return { status: 200, body: { id: "prp_1", intentId: "int_1", status: "landed", landingId: "lnd_1" } };
  if (key === "GET /api/colonies/web/proposals/prp_7") return { status: 200, body: { id: "prp_7", intentId: "int_7", status: "returned", reason: "stale" } };
  if (key === "POST /api/colonies/web/landings/lnd_1/revert") {
    const proposal = (call.body as { proposal?: string }).proposal;
    return { status: 200, body: { landing: proposal ? revertCommit : { ...revertCommit, paths: landing.paths }, reverted: landing, redo: ["int_9"], ...(proposal ? { proposal } : {}) } };
  }
  return { status: 404, body: { error: `no route for ${key}` } };
}

describe("ft revert against a server", () => {
  it("reads the proposal's landing, then reverts only that proposal and says what stayed", async () => {
    const t = io(server);
    expect(await main(["revert", "web", "prp_1", "--reason", "only this broke it"], t)).toBe(0);
    expect(t.calls).toEqual([
      { method: "GET", path: "/api/colonies/web/proposals/prp_1" },
      { method: "POST", path: "/api/colonies/web/landings/lnd_1/revert", body: { reason: "only this broke it", by: "tester", redo: true, proposal: "prp_1" } },
    ]);
    expect(t.out.join("\n")).toBe(
      [
        "Reverted prp_1 of lnd_1 (bbbbbbb) as lnd_2 (ccccccc): only this broke it",
        "  undone  src/a.ts",
        "  stayed  prp_2, prp_3 (the rest of lnd_1, untouched)",
        "  1 intent declared again: int_9",
      ].join("\n"),
    );
  });

  it("reverts nothing when the proposal has not landed", async () => {
    const t = io(server);
    expect(await main(["revert", "web", "prp_7", "--reason", "r"], t)).toBe(1);
    expect(t.calls).toEqual([{ method: "GET", path: "/api/colonies/web/proposals/prp_7" }]);
    expect(t.err).toEqual(["ft: prp_7 has not landed (it is returned), so there is nothing to revert"]);
    // An unknown proposal: the server's 404 comes through.
    const u = io(server);
    expect(await main(["revert", "web", "prp_nope", "--reason", "r"], u)).toBe(1);
    expect(u.err[0]).toContain("GET /api/colonies/web/proposals/prp_nope failed: 404");
    expect(u.calls).toHaveLength(1);
  });

  it("says so and exits 1 when a server that predates reverting one proposal undid the whole landing", async () => {
    // Such a server drops the unknown `proposal` field and answers as for a whole landing.
    const old = (call: Call) => (call.method === "POST" ? { status: 200, body: { landing: { ...revertCommit, paths: landing.paths }, reverted: landing, redo: [] } } : server(call));
    const t = io(old);
    expect(await main(["revert", "web", "prp_1", "--reason", "r"], t)).toBe(1);
    expect(t.out.join("\n")).toBe(["Reverted lnd_1 (bbbbbbb) as lnd_2 (ccccccc): r", "  undone  src/a.ts, src/b.ts, src/c.ts"].join("\n"));
    expect(t.err).toEqual(['ft: the server undid all of lnd_1, not only prp_1: it predates reverting one proposal. To put lnd_1 back: ft revert web lnd_2 --reason "<why>"']);
  });

  it("shows both calls on a dry run, naming the landing it will read", async () => {
    const t = io(server);
    expect(await main(["revert", "web", "prp_1", "--reason", "r", "--dry-run"], t)).toBe(0);
    expect(t.calls).toEqual([]);
    expect(JSON.parse(t.out.join("\n"))).toEqual([
      { method: "GET", url: "https://ft.test/api/colonies/web/proposals/prp_1", authorization: "Bearer ***" },
      { method: "POST", url: "https://ft.test/api/colonies/web/landings/<landing>/revert", authorization: "Bearer ***", body: { reason: "r", by: "tester", redo: true, proposal: "prp_1" } },
    ]);
  });

  it("reverts a whole landing in one call, listing its files", async () => {
    const t = io(server);
    expect(await main(["revert", "web", "lnd_1", "--reason", "r", "--json"], t)).toBe(0);
    expect(t.calls).toEqual([{ method: "POST", path: "/api/colonies/web/landings/lnd_1/revert", body: { reason: "r", by: "tester", redo: true } }]);
    expect(JSON.parse(t.out.join("\n"))).toMatchObject({ reverted: { id: "lnd_1" }, landing: { id: "lnd_2" } });
    const plain = io(server);
    expect(await main(["revert", "web", "lnd_1", "--reason", "r"], plain)).toBe(0);
    expect(plain.out.join("\n")).toBe(["Reverted lnd_1 (bbbbbbb) as lnd_2 (ccccccc): r", "  undone  src/a.ts, src/b.ts, src/c.ts", "  1 intent declared again: int_9"].join("\n"));
  });
});
