import { describe, expect, it } from "vitest";
import type { Directive } from "@fire_trident/core";
import {
  DIRECTION_COLUMNS,
  ESCALATION_KINDS,
  MAX_REPORT_CHARS,
  describeChanges,
  directiveText,
  escalationDecision,
  escalationKind,
  footprintDelta,
  guidanceText,
  inboxEntry,
  intentChanges,
  isInboxDirective,
  isRedirect,
  landedStaleText,
  landingMessage,
  migrateDirection,
  missedRevisions,
  noteDecision,
  noteDecisions,
  parseEscalation,
  parseLandingNotice,
  reportText,
  revisedReturn,
  splitByDirection,
  staleDirection,
  staleRevisionError,
  supersededReturn,
  toDirective,
  toRevision,
  withdrawnError,
  withdrawnReturn,
} from "../../src/colony/direction.ts";

const base = { title: "Create greeting", why: "say hello", footprint: ["src/a.ts", "src/b.ts"], priority: 1 };

describe("intentChanges", () => {
  it("lists only the fields that change, with before and after", () => {
    const d = intentChanges(base, { why: "say bonjour", priority: 1, title: "Create greeting" });
    expect(d.changed).toEqual(["why"]);
    expect(d.before).toEqual({ why: "say hello" });
    expect(d.after).toEqual({ why: "say bonjour" });
    expect(d.next).toEqual({ ...base, why: "say bonjour" });
    expect(d.substantive).toBe(true);
  });

  it("compares footprints as sets and treats a priority-only change as not substantive", () => {
    expect(intentChanges(base, { footprint: ["src/b.ts", "src/a.ts"] }).changed).toEqual([]);
    const p = intentChanges(base, { priority: 5 });
    expect(p).toMatchObject({ changed: ["priority"], substantive: false, after: { priority: 5 } });
    const f = intentChanges(base, { footprint: ["src/a.ts", "src/c.ts"] });
    expect(f).toMatchObject({ changed: ["footprint"], substantive: true, before: { footprint: base.footprint }, after: { footprint: ["src/a.ts", "src/c.ts"] } });
  });

  it("describes the change, naming paths the footprint gained and lost", () => {
    expect(footprintDelta(["a", "b"], ["b", "c"])).toEqual({ added: ["c"], removed: ["a"] });
    expect(describeChanges(["why"])).toBe("why changed");
    expect(describeChanges(["title", "why", "footprint"])).toBe("title, why and footprint changed");
    expect(describeChanges(["footprint"], { footprint: ["a", "b"] }, { footprint: ["b", "c"] })).toBe("footprint changed (+c, -a)");
    expect(describeChanges([])).toBe("nothing changed");
  });
});

describe("return reasons", () => {
  it("marks direction returns so they leave no failure mark", () => {
    expect(withdrawnReturn("superseded by the router work")).toBe("withdrawn: superseded by the router work");
    expect(revisedReturn(1, 2, ["why"], "French UI")).toBe("intent revised: r1 → r2, why changed (French UI)");
    expect(revisedReturn(null, 3, ["title"], "x")).toBe("intent revised: r3, title changed (x)");
    expect(supersededReturn("directive dir_1 from matt")).toBe("superseded: directive dir_1 from matt");
    for (const r of [withdrawnReturn("x"), revisedReturn(1, 2, ["why"], "x"), supersededReturn("x")]) expect(isRedirect(r)).toBe(true);
    for (const r of ["stale read: src/a.ts", "llm: off intent", undefined, "withdrawn"]) expect(isRedirect(r)).toBe(false);
  });

  it("explains a refused proposal in a way the agent loop recognizes", () => {
    expect(staleRevisionError("int_1", 1, 2, ["why"], "French UI")).toMatch(/^intent revised: int_1 is at r2 \(why changed: French UI\); this change was built on r1/);
    expect(withdrawnError("int_1", "not needed")).toBe("intent withdrawn: int_1 (not needed); stop work on it and take other work.");
    expect(withdrawnError("int_1", null)).toContain("(no reason given)");
  });
});

