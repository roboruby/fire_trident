import {
  GOAL_CONFLICT_MIN_LINES,
  LineTrace,
  MERGE_MAX_EDITS,
  TWINS,
  blobId,
  findGoalConflict,
  findTwins,
  footprintsOverlap,
  mergeProblem,
  mergeText,
  removedLines,
  revalidationCandidate,
  textMergeCandidate,
  titleScore,
  titleWords,
  undoesEnough,
  validateProposal,
} from "@fire_trident/core";
import type { FileVersion, IntentFacts, OccResult, Path, RemovedOwner, Sha } from "@fire_trident/core";

/**
 * "Try the rules": the landing page's panel that runs the core's coordination checks in the visitor's browser
 * (TryIt.tsx). Each scene feeds a small editable example through the same pure function the trunk writer, the decide
 * stage or the colony calls, with the options the worker passes, and words what it decided as the colony would (the
 * reasons of trunk/plan.ts, decide/goalconflict.ts and colony/twins.ts). Nothing here reads or writes a server.
 */

/** A blob id as a reason shows it (the trunk writer's short form). */
export function short(blob: Sha | null): string {
  return blob === null ? "absent" : blob.slice(0, 10);
}

/** The stale paths of an OCC result, as the trunk writer's reason names them. */
export function staleDetail(stale: OccResult["stale"]): string {
  return stale.map((s) => `${s.path} (expected ${short(s.expected)}, trunk has ${short(s.actual)})`).join(", ");
}

