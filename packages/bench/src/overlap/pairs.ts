/**
 * The overlap replay's logic, with no I/O (replay.ts runs it over a repository's merged pull requests): which merged
 * pull requests were open at the same time, which of those pairs changed a file in common (what per-file locks would
 * have serialized), what the text merge does with one file both changed (core mergeText, as the trunk writer calls
 * it), each pair's outcome, the counts over all pairs, and the results README those counts go into.
 */
import { isLockfile, mergeContentProblem, mergeText, MERGE_MAX_EDITS } from "@fire_trident/core";

/** One merged pull request as the replay reads it. */
export interface MergedPr {
  number: number;
  /** When it was opened (ISO). */
  createdAt: string;
  /** When it was merged (ISO). */
  mergedAt: string;
  /** The branch it merged into. */
  baseRef: string;
  /** The branch it came from. */
  headRef: string;
  /** It came from another repository (a fork). */
  fromFork: boolean;
  /** The base commit GitHub recorded for it. */
  baseSha: string;
  /** Its final head commit. */
  headSha: string;
  /** The commit its merge made on the base branch (a squash, a merge or the last rebased commit); null when unknown. */
  mergeSha: string | null;
  /** The paths it changed, as GitHub lists them, sorted. */
  files: string[];
  /** GitHub's count of changed files: more than files.length when the list was cut short. */
  changedFiles: number;
}

/** Two merged pull requests whose open-to-merge windows overlapped: `earlier` merged first. */
export interface OverlapPair {
  earlier: MergedPr;
  later: MergedPr;
  /** Paths both changed, sorted. */
  shared: string[];
}

/** What selectPrs keeps: the pull requests merged inside a window (or the newest N), and what it left out. */
export interface Selection {
  /** The pull requests paired, oldest merge first. */
  prs: MergedPr[];
  /** Merged inside the window into a branch other than `base`, left out. */
  otherBase: number;
  /** Branch merges left out: pull requests whose head is a branch of the repository that others merge into (a release merging `next` into `main`), so their changes are other pull requests' work. */
  branchMerges: number[];
}

/**
 * Which pull requests selectPrs keeps: merged at or after `since` and before `until` (with `newest`, only the newest that
 * many of those), into `base` when it is given, else into any branch.
 */
export interface SelectOptions {
  base?: string;
  since?: string;
  until?: string;
  newest?: number;
}

const ms = (iso: string): number => Date.parse(iso);

/** Merge order: by merge time, then by number. */
export function mergeOrder(a: MergedPr, b: MergedPr): number {
  return ms(a.mergedAt) - ms(b.mergedAt) || a.number - b.number;
}

/**
 * The pull requests the replay pairs (see SelectOptions), oldest merge first. A branch merge is left out: a pull request
 * from a branch of the repository itself (not a fork) that other listed pull requests merged into.
 */
export function selectPrs(all: readonly MergedPr[], opts: SelectOptions): Selection {
  const since = opts.since ? ms(opts.since) : -Infinity;
  const until = opts.until ? ms(opts.until) : Infinity;
  const targets = new Set(all.map((p) => p.baseRef));
  const byNumber = new Map<number, MergedPr>();
  for (const p of all) if (ms(p.mergedAt) >= since && ms(p.mergedAt) < until) byNumber.set(p.number, p);
  const inWindow = [...byNumber.values()].sort(mergeOrder);
  const onBase = inWindow.filter((p) => opts.base === undefined || p.baseRef === opts.base);
  const isBranchMerge = (p: MergedPr) => !p.fromFork && targets.has(p.headRef);
  let kept = onBase.filter((p) => !isBranchMerge(p));
  if (opts.newest !== undefined) kept = kept.slice(Math.max(0, kept.length - opts.newest));
  const first = kept[0] ? ms(kept[0].mergedAt) : Infinity;
  return {
    prs: kept,
    otherBase: inWindow.length - onBase.length,
    branchMerges: onBase.filter((p) => isBranchMerge(p) && (opts.newest === undefined || ms(p.mergedAt) >= first)).map((p) => p.number),
  };
}

/** Whether two pull requests were open at the same time: each opened before the other merged. */
export function overlaps(a: MergedPr, b: MergedPr): boolean {
  return ms(a.createdAt) < ms(b.mergedAt) && ms(b.createdAt) < ms(a.mergedAt);
}

