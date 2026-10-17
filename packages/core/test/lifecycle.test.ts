import { describe, expect, it } from "vitest";
import {
  LIFECYCLE_CAPTION,
  LIFECYCLE_STEPS,
  TAKE_BACK_PUSH,
  changeLifecycle,
  changeLifecycleOf,
  declaredText,
  intentLifecycle,
  intentLifecycleOf,
  noteCertified,
  noteLifecycleFacts,
  placeCertified,
  silenceWords,
  testsCertified,
  type ChangeLifecycle,
  type LifecycleFacts,
  type LifecycleStepKey,
} from "../src/lifecycle.ts";
import type { CheckResult, GateRecord, NoteDecision } from "../src/types.ts";

/** The lifecycle strip: each step's state and words, the step reached, and where a change left the path. */

const T0 = 1_800_000_000_000;
const SHA = "a".repeat(40);
const GREEN = "c".repeat(40);
const head = (rule: string, action: string, layer: string, conf: string) => `${rule} → ${action} by ${layer} at head 9a7220a8f2f2 (confirmations: ${conf}): reasons`;
const R3: GateRecord = {
  rule: "R3 innate+autonomy",
  preset: "production",
  values: [
    { name: "confidence", value: 0.93, op: "≥", bound: 0.85 },
    { name: "p(needs_human)", value: 0.04, op: "<", bound: 0.2 },
  ],
};
const gate = (rule: string, action: string, layer: string, conf: string, record?: GateRecord): CheckResult => ({ name: "gate", ok: action === "land", ms: 0, detail: head(rule, action, layer, conf), ...(record ? { gate: record } : {}) });
const autonomy = gate("R3 innate+autonomy", "land", "reflex", "innate + autonomy", R3);

const intent = { id: "int_1", title: "Add a limit", source: "human", createdBy: "Lee", createdAt: T0, status: "landed" };
const agent = { id: "agt_1", name: "worker-1", kind: "internal", model: "@cf/google/gemma-4-26b-a4b-it", claimedAt: T0 + 1_000 };

/** The step of a strip by key. */
const at = (s: ChangeLifecycle, key: LifecycleStepKey) => s.steps.find((x) => x.key === key)!;
/** Each step's state in order. */
const states = (s: ChangeLifecycle) => s.steps.map((x) => `${x.key}:${x.state}`);

