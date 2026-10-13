import { describe, expect, it } from "vitest";
import type { ColonyEvent, Intent } from "@fire_trident/core";
import { EVENT_TYPES, helpText, parseCommand } from "../src/args.ts";
import { planRequest } from "../src/api.ts";
import { colors, formatEscalationAnswer, formatEscalations, formatEvent, formatIntentShow } from "../src/format.ts";
import { main } from "../src/run.ts";
import type { Io } from "../src/run.ts";

/** Agents' reports that an intent cannot be done as written: listing them and answering one. */

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

const report = "test/router.test.ts:12 expects 405,\nbut the spec says 404";
const escalated: Partial<Intent> = {
  id: "int_42",
  title: "Fix the router test",
  status: "open",
  footprint: ["src/router.ts"],
  escalation: { kind: "broken-test", report, by: "agt_7", at: 0 },
};

describe("parsing", () => {
  it("lists the reports of a colony", () => {
    expect(ok(["escalations", "web"])).toEqual({ name: "escalations", colony: "web" });
    expect(err(["escalations"])).toMatch(/missing <colony>/);
    expect(err(["escalations", "web", "extra"])).toMatch(/unexpected argument "extra"/);
  });

  it("answers one: amend with what changes, withdraw or dismiss with a note", () => {
    expect(ok(["escalation", "web", "int_42", "dismiss", "--note", "the test is right", "--by", "matt"])).toEqual({
      name: "escalation",
      colony: "web",
      intentId: "int_42",
      decision: "dismiss",
      note: "the test is right",
      by: "matt",
    });
    expect(ok(["escalation", "web", "int_42", "amend", "--note", "spec changed", "--why", "Return 404", "--footprint", "src/a.ts,src/b.ts", "--title", "Fix it"])).toEqual({
      name: "escalation",
      colony: "web",
      intentId: "int_42",
      decision: "amend",
      note: "spec changed",
      title: "Fix it",
      why: "Return 404",
      footprint: ["src/a.ts", "src/b.ts"],
    });
    expect(ok(["escalation", "web", "int_42", "withdraw", "--note", "not needed"])).toMatchObject({ decision: "withdraw" });
    expect(err(["escalation", "web", "int_42", "dismiss"])).toMatch(/missing --note/);
    expect(err(["escalation", "web", "int_42", "approve", "--note", "x"])).toMatch(/decision must be amend, withdraw or dismiss; got "approve"/);
    expect(err(["escalation", "web", "int_42", "amend", "--note", "x"])).toMatch(/amend says what changes/);
    expect(err(["escalation", "web", "int_42", "dismiss", "--note", "x", "--why", "y"])).toMatch(/--why does not apply to escalation dismiss/);
    expect(err(["escalation", "web", "int_42", "amend", "--note", "x", "--title", " "])).toMatch(/--title cannot be empty/);
    expect(err(["escalation", "web"])).toMatch(/missing <intentId>/);
  });

  it("knows the escalation event and has help for both commands", () => {
    expect(EVENT_TYPES).toContain("escalation");
    expect(ok(["watch", "web", "--only", "escalation"])).toEqual({ name: "watch", colony: "web", only: ["escalation"] });
    expect(helpText("escalations")).toContain("ft escalations <colony>");
    expect(helpText("escalation")).toContain("ft escalation <colony> <intentId> amend --note <text>");
    expect(helpText()).toContain("escalations <colony>");
    expect(helpText()).toContain("escalation <colony> <intent>");
  });
});

describe("requests", () => {
  it("maps each command to one HTTP call", () => {
    expect(planRequest({ name: "escalations", colony: "web" }, "me")).toEqual({ method: "GET", path: "/api/colonies/web/escalations" });
    expect(planRequest({ name: "escalation", colony: "web", intentId: "int 42", decision: "dismiss", note: "n" }, "me")).toEqual({
      method: "POST",
      path: "/api/colonies/web/intents/int%2042/escalation",
      body: { decision: "dismiss", note: "n", by: "me" },
    });
    expect(planRequest({ name: "escalation", colony: "web", intentId: "int_42", decision: "amend", note: "n", why: "w", footprint: ["src/a.ts"], by: "matt" }, "me")).toEqual({
      method: "POST",
      path: "/api/colonies/web/intents/int_42/escalation",
      body: { decision: "amend", note: "n", by: "matt", amend: { why: "w", footprint: ["src/a.ts"] } },
    });
  });
});

