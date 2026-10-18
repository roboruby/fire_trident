import type { CheckResult, Id, Intent, NoteAcceptance, Path } from "@fire_trident/core";
import { revalidationEnabled } from "@fire_trident/core";
import { errorText } from "../colony/errors.ts";
import type { InnateFile } from "../colony/innate.ts";
import { acceptanceFor, type AcceptanceHost } from "./acceptance.ts";
import { fileDiff, type FileDiff } from "./diff.ts";
import type { GateVerdict } from "./gate.ts";
import { checkLine, parseLine, type FileText, type LineCheck, type LineClaims, type ModuleCache } from "./keepcheck.ts";
import { ACCEPTANCE_LIMITS, acceptanceGate, askedLines, checkAcceptance, type AcceptanceAnswer, type AcceptanceLine } from "./quotes.ts";
import { secondOpinionDiff, type ReflexInput } from "./reflex.ts";
import { REVIEW_FILE_CHARS, REVIEW_TOTAL_CHARS } from "./review.ts";

/**
 * The review view (FT_REVIEW_VIEW): review judges what it can see. Quoted acceptance (FT_QUOTED_ACCEPTANCE) asks the
 * second opinion to answer the intent's acceptance lines and the keep lines of the newest landing by another intent on the
 * files a change modifies, each "met" with a quote from the diff it was shown. A keep line is a guarantee about code the
 * change usually did not touch, so the diff often cannot show it, and a model that cannot find a line sends the change
 * back or to a person. With the view on for the colony:
 *
 * - Before any model, FireTrident checks the lines that name an export, a signature, a type or a file by reading the files
 *   after the change (decide/keepcheck.ts): the changed files, and the trunk files a line names. A line it proves is met,
 *   checked by FireTrident; a line it disproves sends the change back with the exact mismatch (rule A1, deterministic);
 *   a keep line that did not hold before the change either is unclear and not asked; the rest goes to the model as today.
 * - The second opinion is asked only the lines left open, and when there are any it sees each changed file whole (every
 *   line after the change, with what the change removed) wherever the file fits the review view's budgets (24,000
 *   characters a file, 60,000 in all), so a line in an untouched region is visible; a file that does not fit is shown as
 *   today. What the view shows of the change never drops below what the plain diff showed: coverage is the same.
 * - A "met" counts with a quote found in the changed file's text after the change, not only in the lines shown.
 * - The second opinion's receipt digests the diff text it was actually given (decide/receipt.ts promptShown).
 *
 * Off (absent), every change is reviewed exactly as before.
 */

/** The rule of a change a line FireTrident disproved sent back. */
export const VIEW_RULE = "A1 acceptance disproven";
/** The evidence check's name (FireTrident's own: core answerable reads the "deterministic: " prefix). */
export const VIEW_CHECK = "deterministic: acceptance lines";
/** Trunk files read for the lines of one change, at most. */
const MAX_TRUNK_READS = 8;
/** How long the trunk reads may take together before the lines that name them are left to the model. */
const TRUNK_WAIT_MS = 5_000;
/** Texts larger than this are not read for claims (the innate checks read no text above 512 KB either). */
const MAX_TEXT = 512 * 1024;
/** Characters of what FireTrident found kept on a line's record. */
const FOUND_CHARS = 300;

/** Is the review view on for this colony? `setting` is FT_REVIEW_VIEW: "on", a comma-separated list of colony ids, or absent / "off". */
export function reviewViewEnabled(setting: string | undefined, colonyId: Id): boolean {
  return revalidationEnabled(setting, colonyId);
}

/** What the view needs from the colony: the flags, the keep lines' lookup, and the trunk's files. */
export interface ReviewViewHost extends AcceptanceHost {
  env: { FT_REVIEW_VIEW?: string; FT_QUOTED_ACCEPTANCE?: string };
  trunk(): { readFile(path: Path): Promise<string | null> };
}

/** What the view reads of one change. */
export interface ReviewViewInput {
  intent: Intent | null;
  /** The whole change (the innate checks' files): the texts each line is checked in, and quotes are looked for in. */
  files: readonly InnateFile[];
  /** What the model layers see (a reproduction's residual, else the whole change): keep lines come from these files, and the view is built from them. */
  view: readonly InnateFile[];
  /** Their review diffs, as the model layers are shown them without the view. */
  diffs: readonly FileDiff[];
  vaccine: boolean;
}