describe("a landed change", () => {
  const landed: LifecycleFacts = {
    intent,
    agent,
    change: { id: "prp_1", agentId: "agt_1", status: "landed", createdAt: T0 + 2_000, evidence: { checks: [autonomy] }, decisions: [{ kind: "triage", layer: "reflex", p: 0.93, action: "land", at: T0 + 3_000 }] },
    landing: { id: "lnd_1", trunkSha: SHA, at: T0 + 4_000 },
    certified: { status: "certified", sha: GREEN, at: T0 + 5_000 },
  };

  it("walks every step to certified, with who, which rule and which commit, and marks certified as reached", () => {
    const s = changeLifecycle(landed);
    expect(s.steps.map((x) => x.key)).toEqual([...LIFECYCLE_STEPS]);
    expect(states(s)).toEqual(["declared:done", "claimed:done", "proposed:done", "confirmed:done", "landed:done", "certified:done", "taken-back:outside", "merged:outside"]);
    expect(s.reached).toBe("certified");
    expect(s.off).toBeUndefined();
    expect(at(s, "declared")).toMatchObject({ text: "Lee (a person)", at: T0, link: { kind: "intent", id: "int_1" } });
    expect(at(s, "claimed")).toMatchObject({ text: "worker-1 (in-platform agent, gemma-4-26b-a4b-it)", at: T0 + 1_000, link: { kind: "agent", id: "agt_1" } });
    expect(at(s, "proposed")).toMatchObject({ text: "prp_1", at: T0 + 2_000, link: { kind: "proposal", id: "prp_1" } });
    expect(at(s, "confirmed")).toMatchObject({ text: "earned autonomy: R3: confidence 0.93 ≥ 0.85, p(needs_human) 0.04 < 0.2", at: T0 + 3_000 });
    expect(at(s, "landed")).toMatchObject({ text: "lnd_1 · aaaaaaa", at: T0 + 4_000, link: { kind: "landing", id: "lnd_1", sha: SHA } });
    expect(at(s, "certified")).toMatchObject({ text: "certified commit ccccccc includes it", at: T0 + 5_000, link: { kind: "certification", id: "lnd_1", sha: GREEN } });
    expect(s.text).toBe("Certified: certified commit ccccccc includes it; next, outside FireTrident: push certified as a branch and open a pull request");
  });

  it("never marks the two steps in the team's forge as done, and gives the take-back command", () => {
    const s = changeLifecycle(landed);
    expect(at(s, "taken-back")).toEqual({
      key: "taken-back",
      label: "Taken back",
      state: "outside",
      text: "outside FireTrident: push certified as a branch and open a pull request",
      command: TAKE_BACK_PUSH,
      link: { kind: "take-back", id: "take-back" },
    });
    expect(at(s, "merged")).toMatchObject({ label: "Merged by a person", state: "outside", text: "outside FireTrident: a person merges it in your forge" });
    expect(TAKE_BACK_PUSH).toBe("git push <your-origin> certified:refs/heads/firetrident/certified");
    expect(LIFECYCLE_CAPTION).toBe("FireTrident lands to its own trunk and never merges into your repository; the last two steps happen in your forge.");
  });

  it("stops at landed while no certification includes it, and says why", () => {
    const s = changeLifecycle({ ...landed, certified: { status: "pending", reason: "trunk certification is off for this colony" } });
    expect(s.reached).toBe("landed");
    expect(at(s, "certified")).toMatchObject({ state: "todo", text: "not certified yet: trunk certification is off for this colony" });
    expect(s.text).toBe("Landed: lnd_1 · aaaaaaa; next, not certified yet: trunk certification is off for this colony");
    expect(at(changeLifecycle({ ...landed, certified: undefined }), "certified").text).toBe("not certified yet");
    expect(at(changeLifecycle({ ...landed, certified: { status: "unknown", reason: "its tests say" } }), "certified")).toMatchObject({ state: "todo", text: "not known here: its tests say" });
  });

  it("says a colony with no tests this platform can run has none, and the step does not apply", () => {
    const s = changeLifecycle({ ...landed, certified: { status: "no-tests", reason: "no test file on trunk" } });
    expect(at(s, "certified")).toMatchObject({ state: "none", text: "no tests this platform can run: no test file on trunk" });
    expect(s.reached).toBe("landed");
    expect(s.off).toBeUndefined();
  });

  it("names a person's approval as the confirmation, and a proof with no model", () => {
    const human: NoteDecision = { kind: "triage", layer: "human", p: 1, action: "approve", by: "maya", at: T0 + 3_500 };
    const sent = gate("L5 too large", "escalate", "llm", "");
    const s = changeLifecycle({ ...landed, change: { ...landed.change!, evidence: { checks: [sent] }, decisions: [human], approvedAt: T0 + 3_600 } });
    expect(at(s, "confirmed")).toMatchObject({ state: "done", text: "A person (maya) approved it; L5 too large had sent it to a person.", at: T0 + 3_600 });
    const proof = changeLifecycle({ ...landed, change: { ...landed.change!, evidence: { checks: [gate("D3 innate+proof", "land", "deterministic", "innate + deterministic")] }, decisions: [] } });
    expect(at(proof, "confirmed").text).toBe("deterministic proof: D3 innate+proof: a deterministic proof, no model");
  });
});