/** Paths in both sorted lists. */
function common(a: readonly string[], b: readonly string[]): string[] {
  const other = new Set(b);
  return a.filter((p) => other.has(p));
}

/** Every pair of pull requests into the same branch whose open-to-merge windows overlapped, in merge order of the earlier then the later. */
export function overlappingPairs(prs: readonly MergedPr[]): OverlapPair[] {
  const sorted = [...prs].sort(mergeOrder);
  const out: OverlapPair[] = [];
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const earlier = sorted[i]!;
      const later = sorted[j]!;
      if (earlier.baseRef === later.baseRef && overlaps(earlier, later)) out.push({ earlier, later, shared: common(earlier.files, later.files) });
    }
  }
  return out;
}

/** What text merge does with one file: lands it, conflicts, or cannot read it. */
export type MergeVerdict = "clean" | "conflict" | "not-mergeable";

/** Text merge of one file both pull requests changed (mergeFile). */
export interface FileMerge {
  verdict: MergeVerdict;
  /** Where each conflicting hunk starts, as a 1-based line of the base (conflict). */
  lines?: number[];
  /** Why text merge does not read the file (not-mergeable). */
  reason?: string;
  /** The rule beyond git's that resolved its conflicting hunks (the insertion rule), when one did. */
  rule?: "insertions";
}

/** One file's three versions as bytes; null where the file does not exist. `submodule`: a version is a commit, not a file. */
export interface ThreeVersions {
  base: Uint8Array | null;
  earlier: Uint8Array | null;
  later: Uint8Array | null;
  submodule?: boolean;
}

/** Fatal and BOM-keeping, as the trunk writer decodes the texts it merges. */
const DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * Text merge of one file both pull requests changed, as the trunk writer would merge the later one landing on a trunk
 * that holds the earlier one (trunk/plan.ts mergeWrites): base is the merge base's version, ours the earlier
 * pull request's, theirs the later one's. A file added on both sides or deleted on one, a submodule, a lockfile, a
 * version over 512 KB, binary or not UTF-8, or a side past the edit limit is not merged (the change goes back stale);
 * otherwise core mergeText, with the insertion rule when `insertions`.
 */
export function mergeFile(path: string, v: ThreeVersions, insertions: boolean): FileMerge {
  if (v.submodule) return { verdict: "not-mergeable", reason: "a submodule" };
  if (v.base === null) return { verdict: "not-mergeable", reason: "added on both sides" };
  if (v.earlier === null || v.later === null) return { verdict: "not-mergeable", reason: "deleted on one side" };
  if (isLockfile(path)) return { verdict: "not-mergeable", reason: "a lockfile" };
  const problem = mergeContentProblem([v.base, v.earlier, v.later]);
  if (problem !== null) return { verdict: "not-mergeable", reason: problem };
  let texts: [string, string, string];
  try {
    texts = [DECODER.decode(v.base), DECODER.decode(v.earlier), DECODER.decode(v.later)];
  } catch {
    return { verdict: "not-mergeable", reason: "not UTF-8" };
  }
  const r = mergeText(texts[0], texts[1], texts[2], MERGE_MAX_EDITS, { insertions });
  if (r.clean) return r.rule ? { verdict: "clean", rule: r.rule } : { verdict: "clean" };
  if (r.limited) return { verdict: "not-mergeable", reason: `over the edit limit (${MERGE_MAX_EDITS} lines)` };
  return { verdict: "conflict", lines: r.lines };
}

/** How a pair would land: both land, the later goes back on a conflicting hunk, or it goes back on a file text merge cannot read. */
export type PairOutcome = "lands" | "conflict" | "not-mergeable";

/** The outcome over every file both changed: any file text merge cannot read sends the later one back, then any conflict does. */
export function pairOutcome(files: readonly FileMerge[]): PairOutcome {
  if (files.some((f) => f.verdict === "not-mergeable")) return "not-mergeable";
  if (files.some((f) => f.verdict === "conflict")) return "conflict";
  return "lands";
}

