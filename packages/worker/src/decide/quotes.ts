import type { AcceptanceVerdict, Id, Intent, IntentSource, NoteAcceptance, Path } from "@fire_trident/core";

/**
 * Quoted acceptance (FT_QUOTED_ACCEPTANCE): when a change's intent carries an acceptance list, the second opinion answers
 * each line as met, not met or unclear, and each "met" names a file and quotes the line of the diff that meets it. This
 * module checks those quotes against the diff the model was shown, and says what the gate counts: an approval is a
 * confirmation only when every line of the intent is met with a quote found in an added or unchanged line, or, for a line
 * stating what must not be there (isAbsence), met on the model's word. Keep lines (the acceptance list of the newest
 * landing by another intent on the files the change modifies) only send a change back when the model answers one not
 * met. Pure: no I/O, no model.
 */

/** Caps on what the second opinion is asked and what a decision keeps. */
export const ACCEPTANCE_LIMITS = {
  /** Lines of the intent's own list asked; more count as unclear (the model was not asked them). */
  intentLines: 24,
  /** Keep lines asked, from the newest landing by another intent. */
  keepLines: 8,
  /** Characters of a line put to the model and kept in a record. */
  lineChars: 400,
  /** Characters of a quote kept in a record. */
  quoteChars: 300,
  /** Characters of a path kept in a record. */
  pathChars: 300,
  /** Shortest quote that counts, whitespace collapsed. */
  minQuote: 8,
  /** Answers read from one reply. */
  answers: 64,
} as const;

/** One acceptance line put to the second opinion, numbered by its place in the list (from 1). */
export interface AcceptanceLine {
  kind: "intent" | "keep";
  text: string;
  /** Keep lines: the landing whose intent's acceptance list it comes from. */
  landingId?: Id;
}

/** The second opinion's answer for one numbered line, as read from its reply (decide/reflex.ts parseVerdict). */
export interface AcceptanceAnswer {
  line: number;
  verdict: AcceptanceVerdict;
  path?: string;
  quote?: string;
}

/** One file of the diff as the second opinion was shown it: its unified hunks, up to any cut (decide/reflex.ts secondOpinionDiff). */
export interface ShownFile {
  path: Path;
  hunks: string;
}

/** The newest landing by another intent on the files a change modifies, with that intent's acceptance list and source. */
export interface KeepSource {
  landingId: Id;
  intentId: Id;
  acceptance?: unknown;
  source?: IntentSource;
}

/** Intents whose acceptance lines the platform itself writes and checks by running the tests (repairs, megafile splits): never asked to quote. */
const PLATFORM_SOURCES: ReadonlySet<string> = new Set(["certify", "system"]);

/** Whitespace collapsed to single spaces, trimmed. */
export function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** The words that make an acceptance line an absence, as whole words in any case, and any contraction ending in "n't". */
const ABSENCE_WORDS = /\b(?:no|not|never|nothing|none|without|only|unchanged|untouched|cannot)\b|\b\w+n't\b/;

/**
 * Is an acceptance line phrased as an absence, saying what must NOT be there? True when the line contains, as a whole
 * word in any case, "no", "not", "never", "nothing", "none", "without", "only", "unchanged", "untouched" or "cannot", or a
 * contraction ending in "n't" (doesn't, isn't, won't). Nothing in a diff proves an absence, so a "met" for such a line
 * counts on the model's word (checkAcceptance); every other line is positive, and its "met" needs a quote found in the
 * diff. The rule is plain on purpose: a positive line that carries one of these words ("returns 404 when the slug does
 * not exist") is read as an absence too, and its "met" then rests on the model's word.
 */
export function isAbsence(line: string): boolean {
  return ABSENCE_WORDS.test(collapse(line).toLowerCase().replace(/[‘’]/g, "'"));
}

