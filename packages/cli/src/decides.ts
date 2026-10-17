// A copy of packages/core/src/decides.ts: the published CLI ships without @fire_trident/core (scripts/vendor_cli.rb writes it; test/package.test.ts keeps the two the same).
import type { GateRecord, GateValue, LineageNote, ProofRung } from "@fire_trident/core";
import { personName } from "./answerable.ts";
import { changeRung, shortModel } from "./testdelta.ts";

/**
 * How a colony decides, as every surface shows it (the colony page's card, each landing card in the Why tab, the landing
 * page's note card, `ft status`, `ft why`): the rule that confirmed each landed change with the values it used, read from
 * the change's gate check in its lineage note, and the words for the colony's report (GET /api/colonies/:id/decides,
 * worker decide/decides.ts): its preset and the last 30 days of landed changes by what confirmed them. Notes are read
 * defensively: a gate check written before it kept its record names its rule only, and the line says the bounds were
 * not recorded. Pure: no I/O.
 */

/** What can confirm a landed change, in the order the split lists them. */
export const CONFIRM_KINDS = ["deterministic", "model", "autonomy", "person", "unreviewed"] as const;

/** What confirmed a landed change (a ProofRung other than FireTrident's own commits). */
export type ConfirmKind = (typeof CONFIRM_KINDS)[number];

/** How the split names each kind. */
export const CONFIRM_LABEL: Record<ConfirmKind, string> = {
  deterministic: "deterministic proof",
  model: "a model",
  autonomy: "earned autonomy",
  person: "a person",
  unreviewed: "no review recorded",
};

/** What confirmed one landed change, and the line a landing card shows for it. */
export interface Confirmation {
  rung: ProofRung;
  /** The rule's code ("D3", "M1", "R3", "L3"); for a person's approval, the rule that sent the change to them; "" when none is recorded. */
  rule: string;
  /** The rule as the gate names it ("R3 innate+autonomy"); "" when none is recorded. */
  ruleName: string;
  /** The model or the person, when the note names one. */
  by?: string;
  /** The preset the colony's policy equalled when the gate decided ("production", "custom"); absent on older notes. */
  preset?: string;
  values: GateValue[];
  /** The values come from the gate's record; false when they are read from an older note's words, without their bounds. */
  recorded: boolean;
  /** The line: "R3: confidence 0.93 ≥ 0.85, p(needs_human) 0.04 < 0.2, approved landings 23 ≥ 20". */
  text: string;
}

/** What confirmed each change of a landing, and the landing's line. */
export interface LandingConfirmation {
  changes: Array<Confirmation & { proposalId: string }>;
  /** The kind when every change shares it, else "mixed"; "system" for FireTrident's own commit, "unknown" when the note says nothing. */
  kind: ConfirmKind | "mixed" | "system" | "unknown";
  text: string;
}

type Json = Record<string, unknown>;
const isObj = (x: unknown): x is Json => typeof x === "object" && x !== null && !Array.isArray(x);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
/** Text from a note or the server on one line, no control characters, at most `max` characters (ending in "…" when cut). */
function words(v: unknown, max = 160): string {
  if (typeof v !== "string") return "";
  const one = v.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
}
const OPS: ReadonlySet<string> = new Set(["≥", ">", "<", "≤", "="]);

/** A number as the line writes it: two decimals at most, three for a small probability, integers as they are. */
export function valueNumber(n: number): string {
  if (!Number.isFinite(n)) return "?";
  if (Number.isInteger(n)) return String(n);
  if (Math.abs(n) < 0.01) return String(Math.round(n * 1000) / 1000);
  return String(Math.round(n * 100) / 100);
}

