import { describe, expect, it } from "vitest";
import type { Proposal } from "@fire_trident/core";
import { helpText, parseCommand } from "../src/args.ts";
import { planRequest } from "../src/api.ts";
import { formatAudit, percentArg } from "../src/audit.ts";
import { colors, formatReview } from "../src/format.ts";
import { decidesLines } from "../src/gateline.ts";
import { main, type Io } from "../src/run.ts";

/** `ft audit` and the audit sample in `ft review` (packages/worker/src/colony/audit.ts on the server). */

const c = colors(false);

function parsed(argv: string[]) {
  const r = parseCommand(argv);
  if (!r.ok) throw new Error(r.error);
  return r.command;
}

function error(argv: string[]): string {
  const r = parseCommand(argv);
  if (r.ok) throw new Error(`parsed: ${JSON.stringify(r.command)}`);
  return r.error;
}

function item(id: string, audit?: Record<string, unknown>): Proposal {
  return {
    id,
    colonyId: "web",
    intentId: `int_${id}`,
    agentId: "agt_1",
    workspace: { namespace: "ft-sessions", name: "ws", remote: "" },
    baseSha: "0".repeat(40),
    headSha: "1".repeat(40),
    writeSet: [{ path: "src/a.ts", blob: "2".repeat(40) }],
    readSet: [],
    declared: { footprint: ["src/a.ts"], summary: `change ${id}` },
    evidence: { checks: [] },
    status: audit ? "landed" : "escalated",
    createdAt: 1,
    ...(audit ? { audit } : {}),
  } as Proposal;
}

const MARK = { kind: "audit", layer: "autonomy", label: "earned autonomy", rule: "R3 innate+autonomy", landedBy: "Already landed by R3 innate+autonomy (earned autonomy).", landingId: "lnd_7" };

describe("ft audit", () => {
  it("shows the audit, sets the rates in percent, and answers an item", () => {
    expect(planRequest(parsed(["audit", "web"]), "maya")).toEqual({ method: "GET", path: "/api/colonies/web/audit" });
    expect(planRequest(parsed(["audit", "web", "--rate", "5"]), "maya")).toEqual({ method: "POST", path: "/api/colonies/web/decide/policy", body: { auditRate: 0.05 } });
    expect(planRequest(parsed(["audit", "web", "--rate", "0", "--canary-rate", "2%"]), "maya")).toEqual({ method: "POST", path: "/api/colonies/web/decide/policy", body: { auditRate: 0, canaryRate: 0.02 } });
    expect(planRequest(parsed(["audit", "web", "prp_1", "fine"]), "maya")).toEqual({ method: "POST", path: "/api/colonies/web/audit/prp_1", body: { verdict: "fine", reason: "", by: "maya" } });
    expect(planRequest(parsed(["audit", "web", "prp_1", "wrong", "--reason", "drops a check", "--revert", "--by", "lee"]), "maya")).toEqual({
      method: "POST",
      path: "/api/colonies/web/audit/prp_1",
      body: { verdict: "should-not-have-landed", reason: "drops a check", by: "lee", revert: true },
    });
    expect(helpText("audit")).toContain("ft audit <colony> <proposalId> fine|wrong");
  });

  it("says what is wrong with a command", () => {
    expect(error(["audit"])).toMatch(/missing <colony>/);
    expect(error(["audit", "web", "--rate", "25"])).toBe('--rate is a percent from 0 to 20 (3 is 3%), got "25"');
    expect(error(["audit", "web", "prp_1", "wrong"])).toMatch(/--reason is required for wrong/);
    expect(error(["audit", "web", "prp_1", "fine", "--revert"])).toMatch(/--revert goes with wrong/);
    expect(error(["audit", "web", "prp_1", "maybe"])).toMatch(/answer fine or wrong/);
    expect(error(["audit", "web", "--reason", "x"])).toMatch(/--reason does not apply to showing the audit/);
    expect(percentArg("0.5", "rate")).toBe(0.005);
  });

  it("prints the measures per confirming layer, the canaries, people's decisions and what waits", () => {
    const text = formatAudit(parsed(["audit", "web"]) as never, {
      rate: 0.03,
      every: 5,
      line: "audited 12 of 400 landings without a person: 0 should not have landed (0–24%)",
      layers: {
        deterministic: { label: "a deterministic proof", landed: 300, audited: 9, wrong: 0, lo: 0, hi: 0.3, pending: 0 },
        reproduction: { label: "reproduction by its recipe", landed: 0, audited: 0 },
        model: { label: "a model's approval", landed: 100, audited: 3, wrong: 0, lo: 0, hi: 0.56, pending: 1 },
      },
      canaries: { line: "canaries: 4 of 5 caught (80%, 38–96%), 1 approved" },
      reviewers: { line: "approved 9 of 10 escalations (90%) in the last 2 weeks, 5 of 10 escalations (50%) in the 6 before: up 40 points" },
      waiting: [{ proposalId: "prp_9", rule: "L3 innate+llm" }],
    }, c);
    expect(text).toContain("web audit sample 3%, one item after every 5 escalations in ft review");
    expect(text).toContain("  audited 12 of 400 landings without a person: 0 should not have landed (0–24%)");
    expect(text).toContain("a deterministic proof:         9 of 300 audited, 0 should not have landed (0–30%)");
    expect(text).toContain("a model's approval:            3 of 100 audited, 0 should not have landed (0–56%), 1 waiting");
    expect(text).not.toContain("reproduction");
    expect(text).toContain("canaries: 4 of 5 caught (80%, 38–96%), 1 approved");
    expect(text).toContain("people: approved 9 of 10 escalations (90%)");
    expect(text).toContain("prp_9  landed by L3 innate+llm");
    expect(formatAudit(parsed(["audit", "web", "--rate", "5"]) as never, { auditRate: 0.05, canaryRate: 0 }, c)).toBe("web Audit sample: 5% of the changes that land without a person go to a person after they land; blind canaries off.");
    expect(formatAudit(parsed(["audit", "web", "prp_1", "fine"]) as never, { sentence: "Recorded as fine: prp_1 landed by D3 innate+proof (a deterministic proof) and should have." }, c)).toBe(
      "Recorded as fine: prp_1 landed by D3 innate+proof (a deterministic proof) and should have.",
    );
  });
});