/** The view of one change. */
export interface ReviewView {
  /** Every acceptance and keep line, in order (decide/acceptance.ts acceptanceFor). */
  lines: AcceptanceLine[];
  /** The evidence check: each line FireTrident settled, and what is left to the model layers. */
  check: CheckResult;
  /** The reason a line FireTrident disproved sends the change back with (see viewReturn); absent when none did. */
  back?: string;
  /** The changed files the second opinion sees whole (when it is asked). */
  whole: Path[];
  /** The second opinion's input from the one the reflex read: the lines left open, the files whole where they fit, the settled lines as facts. */
  input(x: ReflexInput): ReflexInput;
  /** Every line as it counts once the second opinion answered (`answers`, its per-line answers): settled ones as FireTrident found them. */
  accepted(answers: readonly AcceptanceAnswer[] | undefined): NoteAcceptance[];
}

/** The gate's verdict for a change a line FireTrident disproved sent back: a deterministic return under VIEW_RULE. */
export function viewReturn(reason: string, was: GateVerdict): GateVerdict {
  return { action: "return", layer: "deterministic", p: 1, rule: VIEW_RULE, reasons: [reason], detectors: ["acceptance:not-met"], damage: was.damage, confirmations: [], confidence: was.confidence, risk: was.risk };
}

/** `p`, or a rejection once `ms` have passed. */
async function within<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`the trunk did not answer within ${ms / 1000} s`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** A file's text as the checks read it: absent, unreadable (undefined) or too large to read. */
function readable(text: string | null | undefined): FileText {
  if (text === null || text === undefined) return text;
  return text.length > MAX_TEXT ? undefined : text;
}

/**
 * The texts the parsed lines name: a changed file's after and before (absent when the change adds or deletes it, unknown
 * when it is binary, too large or unreadable), a trunk file's current text for both (at most MAX_TRUNK_READS of them,
 * within TRUNK_WAIT_MS; unknown past that or when the read fails).
 */
async function lineTexts(host: ReviewViewHost, parsed: ReadonlyArray<LineClaims | null>, files: readonly InnateFile[]): Promise<Map<Path, { after: FileText; before: FileText }>> {
  const out = new Map<Path, { after: FileText; before: FileText }>();
  const changed = new Map(files.map((f) => [f.path, f]));
  const trunk: Path[] = [];
  for (const p of parsed) {
    if (!p || out.has(p.path) || trunk.includes(p.path)) continue;
    const f = changed.get(p.path);
    if (f) {
      const after = f.afterBlob === null ? null : f.binary || f.unreadable ? undefined : (f.after ?? undefined);
      const before = f.beforeBlob === null ? null : f.binary ? undefined : (f.before ?? undefined);
      out.set(p.path, { after: readable(after), before: readable(before) });
    } else trunk.push(p.path);
  }
  const read = new Map<Path, FileText>();
  let open = true;
  const asked = trunk.slice(0, MAX_TRUNK_READS);
  try {
    await within(
      Promise.all(
        asked.map(async (path) => {
          let text: FileText;
          try {
            text = readable(await host.trunk().readFile(path));
          } catch (err) {
            console.warn(`review view: trunk file ${path} not read: ${errorText(err)}`);
            text = undefined;
          }
          if (open) read.set(path, text);
        }),
      ),
      TRUNK_WAIT_MS,
    );
  } catch (err) {
    console.warn(`review view: trunk files not read: ${errorText(err)}`);
  }
  open = false;
  for (const path of trunk) {
    const text = read.get(path);
    out.set(path, { after: text, before: text });
  }
  return out;
}

/**
 * The diffs with each modified file shown whole (every line after the change, and what it removed) while it fits: its
 * whole rendering within REVIEW_FILE_CHARS, the second opinion's diff text within REVIEW_TOTAL_CHARS, and what that text
 * shows (its coverage) unchanged. Files in `first` are tried first. A view that was already cut is left as it is.
 */