/** One value as the line writes it: "confidence 0.93 ≥ 0.85", "model gemma-4-26b-a4b-it", "no destructive change". */
export function valueText(v: GateValue): string {
  const name = words(v.name, 60);
  if (typeof v.value === "boolean") return v.value ? name : `no ${name}`;
  const value = typeof v.value === "number" ? valueNumber(v.value) : name === "model" ? shortModel(words(v.value, 120)) : words(v.value);
  const bound = typeof v.bound === "number" && Number.isFinite(v.bound) && typeof v.op === "string" && OPS.has(v.op) ? ` ${v.op} ${valueNumber(v.bound)}` : "";
  return `${name} ${value}${bound}`;
}

/** A gate record as stored, or null when the check has none (or not one this reader can use). */
export function gateRecordOf(raw: unknown): GateRecord | null {
  if (!isObj(raw) || typeof raw.rule !== "string" || raw.rule.trim() === "") return null;
  const values: GateValue[] = [];
  for (const v of list(raw.values).slice(0, 20)) {
    if (!isObj(v) || typeof v.name !== "string" || v.name.trim() === "") continue;
    const value = v.value;
    if (typeof value !== "number" && typeof value !== "string" && typeof value !== "boolean") continue;
    if (typeof value === "number" && !Number.isFinite(value)) continue;
    const op = typeof v.op === "string" && OPS.has(v.op) ? (v.op as GateValue["op"]) : undefined;
    const bound = typeof v.bound === "number" && Number.isFinite(v.bound) ? v.bound : undefined;
    values.push({ name: v.name, value, ...(op && bound !== undefined ? { op, bound } : {}) });
  }
  return { rule: words(raw.rule, 80), preset: typeof raw.preset === "string" ? words(raw.preset, 40) : "", values };
}

/** The platform's gate check of a change: the last check named "gate" that the agent did not send (as gateOf reads it). */
function gateCheck(checks: readonly unknown[]): Json | null {
  for (let i = checks.length - 1; i >= 0; i--) {
    const c = checks[i];
    if (isObj(c) && c.name === "gate" && c.by !== "agent" && typeof c.detail === "string") return c;
  }
  return null;
}

/** The values an older note's words still carry: the reflex's confidence and the p(needs_human) the deciding model gave. */
function wordsValues(rule: string, detail: string, checks: readonly unknown[]): GateValue[] {
  const out: GateValue[] = [];
  const num = (re: RegExp, text: string): number | null => {
    const m = re.exec(text);
    const n = m ? Number(m[1]) : NaN;
    return Number.isFinite(n) ? n : null;
  };
  const layer = rule.startsWith("R") ? "reflex" : rule.startsWith("L") ? "llm" : "";
  if (layer === "reflex") {
    const confidence = num(/confidence (\d+(?:\.\d+)?)/, detail);
    if (confidence !== null) out.push({ name: "confidence", value: confidence });
  }
  if (layer) {
    for (let i = checks.length - 1; i >= 0; i--) {
      const c = checks[i];
      if (!isObj(c) || c.by === "agent" || typeof c.name !== "string" || !c.name.startsWith(`${layer}: `) || typeof c.detail !== "string") continue;
      out.unshift({ name: "model", value: c.name.slice(layer.length + 2) });
      const p = num(/needs_human (\d+(?:\.\d+)?)/, c.detail);
      if (p !== null) out.push({ name: "p(needs_human)", value: p });
      break;
    }
  }
  return out;
}