/** A line cut to `max` characters, marked with an ellipsis when cut. */
function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The non-empty lines of an acceptance list as stored (old or odd data gives none), one line each. */
function listLines(acceptance: unknown): string[] {
  if (!Array.isArray(acceptance)) return [];
  return acceptance.flatMap((x) => (typeof x === "string" && collapse(x) !== "" ? [collapse(x)] : []));
}

/**
 * The lines a change's second opinion answers: its intent's acceptance list (at most ACCEPTANCE_LIMITS.intentLines),
 * then the keep lines from `keep`. Null when the intent has no acceptance list, or certification or the colony wrote it
 * (their lines are checked by running the tests): the gate then keeps today's rule. Keep lines come only from an intent a
 * person, a rule or an agent wrote.
 */
export function acceptanceLines(intent: Pick<Intent, "acceptance" | "source"> | null | undefined, keep?: KeepSource | null): AcceptanceLine[] | null {
  if (!intent || PLATFORM_SOURCES.has(intent.source)) return null;
  const own = listLines(intent.acceptance);
  if (own.length === 0) return null;
  const lines: AcceptanceLine[] = own.map((text) => ({ kind: "intent", text: cut(text, ACCEPTANCE_LIMITS.lineChars) }));
  if (keep && !(keep.source && PLATFORM_SOURCES.has(keep.source))) {
    for (const text of listLines(keep.acceptance).slice(0, ACCEPTANCE_LIMITS.keepLines)) lines.push({ kind: "keep", text: cut(text, ACCEPTANCE_LIMITS.lineChars), landingId: keep.landingId });
  }
  return lines;
}

/** The lines put to the model: the intent's first ACCEPTANCE_LIMITS.intentLines, then the keep lines. */
export function askedLines(lines: readonly AcceptanceLine[]): AcceptanceLine[] {
  const own = lines.filter((l) => l.kind === "intent");
  return [...own.slice(0, ACCEPTANCE_LIMITS.intentLines), ...lines.filter((l) => l.kind === "keep")];
}

/**
 * The newest landing by another intent among `landed` (newest first, as the colony's why-context index gives them),
 * with that intent; null when there is none or it cannot be read. Only the newest counts: an older landing with an
 * acceptance list behind a newer one without is not used.
 */
export function keepSource(landed: ReadonlyArray<{ landingId: Id; intentId?: Id }> | null | undefined, intentId: Id, intentOf: (id: Id) => Pick<Intent, "acceptance" | "source"> | null): KeepSource | null {
  for (const l of landed ?? []) {
    if (!l?.intentId || l.intentId === intentId) continue;
    const other = intentOf(l.intentId);
    if (!other) return null;
    return { landingId: l.landingId, intentId: l.intentId, ...(other.acceptance !== undefined ? { acceptance: other.acceptance } : {}), source: other.source };
  }
  return null;
}

/** A verdict word as models write it: "met", "not met" ("not_met", "unmet", "Not Met"), else unclear. */
function verdictOf(v: unknown): AcceptanceVerdict {
  const s = typeof v === "string" ? v.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim() : "";
  if (s === "met" || s === "yes" || s === "pass") return "met";
  if (s === "not met" || s === "unmet" || s === "no" || s === "fail" || s === "notmet") return "not met";
  return "unclear";
}

/**
 * The per-line answers of a second opinion's reply (its `acceptance` field); undefined when there are none. An entry's
 * line is its `line` (a number or digits), else its place in the list; a reply whose first numbered entry is 0 numbers
 * from 0 and is read as such. Anything malformed is left out or read as unclear.
 */
