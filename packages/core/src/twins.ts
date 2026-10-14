import { pathsOverlap } from "./residual.ts";
import type { Id, IntentStatus, Millis, Path } from "./types.ts";

/**
 * Twin intents. When many agents and people declare intents in one colony, the same need gets declared twice in
 * different words ("Add rate limiting to /api/links", "Rate-limit the links API"): two agents then take the same work
 * and one of the two changes comes back. A new intent is a twin of one the colony has when both signals hold:
 * - its title's words score at least TWINS.minScore against the other's: Jaccard over the normalized words (lowercase,
 *   punctuation, stop words and the verbs that only say "do it" dropped, a light stem so "limiting" and "limit" meet).
 *   A title that asks to take something away (remove, delete, revert, ...) never matches one that does not;
 * - their footprints overlap: a path in both, or a glob or directory of one that covers an entry of the other.
 * Only intents still open, claimed or proposed count, and those landed within TWINS.landedMs. Pure and deterministic:
 * the caller passes the time. The worker's colony/twins.ts (FT_TWINS) picks the candidates and answers the declare.
 */

/** The thresholds of the twin check. */
export interface TwinThresholds {
  /** The title score (Jaccard of the normalized words) at or above which two titles ask for the same thing. */
  minScore: number;
  /** How long a landed intent still counts: work declared again just after it landed is still a twin. */
  landedMs: number;
  /** Matches a check returns at most, best first. */
  maxSimilar: number;
}

/** The thresholds in one place (the check uses these unless a caller passes others). */
export const TWINS: Readonly<TwinThresholds> = {
  /**
   * Strict: the same words in another order, with other function words, score 1; one extra word on one side of a
   * four-word title scores 0.8; one word swapped for another stays below it until titles reach nine words.
   */
  minScore: 0.8,
  /** Half an hour. */
  landedMs: 30 * 60_000,
  maxSimilar: 5,
};

/** An intent the colony has, as the twin check compares it. */
export interface TwinCandidate {
  id: Id;
  title: string;
  status: IntentStatus;
  footprint: readonly Path[];
  /** When a landed intent landed. A landed intent without it never counts. */
  landedAt?: Millis;
}

/** An intent a new one is a twin of: its title score, rounded to two places, says how close the titles are. */
export interface TwinMatch {
  id: Id;
  title: string;
  status: IntentStatus;
  score: number;
}

/** A title's normalized words, each once, and whether it asks to take something away. */
export interface TitleWords {
  words: string[];
  removal: boolean;
}

/** Function words: they say nothing about what an intent asks. Matched before stemming. */
const STOP_WORDS: ReadonlySet<string> = new Set([
  "a", "an", "the", "and", "or", "but", "nor", "to", "for", "of", "in", "on", "at", "by", "with", "from", "into", "onto",
  "as", "via", "per", "than", "then", "so", "if", "when", "while", "is", "are", "was", "were", "be", "been", "being",
  "it", "its", "this", "that", "these", "those", "there", "here", "we", "our", "us", "you", "your", "i", "my", "me",
  "they", "them", "their", "all", "any", "some", "each", "every", "just", "only", "also", "too", "now", "please",
  "should", "must", "can", "could", "will", "would", "may", "might", "shall", "do", "does", "did", "has", "have", "had",
  "about", "after", "before", "during",
  // What punctuation leaves of "user's" and "don't".
  "s", "t",
]);

/** Verbs that only say "do it": "Add rate limiting" and "Rate limiting" ask the same. Matched after stemming. */
const DO_IT: ReadonlySet<string> = new Set(["add", "implement", "implementation", "introduce", "make", "ensure", "enable", "new"].map(stem));

/** Words that ask to take something away: a title with one never matches a title without one. Matched after stemming. */
const REMOVAL: ReadonlySet<string> = new Set(
  ["remove", "removal", "delete", "deletion", "drop", "disable", "revert", "undo", "rollback", "eliminate", "deprecate", "strip"].map(stem),
);

