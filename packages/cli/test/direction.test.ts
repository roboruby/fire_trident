import { describe, expect, it } from "vitest";
import type { ColonyEvent, Landing, LineageNote } from "@fire_trident/core";
import { EVENT_TYPES, helpText, parseCommand } from "../src/args.ts";
import { planRequest } from "../src/api.ts";
import { colors, decisionSteps, directionLines, formatAgents, formatAmend, formatDirect, formatEvent, formatRetract, formatWhy, formatWithdraw } from "../src/format.ts";

const c = colors(false);

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

describe("parsing changes of direction", () => {
  it("amends an intent with any of title, why, footprint and priority, and a reason", () => {
    expect(ok(["intent", "amend", "web", "int_1", "--why", "say bonjour", "--footprint", "src/a.ts,src/b.ts", "--footprint", "src/a.ts", "--priority", "2.5", "--reason", "French UI", "--by", "matt"])).toEqual({
      name: "intent-amend",
      colony: "web",
      intentId: "int_1",
      why: "say bonjour",
      footprint: ["src/a.ts", "src/b.ts"],
      priority: 2.5,
      reason: "French UI",
      by: "matt",
    });
    expect(err(["intent", "amend", "web", "int_1", "--reason", "x"])).toMatch(/say what changes/);
    expect(err(["intent", "amend", "web", "int_1", "--why", "x"])).toMatch(/missing --reason/);
    expect(err(["intent", "amend", "web", "--why", "x", "--reason", "y"])).toMatch(/missing <intentId>/);
    expect(err(["intent", "amend", "web", "int_1", "--priority=-1", "--reason", "x"])).toMatch(/--priority must be a number/);
    expect(err(["intent", "amend", "web", "int_1", "--title", " ", "--reason", "x"])).toMatch(/--title cannot be empty/);
  });

  it("withdraws, shows, retracts, and directs", () => {
    expect(ok(["intent", "withdraw", "web", "int_1", "--reason", "not needed"])).toEqual({ name: "intent-withdraw", colony: "web", intentId: "int_1", reason: "not needed" });
    expect(err(["intent", "withdraw", "web", "int_1", "--why", "x", "--reason", "y"])).toMatch(/--why does not apply to intent withdraw/);
    expect(ok(["intent", "show", "web", "int_1"])).toEqual({ name: "intent-show", colony: "web", intentId: "int_1" });
    expect(err(["intent", "frob"])).toMatch(/unknown intent subcommand "frob"/);
    expect(ok(["rule", "retract", "web", "rul_1", "--reason", "logging is fine"])).toEqual({ name: "rule-retract", colony: "web", ruleId: "rul_1", reason: "logging is fine" });
    expect(err(["rule", "add", "web", "--pattern", "x", "--hint", "h", "--description", "d", "--reason", "r"])).toMatch(/--reason does not apply to rule add/);
    expect(ok(["direct", "web", "agt_1", "use", "the", "logger", "--intent", "int_2"])).toEqual({ name: "direct", colony: "web", agentId: "agt_1", message: "use the logger", intentId: "int_2" });
    expect(ok(["direct", "web", "agt_1", "use the logger"])).toMatchObject({ message: "use the logger" });
    expect(err(["direct", "web", "agt_1"])).toMatch(/missing the message/);
    expect(err(["direct", "web", "agt_1", "x".repeat(2_001)])).toMatch(/at most 2000/);
    expect(err(["watch", "web", "--only", "nope"])).toMatch(/expected agent, mark/);
    expect(ok(["watch", "web", "--only", "amended,status"])).toEqual({ name: "watch", colony: "web", only: ["amended", "status"] });
    for (const t of ["amended", "withdrawn", "retracted", "reverted", "directive", "status"]) expect(EVENT_TYPES).toContain(t);
    for (const t of ["intent", "direct"]) expect(helpText(t)).toContain(`ft ${t}`);
    expect(helpText("rule")).toContain("ft rule retract");
  });

  it("reverts a landing by id or commit, with a reason, redoing its intents unless --no-redo", () => {
    expect(ok(["revert", "web", "lnd_1", "--reason", "breaks 405 handling"])).toEqual({ name: "revert", colony: "web", ref: "lnd_1", reason: "breaks 405 handling", redo: true });
    expect(ok(["revert", "web", "97b1036", "--reason", "r", "--no-redo", "--by", "matt"])).toEqual({ name: "revert", colony: "web", ref: "97b1036", reason: "r", redo: false, by: "matt" });
    expect(err(["revert", "web", "lnd_1"])).toMatch(/--reason/);
    expect(err(["revert", "web", "--reason", "r"])).toMatch(/missing <landing\|commit\|proposal>/);
    expect(helpText("revert")).toContain("ft revert <colony> <landing|commit|proposal>");
    expect(planRequest({ name: "revert", colony: "web", ref: "lnd_1", reason: "r", redo: true }, "me")).toEqual({
      method: "POST",
      path: "/api/colonies/web/landings/lnd_1/revert",
      body: { reason: "r", by: "me", redo: true },
    });
  });

  it("maps each to one HTTP call", () => {
    expect(planRequest({ name: "intent-amend", colony: "web", intentId: "int 1", why: "w", reason: "r" }, "me")).toEqual({
      method: "PATCH",
      path: "/api/colonies/web/intents/int%201",
      body: { why: "w", reason: "r", by: "me" },
    });
    expect(planRequest({ name: "intent-withdraw", colony: "web", intentId: "int_1", reason: "r", by: "matt" }, "me")).toEqual({
      method: "POST",
      path: "/api/colonies/web/intents/int_1/withdraw",
      body: { reason: "r", by: "matt" },
    });
    expect(planRequest({ name: "intent-show", colony: "web", intentId: "int_1" }, "me")).toEqual({ method: "GET", path: "/api/colonies/web/intents/int_1" });
    expect(planRequest({ name: "rule-retract", colony: "web", ruleId: "rul_1", reason: "r" }, "me")).toEqual({ method: "DELETE", path: "/api/colonies/web/rules/rul_1", body: { reason: "r", by: "me" } });
    expect(planRequest({ name: "direct", colony: "web", agentId: "agt_1", message: "m" }, "me")).toEqual({ method: "POST", path: "/api/colonies/web/agents/agt_1/directive", body: { message: "m", by: "me" } });
  });
});