describe("formatting", () => {
  it("lists the reports waiting for a person, with how to answer", () => {
    expect(formatEscalations("web", [], c, 60_000)).toBe("✓ No reports waiting for a person in web.");
    const text = formatEscalations("web", [escalated, { ...escalated, id: "int_1", escalation: { ...escalated.escalation!, resolved: { by: "m", at: 1, decision: "dismiss", note: "n" } } }], c, 60_000);
    expect(text.split("\n")).toEqual([
      "1 report waiting for a person in web (no agent is offered these intents until you answer)",
      "",
      'int_42 "Fix the router test" src/router.ts',
      "  broken-test by agt_7 1m ago",
      "  │ test/router.test.ts:12 expects 405,",
      "  │ but the spec says 404",
      "",
      "  Answer one: ft escalation web <intentId> amend|withdraw|dismiss --note <text>",
    ]);
  });

  it("reports the answer", () => {
    const resolved = (decision: "amend" | "withdraw" | "dismiss") => ({ intent: { ...escalated, revision: 2, escalation: { ...escalated.escalation!, resolved: { by: "matt", at: 1, decision, note: "the spec changed" } } } });
    expect(formatEscalationAnswer("int_42", "amend", resolved("amend"), c)).toBe('✓ Amended int_42 "Fix the router test" to r2; agents are offered it again\n  answer: the spec changed');
    expect(formatEscalationAnswer("int_42", "withdraw", resolved("withdraw"), c)).toBe('✓ Withdrew int_42 "Fix the router test"\n  answer: the spec changed');
    expect(formatEscalationAnswer("int_42", "dismiss", resolved("dismiss"), c)).toContain("The answer is guidance on the intent: the next agent to take it reads it.");
  });

  it("prints the escalation event, and landing notices among directives", () => {
    const clock = () => "12:00:00";
    const lines = ([
      { t: "escalation", at: 0, intentId: "int_42", agentId: "agt_7", kind: "broken-test", report: "expects 405", title: "Fix the router test" },
      { t: "escalation", at: 0, intentId: "int_42", agentId: "agt_7", kind: "broken-test", report: "expects 405", title: "Fix the router test", resolved: { by: "matt", at: 0, decision: "dismiss", note: "the test is right" } },
      { t: "directive", at: 0, directiveId: "dir_1", agentId: "agt_1", intentId: "int_1", message: "Landing lnd_1 changed src/a.ts", by: "colony", kind: "landing" },
    ] as ColonyEvent[]).map((e) => formatEvent(e, c, clock));
    expect(lines).toEqual([
      '12:00:00 escalation int_42 broken-test by agt_7 "Fix the router test": "expects 405"',
      '12:00:00 escalation int_42 dismissed by matt: "the test is right" (broken-test report by agt_7)',
      '12:00:00 directive  agt_1 ← colony (landing notice): "Landing lnd_1 changed src/a.ts" (int_1)',
    ]);
  });

  it("shows an intent's reports in ft intent show", () => {
    const text = formatIntentShow({ intent: escalated, escalations: [escalated.escalation!] }, c, 120_000);
    expect(text).toContain('report    broken-test by agt_7 2m ago: "test/router.test.ts:12 expects 405, but the spec says 404" (waiting for a person)');
    expect(formatIntentShow({ intent: { ...escalated, escalation: { ...escalated.escalation!, resolved: { by: "matt", at: 60_000, decision: "dismiss", note: "fine" } } } }, c, 120_000)).toContain("(dismissed by matt 1m ago: fine)");
  });
});

describe("running", () => {
  function io(responses: Record<string, unknown>) {
    const out: string[] = [];
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    const fake: Io = {
      env: { FT_URL: "https://ft.test", FT_TOKEN: "t", FT_USER: "matt" },
      stdout: (line) => out.push(line),
      stderr: (line) => out.push(line),
      isTTY: false,
      fetch: (async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        calls.push({ method, url, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
        const key = `${method} ${new URL(url).pathname}`;
        return new Response(JSON.stringify(responses[key] ?? { error: "no route" }), { status: key in responses ? 200 : 404, headers: { "content-type": "application/json" } });
      }) as typeof fetch,
      readFile: async () => "",
      sleep: async () => undefined,
      now: () => 60_000,
      WebSocket: globalThis.WebSocket,
      onInterrupt: () => undefined,
    };
    return { fake, out, calls };
  }

  it("lists the reports and answers one", async () => {
    const r = io({
      "GET /api/colonies/web/escalations": { colonyId: "web", total: 1, intents: [escalated] },
      "POST /api/colonies/web/intents/int_42/escalation": { intent: { ...escalated, escalation: { ...escalated.escalation!, resolved: { by: "matt", at: 1, decision: "dismiss", note: "fine" } } } },
    });
    expect(await main(["escalations", "web"], r.fake)).toBe(0);
    expect(r.out[0]!.split("\n")[0]).toBe("1 report waiting for a person in web (no agent is offered these intents until you answer)");
    expect(await main(["escalation", "web", "int_42", "dismiss", "--note", "fine"], r.fake)).toBe(0);
    expect(r.calls[1]).toEqual({ method: "POST", url: "https://ft.test/api/colonies/web/intents/int_42/escalation", body: { decision: "dismiss", note: "fine", by: "matt" } });
    expect(r.out.join("\n")).toContain('✓ Dismissed the report on int_42 "Fix the router test"; agents are offered it again');
  });
});
