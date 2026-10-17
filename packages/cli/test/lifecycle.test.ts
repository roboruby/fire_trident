import { describe, expect, it } from "vitest";
import type { Landing, LineageNote } from "@fire_trident/core";
import { changeLifecycle, intentLifecycle } from "@fire_trident/core";
import { colors, formatWhy } from "../src/format.ts";
import { main, type Io } from "../src/run.ts";
import { lifecycleLines, lifecycleRequest, stripLine, stripRows } from "../src/strip.ts";

/** The lifecycle strip in the CLI: `ft intent show` prints the colony's strip, `ft why` each landed change's from its note. */

const c = colors(false);
const NOW = 1_800_000_000_000;
const SHA = "a".repeat(40);
const GREEN = "c".repeat(40);
const gate = { name: "gate", ok: true, ms: 0, detail: "D3 innate+proof → land by deterministic at head 1 (confirmations: innate + deterministic): proof", gate: { rule: "D3 innate+proof", preset: "production", values: [] } };

/** An intent's answer as the server computes it. */
function answer(status: "landed" | "returned") {
  const landed = {
    change: { id: "prp_2", agentId: "agt_2", status: "landed", createdAt: NOW - 60_000, evidence: { checks: [gate] } },
    landing: { id: "lnd_2", trunkSha: SHA, at: NOW - 30_000 },
    certified: { status: "pending" as const, reason: "trunk certification is off for this colony" },
  };
  const returned = {
    change: { id: "prp_1", agentId: "agt_1", status: "returned", createdAt: NOW - 120_000, settledAt: NOW - 90_000, reason: "stale: src/a.ts changed since you read it", beatenBy: { landingId: "lnd_1", trunkSha: GREEN, title: "Rename a" }, evidence: { checks: [gate] } },
  };
  return intentLifecycle({
    colonyId: "web",
    intent: { id: "int_1", title: "Add a limit", source: "human", createdBy: "lee", createdAt: NOW - 3_600_000, status: status === "landed" ? "landed" : "claimed" },
    changes: status === "landed" ? [returned, landed] : [returned],
    agents: { agt_1: { id: "agt_1", name: "first", kind: "external" }, agt_2: { id: "agt_2", name: "second", kind: "internal", model: "@cf/google/gemma-4-26b-a4b-it" } },
    ...(status === "returned" ? { holder: { id: "agt_1", name: "first", kind: "external" } } : {}),
  });
}