describe("a change that left the path", () => {
  it("returned after the gate let it through: trunk moved, with the reason and the landing that beat it", () => {
    const s = changeLifecycle({
      intent: { ...intent, status: "claimed" },
      agent,
      change: {
        id: "prp_2",
        agentId: "agt_1",
        status: "returned",
        createdAt: T0 + 2_000,
        settledAt: T0 + 6_000,
        reason: "stale: src/limit.ts changed since you read it",
        beatenBy: { landingId: "lnd_9", trunkSha: "9".repeat(40), title: "Rename the limit" },
        evidence: { checks: [autonomy] },
      },
    });
    expect(states(s).slice(0, 5)).toEqual(["declared:done", "claimed:done", "proposed:done", "confirmed:done", "landed:todo"]);
    expect(s.reached).toBe("confirmed");
    expect(s.off).toEqual({
      kind: "returned",
      label: "Returned",
      after: "confirmed",
      text: "stale: src/limit.ts changed since you read it",
      at: T0 + 6_000,
      beatenBy: { landingId: "lnd_9", trunkSha: "9".repeat(40), title: "Rename the limit" },
      link: { kind: "landing", id: "lnd_9", sha: "9".repeat(40) },
    });
    expect(s.text).toBe("Returned after confirmed: stale: src/limit.ts changed since you read it");
  });

  it("returned by the gate itself leaves after proposed, and a rejection says so", () => {
    const back = changeLifecycle({ intent: { ...intent, status: "claimed" }, agent, change: { id: "prp_3", agentId: "agt_1", status: "returned", reason: "llm: does not do what the intent asks", evidence: { checks: [gate("L2 llm return", "return", "llm", "")] } } });
    expect(back.off).toMatchObject({ kind: "returned", after: "proposed", text: "llm: does not do what the intent asks" });
    expect(at(back, "confirmed").state).toBe("todo");
    const rejected = changeLifecycle({ intent: { ...intent, status: "open" }, agent, change: { id: "prp_4", agentId: "agt_1", status: "rejected" } });
    expect(rejected.off).toMatchObject({ kind: "returned", label: "Rejected", after: "proposed", text: "a person or the review rejected it" });
  });

  it("escalated: waits for a person, naming the rule that sent it", () => {
    const s = changeLifecycle({ intent: { ...intent, status: "proposed" }, agent, change: { id: "prp_5", agentId: "agt_1", status: "escalated", settledAt: T0 + 7_000, evidence: { checks: [gate("P3 protected path", "escalate", "deterministic", "")] } } });
    expect(s.reached).toBe("proposed");
    expect(at(s, "confirmed")).toMatchObject({ state: "todo", text: "not confirmed" });
    expect(s.off).toEqual({ kind: "escalated", label: "Escalated", after: "proposed", text: "waiting for a person: P3 protected path sent it to one", at: T0 + 7_000, link: { kind: "proposal", id: "prp_5" } });
    // With the colony's reason; and a merge held again after a person approved it leaves after confirmed.
    expect(changeLifecycle({ intent, agent, change: { id: "prp_6", status: "escalated", reason: "escalated by llm: touches auth" } }).off?.text).toBe("waiting for a person: escalated by llm: touches auth");
    const held = changeLifecycle({ intent, agent, change: { id: "prp_7", agentId: "agt_1", status: "escalated", approvedAt: T0, held: true, decisions: [{ layer: "human", action: "approve", by: "maya" }] } });
    expect(held.off).toMatchObject({ after: "confirmed", text: "a person approved it, then trunk moved: the merge waits for a person to approve it again" });
    // The gate let it through, then the trunk writer held its merge for a person (merge locks).
    const locked = changeLifecycle({ intent, agent, change: { id: "prp_8", agentId: "agt_1", status: "escalated", held: true, reason: "merge held for a person", evidence: { checks: [autonomy] } } });
    expect([locked.reached, locked.off?.after, locked.off?.text]).toEqual(["confirmed", "confirmed", "waiting for a person: merge held for a person"]);
  });

  it("reaped: the colony took the intent back from a silent agent, after claimed", () => {
    const s = changeLifecycle({
      intent: { id: "int_2", source: "human", createdBy: "Lee", status: "open", closure: { cause: "reaped_silent", at: T0 + 9_000, agentId: "agt_walk", gapMs: 97_000 } },
      agent: { id: "agt_walk", name: "walker", kind: "external" },
    });
    expect(states(s).slice(0, 3)).toEqual(["declared:done", "claimed:done", "proposed:todo"]);
    expect(s.off).toEqual({ kind: "reaped", label: "Reaped", after: "claimed", text: "the colony took it back: walker was silent for 1 min 37 s; it is open for the next agent", at: T0 + 9_000, link: { kind: "intent", id: "int_2" } });
  });

  it("withdrawn: after the last step it reached, with the reason", () => {
    const s = changeLifecycle({ intent: { ...intent, status: "withdrawn", withdrawnReason: "not needed any more", withdrawnAt: T0 + 8_000 }, agent, change: { id: "prp_8", agentId: "agt_1", status: "returned", reason: "intent withdrawn" } });
    expect(s.off).toMatchObject({ kind: "withdrawn", after: "proposed", text: "not needed any more", at: T0 + 8_000 });
    expect(changeLifecycle({ intent: { id: "int_3", status: "withdrawn" } }).off).toMatchObject({ kind: "withdrawn", after: "declared", text: "a person withdrew the intent" });
  });

  it("an agent's report waits for a person: escalated after claimed", () => {
    const s = changeLifecycle({ intent: { id: "int_4", source: "rule", createdBy: "Lee", status: "open", report: { kind: "contradictory-spec", by: "agt_1", at: T0 } }, agent });
    expect(at(s, "declared").text).toBe("a rule approved by Lee");
    expect(s.off).toMatchObject({ kind: "escalated", after: "claimed", text: "worker-1 reported it as contradictory-spec: waiting for a person to amend, withdraw or dismiss it" });
  });
});

