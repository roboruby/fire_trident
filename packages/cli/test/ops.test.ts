import { describe, expect, it } from "vitest";
import { helpText, parseCommand } from "../src/args.ts";
import type { Command } from "../src/args.ts";
import { planRequest } from "../src/api.ts";
import { colors, formatAgents, formatColonies, formatDelete, formatStatus, formatStop, formatVaccinate, shortSource, sparkline, table } from "../src/format.ts";

const plain = colors(false);

function cmd(argv: string[]): Command {
  const r = parseCommand(argv);
  if (!r.ok) throw new Error(r.error);
  return r.command;
}

function usage(argv: string[]): string {
  const r = parseCommand(argv);
  if (r.ok) throw new Error(`expected a usage error for ${argv.join(" ")}`);
  return r.error;
}

describe("operations commands", () => {
  it("lists colonies, optionally re-scanning trunks", () => {
    expect(planRequest(cmd(["colonies"]), "m")).toEqual({ method: "GET", path: "/api/colonies" });
    expect(planRequest(cmd(["colonies", "--scan"]), "m")).toEqual({ method: "GET", path: "/api/colonies?scan=1" });
    expect(usage(["colonies", "extra"])).toMatch(/unexpected argument "extra"/);
  });

  it("lists agents with --all and --no-journal", () => {
    expect(planRequest(cmd(["agents", "web"]), "m")).toEqual({ method: "GET", path: "/api/colonies/web/agents" });
    expect(planRequest(cmd(["agents", "web", "--all", "--no-journal"]), "m")).toEqual({ method: "GET", path: "/api/colonies/web/agents?all=1&journal=0" });
    expect(usage(["agents"])).toMatch(/missing <colony>/);
  });

  it("stops one agent or all of them, never neither or both", () => {
    expect(planRequest(cmd(["stop", "web", "agt_1"]), "m")).toEqual({ method: "POST", path: "/api/colonies/web/agents/agt_1/stop", body: {} });
    expect(planRequest(cmd(["stop", "web", "--all", "--reason", "demo over"]), "m")).toEqual({ method: "POST", path: "/api/colonies/web/swarm/stop", body: { reason: "demo over" } });
    expect(usage(["stop", "web"])).toMatch(/say which agent to stop, or --all/);
    expect(usage(["stop", "web", "agt_1", "--all"])).toMatch(/not both/);
  });

  it("deletes only with --yes (or as a dry run)", () => {
    expect(planRequest(cmd(["delete", "web", "--yes"]), "m")).toEqual({ method: "DELETE", path: "/api/colonies/web" });
    expect(cmd(["delete", "web", "--dry-run"])).toEqual({ name: "delete", colony: "web" });
    expect(usage(["delete", "web"])).toMatch(/add --yes to confirm/);
    expect(usage(["delete", "--yes"])).toMatch(/missing <colony>/);
  });

  it("vaccinates with a count", () => {
    expect(planRequest(cmd(["vaccinate", "web", "--count", "12"]), "m")).toEqual({ method: "POST", path: "/api/colonies/web/vaccinate", body: { count: 12 } });
    expect(usage(["vaccinate", "web"])).toBe("missing --count");
    expect(usage(["vaccinate", "web", "--count", "0"])).toMatch(/between 1 and 64/);
    expect(usage(["vaccinate", "web", "--count", "65"])).toMatch(/between 1 and 64/);
  });

  it("has help for each new command", () => {
    for (const t of ["colonies", "agents", "stop", "delete", "vaccinate"]) expect(helpText(t)).toContain(`ft ${t}`);
    expect(helpText()).toContain("~/.config/firetrident/env");
  });
});