function io(routes: Record<string, unknown>, out: string[], asked: string[] = []): Io {
  return {
    env: { FT_URL: "https://ft.test", NO_COLOR: "1" },
    stdout: (l) => void out.push(l),
    stderr: () => {},
    isTTY: false,
    fetch: (async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      asked.push(path);
      if (!Object.hasOwn(routes, path)) return new Response(JSON.stringify({ error: `no route for GET ${path}` }), { status: 404 });
      return new Response(JSON.stringify(routes[path]), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof globalThis.fetch,
    readFile: async () => "",
    sleep: async () => {},
    now: () => NOW,
    WebSocket: globalThis.WebSocket,
    onInterrupt: () => {},
  };
}

const intentAnswer = { intent: { id: "int_1", title: "Add a limit", status: "landed", revision: 1, footprint: ["src/a.ts"] } };

describe("ft intent show", () => {
  it("prints the strip: each step with its evidence and time, where a change left the path, the caption, the take-back command", async () => {
    const out: string[] = [];
    const asked: string[] = [];
    const routes = { "/api/colonies/web/intents/int_1": intentAnswer, "/api/colonies/web/intents/int_1/lifecycle": answer("landed") };
    expect(await main(["intent", "show", "web", "int_1"], io(routes, out, asked))).toBe(0);
    expect(asked.sort()).toEqual(["/api/colonies/web/intents/int_1", "/api/colonies/web/intents/int_1/lifecycle"]);
    const text = out.join("\n");
    expect(text).toContain("  lifecycle ✓ declared → ✓ claimed → ✓ proposed → ✓ confirmed → ✓ landed → ○ certified → ↗ taken back → ↗ merged by a person");
    expect(text).toContain("    ✓ Declared            lee (a person) · 1h ago · intent int_1");
    expect(text).toContain("    ✓ Claimed             second (in-platform agent, gemma-4-26b-a4b-it) · agent agt_2");
    expect(text).toContain("    ✓ Confirmed           deterministic proof: D3 innate+proof · proposal prp_2");
    expect(text).toContain("    ✓ Landed              lnd_2 · aaaaaaa · 30s ago");
    expect(text).toContain("    ○ Certified           not certified yet: trunk certification is off for this colony");
    expect(text).toContain("    ↗ Taken back          outside FireTrident: push certified as a branch and open a pull request");
    expect(text).toContain("                          git push <your-origin> certified:refs/heads/firetrident/certified");
    expect(text).toContain("    ↗ Merged by a person  outside FireTrident: a person merges it in your forge");
    expect(text).toContain("FireTrident lands to its own trunk and never merges into your repository; the last two steps happen in your forge.");
    expect(text).toContain("  changes   prp_1 Returned after confirmed: stale: src/a.ts changed since you read it");
  });

  it("shows a change sent back with the landing that beat it, and leaves the strip out for a server without the read", async () => {
    const rows = stripRows(answer("returned").current, c, NOW);
    expect(stripLine(answer("returned").current, c)).toBe("✓ declared → ✓ claimed → ✓ proposed → ✓ confirmed ↳ returned");
    expect(rows).toContain('    ↳ Returned            stale: src/a.ts changed since you read it · 1m ago · beaten by landing lnd_1 ccccccc "Rename a"');
    const out: string[] = [];
    expect(await main(["intent", "show", "web", "int_1"], io({ "/api/colonies/web/intents/int_1": intentAnswer }, out))).toBe(0);
    expect(out.join("\n")).not.toContain("lifecycle");
    expect(lifecycleLines({ not: "a strip" }, c, NOW)).toEqual([]);
    expect(lifecycleRequest("web", "int 1")).toEqual({ method: "GET", path: "/api/colonies/web/intents/int%201/lifecycle" });
  });

  it("adds the strip to --json beside the intent", async () => {
    const out: string[] = [];
    const routes = { "/api/colonies/web/intents/int_1": intentAnswer, "/api/colonies/web/intents/int_1/lifecycle": answer("landed") };
    expect(await main(["--json", "intent", "show", "web", "int_1"], io(routes, out))).toBe(0);
    const json = JSON.parse(out.join("\n"));
    expect(json.intent.id).toBe("int_1");
    expect(json.lifecycle.current.reached).toBe("landed");
  });
});

describe("ft why", () => {
  const entry = (certification?: unknown): { landing: Landing; note: LineageNote } => ({
    landing: { id: "lnd_1", colonyId: "web", trunkSha: SHA, parentSha: "f".repeat(40), proposalIds: ["prp_1"], intentIds: ["int_1"], paths: ["src/a.ts"], regions: ["src"], at: NOW - 60_000 },
    note: {
      schema: "firetrident.lineage/v1",
      landingId: "lnd_1",
      colonyId: "web",
      proposals: [{ id: "prp_1", agentId: "agt_1", agentKind: "internal", intent: { id: "int_1", title: "Fix it", why: "" }, writeSet: [{ path: "src/a.ts", blob: "b".repeat(40) }], readSet: [], decisions: [], evidence: { checks: [gate] } }],
      ...(certification ? { certification } : {}),
    } as LineageNote,
  });

  it("prints each landed change's strip from its note, and what comes next", () => {
    const pending = formatWhy({ path: "src/a.ts" }, [entry()], {}, c, NOW);
    expect(pending).toContain("  path     ✓ declared → ✓ claimed → ✓ proposed → ✓ confirmed → ✓ landed → ○ certified → ↗ taken back → ↗ merged by a person");
    expect(pending).toContain("           not certified yet");
    // Certified by its own note, or by the status read's newest green commit landed after it.
    const own = formatWhy({ path: "src/a.ts" }, [entry({ status: "green", runner: "node:test" })], {}, c, NOW);
    expect(own).toContain("→ ✓ certified → ↗ taken back");
    expect(own).toContain("           next: push certified to your forge as a branch and open a pull request: git push <your-origin> certified:refs/heads/firetrident/certified");
    const later = formatWhy({ path: "src/a.ts" }, [entry()], { greenSha: GREEN, landings: [{ ...entry().landing, id: "lnd_2", trunkSha: GREEN, at: NOW }] }, c, NOW);
    expect(later).toContain("→ ✓ certified → ↗ taken back");
    // A test row saying the colony has no tests this platform can run.
    const none = formatWhy({ path: "src/a.ts" }, [entry()], { tests: { lnd_1: { colonyId: "web", landingId: "lnd_1", trunkSha: SHA, baseSha: SHA, status: "no-tests", reason: "no test file on trunk", proof: { rungs: [], text: "deterministic" }, text: "no tests" } } }, c, NOW);
    expect(none).toContain("→ ✓ landed → – certified → ↗ taken back");
    expect(none).toContain("           no tests this platform can run: no test file on trunk");
  });

  it("draws the same strip core draws", () => {
    const s = changeLifecycle({ intent: { id: "int_1" }, change: { id: "prp_1", status: "pending" } });
    expect(stripLine(s, c)).toBe("✓ declared → ✓ claimed → ✓ proposed → ○ confirmed → ○ landed → ○ certified → ↗ taken back → ↗ merged by a person");
  });
});
