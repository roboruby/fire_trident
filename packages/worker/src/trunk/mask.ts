import type { LineageNote } from "@fire_trident/core";
import { PRIVATE_KEY_BEGIN, PRIVATE_KEY_END, looksLikeSecret } from "../decide/danger.ts";

/**
 * Lineage notes are public (GET /why, and plain git under refs/notes/firetrident), and they carry
 * free text that agents and people wrote: intents' titles and whys, an agent's "not verified"
 * statement, check details, directives and status notes, review questions and answers. Before a note
 * is written, every secret-looking part of that text is replaced with MASKED, as found by the danger
 * scanner's secret detector (decide/danger.ts looksLikeSecret), so no pattern is kept twice. Ids,
 * agents, read and write sets and revalidated paths are left as they are. Pure: no I/O.
 */

/** What replaces each secret-looking part. */
export const MASKED = "[masked]";
/** Most words one masked run spans: a credential name, an operator and a quoted value, or a PEM header line. */
const RUN_WORDS = 6;
/** Longest run of several words tested together. */
const RUN_CHARS = 600;
/** Longest text the detector reads at once, and the step between the slices of a longer one. */
const SLICE_CHARS = 512;
const SLICE_STEP = 256;
/** Text shorter than this holds nothing the secret detector finds. */
const MIN_CHARS = 8;
/** Nesting followed into a note's free text at most (notes are a few levels deep). */
const MAX_DEPTH = 32;

/**
 * Whether the secret detector flags `text`, reading a long text in overlapping slices. Every pattern
 * that matters here spans far less than a slice, and the detector's time grows faster than the length
 * it reads (a crafted run of word characters), so slices keep agent text from stalling the trunk writer.
 */
function flagged(text: string): boolean {
  if (text.length <= SLICE_CHARS) return looksLikeSecret(text);
  for (let at = 0; ; at += SLICE_STEP) {
    if (looksLikeSecret(text.slice(at, at + SLICE_CHARS))) return true;
    if (at + SLICE_CHARS >= text.length) return false;
  }
}

/**
 * One line with its secret-looking parts masked. When the detector flags the line, each shortest run
 * of words (up to RUN_WORDS) that it flags on its own is replaced with MASKED, scanning left to right;
 * a line still flagged after that (two far-apart parts that are only a secret together, such as a log
 * call and a credential's name) is masked whole.
 */
function maskLine(line: string): string {
  if (line.length < MIN_CHARS || !flagged(line)) return line;
  // Words sit at the even indexes, the whitespace between them at the odd ones.
  const parts = line.split(/(\s+)/);
  const words: number[] = [];
  for (let i = 0; i < parts.length; i += 2) if (parts[i] !== "") words.push(i);
  const runs: Array<[number, number]> = [];
  let from = 0;
  for (let end = 0; end < words.length; end++) {
    for (let n = 1; n <= RUN_WORDS && end - n + 1 >= from; n++) {
      const start = end - n + 1;
      const run = parts.slice(words[start], words[end]! + 1).join("");
      if (n > 1 && run.length > RUN_CHARS) break;
      if (flagged(run)) {
        runs.push([start, end]);
        from = end + 1;
        break;
      }
    }
  }
  let out = "";
  let at = 0;
  for (const [start, end] of runs) {
    out += `${parts.slice(at, words[start]).join("")}${MASKED}`;
    at = words[end]! + 1;
  }
  out += parts.slice(at).join("");
  return flagged(out) ? MASKED : out;
}

/**
 * `text` with every secret-looking part replaced with MASKED, line by line (see maskLine). A private
 * key block is masked from its BEGIN line through its END line, since the key material between them
 * matches no pattern on its own. Anything that is not a string comes back as it is.
 */
export function maskSecrets(text: string): string {
  if (typeof text !== "string" || text.length < MIN_CHARS) return text;
  let inKey = false;
  return text
    .split("\n")
    .map((line) => {
      if (inKey) {
        if (PRIVATE_KEY_END.test(line)) inKey = false;
        return MASKED;
      }
      const begin = PRIVATE_KEY_BEGIN.exec(line);
      if (!begin) return maskLine(line);
      const after = line.slice(begin.index);
      const end = PRIVATE_KEY_END.exec(after);
      if (!end) inKey = true;
      const rest = end ? after.slice(end.index + end[0].length) : "";
      return `${maskLine(line.slice(0, begin.index))}${MASKED}${maskLine(rest)}`;
    })
    .join("\n");
}

/** A JSON value with every string in it (through arrays and plain objects) passed through maskSecrets. */
export function maskStrings<T>(value: T, depth = 0): T {
  if (typeof value === "string") return maskSecrets(value) as T;
  if (value === null || typeof value !== "object" || depth >= MAX_DEPTH) return value;
  if (Array.isArray(value)) return value.map((v: unknown) => maskStrings(v, depth + 1)) as T;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskStrings(v, depth + 1)])) as T;
}

type NoteEntry = LineageNote["proposals"][number];

/**
 * One proposal of a note with its free text masked: the intent's title and why, who declared it and who approved its
 * rule, the model name, decisions, evidence, alternatives and provenance (model names).
 */
function maskEntry(e: NoteEntry): NoteEntry {
  const out: NoteEntry = { ...e, decisions: maskStrings(e.decisions), evidence: maskStrings(e.evidence) };
  if (e.intent) {
    out.intent = { ...e.intent, title: maskSecrets(e.intent.title), why: maskSecrets(e.intent.why) };
    if (typeof e.intent.createdBy === "string") out.intent.createdBy = maskSecrets(e.intent.createdBy);
    if (typeof e.intent.ruleApprovedBy === "string") out.intent.ruleApprovedBy = maskSecrets(e.intent.ruleApprovedBy);
  }
  if (typeof e.model === "string") out.model = maskSecrets(e.model);
  if (e.alternatives) out.alternatives = maskStrings(e.alternatives);
  if (e.provenance) out.provenance = maskStrings(e.provenance);
  return out;
}

/**
 * A lineage note ready to publish: every proposal's free text masked (maskEntry), and a system
 * commit's `system` block (an antibody's reason and question) too. Ids, paths and blob ids are kept.
 */
export function maskNote<N extends LineageNote>(note: N): N {
  const system = (note as { system?: unknown }).system;
  return {
    ...note,
    proposals: Array.isArray(note.proposals) ? note.proposals.map(maskEntry) : note.proposals,
    ...(system !== undefined ? { system: maskStrings(system) } : {}),
  };
}