/** What confirmed one landed change of a note, with its rule and values (see Confirmation). */
export function changeConfirmed(entry: unknown): Confirmation {
  const p = isObj(entry) ? entry : {};
  const checks = list(isObj(p.evidence) ? p.evidence.checks : undefined);
  const check = gateCheck(checks);
  const record = gateRecordOf(check?.gate);
  const detail = typeof check?.detail === "string" ? check.detail : "";
  const ruleName = record?.rule ?? words(detail.split(" → ")[0] ?? "", 80);
  const rule = /^[A-Z]\d+$/.test(ruleName.split(" ")[0] ?? "") ? ruleName.split(" ")[0]! : "";
  const values = record ? record.values : rule ? wordsValues(rule, detail, checks) : [];
  const { rung, by } = changeRung(p);
  const base = { rung, rule, ruleName, ...(by ? { by } : {}), ...(record?.preset ? { preset: record.preset } : {}), values, recorded: record !== null };
  const said = values.map(valueText).join(", ");
  const older = record ? "" : "; its bounds were not recorded (the note predates the gate's record)";

  if (rung === "person") {
    // A person approved it: the rule that sent it to them, with what that rule saw.
    const human = list(p.decisions).filter((d) => isObj(d) && d.layer === "human" && d.action === "approve");
    const name = human.length > 0 ? personName((human[human.length - 1] as Json).by) : null;
    const who = name ? `A person (${name})` : "A person";
    const sent = ruleName ? `; ${ruleName} had sent it to a person${said ? ` (${said})` : ""}` : "";
    return { ...base, text: `${who} approved it${sent}.` };
  }
  if (rung === "unreviewed") return { ...base, text: "No review recorded: no gate decision is kept with this change." };
  // The gate did not land it and no person approved it: it landed anyway (a change of direction raced the decision).
  const action = /→ (\S+) by/.exec(detail)?.[1] ?? "land";
  if (action !== "land") {
    const did = action === "escalate" ? "sent it to a person" : action === "return" ? "sent it back to its agent" : `answered ${words(action, 20)}`;
    return { ...base, rung: "unreviewed", text: `No confirmation recorded: ${ruleName || "the gate"} ${did}, and it landed without a recorded approval.` };
  }
  if (!rule) return { ...base, text: "Unknown: the note does not say which rule confirmed it." };
  // A proof has no bounds to record: an older note's D3 or M1 says what it is.
  if (!record && rung === "deterministic") return { ...base, text: `${ruleName}: a deterministic proof, no model` };
  return { ...base, text: said ? `${rule}: ${said}${older}` : `${ruleName}${older}` };
}

/**
 * What confirmed each change of a landing, and its line: one change's line, or each distinct line with how many of the
 * changes it covers. A person's revert and FireTrident's own commits are not decided by the gate, and say so.
 */
export function landingConfirmed(note: LineageNote | Json | null | undefined): LandingConfirmation {
  const n: Json = isObj(note) ? (note as Json) : {};
  if (isObj(n.revert)) {
    const name = personName(n.revert.by);
    return { changes: [], kind: "person", text: `${name ? `A person (${name})` : "A person"} reverted ${words(n.revert.of, 40) || "a landing"}: no gate decides a revert.` };
  }
  if (isObj(n.system)) return { changes: [], kind: "system", text: "FireTrident's own commit: no gate decides it." };
  const proposals = list(n.proposals).filter(isObj);
  if (proposals.length === 0) return { changes: [], kind: "unknown", text: "Unknown: the note lists no change." };
  const changes = proposals.map((p) => ({ proposalId: words(p.id, 80), ...changeConfirmed(p) }));
  const kinds = new Set(changes.map((c) => c.rung));
  const only = [...kinds][0];
  const kind: LandingConfirmation["kind"] = kinds.size === 1 && only && (CONFIRM_KINDS as readonly string[]).includes(only) ? (only as ConfirmKind) : kinds.size === 1 ? "unknown" : "mixed";
  const groups: Array<{ text: string; n: number }> = [];
  for (const c of changes) {
    const g = groups.find((x) => x.text === c.text);
    if (g) g.n++;
    else groups.push({ text: c.text, n: 1 });
  }
  const text = groups.length === 1 ? groups[0]!.text : groups.map((g) => `${g.n} of ${changes.length} changes: ${g.text.replace(/\.$/, "")}`).join("; ");
  return { changes, kind, text };
}

// ---------------------------------------------------------------------------
// The colony's report (GET /api/colonies/:id/decides)

