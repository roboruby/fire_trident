import { describe, expect, it } from "vitest";
import type { ColonySnapshot, PauseState } from "@fire_trident/core";
import { EVENT_TYPES, helpText, parseCommand } from "../src/args.ts";
import { planRequest } from "../src/api.ts";
import { colors, formatEvent, formatStatus } from "../src/format.ts";
import { formatPause, pauseLines } from "../src/pause.ts";
import { main } from "../src/run.ts";
import type { Io } from "../src/run.ts";

/** The pause switch in the CLI: ft pause and ft resume for a colony or the deployment, and the pause in ft status. */

const c = colors(false);
const colony = { id: "web", name: "web", trunk: { namespace: "n", name: "x", remote: "r" }, trunkSha: "a".repeat(40), createdAt: 0, regionDepth: 1 } as ColonySnapshot["colony"];
const own: PauseState = { scope: "colony", by: "maya", reason: "demo reset", at: 1 };
const deployment: PauseState = { scope: "deployment", by: "ops", reason: "spend check", at: 2 };

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

describe("ft pause and ft resume: parsing and requests", () => {
  it("pauses a colony or the deployment with a reason, and resumes either", () => {
    expect(ok(["pause", "web", "--reason", "demo reset"])).toEqual({ name: "pause", colony: "web", reason: "demo reset" });
    expect(ok(["pause", "--deployment", "--reason", "spend check", "--by", "ops"])).toEqual({ name: "pause", reason: "spend check", by: "ops" });
    expect(ok(["resume", "web"])).toEqual({ name: "resume", colony: "web" });
    expect(ok(["resume", "--deployment", "--by", "ops"])).toEqual({ name: "resume", by: "ops" });
    expect(err(["pause", "web"])).toMatch(/missing --reason/);
    expect(err(["pause", "--reason", "x"])).toMatch(/missing <colony>.*--deployment/);
    expect(err(["pause", "web", "--deployment", "--reason", "x"])).toMatch(/unexpected argument "web"/);
    expect(err(["resume"])).toMatch(/missing <colony>/);
    expect(helpText("pause")).toMatch(/^ft pause <colony> --reason <text>/);
    expect(helpText("resume")).toMatch(/^ft resume <colony>/);
    expect(helpText()).toContain("pause <colony> --reason <text>");
    expect(EVENT_TYPES).toEqual(expect.arrayContaining(["paused", "resumed"]));
  });

  it("asks the colony's route, or the deployment's", () => {
    expect(planRequest(ok(["pause", "web", "--reason", "demo reset"]), "matt")).toEqual({ method: "POST", path: "/api/colonies/web/pause", body: { by: "matt", reason: "demo reset" } });
    expect(planRequest(ok(["pause", "--deployment", "--reason", "spend check"]), "matt")).toEqual({ method: "POST", path: "/api/pause", body: { by: "matt", reason: "spend check" } });
    expect(planRequest(ok(["resume", "web", "--by", "maya"]), "matt")).toEqual({ method: "POST", path: "/api/colonies/web/resume", body: { by: "maya" } });
    expect(planRequest(ok(["resume", "--deployment"]), "matt")).toEqual({ method: "POST", path: "/api/resume", body: { by: "matt" } });
  });
});

describe("ft pause and ft resume: output", () => {
  it("says what holds, what still works, and how to resume", () => {
    const paused = formatPause({ name: "pause", colony: "web", reason: "demo reset" }, { colonyId: "web", pause: own, already: false, writer: true }, c).split("\n");
    expect(paused[0]).toBe("Paused the colony web: maya: demo reset");
    expect(paused.at(-1)).toBe("  Resume: ft resume web");
    expect(formatPause({ name: "pause", colony: "web", reason: "x" }, { pause: own, already: true }, c)).toMatch(/^Already paused the colony web: maya: demo reset/);
    const all = formatPause({ name: "pause", reason: "spend check" }, { pause: deployment, already: false, colonies: { total: 3, told: 2, failed: [{}] } }, c);
    expect(all).toContain("Paused every colony on the server: ops: spend check");
    expect(all).toContain("2 of 3 colonies told now; the others read it again within seconds.");
    expect(all).toContain("Resume: ft resume --deployment");
  });

  it("says when a resume found nothing to resume, and names a pause still in force", () => {
    expect(formatPause({ name: "resume", colony: "web" }, { resumed: { by: "maya" }, already: false, pauses: [] }, c)).toBe(
      "Resumed the colony web: agents may work again, and the lanes land what waited in them.",
    );
    expect(formatPause({ name: "resume", colony: "web" }, { resumed: { by: "maya" }, already: false, pauses: [deployment] }, c)).toContain(
      "Still paused (deployment) by ops: spend check. Resume: ft resume --deployment",
    );
    expect(formatPause({ name: "resume", colony: "web" }, { resumed: null, already: true, pauses: [] }, c)).toBe("Not paused: nothing to resume for the colony web.");
  });

  it("shows paused and resumed events in ft watch", () => {
    const clock = () => "12:00:00";
    expect(formatEvent({ t: "paused", at: 1, scope: "colony", by: "maya", reason: "demo reset" }, c, clock)).toBe("12:00:00 paused     colony by maya: demo reset");
    expect(formatEvent({ t: "resumed", at: 2, scope: "deployment", by: "ops" }, c, clock)).toBe("12:00:00 resumed    deployment by ops");
  });

  it("leads ft status with the pauses in force, only when the server sends them", () => {
    expect(pauseLines([own, deployment], "web", c)).toEqual([
      "paused     this colony by maya: demo reset  → ft resume web",
      "paused     the whole deployment by ops: spend check  → ft resume --deployment",
    ]);
    const status = formatStatus({ colony, pauses: [own] }, c, 0).split("\n");
    expect(status[1]).toBe("paused     this colony by maya: demo reset  → ft resume web");
    expect(formatStatus({ colony }, c, 0)).not.toContain("paused ");
    expect(pauseLines([{ ...own, reason: "a\u001b[31mb" }], "web", c)[0]).toContain("a [31mb");
  });
});

describe("ft pause: running", () => {
  it("pauses a colony through the API", async () => {
    const out: string[] = [];
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    const fake: Io = {
      env: { FT_URL: "https://ft.test", FT_TOKEN: "t", FT_USER: "matt" },
      stdout: (line) => out.push(line),
      stderr: (line) => out.push(line),
      isTTY: false,
      fetch: (async (url: string, init?: RequestInit) => {
        calls.push({ method: init?.method ?? "GET", url, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
        return new Response(JSON.stringify({ colonyId: "web", pause: { ...own, by: "matt" }, already: false, writer: true }), { status: 201, headers: { "content-type": "application/json" } });
      }) as typeof fetch,
      readFile: async () => "",
      sleep: async () => undefined,
      now: () => 0,
      WebSocket: globalThis.WebSocket,
      onInterrupt: () => undefined,
    };
    expect(await main(["pause", "web", "--reason", "demo reset"], fake)).toBe(0);
    expect(calls).toEqual([{ method: "POST", url: "https://ft.test/api/colonies/web/pause", body: { by: "matt", reason: "demo reset" } }]);
    expect(out.join("\n")).toContain("Paused the colony web: matt: demo reset");
  });
});
