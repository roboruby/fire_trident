import type { DecidePolicy } from "./policy.ts";
import { DEFAULT_POLICY, mergePolicy } from "./policy.ts";

/**
 * The gate's four presets: named values for the policy fields that decide what lands without a person, from the most
 * trusting (one person's local development) to the most careful (production). Central development is DEFAULT_POLICY, so
 * a colony nobody tuned reads as it. A colony's policy is shown as the preset it equals, or as "custom" with the values
 * that differ from the nearest one (presetOf). Setting a policy stays an admin action through POST /decide/policy; a
 * preset is only a name for values that route already takes. Pure: no I/O.
 *
 * Whatever the preset, some changes always wait for a person: danger patterns (P1), protected paths (P3), goal
 * conflicts (P4), an intent on probation after a security finding (P2), changes too large for model review (L5), an
 * acceptance line not shown met (L7), and a change no model could review (M2, L8). See decide/gate.ts.
 */

/** A preset's name, as the API, the card and the gate check's record carry it. */
export type PresetName = "local-development" | "central-development" | "pre-production" | "production";

/** The policy fields a preset sets, in the order the card lists them, with how a reader names each. */
export const PRESET_FIELDS = [
  { key: "enabled", label: "review by models" },
  { key: "deterministic", label: "deterministic proofs land alone" },
  { key: "commentProof", label: "comment-only proof" },
  { key: "confidence", label: "reflex confidence to act alone" },
  { key: "hit", label: "detector answer that counts as a hit" },
  { key: "needsHuman", label: "p(needs_human) a landing stays under" },
  { key: "autonomyAfter", label: "approved landings to earn autonomy" },
  { key: "alertsPerHour", label: "escalations to people per hour" },
  { key: "budgetRiskFloor", label: "risk that reaches a person past the budget" },
] as const satisfies ReadonlyArray<{ key: keyof DecidePolicy; label: string }>;

/** A field a preset sets. */
export type PresetField = (typeof PRESET_FIELDS)[number]["key"];

/** The values a preset sets. */
export type PresetValues = Pick<DecidePolicy, PresetField>;

/** One preset: its name, how a reader names it, and its values. */
export interface Preset {
  name: PresetName;
  label: string;
  values: PresetValues;
}

const CENTRAL: PresetValues = {
  enabled: DEFAULT_POLICY.enabled,
  deterministic: DEFAULT_POLICY.deterministic,
  commentProof: DEFAULT_POLICY.commentProof,
  confidence: DEFAULT_POLICY.confidence,
  hit: DEFAULT_POLICY.hit,
  needsHuman: DEFAULT_POLICY.needsHuman,
  autonomyAfter: DEFAULT_POLICY.autonomyAfter,
  alertsPerHour: DEFAULT_POLICY.alertsPerHour,
  budgetRiskFloor: DEFAULT_POLICY.budgetRiskFloor,
};

/**
 * The four presets, most trusting first. Each step up asks the models for more certainty, makes a region earn autonomy
 * with more approved landings, lets detectors fire on weaker answers, and pages people for lower risk once the hourly
 * alert budget is spent (production pages them for every escalation).
 */
export const PRESETS: readonly Preset[] = [
  {
    name: "local-development",
    label: "local development",
    values: { ...CENTRAL, confidence: 0.7, hit: 0.6, needsHuman: 0.7, autonomyAfter: 1, alertsPerHour: 10, budgetRiskFloor: 3 },
  },
  { name: "central-development", label: "central development", values: CENTRAL },
  {
    name: "pre-production",
    label: "pre-production",
    values: { ...CENTRAL, confidence: 0.85, hit: 0.4, needsHuman: 0.3, autonomyAfter: 10, alertsPerHour: 60, budgetRiskFloor: 1 },
  },
  {
    name: "production",
    label: "production",
    values: { ...CENTRAL, confidence: 0.9, hit: 0.3, needsHuman: 0.2, autonomyAfter: 20, alertsPerHour: 120, budgetRiskFloor: 0 },
  },
];