describe("formatting changes of direction", () => {
  it("prints one line per new event", () => {
    const clock = () => "12:00:00";
    const lines = ([
      { t: "amended", at: 0, intentId: "int_1", revision: 2, changed: ["why"], reason: "French UI", by: "matt", title: "Greet", returned: 1 },
      { t: "withdrawn", at: 0, intentId: "int_1", reason: "not needed", by: "matt", title: "Greet", returned: 0 },
      { t: "retracted", at: 0, ruleId: "rul_1", reason: "fine", by: "matt", withdrawn: 3 },
      { t: "reverted", at: 0, landingId: "lnd_2", of: "lnd_1", trunkSha: "a".repeat(40), paths: ["src/a.ts"], reason: "breaks it", by: "matt", redo: ["int_9"] },
      { t: "directive", at: 0, directiveId: "dir_1", agentId: "agt_1", intentId: "int_1", message: "keep it short", by: "matt", via: "push" },
      { t: "status", at: 0, agentId: "agt_1", note: "writing src/a.ts" },
    ] as ColonyEvent[]).map((e) => formatEvent(e, c, clock));
    expect(lines).toEqual([
      '12:00:00 amended    int_1 r2 why changed "Greet" by matt: French UI (1 returned)',
      '12:00:00 withdrawn  int_1 "Greet" by matt: not needed',
      "12:00:00 retracted  rul_1 by matt: fine 3 intents withdrawn",
      "12:00:00 reverted   lnd_1 by matt: breaks it as lnd_2 1 intent declared again",
      '12:00:00 directive  agt_1 ← matt: "keep it short" (int_1) push',
      "12:00:00 status     agt_1 writing src/a.ts",
    ]);
  });

  it("shows what each agent says it is doing", () => {
    const text = formatAgents("web", [{ id: "agt_1", kind: "internal", state: "working", step: "produce", note: "writing src/a.ts", noteAt: 50_000, lastSeen: 59_000 }, { id: "agt_2", state: "idle" }], c, 60_000);
    expect(text).toMatch(/AGENT +KIND +STATE +STEP +INTENT +MODEL +SEEN +NOW/);
    expect(text).toContain("writing src/a.ts (10s ago)");
  });

  it("explains the direction and the decide arc of a landed change", () => {
    expect(directionLines(undefined, c, 0)).toEqual([]);
    expect(
      directionLines(
        { intentRevision: 2, revisions: [{ revision: 2, changed: ["why"], reason: "French UI", by: "matt", at: 0 }], directives: [{ id: "dir_1", message: "keep it short", by: "matt", at: 0 }], note: "proposing src/a.ts" },
        c,
        120_000,
      ),
    ).toEqual([
      { k: "revision", v: "built on r2 (amended 1 time)" },
      { k: "", v: 'r2: why changed by matt 2m ago: "French UI"' },
      { k: "directive", v: '"keep it short" from matt 2m ago' },
      { k: "doing", v: '"proposing src/a.ts"' },
    ]);
    const steps = decisionSteps(
      [{ kind: "triage", layer: "llm", p: 0.9, action: "land", by: "gpt", answer: "approve: only imports" }],
      [
        { name: "deterministic: mechanical proof", ok: true, ms: 1, detail: "pass: 2 specifiers resolve to the same files" },
        { name: "gate", ok: true, ms: 0, detail: "proof → land by deterministic at head abc: ok" },
      ],
      c,
    );
    expect(steps).toEqual([
      { head: "deterministic proof → land", detail: "deterministic: pass: 2 specifiers resolve to the same files" },
      { head: "llm triage p=0.90 → land (gpt)", detail: "llm: approve: only imports" },
    ]);
  });

  it("puts direction and decisions into ft why", () => {
    const landing: Landing = { id: "lnd_1", colonyId: "web", trunkSha: "b".repeat(40), parentSha: "a".repeat(40), proposalIds: ["prp_1"], intentIds: ["int_1"], paths: ["src/a.ts"], regions: ["src"], at: 1_000 };
    const note: LineageNote = {
      schema: "firetrident.lineage/v1",
      landingId: "lnd_1",
      colonyId: "web",
      proposals: [
        {
          id: "prp_1",
          agentId: "agt_1",
          agentKind: "internal",
          intent: { id: "int_1", title: "Greet", why: "say bonjour" },
          writeSet: [{ path: "src/a.ts", blob: "c".repeat(40) }],
          readSet: [],
          decisions: [{ kind: "triage", layer: "reflex", p: 0.2, action: "consult", by: "@cf/cloudflare/clef", answer: "needs_human 0.02" }],
          evidence: { checks: [], direction: { intentRevision: 2, revisions: [{ revision: 2, changed: ["why"], reason: "French UI", by: "matt", at: 0 }] } },
        },
      ],
    };
    const text = formatWhy({ path: "src/a.ts" }, [{ landing, note }], {}, c, 61_000);
    expect(text).toContain("revision built on r2 (amended 1 time)");
    expect(text).toContain('r2: why changed by matt 1m ago: "French UI"');
    expect(text).toContain("decided  reflex triage p=0.20 → consult (@cf/cloudflare/clef)");
    expect(text).toContain("reflex: needs_human 0.02");
  });

  it("reports what each command did", () => {
    expect(formatAmend("int_1", { intent: { title: "Greet", revision: 1 }, revision: null }, c)).toBe('✓ Nothing changed: int_1 "Greet" already says that (r1)');
    expect(formatAmend("int_1", { revision: { revision: 2, changed: ["priority"], reason: "urgent", substantive: false }, returned: 0, notified: [] }, c)).toContain("priority only: work in progress still fits");
    expect(formatWithdraw("int_1", "x", { already: true, intent: { withdrawnReason: "earlier" } }, c)).toBe("✓ int_1 was already withdrawn: earlier");
    expect(formatRetract("rul_1", "x", { withdrawn: 2, notified: [{ agentId: "a", delivery: "pushed" }, { agentId: "b", delivery: "inbox" }] }, c)).toContain("2 unlanded intents withdrawn; 2 agents told (1 pushed, 1 inbox)");
    expect(formatDirect("agt_1", { id: "dir_1", message: "m", delivery: "failed" }, c)).toMatch(/^! Directive dir_1 to agt_1: not delivered/);
  });
});