describe("an intent's strips", () => {
  const returned = { change: { id: "prp_a", agentId: "agt_1", status: "returned", createdAt: T0 + 1, reason: "stale" } };
  const landedOne = { change: { id: "prp_b", agentId: "agt_2", status: "landed", createdAt: T0 + 2 }, landing: { id: "lnd_b", trunkSha: SHA }, certified: { status: "no-tests" as const } };

  it("follows the landed change, and lists every change newest first", () => {
    const l = intentLifecycle({ colonyId: "web", intent, changes: [returned, landedOne], agents: { agt_2: { id: "agt_2", name: "second" } } });
    expect(l.current.proposalId).toBe("prp_b");
    expect(at(l.current, "claimed").text).toBe("second");
    expect(l.changes.map((c) => c.proposalId)).toEqual(["prp_b", "prp_a"]);
    expect(l.changes[1]!.off?.kind).toBe("returned");
    expect(l.caption).toBe(LIFECYCLE_CAPTION);
  });

  it("while an agent holds it: its last change sent back, or its attempt; open: the reaped attempt", () => {
    const held = { ...intent, status: "claimed" };
    expect(intentLifecycle({ intent: held, changes: [returned], holder: { id: "agt_1" } }).current.off?.kind).toBe("returned");
    const other = intentLifecycle({ intent: held, changes: [returned], holder: { id: "agt_3", name: "third" } }).current;
    expect([other.proposalId, other.reached, at(other, "claimed").text, other.off]).toEqual([undefined, "claimed", "third", undefined]);
    const reaped = intentLifecycle({ intent: { ...intent, status: "open", closure: { cause: "reaped_silent", at: T0, agentId: "agt_w", gapMs: 700_000 } }, changes: [], agents: { agt_w: { id: "agt_w", name: "walker" } } }).current;
    expect(reaped.off).toMatchObject({ kind: "reaped", after: "claimed", text: "the colony took it back: walker was silent for 11 min 40 s; it is open for the next agent" });
    const fresh = intentLifecycle({ intent: { id: "int_9", status: "open" }, changes: [] }).current;
    expect([fresh.reached, fresh.off, fresh.text]).toEqual(["declared", undefined, "Declared: not recorded"]);
  });

  it("reads back as it was sent, drops what it does not know, and refuses what is not one", () => {
    const l = intentLifecycle({ intent, changes: [returned, landedOne] });
    expect(intentLifecycleOf(JSON.parse(JSON.stringify(l)))).toEqual(l);
    const odd = { intentId: "int_1", current: { intentId: "int_1", reached: "landed", steps: [{ key: "landed", state: "done", text: "x\u0007y", link: { kind: "nope", id: "z" } }, { key: "bogus", state: "done", text: "" }], text: "t" } };
    expect(intentLifecycleOf(odd)?.current.steps).toEqual([{ key: "landed", label: "Landed", state: "done", text: "x y" }]);
    expect(intentLifecycleOf({ intentId: "int_1" })).toBeNull();
    expect(intentLifecycleOf(null)).toBeNull();
    expect(changeLifecycleOf({ intentId: "i", steps: [] })).toBeNull();
  });
});

