import type { CheckResult, Evidence, Id, LandingAnswer, LineageNote } from "./types.ts";

/**
 * Who answers for a landing, and who said each line of its evidence, read from its lineage note alone, so the Why tab,
 * the landing page's note card, `ft why`, the MCP `why` tools and the colony's count agree. The stock-git checkers
 * (scripts/verify_note.mjs, scripts/coordination.rb) carry the same rules for the answerable line. Notes are read
 * defensively: a note written before a field existed lacks it, and what it cannot say is "unknown". Pure: no I/O.
 *
 * The nearest answerable person for one landed change, first match wins:
 * 1. `approved`: a person approved this change (a human decision `approve` among the note's decisions).
 * 2. `rule`: the person who approved the rule, when the rule's deterministic proof landed the change (the gate check
 *    says `→ land by deterministic`) and the note records the rule's approver.
 * 3. `asked`: the person who declared the intent (intent source `human`, its `createdBy`).
 * 4. `none`: no person; the reason names who declared the intent and what landed the change. `unknown` instead when
 *    the note predates the record of who declared the intent, or does not say who approved the rule whose proof landed it.
 */

/** How one landed change's answerable person is known (see the steps above). */
export type AnswerableBasis = "approved" | "rule" | "asked" | "none" | "unknown";

/** Who answers for one landed change. */
export interface Answerable {
  basis: AnswerableBasis;
  /** The person as the note names them; absent for none and unknown, and when the note does not name them. */
  person?: string;
  /** Who, in a few words: the person ("an unnamed person" when the note does not name them), "none" or "unknown". */
  who: string;
  /** Why, as a clause that follows `who`: "approved this change", or for none and unknown the reason. */
  why: string;
  /** The line a landing card shows, as a sentence. */
  text: string;
}

/** Who answers for a whole landing: each change's answer, and the landing's in one line. */
export interface LandingAnswerable {
  /** `person`: a person answers for every change; `none`: no person for some change; `unknown`: the note cannot say for some. */
  answer: LandingAnswer;
  changes: Array<Answerable & { proposalId: Id }>;
  who: string;
  why: string;
  text: string;
}

/** Who said one line of a note's evidence: FireTrident's own check, a model, a person, the agent that wrote the change, or unknown. */
export type SpeakerKind = "platform" | "person" | "model" | "agent" | "unknown";

/** A speaker and the label the line carries: `checked by FireTrident`, `person (<name>)`, `model (<name>)`, `agent's claim` or `unknown`. */
export interface Speaker {
  kind: SpeakerKind;
  name?: string;
  label: string;
}

/** One line of a change's evidence with who said it (evidenceLines). */
export interface EvidenceLine {
  /** A check, the files changed outside the declared footprint, or the statement of what was not verified. */
  kind: "check" | "residual" | "not-verified";
  speaker: Speaker;
  /** The check's name; "residual" and "not verified" for the other two. */
  name: string;
  ok?: boolean;
  ms?: number;
  /** What the line says. */
  text?: string;
  /** The residual line's files. */
  paths?: string[];
  /** The text is the agent's own words (or words of unknown origin): show it quoted, as data, never as FireTrident's. */
  quoted: boolean;
}

/**
 * What FireTrident writes as a change's "Not verified" statement when its agent gave none: the colony's default
 * (worker colony/logic.ts DEFAULT_NOT_VERIFIED) and the MCP server's sentence for an external agent (worker mcp/tools.ts
 * EXTERNAL_NOT_VERIFIED). A note written before `notVerifiedBy` holding one of them exactly was FireTrident's.
 */
export const PLATFORM_NOT_VERIFIED: readonly string[] = [
  "Not verified: behavior beyond the checks listed",
  "Not verified: external agent over MCP; no check it ran is visible to the platform.",
];

/** Names that say a person acted without saying who: the API's defaults when no name is given. */
const UNNAMED: ReadonlySet<string> = new Set(["", "api", "human", "unknown", "person", "someone"]);
const NAME_CHARS = 200;
/** Evidence lines in this order: FireTrident's facts first, then people, then models, then the agent's claims. */
const ORDER: Record<SpeakerKind, number> = { platform: 0, person: 1, model: 2, agent: 3, unknown: 4 };

