import { describe, expect, it } from "vitest";
import type { Proposal } from "@fire_trident/core";
import {
  AUDIT_LAYERS,
  auditDraw,
  auditKey,
  auditLine,
  auditMeasures,
  auditPick,
  confirmingLayer,
  interleave,
  landedByText,
  reviewerDrift,
  type AuditLayer,
} from "../../src/decide/audit.ts";
import { DEFAULT_POLICY, mergePolicy, policyProblems } from "../../src/decide/policy.ts";

/** A proposal's evidence with the gate check the decide engine writes. */
function gated(rule: string, action = "land", layer = "deterministic", over: Partial<Proposal> = {}): Pick<Proposal, "evidence" | "approvedAt"> {
  return {
    evidence: { checks: [{ name: "gate", ok: action === "land", ms: 0, detail: `${rule} → ${action} by ${layer} at head 0123456789ab: reasons`, gate: { rule, preset: "central-development", values: [] } }] },
    ...over,
  };
}

/** Run the sample over a stream of landings, layer by layer, as the colony does; returns the keys picked per layer. */
function sample(stream: ReadonlyArray<{ key: string; layer: AuditLayer }>, rate: number): Record<AuditLayer, string[]> {
  const counts = Object.fromEntries(AUDIT_LAYERS.map((l) => [l, { seen: 0, picked: 0 }])) as Record<AuditLayer, { seen: number; picked: number }>;
  const picked = Object.fromEntries(AUDIT_LAYERS.map((l) => [l, [] as string[]])) as Record<AuditLayer, string[]>;
  for (const { key, layer } of stream) {
    const c = counts[layer];
    const pick = auditPick(key, rate, c);
    c.seen++;
    if (pick.pick) {
      c.picked++;
      picked[layer].push(key);
    }
    // The stratified bounds hold after every landing: at least one, and floor to ceil of rate × seen.
    if (!(rate > 0)) continue;
    expect(c.picked).toBeGreaterThanOrEqual(Math.max(1, Math.floor(rate * c.seen + 1e-9)));
    expect(c.picked).toBeLessThanOrEqual(Math.max(1, Math.ceil(rate * c.seen - 1e-9)));
  }
  return picked;
}

/** A stream of landings: 1,000 proofs, 300 model approvals, 40 on earned autonomy and 5 reproductions, interleaved. */
function stream(seed: string): Array<{ key: string; layer: AuditLayer }> {
  const out: Array<{ key: string; layer: AuditLayer }> = [];
  const plan: Array<[AuditLayer, number]> = [
    ["deterministic", 1000],
    ["model", 300],
    ["autonomy", 40],
    ["reproduction", 5],
  ];
  for (const [layer, n] of plan) for (let i = 0; i < n; i++) out.push({ key: auditKey(`lnd_${seed}_${layer}_${i}`, `prp_${seed}_${i}`), layer });
  // A fixed shuffle (the order landings arrive in), so layers interleave.
  return out.map((x, i) => ({ x, k: auditDraw(`order:${seed}:${i}`) })).sort((a, b) => a.k - b.k).map((y) => y.x);
}

describe("the stratified audit sample", () => {
  it("draws the same number from the same key, spread over [0, 1)", () => {
    expect(auditDraw("lnd_1:prp_1")).toBe(auditDraw("lnd_1:prp_1"));
    expect(auditDraw("lnd_1:prp_1")).not.toBe(auditDraw("lnd_1:prp_2"));
    const draws = Array.from({ length: 4000 }, (_, i) => auditDraw(auditKey(`lnd_${i}`, `prp_${i}`)));
    expect(Math.min(...draws)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...draws)).toBeLessThan(1);
    // Each tenth of the range holds about a tenth of the draws.
    for (let d = 0; d < 10; d++) {
      const n = draws.filter((x) => x >= d / 10 && x < (d + 1) / 10).length;
      expect(n).toBeGreaterThan(320);
      expect(n).toBeLessThan(480);
    }
  });

  it("samples every confirming layer, each in proportion, and the same landings every time", () => {
    const picked = sample(stream("a"), 0.03);
    // 3% of 1,000 is 30; of 300, 9; of 40, 1 or 2; the 5 reproductions still get their one.
    expect(picked.deterministic).toHaveLength(30);
    expect(picked.model).toHaveLength(9);
    expect(picked.autonomy.length).toBeGreaterThanOrEqual(1);
    expect(picked.autonomy.length).toBeLessThanOrEqual(2);
    expect(picked.reproduction).toHaveLength(1);
    // Reproducible: the same landings in the same order give the same sample.
    expect(sample(stream("a"), 0.03)).toEqual(picked);
    // Other landings (other ids) are sampled at other places, by the hash.
    const other = sample(stream("b"), 0.03);
    expect(other.deterministic).toHaveLength(30);
    const positions = (keys: string[]) => keys.map((k) => Number(/_(\d+)$/.exec(k.split(":")[0]!)![1]));
    expect(positions(other.deterministic)).not.toEqual(positions(picked.deterministic));
  });

  it("takes the first landing of each layer, then keeps each layer between its floor and ceiling", () => {
    expect(auditPick("k", 0.03, { seen: 0, picked: 0 })).toEqual({ pick: true, why: "first" });
    expect(auditPick("k", 0.03, { seen: 5, picked: 1 })).toEqual({ pick: false, why: "ahead" });
    // 34 landings at 3% owe a second audit by the 67th at the latest.
    expect(auditPick("k", 0.03, { seen: 66, picked: 1 })).toEqual({ pick: true, why: "owed" });
    expect(auditPick("k", 0.2, { seen: 9, picked: 2 })).toMatchObject({ pick: false });
  });

  it("is off at rate 0", () => {
    const off = sample(stream("c"), 0).deterministic;
    expect(off).toEqual([]);
    expect(auditPick("k", 0, { seen: 0, picked: 0 })).toEqual({ pick: false, why: "off" });
  });
});