describe("operations output", () => {
  it("draws sparklines and aligned tables", () => {
    expect(sparkline([0, 1, 7, 0])).toBe("▁▂█▁");
    expect(sparkline([0, 0])).toBe("▁▁");
    expect(sparkline([])).toBe("");
    expect(table(["A", "NUM"], [["xx", "1"], ["y", "100"]], new Set([1]), plain)).toEqual(["A   NUM", "xx    1", "y   100"]);
    expect(shortSource("https://github.com/org/repo.git")).toBe("github.com/org/repo");
  });

  it("formats the colony list", () => {
    const text = formatColonies(
      [
        { id: "web", source: { url: "https://github.com/org/web" }, createdAt: 0, trunkSha: "abcdef0123", counters: { agentsActive: 21, intentsOpen: 3, intentsLanded: 74, landings: 1284, landingsPerMin: 12, violations: 5 } },
        { id: "gone", createdAt: 0, error: "Network connection lost." },
      ],
      plain,
      7_200_000,
    );
    expect(text).toContain("2 colonies");
    expect(text).toMatch(/web\s+21\s+3\s+74\s+1,284\s+12\s+5\s+abcdef0\s+2h ago\s+github\.com\/org\/web/);
    expect(text).toContain("unreachable: Network connection lost.");
    expect(formatColonies([], plain, 0)).toContain("No colonies yet");
  });

  it("formats agents with their step, intent and notes", () => {
    const text = formatAgents(
      "web",
      [
        { id: "agt_1", kind: "synthetic", state: "working", step: "commit", attempts: 2, intentTitle: "Remove console.log", model: "m1", lastSeen: 59_000 },
        { id: "agt_2", kind: "synthetic", state: "waiting", running: true, model: "m1", lastSeen: 0 },
        { id: "agt_3", kind: "internal", state: "dead", running: false, stopReason: "stopped by request", lastSeen: 0 },
      ],
      plain,
      60_000,
    );
    expect(text.split("\n")[0]).toBe("web  3 agents: 1 working · 1 waiting · 1 dead");
    expect(text).toMatch(/agt_1\s+synthetic\s+working\s+commit \(try 2\)\s+"Remove console\.log"\s+m1\s+just now/);
    expect(text).toMatch(/agt_2\s+synthetic\s+waiting\s+take\s+-\s+m1\s+1m ago/);
    expect(text).toMatch(/agt_3\s+internal\s+dead\s+-\s+-\s+-\s+1m ago\s+stopped by request/);
    expect(formatAgents("web", [], plain, 0)).toContain("no agents");
    const counted = formatAgents("web", [{ id: "agt_9", kind: "synthetic", state: "idle", running: true, counters: { landed: 12 }, lastSeen: 0 }], plain, 0);
    expect(counted.split("\n")[1]).toMatch(/^AGENT\s+KIND\s+STATE\s+STEP\s+INTENT\s+MODEL\s+LANDED\s+SEEN$/);
    expect(counted).toMatch(/agt_9\s+synthetic\s+idle\s+take\s+-\s+-\s+12\s+just now/);
  });

  it("reports stops", () => {
    expect(formatStop("web", "agt_1", { stopped: ["agt_1"], failed: [] }, plain)).toContain("✓ Stopped agt_1 in web");
    expect(formatStop("web", undefined, { stopped: ["a", "b"], failed: [{ agentId: "c", error: "timeout" }] }, plain)).toBe("✓ Stopped 2 agents in web\n  ✗ c: timeout");
    expect(formatStop("web", undefined, { stopped: [], failed: [] }, plain)).toBe("✓ No running in-platform agents in web");
  });

  it("reports deletions per namespace and object kind", () => {
    const text = formatDelete(
      "tmp",
      {
        found: true,
        ok: true,
        agents: { stopped: 3 },
        repos: { deleted: ["ft-trunk/tmp--trunk", "ft-ws-0/tmp--seed", "ft-ws-0/tmp--ws-0"] },
        objects: [
          { object: "AgentDO agt_1", cleared: true },
          { object: "AgentDO agt_2", cleared: true },
          { object: "TrunkDO tmp", cleared: false, detail: "destroy() not available on this class" },
          { object: "ColonyDO tmp", cleared: true },
        ],
        unregistered: true,
      },
      plain,
    );
    expect(text).toContain("✓ Deleted colony tmp");
    expect(text).toContain("agents   3 stopped");
    expect(text).toContain("repos    3 deleted (ft-trunk 1, ft-ws-0 2)");
    expect(text).toContain("AgentDO 2/2 cleared · TrunkDO 0/1 cleared (destroy() not available on this class) · ColonyDO cleared");
    expect(text).toContain("registry removed");
    expect(formatDelete("tmp", { found: false, ok: true, repos: { deleted: [] }, objects: [] }, plain)).toContain("Nothing left of tmp");
  });

  it("reports vaccinations by threat class, and other reply shapes generically", () => {
    const res = {
      batch: "vb_1",
      requested: 4,
      started: 3,
      vaccines: [{ cls: "secret-log" }, { cls: "secret-log" }, { cls: "off-intent" }],
      skipped: [{ cls: "forbidden-import", reason: "no import to break" }],
    };
    expect(formatVaccinate("web", 4, res, plain).split("\n")).toEqual([
      "✓ Vaccinated web: 3 of 4 vaccines started (batch vb_1)",
      "  secret-log 2 · off-intent 1",
      "  skipped forbidden-import: no import to break",
      "  Watch the meter: ft watch web --only decision",
    ]);
    expect(formatVaccinate("web", 5, { created: 1 }, plain)).toBe("✓ Vaccinated web: asked for 5\n  created 1");
    expect(formatVaccinate("web", 5, null, plain)).toBe("✓ Vaccinated web: asked for 5");
  });

  it("adds in-flight work and the 30-minute trend to the status summary", () => {
    const colony = { id: "web", name: "web", trunk: { namespace: "n", name: "x", remote: "r" }, trunkSha: "a".repeat(40), createdAt: 0, regionDepth: 1 };
    const text = formatStatus(
      { colony, metrics: { proposalsInFlight: 4, reviewQueue: 1, landingsPerMin: 9 }, series: { landings: [0, 2, 5], violations: [214, 120, 80] } },
      plain,
      0,
    );
    expect(text).toContain("in flight  4 proposals · 1 awaiting review · 9 landings/min");
    expect(text).toContain("last 30m   ▁▄█ 7 landings · violations 214 → 80");
  });
});