/** The preset of this name, or null. */
export function presetNamed(name: string): Preset | null {
  return PRESETS.find((p) => p.name === name) ?? null;
}

/** `base` with a preset's values set (the policy a colony would have on it; mergePolicy keeps everything else). */
export function presetPolicy(name: PresetName, base: DecidePolicy = DEFAULT_POLICY): DecidePolicy {
  const preset = presetNamed(name);
  return preset ? mergePolicy(base, preset.values) : base;
}

/** The policy's value of each preset field. */
export function presetValues(policy: DecidePolicy): PresetValues {
  const out = {} as Record<PresetField, number | boolean>;
  for (const f of PRESET_FIELDS) out[f.key] = policy[f.key];
  return out as PresetValues;
}

/** Numbers within this much are the same value (a policy stored as JSON reads back exactly; this only absorbs float noise). */
const EPSILON = 1e-9;

function same(a: number | boolean, b: number | boolean): boolean {
  return typeof a === "number" && typeof b === "number" ? Math.abs(a - b) < EPSILON : a === b;
}

/** One preset field where a policy differs from a preset. */
export interface PresetDiff {
  field: PresetField;
  label: string;
  value: number | boolean;
  preset: number | boolean;
}

/** Which preset a policy equals: its name, or "custom" with the nearest preset (fewest fields differ, the earlier on a tie) and the differences. */
export interface PresetMatch {
  preset: PresetName | "custom";
  nearest: PresetName;
  differs: PresetDiff[];
}

/** The fields where `policy` differs from `preset`, in PRESET_FIELDS order. */
export function presetDiffs(policy: DecidePolicy, preset: Preset): PresetDiff[] {
  const out: PresetDiff[] = [];
  for (const f of PRESET_FIELDS) {
    const value = policy[f.key];
    const want = preset.values[f.key];
    if (!same(value, want)) out.push({ field: f.key, label: f.label, value, preset: want });
  }
  return out;
}

/** The preset a policy equals on every preset field, or "custom" with what differs from the nearest preset. */
export function presetOf(policy: DecidePolicy): PresetMatch {
  let best: { preset: Preset; differs: PresetDiff[] } | null = null;
  for (const preset of PRESETS) {
    const differs = presetDiffs(policy, preset);
    if (differs.length === 0) return { preset: preset.name, nearest: preset.name, differs: [] };
    if (!best || differs.length < best.differs.length) best = { preset, differs };
  }
  return { preset: "custom", nearest: best!.preset.name, differs: best!.differs };
}

const fixed = (n: number): string => String(Math.round(n * 100) / 100);

/**
 * What a policy lets land without a person, in one sentence built from its values, so a preset's sentence never says
 * other numbers than the preset sets: the deterministic proof (with or without comment-only changes), the second
 * opinion's approval under the p(needs_human) bound, and the reflex alone on earned autonomy.
 */
export function letsLand(v: PresetValues): string {
  if (!v.enabled) return "Every change that passes its checks lands without a person or a model: review is off, so only protected paths and tests before landing still hold one.";
  const parts: string[] = [];
  if (v.deterministic) parts.push(v.commentProof ? "a deterministic proof (an import rewrite, a rule's replacement, or a change only to comments)" : "a deterministic proof (an import rewrite or a rule's replacement)");
  parts.push(`a second opinion's approval with p(needs_human) under ${fixed(v.needsHuman)}`);
  parts.push(`the reflex alone at confidence ${fixed(v.confidence)} or more, in a region with ${v.autonomyAfter} approved ${v.autonomyAfter === 1 ? "landing" : "landings"} since its last escalation or rejection`);
  const list = parts.length === 3 ? `${parts[0]}, ${parts[1]}, or ${parts[2]}` : `${parts[0]} or ${parts[1]}`;
  return `${list.charAt(0).toUpperCase()}${list.slice(1)} lands a change without a person.`;
}