export function parseAcceptance(x: unknown): AcceptanceAnswer[] | undefined {
  if (!Array.isArray(x)) return undefined;
  const entries = x.slice(0, ACCEPTANCE_LIMITS.answers).flatMap((raw, i) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const r = raw as Record<string, unknown>;
    const given = typeof r.line === "number" ? r.line : typeof r.line === "string" && /^\s*\d{1,3}\s*$/.test(r.line) ? Number(r.line) : null;
    return [{ r, n: given ?? i + 1, given: given !== null }];
  });
  // Only a reply whose first numbered entry is 0 numbers from 0: its numbers move up by one. An unnumbered entry is its place.
  const shift = entries.find((e) => e.given)?.n === 0 ? 1 : 0;
  const out: AcceptanceAnswer[] = [];
  for (const { r, n, given } of entries) {
    const line = given ? n + shift : n;
    if (!Number.isInteger(line) || line < 1) continue;
    const a: AcceptanceAnswer = { line, verdict: verdictOf(r.verdict) };
    if (typeof r.path === "string" && r.path.trim() !== "") a.path = r.path.trim().slice(0, 1_000);
    // A quote cut here is still found when the whole one is: what is kept is a prefix of it.
    if (typeof r.quote === "string" && r.quote.trim() !== "") a.quote = r.quote.slice(0, 1_000);
    out.push(a);
  }
  return out;
}

/**
 * A path as a model may write it, made plain: quotes and backticks around it, a leading "./" or "/", and the
 * diff header's " (modified, +3 -1)" after it are dropped.
 */
