import { describe, expect, it } from "vitest";
import type { GuideEntry, GuideLesson } from "@fire_trident/core";
import { helpText, parseCommand } from "../src/args.ts";
import { planRequest } from "../src/api.ts";
import { colors } from "../src/format.ts";
import { formatGuide, formatLessonDecision } from "../src/guide.ts";
import { main } from "../src/run.ts";
import type { Io } from "../src/run.ts";

/** `ft guide`: the colony's field guide, and a person's decision on one lesson. */

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

const entry: GuideEntry = { id: "les_1", text: "Routes register in src/routes/index.ts.", agentId: "agt_9", author: "platform", model: "@cf/model", modelEvidence: "observed", landingId: "lnd_7", activatedAt: 0, activatedBy: "certification" };
const waiting: Partial<GuideLesson> = { id: "les_2", text: "The cache is per isolate.", status: "candidate", agentId: "agt_3", proposalId: "prp_5", createdAt: 30_000, provenance: { author: "external", model: "m", modelEvidence: "declared" } };

describe("parsing", () => {
  it("lists the guide, or decides on one lesson", () => {
    expect(ok(["guide", "web"])).toEqual({ name: "guide", colony: "web" });
    expect(ok(["guide", "web", "approve", "les_1"])).toEqual({ name: "guide-decide", colony: "web", lessonId: "les_1", action: "approve" });
    expect(ok(["guide", "web", "reject", "les_1", "--reason", "moved", "--by", "matt"])).toEqual({ name: "guide-decide", colony: "web", lessonId: "les_1", action: "reject", reason: "moved", by: "matt" });
    expect(err(["guide"])).toMatch(/missing <colony>/);
    expect(err(["guide", "web", "keep", "les_1"])).toMatch(/the action must be approve or reject; got "keep"/);
    expect(err(["guide", "web", "approve"])).toMatch(/missing <lessonId>/);
    expect(err(["guide", "web", "--reason", "x"])).toMatch(/--reason does not apply to listing the guide/);
    expect(err(["guide", "web", "approve", "les_1", "extra"])).toMatch(/unexpected argument "extra"/);
    expect(helpText("guide")).toContain("ft guide <colony> approve|reject <lessonId>");
    expect(helpText()).toContain("guide <colony>");
  });

  it("maps each to one HTTP call", () => {
    expect(planRequest({ name: "guide", colony: "web" }, "me")).toEqual({ method: "GET", path: "/api/colonies/web/guide" });
    expect(planRequest({ name: "guide-decide", colony: "web", lessonId: "les 1", action: "reject", reason: "r" }, "me")).toEqual({
      method: "POST",
      path: "/api/colonies/web/guide/les%201",
      body: { action: "reject", by: "me", reason: "r" },
    });
  });
});

describe("formatting", () => {
  it("lists the active lessons with who wrote them, and for the operator the candidates and the ones that left", () => {
    const text = formatGuide(
      "web",
      { on: true, gate: "certification", note: "A lesson joins the guide once ...", active: [entry], chars: 39, limits: { activeLessons: 30 }, candidates: [waiting], ended: [{ id: "les_0", status: "dropped", endReason: "matt reverted landing lnd_1: wrong" }] },
      c,
      60_000,
    );
    expect(text.split("\n")).toEqual([
      "1/30 active lesson in web's field guide (39 characters)",
      "  A lesson joins the guide once ...",
      "",
      "les_1 Routes register in src/routes/index.ts.",
      "  by agt_9 (in-platform, @cf/model observed), landing lnd_7, active 1m ago by a green certification",
      "",
      "1 candidate waiting",
      "  les_2 The cache is per isolate.",
      "    by agt_3 (external, m declared), proposal prp_5, not landed yet, left 30s ago",
      "",
      "1 dropped or retired lately",
      "  les_0 dropped: matt reverted landing lnd_1: wrong",
      "",
      "  Decide one: ft guide web approve|reject <lessonId> [--reason <text>]",
    ]);
    expect(formatGuide("web", { on: false, note: "The field guide is off for this colony (FT_FIELD_GUIDE)." }, c, 0)).toBe("! The field guide is off for this colony (FT_FIELD_GUIDE).");
    // The public view has no candidates: no decide hint either.
    expect(formatGuide("web", { on: true, active: [] }, c, 0)).toBe("0 active lessons in web's field guide");
  });

  it("reports a decision", () => {
    expect(formatLessonDecision("les_2", "approve", { status: "active" }, c)).toBe("✓ Approved les_2: it is active, and every take carries it as data with its provenance.");
    expect(formatLessonDecision("les_2", "reject", { status: "dropped", endReason: "rejected by matt: moved" }, c)).toBe("✓ Rejected les_2: it left the guide (rejected by matt: moved).");
  });
});

describe("running", () => {
  it("lists the guide and approves a lesson", async () => {
    const out: string[] = [];
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    const responses: Record<string, unknown> = {
      "GET /api/colonies/web/guide": { colonyId: "web", on: true, gate: "person", active: [entry], chars: 39 },
      "POST /api/colonies/web/guide/les_2": { ...waiting, status: "active" },
    };
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
    expect(await main(["guide", "web"], fake)).toBe(0);
    expect(out[0]!.split("\n")[0]).toBe("1 active lesson in web's field guide (39 characters)");
    expect(await main(["guide", "web", "approve", "les_2"], fake)).toBe(0);
    expect(calls[1]).toEqual({ method: "POST", url: "https://ft.test/api/colonies/web/guide/les_2", body: { action: "approve", by: "matt" } });
    expect(out.join("\n")).toContain("✓ Approved les_2: it is active");
  });
});