/**
 * A light English stem: plural endings, -ing, -ed and -er come off, -ation and -ization become -ate and -ize, and a
 * final e goes, so "limiting", "limited", "limits", "limiter" and "limit" meet, and so do "validation" and
 * "validate". Words of three letters or fewer, and words with a digit, stay as they are.
 */
export function stem(word: string): string {
  let w = word;
  if (w.length <= 3 || /\d/.test(w)) return w;
  // Plurals.
  if (w.endsWith("sses")) w = w.slice(0, -2);
  else if (w.endsWith("ies") || w.endsWith("ied")) w = `${w.slice(0, -3)}y`;
  else if (w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us") && !w.endsWith("is")) w = w.slice(0, -1);
  // -ing and -ed, when what is left has a vowel and three letters ("string", "need" and "doing" stay).
  for (const suffix of ["ing", "ed"]) {
    if (!w.endsWith(suffix) || w.endsWith("eed")) continue;
    const base = w.slice(0, -suffix.length);
    if (base.length >= 3 && /[aeiouy]/.test(base)) w = undouble(base);
    break;
  }
  // -er, when four letters are left: "limiter" is "limit" and "logger" is "log"; "user" and "order" stay.
  if (w.endsWith("er") && w.length - 2 >= 4) w = undouble(w.slice(0, -2));
  // Word-forming endings, when three letters are left before them.
  if (w.endsWith("ization") && w.length - 7 >= 3) w = `${w.slice(0, -7)}ize`;
  else if (w.endsWith("ation") && w.length - 5 >= 3) w = `${w.slice(0, -5)}ate`;
  if (w.endsWith("e") && w.length > 3) w = w.slice(0, -1);
  return w;
}

/** "mapp" is "map" and "logg" is "log"; "add", "install", "pass" and "buzz" stay. */
function undouble(w: string): string {
  return w.length > 3 && /([^aeiouylsz])\1$/.test(w) ? w.slice(0, -1) : w;
}

/** A title's words as the check compares them: a set, and whether it asks to take something away. */
interface Normalized {
  words: ReadonlySet<string>;
  removal: boolean;
}

/** The longest title a person or an agent may declare: past it, a title (an old or generated one) is compared by its start. */
const TITLE_CHARS = 500;
const TITLE_CACHE_LIMIT = 1_024;
const titleCache = new Map<string, Normalized>();

/** Normalize a title (memoized: a colony compares the same titles on every declare). */
function normalized(raw: string): Normalized {
  const title = raw.length > TITLE_CHARS ? raw.slice(0, TITLE_CHARS) : raw;
  const hit = titleCache.get(title);
  if (hit) return hit;
  const words = new Set<string>();
  let removal = false;
  for (const token of title.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (token === "" || STOP_WORDS.has(token)) continue;
    const w = stem(token);
    if (DO_IT.has(w)) continue;
    if (REMOVAL.has(w)) removal = true;
    else words.add(w);
  }
  const out: Normalized = { words, removal };
  if (titleCache.size >= TITLE_CACHE_LIMIT) titleCache.clear();
  titleCache.set(title, out);
  return out;
}

/**
 * A title's normalized words (lowercase, punctuation, stop words and do-it verbs dropped, stemmed), each once in
 * order, and whether it asks to take something away.
 */
export function titleWords(title: string): TitleWords {
  const n = normalized(title);
  return { words: [...n.words], removal: n.removal };
}

/** Jaccard of two normalized titles; 0 when either has no words or only one asks to take something away. */
function jaccard(x: Normalized, y: Normalized): number {
  if (x.removal !== y.removal || x.words.size === 0 || y.words.size === 0) return 0;
  const [small, large] = x.words.size <= y.words.size ? [x.words, y.words] : [y.words, x.words];
  let shared = 0;
  for (const w of small) if (large.has(w)) shared++;
  return shared / (x.words.size + y.words.size - shared);
}

/**
 * How much two titles ask for the same thing, 0 to 1: the Jaccard score of their normalized words (titleWords). 0 when
 * either has no words left, or when one asks to take something away and the other does not.
 */
export function titleScore(a: string, b: string): number {
  return jaccard(normalized(a), normalized(b));
}

/** Pairs of entries compared past the exact-path lookup, at most; past it the footprints count as not overlapping. */
const MAX_PAIRS = 20_000;

/** A footprint entry that covers more than itself: a glob, or a directory with a trailing slash. */
function widens(entry: string): boolean {
  return entry.endsWith("/") || /[*?{]/.test(entry);
}

/** An entry as the colony keeps it: trimmed, without a leading "./". */
function entryOf(raw: string): string {
  let e = raw.trim();
  while (e.startsWith("./")) e = e.slice(2);
  return e;
}

/**
 * Whether two footprints overlap: a path in both, or a glob or directory (trailing "/") of one that covers an entry of
 * the other, or two globs one of which covers the other (pathsOverlap). Exact paths are compared by lookup; the pairs
 * with a glob or directory are compared one by one, at most MAX_PAIRS of them, and past that the answer is no: the
 * check fails open, toward declaring the intent as before.
 */
export function footprintsOverlap(a: readonly string[], b: readonly string[]): boolean {
  const left = a.map(entryOf).filter((e) => e !== "");
  const right = b.map(entryOf).filter((e) => e !== "");
  const exact = new Set(right.filter((e) => !widens(e)));
  for (const e of left) if (!widens(e) && exact.has(e)) return true;
  let pairs = 0;
  for (const e of left) {
    if (!widens(e)) continue;
    for (const f of right) {
      if (++pairs > MAX_PAIRS) return false;
      if (pathsOverlap(e, f)) return true;
    }
  }
  for (const f of right) {
    if (!widens(f)) continue;
    for (const e of left) {
      // Glob against glob was compared above.
      if (widens(e)) continue;
      if (++pairs > MAX_PAIRS) return false;
      if (pathsOverlap(f, e)) return true;
    }
  }
  return false;
}

const LIVE: ReadonlySet<IntentStatus> = new Set<IntentStatus>(["open", "claimed", "proposed"]);

/** Whether an intent counts for the twin check at `now`: open, claimed or proposed, or landed within landedMs. */
export function twinEligible(c: Pick<TwinCandidate, "status" | "landedAt">, now: Millis, thresholds: TwinThresholds = TWINS): boolean {
  if (LIVE.has(c.status)) return true;
  return c.status === "landed" && typeof c.landedAt === "number" && Number.isFinite(c.landedAt) && now - c.landedAt <= thresholds.landedMs;
}

/**
 * The intents a newly declared one is a twin of, best first, at most maxSimilar: each still counts (twinEligible), its
 * title scores at least minScore against the new title (titleScore), and its footprint overlaps the new one
 * (footprintsOverlap). Best is the highest score, then open, claimed or proposed before landed, then the order of
 * `candidates`. Empty when the new title has no words left to compare.
 */
export function findTwins(
  declared: { title: string; footprint: readonly string[] },
  candidates: readonly TwinCandidate[],
  now: Millis,
  thresholds: TwinThresholds = TWINS,
): TwinMatch[] {
  const mine = normalized(declared.title);
  if (mine.words.size === 0) return [];
  const found: Array<{ match: TwinMatch; score: number; live: boolean; order: number }> = [];
  candidates.forEach((c, order) => {
    if (!twinEligible(c, now, thresholds)) return;
    const score = jaccard(mine, normalized(c.title));
    if (score < thresholds.minScore || !footprintsOverlap(declared.footprint, c.footprint)) return;
    found.push({ match: { id: c.id, title: c.title, status: c.status, score: Math.round(score * 100) / 100 }, score, live: LIVE.has(c.status), order });
  });
  found.sort((x, y) => y.score - x.score || Number(y.live) - Number(x.live) || x.order - y.order);
  return found.slice(0, Math.max(0, thresholds.maxSimilar)).map((f) => f.match);
}