function plainPath(path: string): string {
  return path
    .trim()
    .replace(/^[`'"]+|[`'"]+$/g, "")
    .replace(/\s+\((?:added|deleted|modified|binary|unreadable)[^)]*\)\s*$/, "")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .trim();
}

/** The unified hunks of a file split into hunks, each as its lines without the "@@" header. */
function hunkLines(hunks: string): string[][] {
  const out: string[][] = [];
  let cur: string[] | null = null;
  for (const line of hunks.split("\n")) {
    if (line.startsWith("@@")) {
      cur = [];
      out.push(cur);
    } else if (cur) cur.push(line);
  }
  return out;
}

/**
 * Each hunk's new side as one text: its added ("+") and unchanged (" ") lines in order, each whitespace collapsed,
 * joined with a space, so a quote spanning consecutive lines is found too. Removed lines and markers are left out.
 */
function newSides(hunks: string): string[] {
  return hunkLines(hunks).map((lines) =>
    lines
      .filter((l) => l.startsWith("+") || l.startsWith(" "))
      .map((l) => collapse(l.slice(1)))
      .filter((l) => l !== "")
      .join(" "),
  );
}

/** Each hunk's removed lines, whitespace collapsed. */
function removedLines(hunks: string): string[] {
  return hunkLines(hunks).flatMap((lines) => lines.filter((l) => l.startsWith("-")).map((l) => collapse(l.slice(1))));
}

/** The forms of a quote the platform looks for: as written, and without the "+" diff markers a model may copy. */
function quoteForms(quote: string): string[] {
  const forms = [collapse(quote)];
  const lines = quote.split(/\r\n|\r|\n/).filter((l) => l.trim() !== "");
  if (lines.length > 0 && lines.every((l) => /^\s*\+/.test(l))) forms.push(collapse(lines.map((l) => l.replace(/^\s*\+/, "")).join("\n")));
  return [...new Set(forms)].filter((f) => f !== "");
}

/** Where a "met" answer's quote is: found (with the file and the form found), or why it does not count. */
export type QuoteCheck = { ok: true; path: Path; quote: string } | { ok: false; problem: string };

/**
 * Check one quote against the diff the model was shown: the named file must be one it was shown, and the quote
 * (whitespace collapsed, at least ACCEPTANCE_LIMITS.minQuote characters) must occur in the added and unchanged lines of
 * one of that file's hunks. A quote found only in removed lines, or nowhere, does not count. With `files` (the review
 * view, FT_REVIEW_VIEW: each changed file's text after the change), a quote found anywhere in the named file's text
 * after the change counts too.
 */
export function checkQuote(path: string | undefined, quote: string | undefined, shown: readonly ShownFile[], files?: ReadonlyMap<Path, string>): QuoteCheck {
  if (!path || plainPath(path) === "") return { ok: false, problem: "it named no file" };
  if (!quote || collapse(quote) === "") return { ok: false, problem: "it quoted no line" };
  const forms = quoteForms(quote);
  if (!forms.some((f) => f.length >= ACCEPTANCE_LIMITS.minQuote)) return { ok: false, problem: `its quote is shorter than ${ACCEPTANCE_LIMITS.minQuote} characters` };
  const named = plainPath(path);
  const file = shown.find((f) => f.path === named);
  const after = files?.get(named);
  if (!file && after === undefined) return { ok: false, problem: `${cut(collapse(named), 120)} is not a file of the diff it was shown` };
  if (file) {
    const sides = newSides(file.hunks);
    for (const f of forms) {
      if (f.length < ACCEPTANCE_LIMITS.minQuote) continue;
      if (sides.some((s) => s.includes(f))) return { ok: true, path: file.path, quote: f };
    }
  }
  // The review view: the file after the change, whole, checked against its text.
  if (after !== undefined) {
    const whole = collapse(after);
    const found = forms.find((f) => f.length >= ACCEPTANCE_LIMITS.minQuote && whole.includes(f));
    if (found) return { ok: true, path: named, quote: found };
    if (!file) return { ok: false, problem: `its quote is not in ${cut(collapse(named), 120)} after the change` };
  }
  if (!file) return { ok: false, problem: `${cut(collapse(named), 120)} is not a file of the diff it was shown` };
  const removed = removedLines(file.hunks);
  if (forms.some((f) => f.length >= ACCEPTANCE_LIMITS.minQuote && removed.some((r) => r.includes(f)))) return { ok: false, problem: `its quote is from a line the change removes from ${file.path}` };
  return { ok: false, problem: `its quote is not in the added or unchanged lines of ${file.path} it was shown` };
}

/**
 * Each acceptance line with what counts for it: the model's answer for its number, a "met" counted only when its quote
 * holds (checkQuote, `basis: "quote"`) or the line states an absence (isAbsence, `basis: "absence"`: on the model's word,
 * no quote needed), else unclear with the model's own answer kept as `said` and the problem in words. A line the model
 * did not answer, or was not asked (past the cap), is unclear. Only a line's first answer is read. `files` (the review view)
 * lets a quote be found in a changed file's whole text after the change (checkQuote).
 */
export function checkAcceptance(lines: readonly AcceptanceLine[], answers: readonly AcceptanceAnswer[] | undefined, shown: readonly ShownFile[], files?: ReadonlyMap<Path, string>): NoteAcceptance[] {
  const asked = askedLines(lines);
  const byLine = new Map<number, AcceptanceAnswer>();
  for (const a of answers ?? []) if (!byLine.has(a.line)) byLine.set(a.line, a);
  const number = new Map(asked.map((l, i) => [l, i + 1]));
  return lines.map((l) => {
    const out: NoteAcceptance = { kind: l.kind, line: l.text, verdict: "unclear", ...(l.landingId ? { landingId: l.landingId } : {}) };
    const n = number.get(l);
    if (n === undefined) {
      out.problem = `not asked: the second opinion answers at most ${ACCEPTANCE_LIMITS.intentLines} lines of an intent`;
      return out;
    }
    const a = byLine.get(n);
    if (!a) {
      out.problem = "the second opinion did not answer this line";
      return out;
    }
    if (a.path) out.path = a.path.slice(0, ACCEPTANCE_LIMITS.pathChars);
    if (a.quote) out.quote = collapse(a.quote).slice(0, ACCEPTANCE_LIMITS.quoteChars);
    if (a.verdict !== "met") {
      out.verdict = a.verdict;
      return out;
    }
    const found = checkQuote(a.path, a.quote, shown, files);
    if (found.ok) {
      out.verdict = "met";
      out.basis = "quote";
      out.path = found.path;
      out.quote = found.quote.slice(0, ACCEPTANCE_LIMITS.quoteChars);
    } else if (isAbsence(l.text)) {
      // Nothing in a diff proves an absence ("No other file changes"): the met counts on the model's word, and a quote
      // the platform could not find is not kept as evidence.
      out.verdict = "met";
      out.basis = "absence";
      delete out.path;
      delete out.quote;
    } else {
      out.said = "met";
      out.problem = found.problem;
    }
    return out;
  });
}

/** "line 2" (the second line of the intent's list) or "keep line 1" (the first keep line). */
function place(l: NoteAcceptance, lines: readonly NoteAcceptance[]): string {
  const n = lines.filter((x) => x.kind === l.kind).indexOf(l) + 1;
  return `${l.kind === "keep" ? "keep line" : "line"} ${n}`;
}

/** A line as reasons name it: `line 2 "…"`, or `keep line 1 "…" (from landing lnd_…)`. */
function named(l: NoteAcceptance, lines: readonly NoteAcceptance[]): string {
  return `${place(l, lines)} "${cut(l.line, 160)}"${l.kind === "keep" && l.landingId ? ` (from landing ${l.landingId})` : ""}`;
}

/**
 * What the model says it saw for a line it answered not met, when it named it: ` (it saw src/a.ts: "…")`; for a line
 * FireTrident checked itself (the review view), what it found: ` (checked by FireTrident: …)`; empty otherwise.
 */
function saw(l: NoteAcceptance): string {
  if (l.basis === "checked") return l.problem ? ` (checked by FireTrident: ${cut(l.problem, 240)})` : "";
  if (!l.quote) return "";
  return ` (it saw ${l.path ? `${l.path}: ` : ""}"${cut(l.quote, 120)}")`;
}

/** What the gate makes of the checked lines (decide/gate.ts L6, L7): plain sentences for its reasons. */
export interface AcceptanceGate {
  /** Lines answered not met (the intent's or keep lines): the change goes back naming them. */
  notMet?: string;
  /** Lines of the intent not shown met: the approval does not count and a person decides. */
  unclear?: string;
  /** Every line of the intent met: with a quote found in the diff, or on the model's word for a line stating an absence. */
  met?: string;
}

/**
 * The gate's reading of the checked lines; null when there are none (no acceptance list, or the flag is off). Keep lines
 * count only when answered not met: one met or unclear changes nothing.
 */
export function acceptanceGate(lines: readonly NoteAcceptance[] | undefined): AcceptanceGate | null {
  if (!Array.isArray(lines) || lines.length === 0) return null;
  const notMet = lines.filter((l) => l.verdict === "not met");
  const own = lines.filter((l) => l.kind === "intent");
  const unclear = own.filter((l) => l.verdict !== "met" && l.verdict !== "not met");
  const out: AcceptanceGate = {};
  if (notMet.length > 0) {
    const ownNot = notMet.filter((l) => l.kind === "intent");
    const keepNot = notMet.filter((l) => l.kind === "keep");
    const parts: string[] = [];
    if (ownNot.length > 0) parts.push(`acceptance not met: ${ownNot.map((l) => `${named(l, lines)}${saw(l)}`).join(", ")}; change it so it meets ${ownNot.length === 1 ? "that line" : "those lines"}, or escalate if the intent cannot be met as written`);
    if (keepNot.length > 0)
      parts.push(`it breaks what a recent landing by another intent met: ${keepNot.map((l) => `${named(l, lines)}${saw(l)}`).join(", ")}; keep what that landing did unless your intent says otherwise, and escalate if both cannot hold`);
    out.notMet = parts.join("; ");
  }
  if (unclear.length > 0) {
    const why = unclear.map((l) => `${named(l, lines)} (${l.problem ?? (l.said ? `answered ${l.said}` : "the second opinion answered unclear")})`).join(", ");
    out.unclear = `acceptance not shown met: ${why}; the second opinion's approval does not count, so a person decides`;
  }
  if (own.length > 0 && notMet.length === 0 && unclear.length === 0) {
    const count = `${own.length} line${own.length === 1 ? "" : "s"}`;
    // Lines met on the model's word (absences) are named, so a reader knows which lines the platform checked.
    const word = own.filter((l) => l.basis === "absence");
    // Lines FireTrident checked itself in the files (the review view, FT_REVIEW_VIEW) are named too.
    const checked = own.filter((l) => l.basis === "checked");
    const quoted = own.length - word.length - checked.length;
    out.met =
      checked.length > 0
        ? `every acceptance line is met (${count}): ${[
            ...(quoted > 0 ? [`${quoted} with a quote found in the diff`] : []),
            `${checked.length} checked by FireTrident in the files after the change (${checked.map((l) => place(l, lines)).join(", ")})`,
            ...(word.length > 0 ? [`${word.length} on the model's word (${word.map((l) => place(l, lines)).join(", ")} ${word.length === 1 ? "states" : "state"} an absence)`] : []),
          ].join(", ")}`
        : word.length === 0
          ? `every acceptance line is met, each with a quote found in the diff (${count})`
          : `every acceptance line is met (${count}): ${own.length - word.length} with a quote found in the diff, ${word.length} on the model's word (${word.map((l) => place(l, lines)).join(", ")} ${word.length === 1 ? "states" : "state"} an absence, so there is no changed line to quote)`;
  }
  return out;
}

