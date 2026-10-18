import { describe, expect, it } from "vitest";
import { parseCommand } from "../src/args.ts";
import { planRequest } from "../src/api.ts";
import { closureLine, formatSilentTtl, parseSilentTtl } from "../src/closure.ts";
import { colors, formatIntentShow } from "../src/format.ts";
import { main, type Io } from "../src/run.ts";

/** The closure ledger in the CLI: `ft policy --silent-ttl` and the closures in `ft intent show`. */

const c = colors(false);
const NOW = 1_800_000_000_000;

function command(argv: string[]) {
  const p = parseCommand(argv);
  if (!p.ok) throw new Error(p.error);
  return p.command;
}

function error(argv: string[]): string {
  const p = parseCommand(argv);
  return p.ok ? "" : p.error;
}

describe("ft policy --silent-ttl", () => {
  it("reads seconds, minutes, hours or default, within the server's bounds", () => {
    expect([parseSilentTtl("90"), parseSilentTtl("90s"), parseSilentTtl("10m"), parseSilentTtl("1.5 min"), parseSilentTtl("1h"), parseSilentTtl("default")]).toEqual([90, 90, 600, 90, 3600, null]);
    for (const bad of ["30s", "25h", "soon", "-90", ""]) expect(parseSilentTtl(bad)).toMatch(/--silent-ttl takes a duration from 60s to 24h/);
    expect(command(["policy", "demo", "--silent-ttl", "90s"])).toEqual({ name: "policy", colony: "demo", protect: [], unprotect: [], silentTtl: 90 });
    expect(command(["policy", "demo", "--silent-ttl", "default"])).toMatchObject({ silentTtl: null });
    expect(error(["policy", "demo", "--silent-ttl", "5s"])).toContain('got "5s"');
    expect(error(["policy", "demo", "--silent-ttl", "90s", "--comment-proof", "off"])).toBe("--silent-ttl is set on its own: ft policy demo --silent-ttl 90s");
    expect(planRequest(command(["policy", "demo", "--silent-ttl", "2m"]), "maya")).toEqual({ method: "POST", path: "/api/colonies/demo/silent-ttl", body: { seconds: 120, by: "maya" } });
  });

  it("sends the limit and prints the colony's answer", async () => {
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    const out: string[] = [];
    const answer = { colonyId: "demo", ms: 90_000, seconds: 90, default: false, inPlatformMs: 600_000, setBy: "tester", note: "An agent outside the platform silent for 90 s loses its claimed intents to the colony, which reopens them with a failure mark." };
    const io: Io = {
      env: { FT_URL: "https://ft.test", FT_TOKEN: "tok", FT_USER: "tester", NO_COLOR: "1" },
      stdout: (l) => void out.push(l),
      stderr: () => {},
      isTTY: false,
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({ method: init?.method ?? "GET", path: new URL(String(input)).pathname, ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) } : {}) });
        return new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof globalThis.fetch,
      readFile: async () => "",
      sleep: async () => {},
      now: () => 0,
      WebSocket: globalThis.WebSocket,
      onInterrupt: () => {},
    };
    expect(await main(["policy", "demo", "--silent-ttl", "90s"], io)).toBe(0);
    expect(calls).toEqual([{ method: "POST", path: "/api/colonies/demo/silent-ttl", body: { seconds: 90, by: "tester" } }]);
    expect(out.join("\n")).toBe(["✓ demo: an agent outside the platform silent for 90 s loses its intents", `  ${answer.note}`].join("\n"));
    expect(formatSilentTtl("demo", { ms: 600_000, default: true }, c)).toBe("✓ demo: silent agents lose their intents after 10 min (the default)");
    expect(formatSilentTtl("demo", {}, c)).toContain("it predates the setting");
  });
});

describe("closures in ft intent show", () => {
  it("lists why the intent closed or reopened, newest first, with the agent, its kind and how long it was silent", () => {
    const res = {
      intent: { id: "int_1", title: "Set v2 to 20", status: "landed" as const, revision: 1, footprint: ["src/values.ts"] },
      closures: [
        { cause: "landed" as const, at: NOW - 30_000, status: "landed" as const, agentId: "agt_second", agentKind: "synthetic" as const, gapMs: 2_000 },
        { cause: "reaped_silent" as const, at: NOW - 60_000, status: "open" as const, agentId: "agt_walker", agentKind: "external" as const, gapMs: 97_000 },
      ],
    };
    const out = formatIntentShow(res, c, NOW);
    expect(out).toContain("  closed    landed · agt_second (synthetic) 30s ago → landed");
    expect(out).toContain("            reaped · agt_walker (external), silent 1 min 37 s 1m ago → reopened");
    // An older server sends only the intent's latest closure, or none.
    expect(formatIntentShow({ intent: { ...res.intent, closure: res.closures[1] } }, c, NOW)).toContain("closed    reaped · agt_walker (external), silent 1 min 37 s");
    expect(formatIntentShow({ intent: res.intent }, c, NOW)).not.toContain("closed");
    expect(closureLine({ cause: "withdrawn", at: NOW, status: "withdrawn", agentId: "agt_x", gapMs: 300_000 }, c, NOW)).toBe("withdrawn while held · agt_x, last seen 5 min before just now → withdrawn");
    // Already on trunk (FT_ALREADY_ON_TRUNK): the landing its content came from, else the trunk commit it was found on.
    expect(closureLine({ cause: "already_on_trunk", at: NOW, status: "landed", agentId: "agt_x", gapMs: 0, onTrunk: { trunkSha: "c".repeat(40), landingId: "lnd_9" } }, c, NOW)).toBe(
      "already on trunk · agt_x, from lnd_9 just now → landed",
    );
    expect(closureLine({ cause: "already_on_trunk", at: NOW, status: "landed", agentId: "agt_x", onTrunk: { trunkSha: "c".repeat(40) } }, c, NOW)).toBe("already on trunk · agt_x, from trunk ccccccc just now → landed");
  });
});