describe("staleDirection (the lane's pre-land check)", () => {
  const revised = { status: "claimed" as const, revision: 3, revisions: [
    { revision: 2, changed: ["why" as const], reason: "first", at: 1_000 },
    { revision: 3, changed: ["footprint" as const], reason: "second", at: 2_000 },
  ] };

  it("never lands a change for a withdrawn intent", () => {
    expect(staleDirection({ intentRevision: 1, createdAt: 0 }, { status: "withdrawn", withdrawnReason: "not needed" })).toBe("withdrawn: not needed");
  });

  it("returns a change built on an older revision, naming every field that changed since", () => {
    expect(staleDirection({ intentRevision: 1, createdAt: 0 }, revised)).toBe("intent revised: r1 → r3, why and footprint changed (second)");
    expect(staleDirection({ intentRevision: 2, createdAt: 0 }, revised)).toBe("intent revised: r2 → r3, footprint changed (second)");
    expect(staleDirection({ intentRevision: 3, createdAt: 0 }, revised)).toBeNull();
  });

  it("falls back to the proposal's time when it carries no revision, and passes unknown intents", () => {
    expect(staleDirection({ createdAt: 1_500 }, revised)).toBe("intent revised: r3, footprint changed (second)");
    expect(staleDirection({ createdAt: 2_500 }, revised)).toBeNull();
    expect(staleDirection({ intentRevision: 1, createdAt: 0 }, undefined)).toBeNull();
    expect(staleDirection({ intentRevision: 1, createdAt: 0 }, { status: "claimed", revision: 1 })).toBeNull();
  });

  it("splits a batch into changes that may land and changes that go back", () => {
    const batch = [
      { id: "p1", intentId: "i1", intentRevision: 1, createdAt: 0 },
      { id: "p2", intentId: "i2", intentRevision: 1, createdAt: 0 },
      { id: "p3", intentId: "i3", createdAt: 0 },
    ];
    const out = splitByDirection(batch, { i1: { status: "withdrawn", withdrawnReason: "gone" }, i2: { status: "claimed", revision: 1 } });
    expect(out.keep.map((p) => p.id)).toEqual(["p2", "p3"]);
    expect(out.returned).toEqual([{ p: batch[0], reason: "withdrawn: gone" }]);
    expect(splitByDirection(batch, undefined).keep).toHaveLength(3);
  });
});

describe("directives and the inbox", () => {
  const d: Directive = { id: "dir_1", colonyId: "c", agentId: "agt_1", kind: "guidance", intentId: "int_1", message: "use the logger", by: "matt", at: 5 };

  it("lines a directive up with proposal entries and tells them apart", () => {
    const e = inboxEntry(d);
    expect(e).toMatchObject({ kind: "directive", id: "dir_1", intentId: "int_1", status: "directive", createdAt: 5, headSha: "" });
    expect(e.reason).toBe("Directive from matt about intent int_1: use the logger");
    expect(isInboxDirective(e)).toBe(true);
    expect(isInboxDirective({ id: "prp_1", status: "landed" })).toBe(false);
    expect(inboxEntry({ ...d, intentId: undefined } as Directive).intentId).toBe("");
  });

  it("shows reviewers the guidance as part of the intent", () => {
    expect(guidanceText([{ message: "Also export  FAREWELL_VERSION", by: "matt" }])).toBe(
      "Directives from a human operator about this intent (they refine it; the agent was told to follow them, and where they conflict with the text above they take precedence):\n- Also export FAREWELL_VERSION (from matt)",
    );
  });

  it("tells the agent what to do for revisions and withdrawals", () => {
    expect(directiveText({ ...d, kind: "revision", revision: 2, changed: ["why"], message: "French UI" })).toMatch(/^Intent int_1 revised to r2 \(why changed\): French UI\. Call take/);
    expect(directiveText({ ...d, kind: "withdrawal", message: "not needed" })).toMatch(/^Intent int_1 withdrawn: not needed\. Stop working on it/);
  });

  it("reads rows back", () => {
    expect(toDirective({ id: "dir_2", agent_id: "agt_1", kind: "revision", intent_id: "int_1", message: "m", by: "b", at: 1, revision: 2, changed: '["why"]', delivered_at: 3, via: "inbox" }, "c")).toEqual({
      id: "dir_2",
      colonyId: "c",
      agentId: "agt_1",
      kind: "revision",
      intentId: "int_1",
      message: "m",
      by: "b",
      at: 1,
      revision: 2,
      changed: ["why"],
      deliveredAt: 3,
      via: "inbox",
    });
    expect(toRevision({ intent_id: "i", revision: 2, at: 1, by: "b", reason: "r", changed: '["why"]', before: '{"why":"a"}', after: '{"why":"b"}', substantive: 1 })).toEqual({
      intentId: "i",
      revision: 2,
      changed: ["why"],
      before: { why: "a" },
      after: { why: "b" },
      reason: "r",
      by: "b",
      at: 1,
      substantive: true,
    });
  });
});