/** The checked lines in one line for the evidence: `line 1 met: src/a.ts "…"; line 2 not met; keep line 1 unclear: …`. */
export function acceptanceDetail(lines: readonly NoteAcceptance[]): string {
  return lines
    .map((l) => {
      const head = `${place(l, lines)} ${l.verdict}`;
      if (l.basis === "checked") return `${head}: checked by FireTrident: ${l.verdict === "met" ? `${l.path ?? "?"}${l.quote ? ` ${cut(l.quote, 160)}` : ""}` : (l.problem ?? "")}`;
      if (l.verdict === "met") return l.basis === "absence" ? `${head}: on the model's word (it states an absence)` : `${head}: ${l.path ?? "?"} "${cut(l.quote ?? "", 120)}"`;
      if (l.problem) return `${head}: ${l.said ? `answered ${l.said} but ` : ""}${l.problem}`;
      return head;
    })
    .join("; ")
    .slice(0, 1_500);
}

const VERDICTS: ReadonlySet<string> = new Set(["met", "not met", "unclear"]);

/**
 * Checked lines as a lineage note keeps them, from a stored decision (old or odd data gives undefined): each entry with
 * a kind, a line and a verdict, its texts capped.
 */
export function noteAcceptance(x: unknown): NoteAcceptance[] | undefined {
  if (!Array.isArray(x)) return undefined;
  const out: NoteAcceptance[] = [];
  for (const raw of x.slice(0, ACCEPTANCE_LIMITS.intentLines + ACCEPTANCE_LIMITS.keepLines)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const r = raw as Record<string, unknown>;
    if ((r.kind !== "intent" && r.kind !== "keep") || typeof r.line !== "string" || typeof r.verdict !== "string" || !VERDICTS.has(r.verdict)) continue;
    const e: NoteAcceptance = { kind: r.kind, line: cut(collapse(r.line), ACCEPTANCE_LIMITS.lineChars), verdict: r.verdict as AcceptanceVerdict };
    if (typeof r.said === "string" && VERDICTS.has(r.said)) e.said = r.said as AcceptanceVerdict;
    if (r.basis === "quote" || r.basis === "absence" || r.basis === "checked") e.basis = r.basis;
    if (typeof r.path === "string" && r.path !== "") e.path = r.path.slice(0, ACCEPTANCE_LIMITS.pathChars);
    if (typeof r.quote === "string" && r.quote !== "") e.quote = collapse(r.quote).slice(0, ACCEPTANCE_LIMITS.quoteChars);
    if (typeof r.problem === "string" && r.problem !== "") e.problem = collapse(r.problem).slice(0, 300);
    if (typeof r.landingId === "string" && r.landingId !== "") e.landingId = r.landingId.slice(0, 100);
    out.push(e);
  }
  return out.length > 0 ? out : undefined;
}