describe("ft review with the audit sample", () => {
  it("lists audit items after the escalations, marked, and counts only the escalations as waiting", () => {
    const text = formatReview([item("prp_e1"), item("prp_a1", MARK), item("prp_e2")], undefined, c, 1_000, { colony: "web" });
    expect(text.split("\n")[0]).toBe("2 proposals waiting for a human");
    expect(text.indexOf("prp_e2")).toBeLessThan(text.indexOf("AUDIT prp_a1"));
    expect(text).toContain("1 landed change from the audit sample: no person saw it before it landed");
    expect(text).toContain("  Already landed by R3 innate+autonomy (earned autonomy).");
    expect(text).toContain("Answer with: ft audit web <proposalId> fine | wrong --reason <text> [--revert]");
  });

  it("shows audit items when no escalation waits", () => {
    const text = formatReview([item("prp_a1", MARK)], undefined, c, 1_000, { colony: "web" });
    expect(text.split("\n")[0]).toBe("Review queue is empty: nothing needs a human.");
    expect(text).toContain("AUDIT prp_a1");
  });

  it("prints a decided canary's reveal in place of the usual words", async () => {
    const sentence = "This was a canary, not a real change: a sealed known-bad change that prints a secret to the logs, put in the review queue to check that people catch what review sends them. You approved it, so it counts as missed; it was sealed and can never land, so nothing changed.";
    const out: string[] = [];
    const fetcher = (async () => new Response(JSON.stringify({ ok: true, canary: { proposalId: "prp_1", outcome: "approved", cls: "secret-log", sentence } }), { headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    const io = {
      env: { FT_URL: "http://ft.invalid", FT_TOKEN: "tok", FT_USER: "tester", NO_COLOR: "1" },
      stdout: (l: string) => void out.push(l),
      stderr: () => {},
      isTTY: false,
      fetch: fetcher,
      readFile: async () => "",
      sleep: async () => {},
      now: () => 0,
      WebSocket: globalThis.WebSocket,
      onInterrupt: () => {},
    } satisfies Io;
    expect(await main(["review", "web", "prp_1", "approve"], io)).toBe(0);
    expect(out).toEqual([sentence]);
  });

  it("puts the audit line under how the colony decides in ft status", () => {
    const raw = {
      colonyId: "web",
      preset: "central-development",
      nearest: "central-development",
      differs: [],
      settings: [],
      lets: "",
      reviewing: true,
      protectedPaths: 0,
      dangerAllow: 0,
      always: "",
      presets: [],
      split: { days: 30, since: 0, total: 0, counts: {} },
      audit: { line: "audited 12 of 400 landings without a person: 0 should not have landed (0–24%)", canaries: "canaries off" },
      at: 1,
    };
    expect(decidesLines(raw, c)).toContain(" ".repeat(11) + "audited 12 of 400 landings without a person: 0 should not have landed (0–24%)");
  });
});