describe("what confirmed a landing", () => {
  it("reads the gate's rule: a proof, a reproduction, earned autonomy or a model", () => {
    expect(confirmingLayer(gated("D3 innate+proof"), null)).toEqual({ layer: "deterministic", rule: "D3 innate+proof" });
    expect(confirmingLayer(gated("M1 innate+proof"), null)).toEqual({ layer: "deterministic", rule: "M1 innate+proof" });
    expect(confirmingLayer(gated("D5 reproduced by recipe"), null)).toEqual({ layer: "reproduction", rule: "D5 reproduced by recipe" });
    expect(confirmingLayer(gated("R3 innate+autonomy", "land", "reflex"), null)).toEqual({ layer: "autonomy", rule: "R3 innate+autonomy" });
    expect(confirmingLayer(gated("L3 innate+llm", "land", "llm"), null)).toEqual({ layer: "model", rule: "L3 innate+llm" });
  });

  it("leaves out what a person approved, and what no review landed", () => {
    expect(confirmingLayer(gated("P1 danger pattern", "escalate"), { layer: "human", action: "none", human: "approve" })).toBeNull();
    expect(confirmingLayer(gated("L3 innate+llm", "land", "llm", { approvedAt: 5 }), null)).toBeNull();
    expect(confirmingLayer({ evidence: { checks: [] } }, null)).toBeNull();
    // An agent's own check named "gate" is not the platform's.
    expect(confirmingLayer({ evidence: { checks: [{ name: "gate", ok: true, ms: 0, by: "agent", detail: "D3 innate+proof → land by deterministic" }] } }, null)).toBeNull();
  });

  it("falls back to the outcome row when no gate check was kept", () => {
    expect(confirmingLayer({ evidence: { checks: [] } }, { layer: "llm", action: "land", human: null })).toEqual({ layer: "model", rule: "L3 innate+llm" });
    expect(confirmingLayer({ evidence: { checks: [] } }, { layer: "reflex", action: "land", human: null })?.layer).toBe("autonomy");
    expect(confirmingLayer({ evidence: { checks: [] } }, { layer: "llm", action: "escalate", human: null })).toBeNull();
  });

  it("says on the card what landed it", () => {
    expect(landedByText("autonomy", "R3 innate+autonomy")).toBe("Already landed by R3 innate+autonomy (earned autonomy).");
  });
});

describe("the baseline stream", () => {
  const E = (n: number) => Array.from({ length: n }, (_, i) => `e${i + 1}`);
  const A = (n: number) => Array.from({ length: n }, (_, i) => `a${i + 1}`);

  it("puts an audit item after every five escalations, in order", () => {
    expect(interleave(E(12), A(5))).toEqual(["e1", "e2", "e3", "e4", "e5", "a1", "e6", "e7", "e8", "e9", "e10", "a2", "e11", "e12", "a3"]);
    expect(interleave(E(10), A(5))).toEqual(["e1", "e2", "e3", "e4", "e5", "a1", "e6", "e7", "e8", "e9", "e10", "a2"]);
  });

  it("ends a short queue with one, shows them when nothing else waits, and leaves a queue alone with none", () => {
    expect(interleave(E(2), A(3))).toEqual(["e1", "e2", "a1"]);
    expect(interleave([], A(3))).toEqual(["a1", "a2", "a3"]);
    expect(interleave([], A(30))).toHaveLength(10);
    expect(interleave(E(3), [])).toEqual(["e1", "e2", "e3"]);
  });
});

