import { describe, expect, it } from "vitest";
import type { Intent } from "@fire_trident/core";
import { A2A_ERRORS, A2AFault, a2aEnabled, agentCard, decodeCursor, encodeCursor, readSendMessage, renderTask, statusFilter, versionSupported, type TaskContext } from "../../src/api/a2a.ts";
import { A2A_CANCEL_REASON, a2aState, a2aTerminal, isA2ACancel, type A2ATaskFacts } from "../../src/colony/a2a.ts";

/**
 * The Agent2Agent door's pure parts: how an intent's status maps to a task's state, how a SendMessage's message
 * becomes an intent, and how a task reads in the protocol's 1.0 shapes and in 0.3's. test/do/a2a.test.ts runs the
 * routes against the real colony.
 */

const ctx: TaskContext = { colonyId: "links", origin: "https://ft.test", publicGit: false };

function intent(extra: Partial<Intent> = {}): Intent {
  return {
    id: "int_a1",
    colonyId: "links",
    title: "Add rate limiting to /api/links",
    why: "Anonymous callers flood it.",
    source: "agent",
    footprint: ["src/links/**"],
    priority: 1,
    status: "open",
    createdAt: Date.UTC(2026, 9, 14, 12),
    createdBy: "a2a",
    ...extra,
  };
}

function facts(extra: Partial<Intent> = {}, more: Partial<A2ATaskFacts> = {}): A2ATaskFacts {
  return { intent: intent(extra), updatedAt: Date.UTC(2026, 9, 14, 12, 5), ...more };
}

const message = (parts: unknown[], extra: Record<string, unknown> = {}) => ({ messageId: "m1", role: "ROLE_USER", parts, ...extra });
const fault = (fn: () => unknown): A2AFault => {
  try {
    fn();
  } catch (err) {
    if (err instanceof A2AFault) return err;
    throw err;
  }
  throw new Error("expected a fault");
};

describe("intent status to task state", () => {
  it("maps every status, a waiting report, and the two kinds of withdrawal", () => {
    expect(a2aState({ status: "open" })).toBe("submitted");
    expect(a2aState({ status: "open" }, true)).toBe("input-required");
    expect(a2aState({ status: "claimed" })).toBe("working");
    expect(a2aState({ status: "proposed" })).toBe("working");
    expect(a2aState({ status: "landed" })).toBe("completed");
    expect(a2aState({ status: "withdrawn", withdrawnReason: A2A_CANCEL_REASON })).toBe("canceled");
    expect(a2aState({ status: "withdrawn", withdrawnReason: `${A2A_CANCEL_REASON}: plan changed` })).toBe("canceled");
    expect(a2aState({ status: "withdrawn", withdrawnReason: "rule rul_1 retracted: too strict" })).toBe("failed");
    expect(a2aState({ status: "withdrawn" })).toBe("failed");
    expect(a2aState({ status: "abandoned" })).toBe("failed");
    expect(a2aState({ status: "something-new" })).toBe("failed");
    expect(isA2ACancel(null)).toBe(false);
    expect(["completed", "canceled", "failed"].every((s) => a2aTerminal(s as never))).toBe(true);
    expect(["submitted", "working", "input-required"].some((s) => a2aTerminal(s as never))).toBe(false);
  });
});