type NoteEntry = LineageNote["proposals"][number];
type Json = Record<string, unknown>;

const isObj = (x: unknown): x is Json => typeof x === "object" && x !== null && !Array.isArray(x);
const line = (v: unknown): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");
const capital = (s: string): string => (s === "" ? s : `${s.charAt(0).toUpperCase()}${s.slice(1)}`);

/** A recorded name on one line, or null when it names nobody in particular (empty, or an API default such as "api"). */
export function personName(raw: unknown): string | null {
  const name = line(raw).slice(0, NAME_CHARS);
  return UNNAMED.has(name.toLowerCase()) ? null : name;
}

/** What the platform's gate check says landed a change: its action, its layer and its confirmations; null without one. */
export function gateOf(checks: readonly unknown[]): { action: string; layer: string; confirmations: string[] } | null {
  // The decide stage appends its gate check after the agent's own checks: the last one that is not the agent's is it.
  for (let i = checks.length - 1; i >= 0; i--) {
    const c = checks[i];
    if (!isObj(c) || c.name !== "gate" || c.by === "agent" || typeof c.detail !== "string") continue;
    const m = /→ (\S+) by (\S+)/.exec(c.detail);
    if (!m) return null;
    const conf = /\(confirmations: ([^)]*)\)/.exec(c.detail);
    return { action: m[1] ?? "", layer: m[2] ?? "", confirmations: conf ? (conf[1] ?? "").split("+").map((s) => s.trim()).filter(Boolean) : [] };
  }
  return null;
}

/** The model a layer's landing decision names, else the one its evidence check names (`llm: <model>`), or "". */
export function modelOf(layer: string, decisions: readonly unknown[], checks: readonly unknown[]): string {
  for (let i = decisions.length - 1; i >= 0; i--) {
    const d = decisions[i];
    if (isObj(d) && d.layer === layer && d.action === "land" && line(d.by) !== "") return line(d.by);
  }
  for (let i = checks.length - 1; i >= 0; i--) {
    const c = checks[i];
    if (isObj(c) && c.by !== "agent" && typeof c.name === "string" && c.name.startsWith(`${layer}: `)) return line(c.name.slice(layer.length + 2));
  }
  return "";
}

/** What landed a change, as a clause: "a deterministic proof landed it", "model <m> approved it", ... */
function landedBy(gate: ReturnType<typeof gateOf>, decisions: readonly unknown[], checks: readonly unknown[]): string {
  if (!gate) return "it landed with no review recorded";
  if (gate.layer === "deterministic") return "a deterministic proof landed it";
  const model = modelOf(gate.layer, decisions, checks);
  const named = model ? `model ${model}` : "a model";
  if (gate.layer === "llm") return `${named} approved it`;
  if (gate.layer === "reflex") return gate.confirmations.includes("autonomy") ? `${named} landed it on earned autonomy` : `${named} landed it`;
  return `the ${gate.layer} layer landed it`;
}

/** Who declared an intent, as a clause: "agent agt_1 declared the intent", ... */
function declaredBy(source: string, createdBy: string, ruleId: string): string {
  if (source === "agent") return `agent ${createdBy || "unknown"} declared the intent`;
  if (source === "rule") return `rule ${ruleId || "unknown"} declared the intent`;
  if (source === "certify") return "trunk certification declared the intent";
  if (source === "system") return "FireTrident declared the intent";
  return `an intent of source ${source} was declared`;
}

function answer(basis: AnswerableBasis, who: string, why: string, text: string, person?: string | null): Answerable {
  return { basis, ...(person ? { person } : {}), who, why, text };
}