describe("the audit's measures", () => {
  it("reads the card's line with its Wilson interval", () => {
    const m = auditMeasures({ deterministic: 300, model: 100 }, [
      { layer: "deterministic", verdict: "fine", n: 9 },
      { layer: "model", verdict: "fine", n: 3 },
      { layer: "model", verdict: null, n: 1 },
    ]);
    expect(m.overall).toMatchObject({ landed: 400, queued: 13, audited: 12, wrong: 0, pending: 1, lo: 0, hi: 0.242 });
    expect(auditLine(m.overall, 0.03)).toBe("audited 12 of 400 landings without a person: 0 should not have landed (0–24%); 1 waits for a person");
    expect(m.layers.model).toMatchObject({ landed: 100, audited: 3, pending: 1, label: "a model's approval" });
  });

  it("measures should-not-have-landed per layer", () => {
    const m = auditMeasures({ autonomy: 40 }, [
      { layer: "autonomy", verdict: "fine" },
      { layer: "autonomy", verdict: "should-not-have-landed" },
    ]);
    expect(m.layers.autonomy).toMatchObject({ audited: 2, wrong: 1, wrongRate: 0.5, lo: 0.095, hi: 0.905 });
    expect(auditLine(m.overall, 0.03)).toBe("audited 2 of 40 landings without a person: 1 should not have landed (10–91%)");
  });

  it("says when the sample is off or nothing was answered yet", () => {
    const none = auditMeasures({}, []);
    expect(auditLine(none.overall, 0)).toBe("audit sample off");
    expect(auditLine(auditMeasures({ model: 3 }, [{ layer: "model", verdict: null }]).overall, 0.03)).toBe("audited 0 of 3 landings without a person; 1 waits for a person");
  });
});

describe("reviewer decisions over time", () => {
  const WEEK = 7 * 24 * 60 * 60_000;
  const now = 100 * WEEK;

  it("counts decisions per week and compares the last two weeks with the weeks before", () => {
    const rows = [
      ...Array.from({ length: 10 }, (_, i) => ({ human: i < 5 ? "approve" : "reject", at: now - 5 * WEEK + i })),
      ...Array.from({ length: 10 }, (_, i) => ({ human: i < 9 ? "approve" : "return", at: now - WEEK + i })),
    ];
    const d = reviewerDrift(rows, now);
    expect(d.weeks).toHaveLength(8);
    expect(d.weeks[7]).toMatchObject({ decisions: 10, approved: 9, returned: 1, approvalRate: 0.9 });
    expect(d.recent).toEqual({ decisions: 10, approved: 9, rate: 0.9 });
    expect(d.earlier).toEqual({ decisions: 10, approved: 5, rate: 0.5 });
    expect(d.change).toBe(40);
    expect(d.line).toBe("approved 9 of 10 escalations (90%) in the last 2 weeks, 5 of 10 escalations (50%) in the 6 before: up 40 points");
  });

  it("says when there are too few decisions to compare", () => {
    expect(reviewerDrift([], now).line).toBe("no decision on an escalation in the last 8 weeks");
    expect(reviewerDrift([{ human: "approve", at: now - 1 }], now)).toMatchObject({ change: null, recent: null });
  });
});

describe("the policy's audit and canary rates", () => {
  it("defaults to a 3% audit sample and no canaries, clamped to 0 to 20%", () => {
    expect(DEFAULT_POLICY).toMatchObject({ auditRate: 0.03, canaryRate: 0 });
    expect(mergePolicy(DEFAULT_POLICY, {})).toMatchObject({ auditRate: 0.03, canaryRate: 0 });
    expect(mergePolicy(DEFAULT_POLICY, { auditRate: 0.5, canaryRate: -1 })).toMatchObject({ auditRate: 0.2, canaryRate: 0 });
    expect(mergePolicy(DEFAULT_POLICY, { auditRate: 0, canaryRate: 0.05 })).toMatchObject({ auditRate: 0, canaryRate: 0.05 });
  });

  it("refuses a rate a person would believe set: 3 meant as 3%, or not a number", () => {
    expect(policyProblems({ auditRate: 3 })).toEqual(["auditRate: must be a share from 0 to 0.2 (0.03 is 3%)"]);
    expect(policyProblems({ canaryRate: "5%" })).toEqual(["canaryRate: must be a share from 0 to 0.2 (0.03 is 3%)"]);
    expect(policyProblems({ auditRate: 0.05, canaryRate: 0.1 })).toEqual([]);
  });
});