describe("lineage note decisions", () => {
  const row = (over: Record<string, unknown>) => ({ id: "dec_1", kind: "triage", subject: "prp_1", layer: "reflex", answers: "{}", p: 0.9312, action: "land", at: 10, ...over });

  it("keeps each decide-arc decision compact: layer, p, action, who answered, the answer", () => {
    const reflex = noteDecision(
      row({ answers: JSON.stringify({ model: "@cf/cloudflare/clef", reflex: { needsHuman: 0.03, sensitive: 0.01, offIntent: 0.02, risk: 0.2 }, reasons: ["innate ok"] }) }),
    );
    expect(reflex).toEqual({
      kind: "triage",
      layer: "reflex",
      p: 0.931,
      action: "land",
      at: 10,
      question: expect.stringContaining("needs_human"),
      by: "@cf/cloudflare/clef",
      answer: "needs_human 0.03, touches_sensitive 0.01, off_intent 0.02, risk 0.20; innate ok",
    });
    const llm = noteDecision(row({ layer: "llm", answers: JSON.stringify({ model: "gpt", verdict: { verdict: "approve", reason: "only specifiers" } }) }));
    expect(llm).toMatchObject({ layer: "llm", by: "gpt", answer: "approve: only specifiers", question: "second opinion: approve, return or escalate" });
    const human = noteDecision(row({ layer: "human", action: "approve", answers: JSON.stringify({ decision: "approve", reason: "looks right", by: "matt" }) }));
    expect(human).toMatchObject({ layer: "human", by: "matt", answer: "approve: looks right", question: "human review" });
    expect(noteDecision(row({ answers: "not json" }))).not.toHaveProperty("answer");
  });

  it("groups by proposal, oldest first, the latest eight each", () => {
    const rows = Array.from({ length: 10 }, (_, i) => row({ id: `d${i}`, at: 100 - i, action: `a${i}` }));
    const out = noteDecisions([...rows, row({ subject: "prp_2", at: 1 })]);
    expect(Object.keys(out).sort()).toEqual(["prp_1", "prp_2"]);
    expect(out.prp_1).toHaveLength(8);
    expect(out.prp_1!.map((d) => d.at)).toEqual([93, 94, 95, 96, 97, 98, 99, 100]);
  });
});

describe("migrateDirection", () => {
  it("creates its tables and adds each missing column once", () => {
    const columns = new Set<string>();
    const statements: string[] = [];
    const sql = {
      exec(q: string): unknown {
        statements.push(q);
        const m = /^ALTER TABLE (\w+) ADD COLUMN (\w+)/.exec(q);
        if (m) {
          const key = `${m[1]}.${m[2]}`;
          if (columns.has(key)) throw new Error(`duplicate column name: ${m[2]}`);
          columns.add(key);
        }
        return null;
      },
    };
    migrateDirection(sql);
    migrateDirection(sql); // a second wake: every ALTER throws, nothing breaks
    expect(columns.size).toBe(DIRECTION_COLUMNS.length);
    expect(statements.filter((s) => s.startsWith("CREATE TABLE IF NOT EXISTS directives"))).toHaveLength(2);
  });
});

describe("missedRevisions (a change that landed after an amendment)", () => {
  const revisions = [
    { revision: 2, substantive: false, at: 1_000 },
    { revision: 3, substantive: true, at: 2_000 },
    { revision: 4, substantive: true, at: 3_000 },
  ];

  it("lists the substantive amendments after the revision the change was built on", () => {
    expect(missedRevisions({ intentRevision: 1, createdAt: 0 }, 4, revisions).map((r) => r.revision)).toEqual([3, 4]);
    expect(missedRevisions({ intentRevision: 3, createdAt: 0 }, 4, revisions).map((r) => r.revision)).toEqual([4]);
    expect(missedRevisions({ intentRevision: 4, createdAt: 0 }, 4, revisions)).toEqual([]);
    // Only the priority moved since r1: the change still fits.
    expect(missedRevisions({ intentRevision: 1, createdAt: 0 }, 2, revisions.slice(0, 1))).toEqual([]);
  });

  it("falls back to the proposal's time, and ignores revisions past the current one", () => {
    expect(missedRevisions({ createdAt: 2_500 }, 4, revisions).map((r) => r.revision)).toEqual([4]);
    expect(missedRevisions({ intentRevision: 1, createdAt: 0 }, 3, revisions).map((r) => r.revision)).toEqual([3]);
  });

  it("says what is left to do", () => {
    expect(landedStaleText(1, 2)).toBe("landed a change built on r1; r2 still to do");
    expect(landedStaleText(null, 3)).toBe("landed a change built on an older revision; r3 still to do");
  });
});