/** Who answers for one landed change of a note (see the steps at the top of this file). */
export function changeAnswerable(entry: NoteEntry | Json): Answerable {
  const p: Json = isObj(entry) ? (entry as Json) : {};
  const decisions = Array.isArray(p.decisions) ? p.decisions : [];
  const evidence = isObj(p.evidence) ? p.evidence : {};
  const checks = Array.isArray(evidence.checks) ? evidence.checks : [];
  const intent = isObj(p.intent) ? p.intent : {};
  const gate = gateOf(checks);
  const lander = landedBy(gate, decisions, checks);

  // 1. A person approved this change.
  for (let i = decisions.length - 1; i >= 0; i--) {
    const d = decisions[i];
    if (!isObj(d) || d.layer !== "human" || d.action !== "approve") continue;
    const name = personName(d.by);
    const who = name ?? "an unnamed person";
    return answer("approved", who, "approved this change", `${capital(who)} approved this change.`, name);
  }

  const ruleId = line(intent.ruleId);
  const hasSource = typeof intent.source === "string" && intent.source !== "";
  // 2. The rule's deterministic proof landed it: the person who approved the rule.
  if (ruleId && gate?.layer === "deterministic" && gate.action === "land") {
    if (typeof intent.ruleApprovedBy === "string") {
      const name = personName(intent.ruleApprovedBy);
      const who = name ?? "an unnamed person";
      const why = `approved rule ${ruleId}, whose deterministic proof landed this change`;
      return answer("rule", who, why, `${capital(who)} ${why}.`, name);
    }
    const why = hasSource ? `the note does not record who approved rule ${ruleId}, whose proof landed this change` : "the note was written before notes recorded who approved each rule";
    return answer("unknown", "unknown", why, `Unknown: ${why}.`);
  }

  if (!hasSource) {
    const why = "the note was written before notes recorded who asked for each intent";
    return answer("unknown", "unknown", why, `Unknown: ${why}.`);
  }
  const source = line(intent.source);
  // 3. A person asked for the intent.
  if (source === "human") {
    const name = personName(intent.createdBy);
    const who = name ?? "an unnamed person";
    return answer("asked", who, "asked for this intent", `${capital(who)} asked for this intent; ${lander}.`, name);
  }
  // 4. No person.
  const why = `${declaredBy(source, line(intent.createdBy), ruleId)} and ${lander}`;
  return answer("none", "none", why, `No person is answerable for this landing: ${why}.`);
}

/** The phrase one change's answer contributes to a landing of several: "<who> <why>", or "no person: <why>". */
function phrase(a: Answerable): string {
  if (a.basis === "none") return `no person: ${a.why}`;
  if (a.basis === "unknown") return `unknown: ${a.why}`;
  return `${a.who} ${a.why}`;
}

/**
 * Who answers for a landing: each change's answer, and the landing's. A person's revert names the person; an antibody's
 * commit names the person whose rejection taught it. A landing of several changes answers `none` when no person
 * answers for one of them, `unknown` when the note cannot say for one, else `person`.
 */