describe("reading a SendMessage", () => {
  it("takes the first line as the title, the rest as the why, and the footprint from a data part", () => {
    const req = readSendMessage(
      message([
        { text: "\n  Add rate limiting to /api/links  \nAnonymous callers flood it.\r\n\r\nCap them at 60 a minute." },
        { data: { footprint: ["src/links/**"], acceptance: ["a 61st request in a minute gets 429"] }, mediaType: "application/json" },
        { data: { priority: 3 } },
      ]),
      "links",
    );
    expect(req).toEqual({
      title: "Add rate limiting to /api/links",
      why: "Anonymous callers flood it.\n\nCap them at 60 a minute.",
      footprint: ["src/links/**"],
      acceptance: ["a 61st request in a minute gets 429"],
      priority: 3,
    });
  });

  it("reads 0.3 parts and role, a single footprint string, and force", () => {
    const req = readSendMessage(
      { kind: "message", messageId: "m2", role: "user", contextId: "links", parts: [{ kind: "text", text: "Rate-limit the links API" }, { kind: "data", data: { footprint: "src/links/handler.ts", force: true } }] },
      "links",
    );
    expect(req).toEqual({ title: "Rate-limit the links API", why: "", footprint: ["src/links/handler.ts"], force: true });
  });

  it("refuses what cannot make an intent, saying what to send instead", () => {
    const text = { text: "Add rate limiting" };
    const fp = { data: { footprint: ["src/links/**"] } };
    expect(fault(() => readSendMessage(message([text]), "links")).message).toMatch(/needs a footprint.*"footprint": \["src\/links\/\*\*"\]/);
    expect(fault(() => readSendMessage(message([fp]), "links")).message).toMatch(/needs text: its first line is the intent's title/);
    expect(fault(() => readSendMessage(message([text, { data: { footprints: ["a"] } }]), "links")).message).toMatch(/"footprints" is not one of them/);
    expect(fault(() => readSendMessage(message([text, { data: ["a"] }]), "links")).message).toMatch(/a data part holds a JSON object/);
    expect(fault(() => readSendMessage(message([text, fp], { role: "ROLE_AGENT" }), "links")).message).toMatch(/role must be ROLE_USER/);
    expect(fault(() => readSendMessage({ role: "ROLE_USER", parts: [text, fp] }, "links")).message).toMatch(/messageId is required/);
    expect(fault(() => readSendMessage(message([text, fp], { contextId: "ctx-9" }), "links")).message).toBe('this colony keeps one context, links: send contextId "links" or none');
    expect(fault(() => readSendMessage(message([{ text: "x".repeat(501) }, fp]), "links")).message).toMatch(/^the message does not make an intent: the first line \(the title\)/);
    expect(fault(() => readSendMessage(message([text, { data: { footprint: [] } }]), "links")).message).toMatch(/footprint/);
    expect(fault(() => readSendMessage(message([text, { data: { priority: -1, footprint: ["a"] } }]), "links")).message).toMatch(/priority/);
    for (const f of [() => readSendMessage(message([text, fp, { raw: "aGk=", filename: "a.png" }]), "links"), () => readSendMessage(message([text, fp, { kind: "file", file: { uri: "x" } }]), "links")]) {
      const e = fault(f);
      expect(e.code).toBe(A2A_ERRORS.contentTypeNotSupported);
      expect(e.message).toMatch(/reads text and JSON data parts, not files/);
    }
    expect(fault(() => readSendMessage(undefined, "links")).code).toBe(A2A_ERRORS.invalidParams);
  });
});

describe("a task in the protocol's shapes", () => {
  it("reads an open intent as submitted, in 1.0 and in 0.3", () => {
    const v1 = renderTask(facts(), "1.0", ctx);
    expect(v1).toEqual({
      id: "int_a1",
      contextId: "links",
      status: {
        state: "TASK_STATE_SUBMITTED",
        message: {
          messageId: `status-int_a1-${Date.UTC(2026, 9, 14, 12, 5)}`,
          role: "ROLE_AGENT",
          parts: [{ text: "Intent int_a1 is open in colony links: no agent has taken it yet. Follow it with GetTask; CancelTask withdraws it." }],
          taskId: "int_a1",
          contextId: "links",
        },
        timestamp: "2026-10-14T12:05:00.000Z",
      },
      metadata: {
        firetrident: { colony: "links", intent: "int_a1", status: "open", title: "Add rate limiting to /api/links", source: "agent", createdBy: "a2a", url: "https://ft.test/api/colonies/links/intents/int_a1" },
      },
    });
    const v03 = renderTask(facts(), "0.3", ctx) as { kind: string; status: { state: string; message: { kind: string; role: string; parts: unknown[] } } };
    expect(v03.kind).toBe("task");
    expect(v03.status.state).toBe("submitted");
    expect(v03.status.message).toMatchObject({ kind: "message", role: "agent" });
    expect(v03.status.message.parts).toEqual([{ kind: "text", text: expect.stringContaining("is open in colony links") }]);
  });

  it("says what each state means and what to do next", () => {
    const text = (f: A2ATaskFacts) => ((renderTask(f, "1.0", ctx).status as { message: { parts: Array<{ text: string }> } }).message.parts[0]!.text);
    const state = (f: A2ATaskFacts) => (renderTask(f, "1.0", ctx).status as { state: string }).state;
    const report = { kind: "contradictory-spec" as const, report: "The spec asks for 60 and for 100.", by: "agt_1", at: 1 };
    const waiting = facts({ escalation: report }, { waiting: true });
    expect(state(waiting)).toBe("TASK_STATE_INPUT_REQUIRED");
    expect(text(waiting)).toBe(
      "An agent reported that intent int_a1 cannot be done as written (contradictory-spec), so no agent takes it until a person answers the report in colony links (ft escalation, or POST /api/colonies/links/intents/int_a1/escalation). CancelTask withdraws it.",
    );
    expect((renderTask(waiting, "1.0", ctx).metadata as { firetrident: { report: unknown } }).firetrident.report).toEqual({ kind: "contradictory-spec", report: report.report, by: "agt_1", at: "1970-01-01T00:00:00.001Z" });
    // A resolved report is history, not a wait.
    expect(state(facts({ escalation: { ...report, resolved: { by: "p", at: 2, decision: "dismiss", note: "n" } } }))).toBe("TASK_STATE_SUBMITTED");
    expect(state(facts({ status: "claimed" }))).toBe("TASK_STATE_WORKING");
    expect(text(facts({ status: "claimed" }))).toBe("An agent took intent int_a1 and is working on it. Follow it with GetTask.");
    expect(text(facts({ status: "proposed" }))).toMatch(/proposed a change for intent int_a1; review and its lane decide/);
    expect(text(facts({ status: "proposed" }, { inReview: true }))).toBe("A change for intent int_a1 waits for a person's review in colony links. Follow it with GetTask.");
    expect(state(facts({ status: "withdrawn", withdrawnReason: `${A2A_CANCEL_REASON}: plan changed` }))).toBe("TASK_STATE_CANCELED");
    expect(text(facts({ status: "withdrawn", withdrawnReason: `${A2A_CANCEL_REASON}: plan changed` }))).toBe("Intent int_a1 was withdrawn by CancelTask (plan changed): its needs are gone and no agent will take it.");
    expect(state(facts({ status: "withdrawn", withdrawnReason: "superseded by int_b2" }))).toBe("TASK_STATE_FAILED");
    expect(text(facts({ status: "withdrawn", withdrawnReason: "superseded by int_b2" }))).toBe("Intent int_a1 was withdrawn: superseded by int_b2. It will not land; send a new message to declare the work again.");
    expect(text(facts({ status: "landed" }))).toMatch(/^Intent int_a1 landed\. Its landing is not on record here/);
  });

  it("completes with the landing commit, the files and their why links", () => {
    const commit = "c".repeat(40);
    const landed = facts({ status: "landed" }, { landing: { id: "lnd_1", proposalId: "prp_1", commit, at: Date.UTC(2026, 9, 14, 12, 4), paths: ["src/links/limit.ts", "src/links/handler.ts"], morePaths: 0 } });
    const task = renderTask(landed, "1.0", { ...ctx, publicGit: true });
    expect(task.status).toMatchObject({ state: "TASK_STATE_COMPLETED" });
    const why = "https://ft.test/api/colonies/links/why?path=src%2Flinks%2Flimit.ts";
    expect((task.status as { message: { parts: Array<{ text: string }> } }).message.parts[0]!.text).toBe(
      `Intent int_a1 landed in trunk commit ${commit} (landing lnd_1). Read why each file changed with ft why links src/links/limit.ts, or GET ${why}.`,
    );
    expect(task.artifacts).toEqual([
      {
        artifactId: "landing-lnd_1",
        name: "Landing",
        description: "The trunk commit that landed this intent, the files its change wrote, and where to read why each changed.",
        parts: [
          { text: `Landed in trunk commit ${commit} (landing lnd_1), writing 2 files; why each changed: ${why} and the other files' links in the data part.` },
          {
            data: {
              landing: "lnd_1",
              commit,
              proposal: "prp_1",
              landedAt: "2026-10-14T12:04:00.000Z",
              files: [
                { path: "src/links/limit.ts", why },
                { path: "src/links/handler.ts", why: "https://ft.test/api/colonies/links/why?path=src%2Flinks%2Fhandler.ts" },
              ],
              whyCommand: "ft why links src/links/limit.ts",
              git: "https://ft.test/git/links.git",
            },
            mediaType: "application/json",
          },
        ],
      },
    ]);
    // 0.3 parts carry kind; without artifacts asked for, none.
    const v03 = renderTask(landed, "0.3", ctx) as { artifacts: Array<{ parts: Array<{ kind: string }> }> };
    expect(v03.artifacts[0]!.parts.map((p) => p.kind)).toEqual(["text", "data"]);
    expect(renderTask(landed, "1.0", ctx, { artifacts: false })).not.toHaveProperty("artifacts");
  });

  it("puts a lead sentence first and survives a stored time that is not a number", () => {
    const task = renderTask(facts({}, { updatedAt: Number.NaN }), "1.0", ctx, { lead: "Nothing new was declared.", extra: { duplicateOf: "int_a1" } });
    const status = task.status as { message: { parts: Array<{ text: string }> }; timestamp?: string };
    expect(status.message.parts[0]!.text).toMatch(/^Nothing new was declared\. Intent int_a1 is open/);
    expect(status.timestamp).toBeUndefined();
    expect((task.metadata as { firetrident: Record<string, unknown> }).firetrident.duplicateOf).toBe("int_a1");
  });
});

describe("the agent card", () => {
  it("names the colony, the JSON-RPC URL, the skill and the bearer token writes need", () => {
    const card = agentCard({ id: "links", name: "Links", source: { url: "https://example.com/links.git", branch: "main" } }, { origin: "https://ft.test", version: "abc1234" }) as Record<string, any>;
    expect(card.name).toBe("FireTrident colony Links");
    expect(card.description).toMatch(/^The Links colony \(links\) on FireTrident: .* Its trunk was imported from https:\/\/example\.com\/links\.git\./);
    expect(card.supportedInterfaces).toEqual([
      { url: "https://ft.test/api/colonies/links/a2a", protocolBinding: "JSONRPC", protocolVersion: "1.0" },
      { url: "https://ft.test/api/colonies/links/a2a", protocolBinding: "JSONRPC", protocolVersion: "0.3" },
    ]);
    expect(card.version).toBe("abc1234");
    expect(card.capabilities).toEqual({ streaming: false, pushNotifications: false, extendedAgentCard: false });
    expect(card.securitySchemes.adminToken.httpAuthSecurityScheme).toMatchObject({ scheme: "Bearer", description: expect.stringMatching(/GetTask, ListTasks and this card do not/) });
    expect(card.securityRequirements).toEqual([{ schemes: { adminToken: { list: [] } } }]);
    expect(card.skills).toHaveLength(1);
    expect(card.skills[0]).toMatchObject({ id: "declare-intent", name: "Declare an intent", securityRequirements: card.securityRequirements });
    expect(card.skills[0].description).toMatch(/"footprint"/);
  });
});

describe("the door's small rules", () => {
  it("is on only where FT_A2A covers the colony", () => {
    expect(a2aEnabled(undefined, "links")).toBe(false);
    expect(a2aEnabled("off", "links")).toBe(false);
    expect(a2aEnabled("on", "links")).toBe(true);
    expect(a2aEnabled("hono, links", "links")).toBe(true);
    expect(a2aEnabled("hono", "links")).toBe(false);
  });

  it("speaks A2A 1.0 and 0.3, and an empty version means 0.3", () => {
    for (const v of [undefined, null, "", "1.0", "1.0.0", "0.3", "0.3.0", " 1.0 "]) expect(versionSupported(v), String(v)).toBe(true);
    for (const v of ["2.0", "0.2", "1", "latest", "1.1"]) expect(versionSupported(v), v).toBe(false);
  });

  it("gives page tokens it can read back, and refuses others", () => {
    const token = encodeCursor({ at: 1760443200123, id: "int_Ab9-x_" });
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(token)).toEqual({ at: 1760443200123, id: "int_Ab9-x_" });
    for (const bad of ["", "!!!", btoa("12:"), btoa("x:int_a"), btoa("1:a b")]) expect(decodeCursor(bad), bad).toBeNull();
  });

  it("filters by any task state, in either spelling, and matches nothing for states no intent has", () => {
    expect(statusFilter(undefined)).toBeNull();
    expect(statusFilter("TASK_STATE_UNSPECIFIED")).toBeNull();
    expect(statusFilter("TASK_STATE_COMPLETED")).toEqual(["completed"]);
    expect(statusFilter("input-required")).toEqual(["input-required"]);
    expect(statusFilter("TASK_STATE_REJECTED")).toBe("none");
    expect(fault(() => statusFilter("done")).message).toMatch(/is not a task state: use one of TASK_STATE_SUBMITTED/);
    expect(fault(() => statusFilter(3)).code).toBe(A2A_ERRORS.invalidParams);
  });
});