/** One file both pull requests of a replayed pair changed against their merge base, to different results. */
export interface PairFile {
  path: string;
  /** Blob ids at the merge base and at the two heads; null where the file does not exist. */
  base: string | null;
  earlier: string | null;
  later: string | null;
  /** git merge-tree named this path conflicted. */
  gitConflict: boolean;
  /** The file was the same at both pull requests' own bases, so a conflict on it is between their own edits; null when unknown. */
  sameAtBothBases: boolean | null;
  /** Text merge (FT_TEXT_MERGE). */
  text: FileMerge;
  /** Text merge with the insertion rule (FT_MERGE_INSERTIONS). */
  insertions: FileMerge;
}

/** One conflict message of git merge-tree: its type and the paths it names. */
export interface GitConflict {
  type: string;
  paths: string[];
}

/**
 * Why a pair sharing a file was or was not replayed: `replayed` at both final heads; `replayed-before-update` at the
 * later one's last commit before it took in the earlier one (its final head holds the earlier merge, and its branch
 * has a commit of its own from before that); `later-contains-earlier` when it has none (rebased onto the earlier, or
 * opened on top of it); `earlier-contains-later` when the earlier head holds the later one; `missing-commit` when a
 * commit is not in the clone.
 */
export type ReplayStatus = "replayed" | "replayed-before-update" | "later-contains-earlier" | "earlier-contains-later" | "missing-commit";

/** Whether a pair was replayed (at both final heads, or before the later one took in the earlier). */
export function wasReplayed(p: Pick<PairRecord, "status">): boolean {
  return p.status === "replayed" || p.status === "replayed-before-update";
}

/** A pair sharing a file and its verdicts. */
export interface PairRecord {
  earlier: number;
  later: number;
  shared: string[];
  status: ReplayStatus;
  /** The later pull request's commit replayed, when it is not its final head (replayed-before-update). */
  laterHead?: string;
  /** The merge base of the two heads both merges used, and how many best merge bases git found. */
  mergeBase?: string;
  mergeBases?: number;
  /** git merge-tree of the two heads over the merge base. */
  git?: { conflict: boolean; conflicts: GitConflict[] };
  /** Every file both changed against the merge base, to different results. */
  files?: PairFile[];
  /** How the later would land on a trunk holding the earlier, with text merge, and with the insertion rule too. */
  text?: PairOutcome;
  insertions?: PairOutcome;
}

/**
 * Whether a git conflict is between the two pull requests' own edits: every path git named in a conflict is a file both
 * changed that was the same at both pull requests' own bases. A path git named that neither changed under that name (a
 * rename git detected) or that changed between the two bases makes it false.
 */
export function ownEdits(p: Pick<PairRecord, "git" | "files">): boolean {
  const paths = new Set((p.git?.conflicts ?? []).flatMap((c) => c.paths));
  if (paths.size === 0) return false;
  const files = new Map((p.files ?? []).map((f) => [f.path, f]));
  return [...paths].every((path) => files.get(path)?.sameAtBothBases === true);
}

/** The headline counts (summarize). */
export interface OverlapCounts {
  /** Pull requests in the selection. */
  prs: number;
  /** Pairs whose open-to-merge windows overlapped. */
  overlappingPairs: number;
  /** Of those, pairs that changed a file in common: what per-file locks would have serialized. */
  pairsSharingFile: number;
  /** Pairs replayed: at both final heads, or at the later one's last commit before it took in the earlier. */
  replayed: number;
  /** Of those, pairs replayed at the later one's last commit before it took in the earlier (its author updated the branch after the earlier landed). */
  replayedBeforeUpdate: number;
  /** Pairs sharing a file where one already held the other with no earlier commit of its own (rebased onto it, or opened on top of it): not replayed. */
  notReplayable: number;
  /** Pairs sharing a file with a head commit or merge commit missing from the clone: not replayed. */
  missingCommits: number;
  /** Replayed pairs git merge-tree reports conflicting. */
  gitConflicts: number;
  /** Of those, pairs whose every git-conflicting file was the same at both pull requests' own bases. */
  gitConflictsOwnEdits: number;
  /** Of the git conflicts, pairs text merge lands both of. */
  textMergeResolved: number;
  /** Of the git conflicts, pairs text merge with the insertion rule lands both of (those text merge lands included). */
  insertionMergeResolved: number;
  /** Git conflicts neither resolves. */
  stillConflicting: number;
  /** Replayed pairs git merges cleanly that text merge would send back. */
  gitCleanTextBack: number;
  /** Replayed pairs git merges cleanly that text merge with the insertion rule would send back. */
  gitCleanInsertionsBack: number;
}