export function wholeFileDiffs(diffs: readonly FileDiff[], files: ReadonlyArray<Pick<InnateFile, "path" | "before" | "after" | "binary" | "unreadable">>, first: ReadonlySet<Path> = new Set()): { diffs: FileDiff[]; whole: Path[] } {
  const out = [...diffs];
  const was = secondOpinionDiff(out);
  if (!was.coverage.complete) return { diffs: out, whole: [] };
  const byPath = new Map(files.map((f) => [f.path, f]));
  const order = out.map((_, i) => i).sort((a, b) => Number(first.has(out[b]!.path)) - Number(first.has(out[a]!.path)) || a - b);
  const whole: Path[] = [];
  let length = was.text.length;
  for (const i of order) {
    const d = out[i]!;
    const f = byPath.get(d.path);
    if (d.status !== "modified" || !f || f.before === null || f.after === null || f.binary || f.unreadable) continue;
    // Its whole rendering is longer than the file: one longer than the budget never fits.
    if (f.after.length > REVIEW_FILE_CHARS) continue;
    const full = fileDiff(d.path, f.before, f.after, { maxChars: REVIEW_FILE_CHARS, context: Number.MAX_SAFE_INTEGER });
    if (full.truncated || full.hunks === d.hunks) continue;
    if (length - d.hunks.length + full.hunks.length > REVIEW_TOTAL_CHARS) continue;
    const next = [...out];
    next[i] = full;
    const now = secondOpinionDiff(next);
    if (!now.coverage.complete || now.coverage.filesShown !== was.coverage.filesShown) continue;
    out[i] = full;
    length = now.text.length;
    whole.push(d.path);
  }
  return { diffs: out, whole };
}

/** A line cut to `max` characters. */
function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** One line as FireTrident settled it, for the decision and the note; null when it is left to the model. */
function settledLine(l: AcceptanceLine, c: LineCheck | null): NoteAcceptance | null {
  if (!c || c.state === "open") return null;
  const base: NoteAcceptance = { kind: l.kind, line: l.text, verdict: "unclear", basis: "checked", path: c.path, ...(l.landingId ? { landingId: l.landingId } : {}) };
  if (c.state === "met") return { ...base, verdict: "met", ...(c.found ? { quote: cut(c.found, ACCEPTANCE_LIMITS.quoteChars) } : {}) };
  if (c.state === "broken") return { ...base, verdict: "not met", problem: cut(c.found, FOUND_CHARS) };
  return { ...base, problem: cut(`it did not hold before this change either: ${c.found}`, FOUND_CHARS) };
}

/** "line 2" or "keep line 1", by a line's place among its kind. */
function placeOf(l: AcceptanceLine, lines: readonly AcceptanceLine[]): string {
  const n = lines.filter((x) => x.kind === l.kind).indexOf(l) + 1;
  return `${l.kind === "keep" ? "keep line" : "line"} ${n}`;
}

/**
 * The review view of one change (see the module comment); null when FT_REVIEW_VIEW does not cover its colony or it has no
 * acceptance lines to check (quoted acceptance off, no acceptance list, a vaccine).
 */