export function landingAnswerable(note: LineageNote | Json | null | undefined): LandingAnswerable {
  const n: Json = isObj(note) ? (note as Json) : {};
  const one = (a: LandingAnswer, who: string, why: string, text: string): LandingAnswerable => ({ answer: a, changes: [], who, why, text });
  if (isObj(n.revert)) {
    const name = personName(n.revert.by);
    const who = name ?? "an unnamed person";
    const why = `reverted ${line(n.revert.of) || "a landing"}`;
    return one("person", who, why, `${capital(who)} ${why}.`);
  }
  // A batch of a recipe (worker trunk/recipes.ts): the person who declared the recipe answers for what it rewrote.
  if (isObj(n.recipe)) {
    const name = personName(n.recipe.by);
    const who = name ?? "an unnamed person";
    const why = `declared recipe ${line(n.recipe.id) || "a recipe"}, which the trunk writer ran`;
    return one("person", who, why, `${capital(who)} ${why}.`);
  }
  if (isObj(n.system)) {
    if (n.system.kind === "antibody") {
      const name = personName(n.system.by);
      const who = name ?? "an unnamed person";
      const why = `rejected ${line(n.system.rejected) || "a change"}, which taught this antibody`;
      return one("person", who, why, `${capital(who)} ${why}.`);
    }
    return one("none", "none", "FireTrident made this commit on its own", "No person is answerable for this landing: FireTrident made this commit on its own.");
  }
  const proposals = (Array.isArray(n.proposals) ? n.proposals : []).filter(isObj);
  if (proposals.length === 0) return one("unknown", "unknown", "the note lists no change", "Unknown: the note lists no change.");
  const changes = proposals.map((p) => ({ proposalId: line(p.id), ...changeAnswerable(p) }));
  const a: LandingAnswer = changes.some((c) => c.basis === "none") ? "none" : changes.some((c) => c.basis === "unknown") ? "unknown" : "person";
  // The changes grouped by what they answer, first seen first.
  const groups: Array<{ a: Answerable; n: number }> = [];
  for (const c of changes) {
    const g = groups.find((x) => x.a.basis === c.basis && x.a.who === c.who && x.a.why === c.why);
    if (g) g.n++;
    else groups.push({ a: c, n: 1 });
  }
  if (groups.length === 1) {
    const only = groups[0]!.a;
    return { answer: a, changes, who: only.who, why: only.why, text: only.text };
  }
  const total = changes.length;
  const persons = [...new Set(changes.filter((c) => c.basis !== "none" && c.basis !== "unknown").map((c) => c.who))];
  const who = a === "person" ? persons.join(", ") : a;
  const why = groups.map((g) => `${g.n} of ${total}: ${phrase(g.a)}`).join("; ");
  const text = groups.map((g) => `${g.n} of ${total} changes: ${g.a.text}`).join(" ");
  return { answer: a, changes, who, why, text };
}

/** The answerable line `scripts/verify_note.mjs` prints for a verified note, after "answerable: ". */
export function answerableLine(a: Pick<LandingAnswerable, "who" | "why">): string {
  return `${a.who} (${a.why})`;
}

/** A speaker with its label. */
export function speaker(kind: SpeakerKind, name?: string): Speaker {
  const who = line(name);
  const label =
    kind === "platform" ? "checked by FireTrident" : kind === "agent" ? "agent's claim" : kind === "unknown" ? "unknown" : who ? `${kind} (${who})` : kind;
  return { kind, ...(who && (kind === "model" || kind === "person") ? { name: who } : {}), label };
}

/** Checks FireTrident runs itself: the innate checks, the deterministic stage, the gate, and the checks named here. */
const PLATFORM_CHECKS: ReadonlySet<string> = new Set(["gate", "danger patterns", "goal conflict", "acceptance: quoted", "tests before landing", "megafile: split"]);
/** Checks an agent sends with its change, by name, for notes written before the colony marked them (`by: "agent"`). */
const AGENT_CHECKS: ReadonlySet<string> = new Set(["agent model usage", "agent git transfer", "agent virtual checkout", "directives", "resolver: merge"]);

/**
 * Who said a check: the agent when the colony marked it as one that came with the proposal; a model for the reflex
 * and second-opinion checks (`reflex: <model>`, `llm: <model>`) and for a contest a judge model decided; FireTrident for
 * its own checks; the agent for the checks FireTrident's agents and resolver send, by name; unknown otherwise (a check
 * an agent sent before the colony marked them).
 */
export function checkSpeaker(c: Pick<CheckResult, "name" | "detail"> & { by?: unknown }): Speaker {
  if (c?.by === "agent") return speaker("agent");
  const name = typeof c?.name === "string" ? c.name : "";
  const model = /^(?:reflex|llm): (.+)$/.exec(name);
  if (model) return speaker("model", model[1]);
  if (name === "contest") {
    const judge = /judged better by (\S+) in both orders/.exec(typeof c.detail === "string" ? c.detail : "");
    return judge ? speaker("model", judge[1]) : speaker("platform");
  }
  if (name.startsWith("innate: ") || name.startsWith("deterministic: ") || PLATFORM_CHECKS.has(name)) return speaker("platform");
  if (name.startsWith("write ") || name.startsWith("recheck ") || AGENT_CHECKS.has(name)) return speaker("agent");
  return speaker("unknown");
}