/** The counts over every pair, and why each still-conflicting pair stays so (the first file's reason, or "overlapping edits"). */
export function summarize(prs: number, overlappingPairs: number, pairs: readonly PairRecord[]): { counts: OverlapCounts; stillConflictingBy: Record<string, number> } {
  const replayed = pairs.filter(wasReplayed);
  const conflicted = replayed.filter((p) => p.git?.conflict === true);
  const clean = replayed.filter((p) => p.git?.conflict === false);
  const still = conflicted.filter((p) => p.insertions !== "lands");
  const stillConflictingBy: Record<string, number> = {};
  for (const p of still) {
    const reason = p.insertions === "not-mergeable" ? (p.files ?? []).find((f) => f.insertions.verdict === "not-mergeable")?.insertions.reason ?? "not mergeable" : "overlapping edits";
    stillConflictingBy[reason] = (stillConflictingBy[reason] ?? 0) + 1;
  }
  return {
    counts: {
      prs,
      overlappingPairs,
      pairsSharingFile: pairs.length,
      replayed: replayed.length,
      replayedBeforeUpdate: replayed.filter((p) => p.status === "replayed-before-update").length,
      notReplayable: pairs.filter((p) => p.status === "later-contains-earlier" || p.status === "earlier-contains-later").length,
      missingCommits: pairs.filter((p) => p.status === "missing-commit").length,
      gitConflicts: conflicted.length,
      gitConflictsOwnEdits: conflicted.filter(ownEdits).length,
      textMergeResolved: conflicted.filter((p) => p.text === "lands").length,
      insertionMergeResolved: conflicted.filter((p) => p.insertions === "lands").length,
      stillConflicting: still.length,
      gitCleanTextBack: clean.filter((p) => p.text !== "lands").length,
      gitCleanInsertionsBack: clean.filter((p) => p.insertions !== "lands").length,
    },
    stillConflictingBy: Object.fromEntries(Object.entries(stillConflictingBy).sort(([a, x], [b, y]) => y - x || a.localeCompare(b))),
  };
}

/** The results document replay.ts writes. */
export interface OverlapReport {
  schema: "firetrident.overlap-replay/v1";
  label: "MEASURED";
  repository: string;
  /** The one branch selected (--base), or null for every branch, each paired within itself. */
  base: string | null;
  window: { since: string | null; until: string | null; newest: number | null; firstMerged: string | null; lastMerged: string | null };
  /** Merged inside the window into another branch than `base`, left out. */
  otherBase: number;
  /** Branch merges left out (Selection). */
  branchMerges: number[];
  command: string;
  generatedAt: string;
  method: string[];
  limits: string[];
  counts: OverlapCounts;
  stillConflictingBy: Record<string, number>;
  prs: MergedPr[];
  /** Overlapping pairs that changed no file in common, as [earlier, later]. */
  pairsWithoutSharedFile: Array<[number, number]>;
  /** Overlapping pairs that changed a file in common, with their verdicts. */
  pairs: PairRecord[];
}

/** The rows of the README's headline table: its label and the count it shows. */
export const README_ROWS: ReadonlyArray<[keyof OverlapCounts, string]> = [
  ["prs", "Pull requests merged in the window"],
  ["overlappingPairs", "Pairs open at the same time (open-to-merge windows overlapped)"],
  ["pairsSharingFile", "Pairs sharing a changed file (what per-file locks would have serialized)"],
  ["replayed", "Pairs replayed"],
  ["replayedBeforeUpdate", "Of those, replayed at the later one's last commit before it took in the earlier"],
  ["notReplayable", "Pairs sharing a file not replayable (one was rebased onto or opened on top of the other)"],
  ["missingCommits", "Pairs sharing a file with a commit missing from the clone"],
  ["gitConflicts", "git conflicts (stock `git merge-tree` of the two heads)"],
  ["gitConflictsOwnEdits", "Of those, every conflicting file the same at both pull requests' own bases"],
  ["textMergeResolved", "Of the git conflicts, text merge lands both (FT_TEXT_MERGE)"],
  ["insertionMergeResolved", "Of the git conflicts, text merge with the insertion rule lands both (FT_MERGE_INSERTIONS)"],
  ["stillConflicting", "Still conflicting (git conflicts neither lands)"],
  ["gitCleanTextBack", "git merges cleanly, text merge sends the later one back"],
  ["gitCleanInsertionsBack", "git merges cleanly, text merge with the insertion rule sends the later one back"],
];