/** One preset as the report lists it: its name, its label, its sentence, and its values of the preset fields. */
export interface DecidesPreset {
  name: string;
  label: string;
  /** What it lets land without a person, in one sentence. */
  lets: string;
  settings: Array<{ field: string; label: string; value: number | boolean }>;
}

/** The last days of landed changes, counted by what confirmed them. */
export interface DecidesSplit {
  days: number;
  since: number;
  total: number;
  counts: Record<ConfirmKind, number>;
}

/**
 * The audit sample in a line (worker colony/audit.ts): of the changes that landed without a person, how many a person
 * audited after they landed and how many should not have landed, with its Wilson 95% interval; and the blind canaries'
 * catch rate. Absent from servers that predate it.
 */
export interface DecidesAudit {
  /** "audited 12 of 400 landings without a person: 0 should not have landed (0–24%)". */
  line: string;
  /** The share of landings without a person put in front of a person (0.03 is 3%; 0 is off). */
  rate: number;
  landed: number;
  audited: number;
  wrong: number;
  lo: number;
  hi: number;
  /** Audit items waiting for a person. */
  pending: number;
  /** The canaries in a line ("canaries off", "canaries: 4 of 5 caught (80%, 38–96%), 1 approved"). */
  canaries: string;
}

/** How a colony decides: the preset its policy equals (or custom and how it differs), the presets, and the split. */
export interface DecidesReport {
  colonyId: string;
  /** The preset's name, or "custom". */
  preset: string;
  /** The preset its policy equals, else the nearest one. */
  nearest: string;
  /** For custom: each preset field that differs from the nearest preset, with both values. */
  differs: Array<{ field: string; label: string; value: number | boolean; preset: number | boolean }>;
  /** The colony's values of the preset fields. */
  settings: Array<{ field: string; label: string; value: number | boolean }>;
  /** What the colony's own policy lets land without a person, in one sentence. */
  lets: string;
  /** Models review its changes now: the policy turns review on and the server has the model binding. */
  reviewing: boolean;
  protectedPaths: number;
  dangerAllow: number;
  /** What waits for a person whatever the preset. */
  always: string;
  presets: DecidesPreset[];
  split: DecidesSplit;
  /** The audit sample and the canaries; absent from servers that predate them. */
  audit?: DecidesAudit;
  at: number;
}

const finite = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const whole = (v: unknown): number => Math.max(0, Math.floor(finite(v)));

function settingsOf(v: unknown): DecidesPreset["settings"] {
  return list(v)
    .filter(isObj)
    .flatMap((s) => (typeof s.field === "string" && (typeof s.value === "number" || typeof s.value === "boolean") ? [{ field: s.field, label: words(s.label, 80) || s.field, value: s.value }] : []));
}

/** The audit's line and numbers as the server sent them; null when it sent none (an older server) or not one. */
export function decidesAuditOf(raw: unknown): DecidesAudit | null {
  if (!isObj(raw) || typeof raw.line !== "string" || raw.line.trim() === "") return null;
  const share = (v: unknown, fallback: number): number => Math.min(1, Math.max(0, typeof v === "number" && Number.isFinite(v) ? v : fallback));
  return {
    line: words(raw.line, 200),
    rate: share(raw.rate, 0),
    landed: whole(raw.landed),
    audited: whole(raw.audited),
    wrong: whole(raw.wrong),
    lo: share(raw.lo, 0),
    hi: share(raw.hi, 1),
    pending: whole(raw.pending),
    canaries: words(raw.canaries, 200),
  };
}