/** Who made a decision of a note: FireTrident for the deterministic proof, the model for the reflex and the second opinion, the person for a human one. */
export function decisionSpeaker(d: { layer?: unknown; by?: unknown }): Speaker {
  if (d?.layer === "proof" || d?.layer === "deterministic") return speaker("platform");
  if (d?.layer === "reflex" || d?.layer === "llm") return speaker("model", line(d.by));
  if (d?.layer === "human") return speaker("person", personName(d.by) ?? "");
  return speaker("unknown");
}

/**
 * Who wrote a change's "Not verified" statement: as its evidence records it (`notVerifiedBy`), else FireTrident when it
 * is one of FireTrident's own sentences exactly, else the agent (FireTrident writes no other).
 */
export function notVerifiedSpeaker(evidence: Pick<Evidence, "notVerified" | "notVerifiedBy"> | null | undefined): Speaker {
  const by = evidence?.notVerifiedBy;
  if (by === "platform") return speaker("platform");
  if (by === "agent") return speaker("agent");
  const text = typeof evidence?.notVerified === "string" ? evidence.notVerified.trim() : "";
  return PLATFORM_NOT_VERIFIED.includes(text) ? speaker("platform") : speaker("agent");
}

/** A "Not verified" statement without its label ("Not verified: "), on one line. */
export function notVerifiedWords(text: unknown): string {
  return line(text).replace(/^not verified:\s*/i, "");
}

/**
 * A change's evidence as lines, each with who said it, in order: FireTrident's facts, then people, then models, then the
 * agent's claims, then lines of unknown origin; within each, as recorded. The statement of what was not verified is a
 * line of its own, never inside a FireTrident line: the innate check that a statement came says only that it did.
 */
export function evidenceLines(evidence: Partial<Evidence> | null | undefined): EvidenceLine[] {
  const ev = isObj(evidence) ? evidence : {};
  const checks = (Array.isArray(ev.checks) ? ev.checks : []).filter((c): c is CheckResult => isObj(c) && typeof c.name === "string" && c.name !== "");
  const nv = notVerifiedSpeaker(ev);
  const words = notVerifiedWords(ev.notVerified);
  const out: EvidenceLine[] = [];
  for (const c of checks) {
    const s = checkSpeaker(c);
    let text = typeof c.detail === "string" ? c.detail : undefined;
    if (c.name === "innate: not-verified" && s.kind === "platform" && c.ok === true) {
      text = nv.kind === "platform" ? "the agent gave no statement; the one below is FireTrident's" : "the agent stated what it did not verify (its claim, below)";
    }
    out.push({ kind: "check", speaker: s, name: c.name, ok: c.ok === true, ...(typeof c.ms === "number" && Number.isFinite(c.ms) ? { ms: c.ms } : {}), ...(text ? { text } : {}), quoted: s.kind === "agent" || s.kind === "unknown" });
  }
  const residual = (Array.isArray(ev.residual) ? ev.residual : []).filter((x): x is string => typeof x === "string" && x !== "");
  if (residual.length > 0) out.push({ kind: "residual", speaker: speaker("platform"), name: "residual", text: `changed outside the declared footprint: ${residual.join(", ")}`, paths: residual, quoted: false });
  if (words !== "") out.push({ kind: "not-verified", speaker: nv, name: "not verified", text: words, quoted: nv.kind !== "platform" });
  return out.map((l, i) => ({ l, i })).sort((a, b) => ORDER[a.l.speaker.kind] - ORDER[b.l.speaker.kind] || a.i - b.i).map((x) => x.l);
}

/** Evidence lines in runs of one speaker (same label), in order: for surfaces that show a label once per run. */
export function bySpeaker(lines: readonly EvidenceLine[]): Array<{ speaker: Speaker; lines: EvidenceLine[] }> {
  const out: Array<{ speaker: Speaker; lines: EvidenceLine[] }> = [];
  for (const l of lines) {
    const last = out[out.length - 1];
    if (last && last.speaker.label === l.speaker.label) last.lines.push(l);
    else out.push({ speaker: l.speaker, lines: [l] });
  }
  return out;
}