/** A markdown table; cells have their pipes escaped and line breaks flattened. */
export function mdTable(header: readonly string[], rows: ReadonlyArray<ReadonlyArray<string | number>>): string {
  const cell = (c: string | number): string => String(c).replace(/\r?\n|\r/g, " ").replace(/\|/g, "\\|");
  return [`| ${header.map(cell).join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`)].join("\n");
}

/** A count with thousands separators. */
const n = (x: number): string => x.toLocaleString("en-US");

/** "k of n (p%)". */
function share(k: number, of: number): string {
  return of === 0 ? `${n(k)} of 0` : `${n(k)} of ${n(of)} (${((100 * k) / of).toFixed(1)}%)`;
}

/** The headline counts README_ROWS names, read back from a README's table: label to count. */
export function readmeCounts(markdown: string): Partial<Record<keyof OverlapCounts, number>> {
  const out: Partial<Record<keyof OverlapCounts, number>> = {};
  for (const line of markdown.split("\n")) {
    const m = /^\| (.+) \| ([\d,]+) \|$/.exec(line);
    if (!m) continue;
    const label = m[1]!.replace(/\\\|/g, "|");
    const row = README_ROWS.find(([, l]) => l === label);
    if (row) out[row[0]] = Number(m[2]!.replace(/,/g, ""));
  }
  return out;
}

/** A link to a pull request. */
function prLink(repository: string, number: number): string {
  return `[#${number}](https://github.com/${repository}/pull/${number})`;
}

/** What text merge did with a pair, in a few words. */
function outcomeText(p: PairRecord, key: "text" | "insertions"): string {
  const o = p[key];
  if (o === "lands") return (p.files ?? []).some((f) => f[key].rule === "insertions") ? "lands (insertion rule)" : "lands";
  const files = (p.files ?? []).filter((f) => f[key].verdict !== "clean");
  return files.map((f) => (f[key].verdict === "conflict" ? `${f.path}: hunk at line ${(f[key].lines ?? []).join(", ")}` : `${f.path}: ${f[key].reason}`)).join("; ");
}