/** A report from the server, read defensively; null when the answer is not one (an older server, an error). */
export function decidesOf(raw: unknown): DecidesReport | null {
  if (!isObj(raw) || typeof raw.preset !== "string" || !isObj(raw.split)) return null;
  const s = raw.split;
  const c = isObj(s.counts) ? s.counts : {};
  const counts = Object.fromEntries(CONFIRM_KINDS.map((k) => [k, whole(c[k])])) as Record<ConfirmKind, number>;
  const presets = list(raw.presets)
    .filter(isObj)
    .flatMap((p) => (typeof p.name === "string" ? [{ name: p.name, label: words(p.label, 40) || p.name, lets: words(p.lets, 400), settings: settingsOf(p.settings) }] : []));
  const differs = list(raw.differs)
    .filter(isObj)
    .flatMap((d) =>
      typeof d.field === "string" && (typeof d.value === "number" || typeof d.value === "boolean") && (typeof d.preset === "number" || typeof d.preset === "boolean")
        ? [{ field: d.field, label: words(d.label, 80) || d.field, value: d.value, preset: d.preset }]
        : [],
    );
  const audit = decidesAuditOf(raw.audit);
  return {
    colonyId: words(raw.colonyId, 64),
    preset: words(raw.preset, 40),
    nearest: words(raw.nearest, 40) || words(raw.preset, 40),
    differs,
    settings: settingsOf(raw.settings),
    lets: words(raw.lets, 400),
    reviewing: raw.reviewing !== false,
    protectedPaths: whole(raw.protectedPaths),
    dangerAllow: whole(raw.dangerAllow),
    always: words(raw.always, 400),
    presets,
    split: { days: whole(s.days) || 30, since: finite(s.since), total: CONFIRM_KINDS.reduce((n, k) => n + counts[k], 0), counts },
    ...(audit ? { audit } : {}),
    at: finite(raw.at),
  };
}

/** A preset's label from the report ("production"), "custom" for custom, else the name as it came. */
export function presetLabel(r: Pick<DecidesReport, "presets">, name: string): string {
  if (name === "custom") return "custom";
  return r.presets.find((p) => p.name === name)?.label ?? name;
}

/** One kind of the split with its count and its share in whole percent (largest remainder, so the shares add up to 100). */
export interface SplitRow {
  kind: ConfirmKind;
  label: string;
  count: number;
  percent: number;
}

/** The split's rows, every kind in order (no review recorded only when it counted one), with shares that add up to 100. */
export function splitRows(split: DecidesSplit): SplitRow[] {
  const kinds = CONFIRM_KINDS.filter((k) => k !== "unreviewed" || split.counts.unreviewed > 0);
  const total = kinds.reduce((n, k) => n + split.counts[k], 0);
  const exact = kinds.map((k) => (total > 0 ? (split.counts[k] * 100) / total : 0));
  const percent = exact.map(Math.floor);
  let left = total > 0 ? 100 - percent.reduce((a, b) => a + b, 0) : 0;
  const order = exact.map((x, i) => ({ i, rest: x - Math.floor(x) })).sort((a, b) => b.rest - a.rest || a.i - b.i);
  for (const o of order) {
    if (left <= 0) break;
    if (exact[o.i]! > 0) {
      percent[o.i]!++;
      left--;
    }
  }
  return kinds.map((k, i) => ({ kind: k, label: CONFIRM_LABEL[k], count: split.counts[k], percent: percent[i]! }));
}

/** The split in one sentence: "Last 30 days: 40 changes landed: 24 by deterministic proof (60%), ...", or that none did. */
export function splitText(split: DecidesSplit): string {
  const days = `Last ${split.days} ${split.days === 1 ? "day" : "days"}`;
  if (split.total === 0) return `${days}: no change landed.`;
  const rows = splitRows(split).filter((r) => r.count > 0);
  const by = (r: SplitRow) => `${r.count.toLocaleString("en-US")} ${r.kind === "autonomy" ? "on" : r.kind === "unreviewed" ? "with" : "by"} ${r.label} (${r.percent}%)`;
  return `${days}: ${split.total.toLocaleString("en-US")} ${split.total === 1 ? "change" : "changes"} landed, ${rows.map(by).join(", ")}.`;
}