/** "6", "6 and 12", "6, 12 and 20". */
function listText(items: readonly string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** "1 line", "5 lines". */
function count(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

// ---------------------------------------------------------------------------
// Scene 1: two agents edit one file from the same trunk (text merge and the insertion rule)
// ---------------------------------------------------------------------------

/** The file both agents edit. */
export const MERGE_PATH: Path = "src/limits.ts";

/** The version both agents started from. */
export const MERGE_BASE = `// Limits of the links API.
export const maxLinks = 100;
export const maxTitle = 80;

export function allowed(count: number): boolean {
  return count < maxLinks;
}
`;

/** The three versions of the file: what both started from, what the first agent landed (trunk now), what the second wrote. */
export interface MergeInputs {
  base: string;
  trunk: string;
  change: string;
}

/** A ready-made pair of edits, one per outcome. */
export interface MergePreset {
  id: "lines" | "insert" | "same";
  label: string;
  inputs: MergeInputs;
}

/** The presets: edits on different lines, insertions at one place, edits of the same line. The first is the default. */
export const MERGE_PRESETS: readonly MergePreset[] = [
  {
    id: "lines",
    label: "different lines",
    inputs: { base: MERGE_BASE, trunk: MERGE_BASE.replace("maxLinks = 100", "maxLinks = 200"), change: MERGE_BASE.replace("count < maxLinks", "count <= maxLinks") },
  },
  {
    id: "insert",
    label: "both insert at one place",
    inputs: {
      base: MERGE_BASE,
      trunk: MERGE_BASE.replace("maxTitle = 80;\n", "maxTitle = 80;\nexport const maxTags = 10;\n"),
      change: MERGE_BASE.replace("maxTitle = 80;\n", "maxTitle = 80;\nexport const maxNotes = 5;\n"),
    },
  },
  {
    id: "same",
    label: "the same line",
    inputs: { base: MERGE_BASE, trunk: MERGE_BASE.replace("maxLinks = 100", "maxLinks = 200"), change: MERGE_BASE.replace("maxLinks = 100", "maxLinks = 500") },
  },
];

/** What the trunk writer decides for the second change: it lands merged (with the text that lands), lands as it is, or goes back. */
export type MergeOutcome = { kind: "merged"; rule: "insertions" | null; text: string; sentence: string } | { kind: "lands"; sentence: string } | { kind: "back"; sentence: string };

/**
 * The second change, decided as the trunk writer decides it (trunk/plan.ts): read-set validation against trunk
 * (validateProposal), the text-merge pre-check (textMergeCandidate), whether the versions can be merged at all
 * (mergeProblem), then the line merge with the insertion rule on, as production runs it (mergeText with
 * `insertions`). A conflict goes back with the trunk writer's own reason, naming the hunk.
 */
export function mergeScene(i: MergeInputs): MergeOutcome {
  const base = blobId(i.base);
  const trunk = blobId(i.trunk);
  const theirs = blobId(i.change);
  const p = { readSet: [] as FileVersion[], writeSet: [{ path: MERGE_PATH, blob: theirs }] };
  const occ = validateProposal(p, (path) => (path === MERGE_PATH ? trunk : null), [{ path: MERGE_PATH, blob: base }]);
  if (occ.eligible) return { kind: "lands", sentence: `Lands as it is: trunk still holds the version the change started from (${MERGE_PATH} is blob ${short(base)}), so there is nothing to merge.` };
  const stale = `stale: ${staleDetail(occ.stale)}`;
  if (!textMergeCandidate(p, occ.stale)) return { kind: "back", sentence: `Goes back to its agent: ${stale}.` };
  const problem = mergeProblem(MERGE_PATH, [i.base, i.trunk, i.change]);
  if (problem !== null) return { kind: "back", sentence: `Goes back to its agent: ${stale}. Its versions are not text-merged (${problem}), so no hunk is named.` };
  const r = mergeText(i.base, i.trunk, i.change, undefined, { insertions: true });
  if (!r.clean) {
    if (r.limited) return { kind: "back", sentence: `Goes back to its agent: ${stale}. One side changed more than ${MERGE_MAX_EDITS.toLocaleString("en-US")} lines, so the sides were not compared.` };
    const n = r.conflicts;
    const conflict = `text merge of ${MERGE_PATH}: ${count(n, "conflicting hunk")}, at line${n === 1 ? "" : "s"} ${listText(r.lines.map(String))} of its base`;
    return { kind: "back", sentence: `Goes back to its agent: ${stale}; ${conflict}.` };
  }
  const moved = `trunk moved ${MERGE_PATH} (expected ${short(base)}, trunk has ${short(trunk)})`;
  if (r.rule === "insertions") {
    return {
      kind: "merged",
      rule: "insertions",
      text: r.text,
      sentence: `Lands by the insertion rule: ${moved}, and both agents only inserted lines at the same place of the base, so their union lands, trunk's lines first; the lineage note records the merge with rule "insertions".`,
    };
  }
  return {
    kind: "merged",
    rule: null,
    text: r.text,
    sentence: `Lands as a line-by-line merge: ${moved}, and the two edits touch different lines of the base, so the trunk writer lands the text below and records the merge in the landing and its lineage note.`,
  };
}

// ---------------------------------------------------------------------------
// Scene 2: a change read a file that moved (read-set validation)
// ---------------------------------------------------------------------------

/** The file the change read, the file it writes, and the names it imports from the one it read (its name assumption). */
export const READ_PATH: Path = "src/config.ts";
export const READ_WRITES: Path = "src/handler.ts";
export const READ_NAMES: readonly string[] = ["maxLinks"];

/** The version of the read file the change saw, and trunk's version now. */
export const READ_SEEN = `export const maxLinks = 100;
export const maxTitle = 80;
`;
export const READ_TRUNK = `${READ_SEEN}export const maxTags = 10;
`;

/** The written file's blobs: what the change started from (still on trunk) and what it wrote. */
const HANDLER_BASE = blobId("export function handler() {}\n");
const HANDLER_NEW = blobId(`import { maxLinks } from "./config.ts";\nexport function handler() {\n  return maxLinks;\n}\n`);

/** What the change read, what trunk has now, and whether trunk deleted the file instead. */
export interface ReadInputs {
  seen: string;
  trunk: string;
  deleted: boolean;
}

/** What read-set validation decides, and what import-name revalidation would do with a stale change (`lane`; null when it lands). */
export interface ReadOutcome {
  kind: "lands" | "back";
  sentence: string;
  lane: string | null;
}

/**
 * The change, decided as the trunk writer decides it (trunk/plan.ts): read-set validation against trunk
 * (validateProposal: every file it read must still have the blob it read, every file it writes the blob it started
 * from), and for a stale change the pre-check of import-name revalidation (revalidationCandidate: stale only through
 * files it read, each still on trunk and covered by a name assumption). The name and growth checks that follow read the
 * file's exports and statements in the worker, so the scene stops where they begin and says so.
 */
export function readScene(i: ReadInputs): ReadOutcome {
  const seen = blobId(i.seen);
  const now = i.deleted ? null : blobId(i.trunk);
  const p = { readSet: [{ path: READ_PATH, blob: seen }], writeSet: [{ path: READ_WRITES, blob: HANDLER_NEW }], nameAssumptions: [{ path: READ_PATH, names: [...READ_NAMES] }] };
  const index = (path: Path): Sha | null => (path === READ_PATH ? now : path === READ_WRITES ? HANDLER_BASE : null);
  const occ = validateProposal(p, index, [{ path: READ_WRITES, blob: HANDLER_BASE }]);
  if (occ.eligible) return { kind: "lands", sentence: `Lands: ${READ_PATH} is still the version the change read (blob ${short(seen)}), so its read set holds and the change goes on.`, lane: null };
  const names = listText([...READ_NAMES]);
  const lane = revalidationCandidate(p, occ.stale)
    ? `With import-name revalidation on, the trunk writer looks again, since the change is stale only through a file it read that is still on trunk and covered by a name assumption (it imports ${names} from it): the change lands if ${READ_PATH} still exports ${names} and only grew since the version it read, with new top-level declarations and every statement it read unchanged and in order. That growth check reads the file's statements in the worker, so it is not run here.`
    : `Import-name revalidation does not apply: the file it read is gone from trunk, so the change goes back as usual.`;
  return { kind: "back", sentence: `Goes back to its agent: stale: ${staleDetail(occ.stale)}.`, lane };
}

// ---------------------------------------------------------------------------
// Scene 3: goal conflict (a change that would undo what a recent landing did for another intent)
// ---------------------------------------------------------------------------

/** The file the three intents fight over, the landing that wrote it, and when (a fixed clock keeps the scene the same on every visit). */
export const GOAL_PATH: Path = "src/backend.ts";
export const GOAL_LANDING = "lnd_rust";
export const GOAL_NOW = 1_800_000_000_000;
export const GOAL_LANDED_AT = GOAL_NOW - 3 * 60_000;

/** The three intents: the one whose change landed, and the two that each move the backend elsewhere. */
export const GOAL_INTENTS = {
  int_rust: { title: "Move the order backend to Rust", why: "Ship the order backend as one static binary with no runtime to install, and keep its latency predictable under load." },
  int_go: { title: "Move the order backend to Go", why: "The team that will own the order backend writes Go, and it should build with one command on any machine." },
  int_ts: { title: "Move the order backend to TypeScript", why: "Share the order types with the web client and run the backend on the same runtime as everything else." },
} as const satisfies Record<string, IntentFacts>;

/** An intent of the scene, by id. */
export type GoalIntentId = keyof typeof GOAL_INTENTS;

/** src/backend.ts for one language: five lines name the language and depend on it; the rest is the same in every version. */
function backend(lang: string, runtime: string, build: string, start: string): string {
  return `// The order service backend: its language, and how it is built and started.
export const backendLanguage = "${lang}";
export const backendRuntime = "${runtime}";
export const buildCommand = "${build}";
export const startCommand = "${start}";
export const healthReport = "orders backend (${lang}) is up";

export const routes = ["/orders", "/orders/:id", "/health"];
`;
}

/** The three versions: what the Rust intent landed, and what the Go and TypeScript intents propose over it. */
export const GOAL_VERSIONS: Readonly<Record<GoalIntentId, string>> = {
  int_rust: backend("rust", "Rust 1.80, one static binary", "cargo build --release", "./target/release/orders"),
  int_go: backend("go", "Go 1.23", "go build ./cmd/orders", "./orders"),
  int_ts: backend("typescript", "TypeScript, run with its types stripped", "npm ci", "node src/server.ts"),
};

/** What the decide stage decides for one proposed version: it waits for a person, or goes on to review. */
export interface GoalOutcome {
  kind: "waits" | "goes-on";
  sentence: string;
}

/**
 * One proposed version of the file, checked as the decide stage checks it (decide/goalconflict.ts): the lines it
 * removes from the version at its base (removedLines), who wrote them, traced back through the landings that changed
 * the file (LineTrace; here one landing, which created the file), and the rule (findGoalConflict) with its own
 * reason. `landed` is the version the landing wrote, `proposed` the change's version, `intentId` the change's intent.
 */
export function goalScene(landed: string, proposed: string, intentId: GoalIntentId): GoalOutcome {
  const removed = removedLines(landed, proposed);
  if (removed.length === 0) return { kind: "goes-on", sentence: "Goes on to review: no line of an existing text file removed." };
  const trace = new LineTrace(landed, removed);
  trace.step(null);
  const owners: RemovedOwner[] = trace.owners().map((o) => ({ landingId: GOAL_LANDING, at: GOAL_LANDED_AT, rank: 0, path: GOAL_PATH, removed: o.removed, lines: o.lines, intentId: "int_rust", proposalId: "prp_rust" }));
  const intent = (id: string): IntentFacts | null => (Object.hasOwn(GOAL_INTENTS, id) ? GOAL_INTENTS[id as GoalIntentId] : null);
  const conflict = findGoalConflict({ intentId, owners, intent, now: GOAL_NOW });
  if (conflict) return { kind: "waits", sentence: `Waits for a person: ${conflict.reason}.` };
  const own = owners[0];
  const why = own && !undoesEnough(own.removed, own.lines) ? `: it removes ${own.removed} of the ${count(own.lines, "line")} landing ${GOAL_LANDING} wrote, fewer than ${GOAL_CONFLICT_MIN_LINES} or less than half` : "";
  return { kind: "goes-on", sentence: `Goes on to review: no recent landing of another intent undone, 1 file and ${count(removed.length, "removed line")} traced${why}.` };
}

// ---------------------------------------------------------------------------
// Scene 4: twin intents (the same need declared twice in different words)
// ---------------------------------------------------------------------------

/** The intent the colony already has, open, and the one being declared. */
export const TWIN_FIRST = { id: "int_m2x9k4q7", title: "Add rate limiting to /api/links", footprint: "src/links/**" } as const;
export const TWIN_SECOND = { title: "Rate-limit the links API", footprint: "src/links/handler.ts" } as const;

/** Two titles and two footprints (each a comma-separated list of paths, globs or directories). */
export interface TwinInputs {
  firstTitle: string;
  firstFootprint: string;
  title: string;
  footprint: string;
}

/** What the declare answers: the twin, so nothing is created, or a new intent. The score and the overlap say why. */
export interface TwinOutcome {
  kind: "caught" | "new";
  score: number;
  overlap: boolean;
  sentence: string;
}

/** A footprint as typed: paths split at commas and white space, empty entries dropped. */
export function footprintOf(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((e) => e.trim())
    .filter((e) => e !== "");
}

/**
 * The declaration, decided as the colony decides it (colony/twins.ts over core/twins.ts): findTwins with the colony's
 * one open intent as the candidate, with the thresholds production uses (TWINS). The title score (titleScore) and the
 * footprint overlap (footprintsOverlap) say why, and a caught twin reads as the declare's own note.
 */
export function twinScene(i: TwinInputs): TwinOutcome {
  const footprint = footprintOf(i.footprint);
  const candidate = { id: TWIN_FIRST.id, title: i.firstTitle, status: "open" as const, footprint: footprintOf(i.firstFootprint) };
  const score = Math.round(titleScore(i.title, i.firstTitle) * 100) / 100;
  const overlap = footprintsOverlap(footprint, candidate.footprint);
  const match = findTwins({ title: i.title, footprint }, [candidate], GOAL_NOW)[0];
  const shown = score.toFixed(2);
  if (match) {
    const note = `This looks like ${candidate.id} ${JSON.stringify(i.firstTitle.replace(/\s+/g, " ").trim())} (open): take that one, or declare again with force: true if yours is different work.`;
    return { kind: "caught", score, overlap, sentence: `Caught: the titles score ${shown} (at least ${TWINS.minScore}) and the footprints overlap, so nothing is created. ${note}` };
  }
  const mine = titleWords(i.title);
  const why =
    mine.words.length === 0
      ? "the title has no words left to compare once function words are dropped"
      : titleWords(i.firstTitle).words.length === 0
        ? "the other title has no words left to compare once function words are dropped"
        : mine.removal !== titleWords(i.firstTitle).removal
          ? "the titles score 0, since one asks to take something away and the other does not"
          : score < TWINS.minScore
            ? `the titles score ${shown}, below ${TWINS.minScore}`
            : `the titles score ${shown}, but the footprints do not overlap`;
  return { kind: "new", score, overlap, sentence: `Declared as new: ${why}, so the colony creates the intent.` };
}
