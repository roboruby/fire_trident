import { describe, expect, it } from "vitest";
import type { Directive, Rule } from "@fire_trident/core";
import {
  MAX_HELD,
  PENDING_TTL_MS,
  directionError,
  directiveNote,
  guidanceFor,
  holdDirective,
  interrupts,
  markApplied,
  nextDirection,
  stepNote,
  withGuidance,
} from "../../src/agents/direction.ts";
import type { HeldDirective } from "../../src/agents/direction.ts";
import { buildEditMessages, buildSpecifierMessages, buildWriteMessages, directiveBlock } from "../../src/agents/prompt.ts";
import { TreeIndex } from "../../src/agents/context.ts";

const d = (over: Partial<Directive> = {}): Directive => ({ id: "dir_1", colonyId: "c", agentId: "agt_1", kind: "guidance", intentId: "int_1", message: "say bonjour", by: "matt", at: 1, ...over });
const job = { intentId: "int_1", intent: { revision: 1 }, step: "produce" };

describe("holding directives", () => {
  it("keeps each directive once and prunes old ones, applied first", () => {
    let list: HeldDirective[] = [];
    list = holdDirective(list, d(), undefined, 10);
    list = holdDirective(list, d(), undefined, 11);
    expect(list).toHaveLength(1);
    list = markApplied(list, "dir_1", 12, "re-planned");
    expect(list[0]).toMatchObject({ appliedAt: 12, outcome: "re-planned" });
    expect(markApplied(list, "dir_1", 13, "again")[0]!.outcome).toBe("re-planned");
    for (let i = 0; i < MAX_HELD + 5; i++) list = holdDirective(list, d({ id: `dir_${i + 2}` }), undefined, 20 + i);
    expect(list).toHaveLength(MAX_HELD);
    expect(list.some((h) => h.directive.id === "dir_1")).toBe(false); // the applied one went first
    const stale = holdDirective([{ directive: d({ id: "old" }), receivedAt: 0 }], d({ id: "new" }), undefined, PENDING_TTL_MS + 1);
    expect(stale.map((h) => h.directive.id)).toEqual(["new"]);
  });
});

describe("what a job acts on first", () => {
  const held = (dir: Directive, applied = false): HeldDirective => ({ directive: dir, receivedAt: 0, ...(applied ? { appliedAt: 1 } : {}) });

  it("puts a withdrawal before a revision before guidance, and ignores other intents", () => {
    const list = [held(d({ id: "g" })), held(d({ id: "r", kind: "revision", revision: 2 })), held(d({ id: "w", kind: "withdrawal" })), held(d({ id: "x", kind: "withdrawal", intentId: "int_9" }))];
    expect(nextDirection(list, job)?.directive.id).toBe("w");
    expect(nextDirection(list.filter((h) => h.directive.id !== "w"), job)?.directive.id).toBe("r");
    expect(nextDirection([held(d({ id: "g" }))], job)?.directive.id).toBe("g");
    expect(nextDirection([held(d({ id: "x", kind: "withdrawal", intentId: "int_9" }))], job)).toBeNull();
  });

  it("skips a revision the job already works from, and anything applied", () => {
    expect(nextDirection([held(d({ kind: "revision", revision: 2 }))], { intentId: "int_1", intent: { revision: 2 } })).toBeNull();
    expect(nextDirection([held(d(), true)], job)).toBeNull();
    expect(nextDirection([held(d({ intentId: undefined }))], job)?.directive.id).toBe("dir_1"); // guidance about no intent in particular
  });

  it("halts the step in flight only when the old direction would waste work", () => {
    expect(interrupts(d({ kind: "withdrawal" }), { intentId: "int_1", step: "fetch" })).toBe(true);
    expect(interrupts(d({ kind: "revision" }), { intentId: "int_1", step: "await" })).toBe(true);
    expect(interrupts(d(), { intentId: "int_1", step: "produce" })).toBe(true);
    expect(interrupts(d(), { intentId: "int_1", step: "fetch" })).toBe(false);
    expect(interrupts(d(), { intentId: "int_1", step: "await" })).toBe(false);
    expect(interrupts(d({ kind: "withdrawal", intentId: "int_2" }), { intentId: "int_1", step: "produce" })).toBe(false);
    expect(interrupts(d(), null)).toBe(false);
  });

  it("starts a job with the guidance held for its intent", () => {
    const list = [held(d({ id: "a" }), true), held(d({ id: "b", intentId: "int_2" })), held(d({ id: "c", intentId: undefined })), held(d({ id: "e", intentId: undefined }), true)];
    expect(guidanceFor(list, "int_1").map((g) => g.id)).toEqual(["a", "c"]);
    const g = withGuidance(withGuidance(undefined, d({ id: "a" })), d({ id: "a", message: "again" }));
    expect(g).toEqual([{ id: "a", message: "again", by: "matt", at: 1 }]);
  });
});

describe("refusals that mean the direction changed", () => {
  it("recognizes revised and withdrawn intents behind a 409", () => {
    expect(directionError(new Error("[ft:409] intent revised: int_1 is at r2 (why changed: x); this change was built on r1."))).toMatchObject({ kind: "revision" });
    expect(directionError(new Error("[ft:409] intent withdrawn: int_1 (gone); stop work on it and take other work."))).toMatchObject({ kind: "withdrawal" });
    expect(directionError(new Error("[ft:409] intent int_1 is held by another agent"))).toBeNull();
    expect(directionError(new Error("intent revised: but no status tag"))).toBeNull();
  });
});