describe("facts from a landing card", () => {
  const entry = {
    id: "prp_1",
    agentId: "agt_1",
    agentKind: "external",
    model: "claude-x",
    intent: { id: "int_1", title: "t", why: "w", source: "agent", createdBy: "agt_0" },
    writeSet: [],
    readSet: [],
    decisions: [{ kind: "triage", layer: "llm", p: 0.9, action: "land", by: "m", at: T0 + 3 }],
    evidence: { checks: [autonomy] },
  };

  it("builds the strip from the note, the landing and what the page adds", () => {
    const s = changeLifecycle(noteLifecycleFacts({ id: "lnd_1", trunkSha: SHA, at: T0 + 4 }, entry, { createdAt: T0, agentName: "byo", certified: noteCertified({ status: "green", finishedAt: T0 + 5 }, SHA) }));
    expect(states(s).slice(0, 6).every((x) => x.endsWith(":done"))).toBe(true);
    expect(at(s, "declared")).toMatchObject({ text: "an agent (agt_0)", at: T0 });
    expect(at(s, "claimed").text).toBe("byo (outside agent, claude-x)");
    expect(at(s, "certified")).toMatchObject({ text: "certified commit aaaaaaa includes it", at: T0 + 5 });
    // An entry with nothing in it still draws a strip.
    expect(changeLifecycle(noteLifecycleFacts({ id: "lnd_2", trunkSha: "" }, null)).reached).toBe("landed");
    expect(noteCertified({ status: "red" }, SHA)).toBeNull();
  });

  it("reads certification from a test row, or places the newest green commit among the landings it holds", () => {
    expect(testsCertified({ status: "certified", certified: { sha: GREEN, status: "green", pass: 1, tests: 1, failing: 0 } })).toEqual({ status: "certified", sha: GREEN });
    expect(testsCertified({ status: "no-tests", reason: "none on trunk" })).toEqual({ status: "no-tests", reason: "none on trunk" });
    expect(testsCertified({ status: "pending", reason: "trunk is red" })).toEqual({ status: "pending", reason: "trunk is red" });
    expect(testsCertified(null)).toBeNull();
    const landings = [
      { trunkSha: SHA, at: 10 },
      { trunkSha: GREEN, at: 20 },
    ];
    expect(placeCertified({ trunkSha: SHA, at: 10 }, { greenSha: GREEN, landings })).toEqual({ status: "certified", sha: GREEN });
    expect(placeCertified({ trunkSha: GREEN, at: 20 }, { greenSha: GREEN, landings })).toEqual({ status: "certified", sha: GREEN });
    expect(placeCertified({ trunkSha: "d".repeat(40), at: 30 }, { greenSha: GREEN, landings })).toEqual({ status: "pending", reason: "the newest certified commit, ccccccc, is older" });
    expect(placeCertified({ trunkSha: SHA, at: 10 }, { greenSha: "e".repeat(40), landings })).toMatchObject({ status: "unknown" });
    expect(placeCertified({ trunkSha: SHA, at: 10 }, { landings, noTests: "no test file on trunk" })).toEqual({ status: "no-tests", reason: "no test file on trunk" });
    expect(placeCertified({ trunkSha: SHA, at: 10 }, { landings })).toEqual({ status: "pending" });
  });

  it("words: who declared it, and a silence", () => {
    expect([declaredText({ source: "human", createdBy: "api" }), declaredText({ source: "human" }), declaredText({ source: "certify", createdBy: "certify" }), declaredText({ source: "system" }), declaredText({})]).toEqual([
      "a person who gave no name",
      "a person",
      "trunk certification, to repair failing tests",
      "FireTrident itself",
      "not recorded",
    ]);
    expect([silenceWords(45_000), silenceWords(97_000), silenceWords(600_000), silenceWords(7_500_000), silenceWords(7_200_000)]).toEqual(["45 s", "1 min 37 s", "10 min", "2 h 5 min", "2 h"]);
  });
});