/** The results README: what was measured, the counts, every git conflict, the limits and the command to reproduce. */
export function overlapReadme(r: OverlapReport): string {
  const c = r.counts;
  const into = r.base ? `into \`${r.base}\`` : "into any branch";
  const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "now");
  const window = r.window.newest !== null ? `the newest ${n(r.window.newest)} pull requests merged ${into}${r.window.until ? ` before ${day(r.window.until)}` : ""}` : `pull requests merged ${into} from ${day(r.window.since)} to ${day(r.window.until)} (UTC, the last day excluded)`;
  const left = [
    r.otherBase > 0 ? `${n(r.otherBase)} merged into other branches` : "",
    r.branchMerges.length > 0 ? `${n(r.branchMerges.length)} branch merges (${r.branchMerges.map((x) => prLink(r.repository, x)).join(", ")}), whose changes are other pull requests' work` : "",
  ].filter(Boolean);
  const lines = [
    `# Overlapping pull requests in ${r.repository}, replayed`,
    "",
    `MEASURED from the repository's real history: ${window}, each paired only with pull requests into the same branch; the first merged ${r.window.firstMerged ?? "none"}, the last ${r.window.lastMerged ?? "none"}. ${left.length > 0 ? `Left out: ${left.join("; ")}. ` : ""}How often work that was open at the same time touched the same files, how often stock git could not merge it, and what FireTrident's text merge would have done with it. Written by \`packages/bench/src/overlap/replay.ts\`; every pair and its verdicts are in [overlap.json](overlap.json).`,
    "",
    mdTable(["Measure (MEASURED)", "Count"], README_ROWS.map(([k, label]) => [label, n(c[k])])),
    "",
    `- Pairs sharing a file: ${share(c.pairsSharingFile, c.overlappingPairs)} of the pairs open at the same time.`,
    `- git conflicts: ${share(c.gitConflicts, c.replayed)} of the replayed pairs.`,
    `- Text merge lands ${share(c.textMergeResolved, c.gitConflicts)} of the git conflicts; with the insertion rule, ${share(c.insertionMergeResolved, c.gitConflicts)}.`,
    `- Per-file locks would have held the later pull request of all ${n(c.pairsSharingFile)} pairs sharing a file until the earlier one merged. Of the ${n(c.replayed)} replayed, git merges ${n(c.replayed - c.gitConflicts)} cleanly, and text merge with the insertion rule lands ${n(c.replayed - c.gitCleanInsertionsBack - c.stillConflicting)}.`,
    `- The ${n(c.gitConflicts)} git conflicts involve ${n(new Set(r.pairs.filter((p) => p.git?.conflict).map((p) => p.later)).size)} distinct later pull requests; ${n(c.gitConflictsOwnEdits)} are between the two pull requests' own edits, the others also involve what their branch did between the two bases.`,
  ];
  const branchOf = new Map(r.prs.map((p) => [p.number, p.baseRef]));
  const branches = [...new Set(r.prs.map((p) => p.baseRef))].sort();
  if (branches.length > 1) {
    const tally = (b: string) => {
      const sharing = r.pairs.filter((p) => branchOf.get(p.earlier) === b);
      const without = r.pairsWithoutSharedFile.filter(([e]) => branchOf.get(e) === b).length;
      return [`\`${b}\``, n(r.prs.filter((p) => p.baseRef === b).length), n(sharing.length + without), n(sharing.length), n(sharing.filter((p) => p.git?.conflict).length)];
    };
    lines.push("", "## By branch", "", mdTable(["Branch merged into", "Pull requests", "Pairs open at the same time", "Sharing a file", "git conflicts"], branches.map(tally)));
  }
  const by = Object.entries(r.stillConflictingBy);
  if (by.length > 0) lines.push("", "## Still conflicting, by reason", "", mdTable(["Reason (the first file that stops the merge)", "Pairs"], by.map(([k, v]) => [k, n(v)])));
  const conflicts = r.pairs.filter((p) => p.git?.conflict);
  if (conflicts.length > 0) {
    lines.push(
      "",
      "## Every git conflict",
      "",
      "Earlier: merged first (trunk's side of the merge); later: the pull request that would land on it. Own edits: every conflicting file was the same at both pull requests' own bases, so the conflict is between their own changes and not with what the branch they merged into did between their bases. Text merge columns name each file that stops the later one (a conflicting hunk, by its first line in the base, or why the file is not merged).",
      "",
      mdTable(
        ["Earlier", "Later", "git conflicts", "Own edits", "Text merge", "With the insertion rule"],
        conflicts.map((p) => [
          prLink(r.repository, p.earlier),
          prLink(r.repository, p.later),
          (p.git?.conflicts ?? []).map((g) => `${g.type}: ${g.paths.join(", ")}`).join("; "),
          ownEdits(p) ? "yes" : "no",
          outcomeText(p, "text"),
          outcomeText(p, "insertions"),
        ]),
      ),
    );
  }
  const back = r.pairs.filter((p) => p.git?.conflict === false && p.insertions !== "lands");
  if (back.length > 0) {
    lines.push(
      "",
      "## git merges cleanly, text merge sends the later one back",
      "",
      mdTable(
        ["Earlier", "Later", "Text merge with the insertion rule"],
        back.map((p) => [prLink(r.repository, p.earlier), prLink(r.repository, p.later), outcomeText(p, "insertions")]),
      ),
    );
  }
  const shared = new Map<string, number>();
  for (const p of r.pairs) for (const path of p.shared) shared.set(path, (shared.get(path) ?? 0) + 1);
  const top = [...shared.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 15);
  if (top.length > 0) lines.push("", "## Files shared most often", "", mdTable(["Path", "Pairs sharing it"], top.map(([p, k]) => [`\`${p}\``, n(k)])));
  lines.push("", "## Method", "", ...r.method.map((m) => `- ${m}`), "", "## Limits", "", ...r.limits.map((m) => `- ${m}`), "", "## Reproduce", "", "From the repository root (reads GitHub with the `gh` CLI, clones the repository, and runs only stock git locally; responses and the clone are cached under `--cache` and never fetched twice):", "", `    ${r.command}`, "");
  return lines.join("\n");
}