describe("status notes", () => {
  const intent = { title: "Create greeting", footprint: ["src/greeting.ts"], revision: 2 };
  it("say what the job is doing at each step", () => {
    expect(stepNote({ step: "produce", intent, reads: [{ path: "src/greeting.ts" }], directives: [{ id: "d", message: "m", by: "b", at: 0 }] })).toBe('writing src/greeting.ts for "Create greeting" r2, following 1 directive');
    expect(stepNote({ step: "await", intent: { ...intent, revision: 1 }, proposalId: "prp_1", lastStatus: "checking" })).toBe('waiting on prp_1 (checking) for "Create greeting"');
    expect(stepNote({ step: "propose", intent, writeSet: [{ path: "a" }, { path: "b" }, { path: "c" }] })).toBe('proposing a, b +1 for "Create greeting" r2');
    expect(stepNote({ step: "deps", intent, depsMissing: ["x", "y"] })).toBe('waiting for 2 file(s) "Create greeting" builds on to land');
  });
  it("say what the agent did with a directive", () => {
    expect(directiveNote(d({ kind: "revision", revision: 3, changed: ["why"] }), "Create greeting", "")).toBe('intent revised to r3 (why changed): restarting "Create greeting"');
    expect(directiveNote(d({ kind: "withdrawal", message: "not needed" }), "Create greeting", "")).toBe('stopped "Create greeting": withdrawn (not needed)');
    expect(directiveNote(d(), "Create greeting", "redoing src/greeting.ts")).toBe('directive from matt "say bonjour": redoing src/greeting.ts');
  });
});

describe("directives in prompts", () => {
  const intent = { id: "int_1", title: "Create greeting", why: "say hello" };
  const directives = [{ message: "Say bonjour,\nnot hello", by: "matt" }];
  const rule: Rule = { id: "r", colonyId: "c", kind: "forbid-import", spec: { from: ["src/**"], module: "^\\.", hint: "h" }, description: "Name files", approvedBy: "a", createdAt: 0 };

  it("renders a block only when there are directives", () => {
    expect(directiveBlock(undefined)).toBeNull();
    expect(directiveBlock([{ message: "  ", by: "x" }])).toBeNull();
    expect(directiveBlock(directives)).toBe(
      "Directives from a human operator (they refine the intent: follow them; where they conflict with the intent text, the latest directive wins):\n- Say bonjour, not hello (from matt)",
    );
  });

  it("puts them in every kind of prompt", () => {
    const write = buildWriteMessages({ intent, directives, path: "src/g.ts", content: null, siblings: [], rules: [], tree: [], context: [], missing: [], written: [] });
    expect(write[1]!.content).toContain("- Say bonjour, not hello (from matt)");
    const edit = buildEditMessages({ intent, directives, path: "src/g.ts", content: "x" });
    expect(edit[1]!.content).toContain("Directives from a human operator");
    const spec = buildSpecifierMessages({ intent, directives, rule, path: "src/g.ts", content: 'import "./a";', facts: [], tree: new TreeIndex(["src/a.ts"]) });
    expect(spec[1]!.content).toContain("- Say bonjour, not hello (from matt)");
    expect(buildEditMessages({ intent, path: "src/g.ts", content: "x" })[1]!.content).not.toContain("Directives");
  });
});

describe("landing notices", () => {
  const held = (dir: Directive): HeldDirective => ({ directive: dir, receivedAt: 0 });
  const landing = (over: Partial<Directive> = {}): Directive =>
    d({
      id: "l",
      kind: "landing",
      by: "colony",
      message: "Landing lnd_1 changed src/a.ts",
      landing: { landingId: "lnd_1", trunkSha: "c".repeat(40), paths: [{ path: "src/a.ts", before: null, after: "b".repeat(40) }], intentTitle: "Add a", why: "needed" },
      ...over,
    });

  it("come after a withdrawal or a revision, before guidance, and only about the job's intent", () => {
    const list = [held(d({ id: "g" })), held(landing()), held(landing({ id: "x", intentId: "int_9" }))];
    expect(nextDirection(list, job)?.directive.id).toBe("l");
    expect(nextDirection([held(d({ id: "w", kind: "withdrawal" })), ...list], job)?.directive.id).toBe("w");
    expect(nextDirection([held(landing({ intentId: "int_9" }))], job)).toBeNull();
    // A landing notice is never guidance: it does not reach the job's prompts as a directive.
    expect(guidanceFor([held(landing())], "int_1")).toEqual([]);
  });

  it("halt only the work built on the old files, before the change is proposed", () => {
    for (const step of ["produce", "commit", "push"]) expect(interrupts(landing(), { intentId: "int_1", step })).toBe(true);
    for (const step of ["fetch", "read", "propose", "await"]) expect(interrupts(landing(), { intentId: "int_1", step })).toBe(false);
    expect(interrupts(landing({ intentId: "int_2" }), { intentId: "int_1", step: "produce" })).toBe(false);
  });

  it("show in the agent's status note", () => {
    expect(directiveNote(landing(), "Create greeting", "re-reading them on the new trunk")).toBe("src/a.ts changed on trunk (lnd_1): re-reading them on the new trunk");
  });
});