describe("landing notices", () => {
  const notice = {
    landingId: "lnd_1",
    trunkSha: "c".repeat(40),
    paths: [
      { path: "src/a.ts", before: "a".repeat(40), after: "b".repeat(40) },
      { path: "src/new.ts", before: null, after: "d".repeat(40) },
    ],
    intentTitle: "Rename helper",
    why: "clarity",
  };

  it("say what changed on trunk as facts: paths, blobs, the landing and its intent", () => {
    expect(landingMessage(notice)).toBe('Landing lnd_1 (trunk ccccccc) changed src/a.ts (aaaaaaa → bbbbbbb), src/new.ts (absent → ddddddd); it completed intent "Rename helper": clarity.');
    expect(landingMessage({ ...notice, intentTitle: "", why: "" })).toBe("Landing lnd_1 (trunk ccccccc) changed src/a.ts (aaaaaaa → bbbbbbb), src/new.ts (absent → ddddddd).");
    const d: Directive = { id: "dir_1", colonyId: "c", agentId: "agt_1", kind: "landing", intentId: "int_1", message: "m", by: "colony", at: 5, landing: notice };
    expect(directiveText(d)).toBe(`Trunk moved under intent int_1: ${landingMessage(notice)}`);
    expect(inboxEntry(d).reason).toBe(directiveText(d));
  });

  it("are read back from their rows, checked", () => {
    const row = { id: "dir_2", agent_id: "agt_1", kind: "landing", intent_id: "int_1", message: "m", by: "colony", at: 1, revision: null, changed: null, delivered_at: null, via: null };
    expect(toDirective({ ...row, landing: JSON.stringify(notice) }, "c").landing).toEqual(notice);
    // Rows from before the column, or unreadable data, carry no notice.
    expect(toDirective(row, "c")).not.toHaveProperty("landing");
    expect(toDirective({ ...row, landing: "{nope" }, "c")).not.toHaveProperty("landing");
    expect(parseLandingNotice({ ...notice, paths: [{ path: "x", before: "HEAD", after: null }] })).toBeNull();
    expect(parseLandingNotice({ ...notice, intentTitle: 5, why: "w".repeat(400) })).toMatchObject({ intentTitle: "", why: expect.stringMatching(/…$/) });
  });
});

describe("escalations", () => {
  it("know the kinds an agent can report and the answers a person can give", () => {
    expect(ESCALATION_KINDS).toEqual(["broken-test", "contradictory-spec", "impossible", "other"]);
    expect(escalationKind("broken-test")).toBe("broken-test");
    expect(escalationKind("bug")).toBeNull();
    expect(escalationDecision("dismiss")).toBe("dismiss");
    expect(escalationDecision("approve")).toBeNull();
    expect(reportText("  a\r\nb  ")).toBe("a\nb");
    expect(reportText("x".repeat(5_000))).toHaveLength(MAX_REPORT_CHARS);
    expect(reportText(7)).toBe("");
  });

  it("are read back from storage, checked", () => {
    const open = { kind: "broken-test", report: "test 4 is wrong", by: "agt_1", at: 5 };
    expect(parseEscalation(JSON.stringify(open))).toEqual(open);
    const resolved = { ...open, resolved: { by: "matt", at: 9, decision: "dismiss", note: "the test is right" } };
    expect(parseEscalation(JSON.stringify(resolved))).toEqual(resolved);
    // An unknown kind reads as other; a malformed answer is left out; junk is nothing.
    expect(parseEscalation(JSON.stringify({ ...open, kind: "weird" }))?.kind).toBe("other");
    expect(parseEscalation(JSON.stringify({ ...open, resolved: { decision: "maybe" } }))).toEqual(open);
    expect(parseEscalation("{bad")).toBeNull();
    expect(parseEscalation(null)).toBeNull();
    expect(parseEscalation(JSON.stringify({ kind: "other" }))).toBeNull();
  });
});

describe("migrateDirection on a store that lists its columns", () => {
  it("adds only the columns a table is missing", () => {
    const have: Record<string, string[]> = { intents: ["id", "revision", "withdrawn_reason"], rules: ["id"], agents: ["id", "note", "note_at"], directives: ["id"] };
    const altered: string[] = [];
    const sql = {
      exec(q: string): unknown {
        const pragma = /^PRAGMA table_info\((\w+)\)$/.exec(q);
        if (pragma) return { toArray: () => (have[pragma[1]!] ?? []).map((name) => ({ name })) };
        const m = /^ALTER TABLE (\w+) ADD COLUMN (\w+)/.exec(q);
        if (m) {
          if (have[m[1]!]!.includes(m[2]!)) throw new Error(`duplicate column name: ${m[2]}`);
          altered.push(`${m[1]}.${m[2]}`);
          have[m[1]!]!.push(m[2]!);
        }
        return { toArray: () => [] };
      },
    };
    migrateDirection(sql);
    expect(altered.sort()).toEqual(["directives.landing", "intents.escalation", "intents.escalation_open", "rules.retract_reason", "rules.retracted_at", "rules.retracted_by"]);
    altered.length = 0;
    migrateDirection(sql); // a second wake alters nothing
    expect(altered).toEqual([]);
  });
});