export async function reviewViewFor(host: ReviewViewHost, x: ReviewViewInput): Promise<ReviewView | null> {
  let colonyId: Id;
  try {
    colonyId = host.colony().id;
  } catch {
    return null;
  }
  if (!reviewViewEnabled(host.env.FT_REVIEW_VIEW, colonyId)) return null;
  const lines = acceptanceFor(host, x.intent, x.view, x.vaccine);
  if (!lines) return null;
  const t0 = Date.now();
  const parsed = lines.map((l) => parseLine(l.text));
  const texts = await lineTexts(host, parsed, x.files);
  const cache: ModuleCache = new Map();
  const checks = lines.map((l, i): LineCheck | null => {
    const p = parsed[i];
    const t = p ? texts.get(p.path) : undefined;
    if (!p || !t) return null;
    try {
      return checkLine(p, l.kind, t.after, t.before, cache);
    } catch (err) {
      // A reader failure never decides a line: it goes to the model as before.
      console.warn(`review view: line not checked: ${errorText(err)}`);
      return null;
    }
  });
  const settled = new Map<AcceptanceLine, NoteAcceptance>();
  lines.forEach((l, i) => {
    const s = settledLine(l, checks[i] ?? null);
    if (s) settled.set(l, s);
  });
  const ask = lines.filter((l) => !settled.has(l));
  const askedOrder = askedLines(ask);

  // A line FireTrident disproved sends the change back, named as the gate names lines (L6).
  const all: NoteAcceptance[] = lines.map((l) => settled.get(l) ?? { kind: l.kind, line: l.text, verdict: "unclear" });
  const back = all.some((a) => a.verdict === "not met") ? acceptanceGate(all)?.notMet : undefined;

  // The second opinion sees whole files only when it has lines to answer, the files those lines name first.
  const named = new Set(x.view.map((f) => f.path).filter((path) => ask.some((l) => l.text.includes(path))));
  const view = ask.length > 0 ? wholeFileDiffs(x.diffs, x.view, named) : { diffs: [...x.diffs], whole: [] };
  const after = new Map<Path, string>();
  for (const f of x.files) if (f.afterBlob !== null && f.after !== null) after.set(f.path, f.after);

  // What the second opinion is told of the settled lines and of the parts of open lines FireTrident checked.
  const facts: string[] = [];
  lines.forEach((l, i) => {
    const s = settled.get(l);
    const c = checks[i];
    if (s?.verdict === "met") facts.push(`${l.kind === "keep" ? "keep line" : "acceptance line"} met, checked by FireTrident in the files after the change (not asked again): "${cut(l.text, 200)}" (${s.path}: ${cut(s.quote ?? "", 200)})`);
    else if (!s && c && c.held.length > 0) {
      const n = askedOrder.indexOf(l) + 1;
      if (n > 0) facts.push(`line ${n} above: FireTrident checked in the files after the change that ${cut(c.held.join("; "), 300)}; judge the rest of the line`);
    }
  });
  const note = [
    ...(settled.size > 0 ? ["FireTrident checked some acceptance lines itself by reading the files after the change (an export, a signature, a type, a file): the facts say which and what it found, and those lines are not asked."] : []),
    ...(view.whole.length > 0
      ? ["Files that fit the review limit are shown whole: every line of the file after the change, unchanged lines starting with a space, added ones with +, removed ones with -. A line the change did not touch is shown too and can be quoted."]
      : []),
    ...(ask.some((l) => l.kind === "keep") ? ["A keep line you cannot check either way is unclear, and that alone is no reason to return the change."] : []),
  ].join("\n");

  const detail = [
    ...lines.map((l, i) => {
      const s = settled.get(l);
      const where = placeOf(l, lines);
      if (s?.verdict === "met") return `${where} met: ${s.quote ?? s.path ?? ""}`;
      if (s?.verdict === "not met") return `${where} not met: ${s.problem ?? ""}`;
      if (s) return `${where} unclear: ${s.problem ?? ""}`;
      const held = checks[i]?.held ?? [];
      return `${where} left to the model layers${held.length > 0 ? ` (holds: ${cut(held.join("; "), 200)})` : ""}`;
    }),
    ...(view.whole.length > 0 ? [`the second opinion, if asked, sees ${view.whole.join(", ")} whole`] : []),
  ]
    .join("; ")
    .slice(0, 1_500);
  const check: CheckResult = { name: VIEW_CHECK, ok: back === undefined, ms: Date.now() - t0, detail };

  return {
    lines,
    check,
    ...(back ? { back } : {}),
    whole: view.whole,
    input(input: ReflexInput): ReflexInput {
      const { acceptance: _asked, facts: given, viewNote: _note, ...rest } = input;
      const allFacts = [...(given ?? []), ...facts];
      return {
        ...rest,
        diffs: view.diffs,
        ...(ask.length > 0 ? { acceptance: ask } : {}),
        ...(allFacts.length > 0 ? { facts: allFacts } : {}),
        ...(note ? { viewNote: note } : {}),
      };
    },
    accepted(answers: readonly AcceptanceAnswer[] | undefined): NoteAcceptance[] {
      const judged = ask.length > 0 ? checkAcceptance(ask, answers, secondOpinionDiff(view.diffs).shown, after) : [];
      return lines.map((l) => settled.get(l) ?? judged[ask.indexOf(l)]!);
    },
  };
}
