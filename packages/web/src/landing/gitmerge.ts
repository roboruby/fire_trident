import { blobId, textMergeCandidate, validateProposal } from "@fire_trident/core";
import type { FileVersion, MovedBy, MovedHunk, OccResult, Path, Sha } from "@fire_trident/core";
import raw from "./gitmerge.json" with { type: "json" };
import { staleDetail } from "./tryit.ts";

/**
 * "Git would have merged this": the fifth scene of the Try panel (TryIt.tsx). Two agents start from one trunk: A
 * renames formatPrice to formatAmount and updates its two callers; B reads src/price.ts and adds src/receipt.ts, which
 * calls formatPrice. They touch different files, so stock git merges them cleanly, and the merged program fails. The
 * trunk writer lands A and sends B back, because a file B read moved. In the control twin, B calls formatDate, which
 * nobody touched: git merges, both land, and the program runs.
 *
 * Git cannot run in a browser, so scripts/gitmerge_scene.mjs ran the git side ahead of time on these texts (git merge,
 * then node src/main.ts) and wrote gitmerge.json, with the program's run on the trunk FireTrident leaves and the diff
 * the return quotes. The FireTrident side runs here: read-set validation (validateProposal) on each change in landing
 * order, against the trunk it would land on, as the trunk writer calls it, worded as the colony words a return (the
 * reasons of trunk/plan.ts, colony/movedby.ts and colony/returnhunks.ts). Import-name revalidation is off in production
 * (FT_REVALIDATE), so a change stale through a file it read goes back, as here. Nothing here reads or writes a server.
 */

/** The two twins: B calls the function A renamed, or one nobody touched. */
export type TwinId = "catch" | "control";

/** One agent's change: the files it read, the new text of each file it writes, and its diff of each file the base has. */
export interface SceneChange {
  branch: string;
  title: string;
  read: Path[];
  writes: Record<Path, string>;
  diffs: Record<Path, string>;
}

/** One run of the program: whether it exited 0, what it printed, and the error and the file and line that raised it. */
export interface ProgramRun {
  command: string;
  ok: boolean;
  exit: number | null;
  stdout: string;
  error: string | null;
  at: string | null;
}

/** A change as the script's run of validateProposal decided it, and the trunk commit its landing made (null: it went back). */
export interface SceneVerdict {
  eligible: boolean;
  stale: OccResult["stale"];
  textMerge: boolean | null;
  commit: Sha | null;
}

/** One twin: its B, what stock git made of A and B (the files each changed, the merge, the run), and what FireTrident made of them. */
export interface SceneTwin {
  id: TwinId;
  label: string;
  b: SceneChange;
  git: { a: Path[]; b: Path[]; both: Path[]; clean: boolean; conflicts: Path[]; run: ProgramRun | null };
  fireTrident: {
    a: SceneVerdict;
    b: SceneVerdict;
    /** The landings that moved a file B read (the newest commit to change it since B's base), and the files. */
    moved: Array<{ commit: Sha; change: "a" | null; paths: Path[] }>;
    /** Each such landing's diff of each such file, as the trunk writer quotes it. */
    quoted: Array<{ commit: Sha; path: Path; diff: string; truncated: boolean }>;
    run: ProgramRun;
  };
}

/** The scene's data (gitmerge.json): the trunk both start from, agent A's change, and the twins. */
export interface GitMergeData {
  about: string;
  base: { files: Record<Path, string> };
  a: SceneChange;
  twins: SceneTwin[];
}

/** The data the script wrote. */
export const GITMERGE: GitMergeData = raw as GitMergeData;

/** The colony's ids for agent A's landing, its intent and its agent (the scene's own; the commit is the script's). */
export const GM_LANDING = "lnd_rename";
export const GM_INTENT = "int_rename";
export const GM_AGENT = "agt_a";
/** B's landing, when it lands. */
const GM_LANDING_B = "lnd_receipt";

/** Files of one landing quoted per return (colony/hunks.ts HUNK_PATHS). */
const QUOTED_PATHS = 3;

/** The sentence a return's reason ends with once its landings' diffs are quoted (colony/returnhunks.ts quotedSentence). */
export const QUOTED_SENTENCE = "What those landings changed in the files is quoted with this return: build on it without reading trunk again.";

/** "a", "a and b", "a, b and c". */
function listText(items: readonly string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** What a change read before it was written, as its card says it. */
export function readText(change: SceneChange): string {
  return change.read.length === 0 ? "It read no file first." : `It read ${listText(change.read)} first.`;
}

/** The sentence ending a return whose files trunk moved (colony/movedby.ts movedSentence): the landings, then what to do. */
export function movedText(moved: readonly MovedBy[]): string {
  const named = moved.map((m) => {
    const facts = [m.trunkSha ? `commit ${m.trunkSha.slice(0, 7)}` : "", m.intentId ? `intent ${m.intentId}` : "", m.agentId ? `agent ${m.agentId}` : ""].filter(Boolean).join(", ");
    return `${m.landingId}${facts ? ` (${facts})` : ""}`;
  });
  const files = new Set(moved.flatMap((m) => m.paths)).size === 1 ? "it" : "them";
  const keep =
    moved.length === 1
      ? "Keep what that landing did unless your intent says otherwise, and escalate if both cannot hold."
      : "Keep what those landings did unless your intent says otherwise, and escalate if they cannot all hold.";
  return `${moved.length === 1 ? "Landing" : "Landings"} ${listText(named)} moved ${files}. ${keep}`;
}

/** What the trunk writer decided for one change, and the sentence the page shows. */
export interface GmDecision {
  kind: "lands" | "back";
  occ: OccResult;
  sentence: string;
}

/** The scene for one twin: the git side from the script's run, the FireTrident side decided here. */
export interface GmOutcome {
  twin: SceneTwin;
  git: { merge: { kind: "lands" | "back"; sentence: string }; run: { kind: "lands" | "fails"; sentence: string; output: string } | null };
  a: GmDecision;
  b: GmDecision;
  /** The landings that moved what B read, with their quoted diffs (B goes back), or none (B lands). */
  moved: MovedBy[];
  /** The program on the trunk FireTrident leaves. */
  run: { kind: "lands" | "fails"; sentence: string; output: string };
}

/** A twin by id (the catch when the id is unknown). */
export function twinOf(id: TwinId): SceneTwin {
  return GITMERGE.twins.find((t) => t.id === id) ?? GITMERGE.twins[0]!;
}

/** A change as the trunk writer sees it: what it read and writes (blob ids of the texts, as git computes them) and its base's blobs of the files it writes. */
function proposalOf(change: SceneChange, base: (path: Path) => Sha | null): { p: { readSet: FileVersion[]; writeSet: FileVersion[] }; baseBlobs: FileVersion[] } {
  return {
    p: { readSet: change.read.map((path) => ({ path, blob: base(path) })), writeSet: Object.entries(change.writes).map(([path, text]) => ({ path, blob: blobId(text) })) },
    baseBlobs: Object.keys(change.writes).map((path) => ({ path, blob: base(path) })),
  };
}

/** What a run of the program says: it ran and printed its lines, or it failed with the error and where. */
function runText(r: ProgramRun, where: string): { kind: "lands" | "fails"; sentence: string; output: string } {
  if (r.ok) return { kind: "lands", sentence: `${r.command} ${where} runs and prints:`, output: r.stdout.replace(/\n$/, "") };
  const error = r.error ?? `it exits with code ${r.exit ?? "unknown"}`;
  const before = r.stdout === "" ? " before printing anything" : "";
  return { kind: "fails", sentence: `${r.command} ${where} fails${before}${r.at ? `, at ${r.at}` : ""}:`, output: error };
}

/**
 * One twin, decided as the trunk writer decides it (trunk/plan.ts): A, then B, each checked by read-set validation
 * (validateProposal) against the trunk it would land on, A's writes on trunk once it lands. A stale change that is not a
 * text merge candidate (textMergeCandidate: stale only on files it writes) goes back with the trunk writer's reason,
 * which the colony ends by naming the landings that moved its files (the newest landing since its base to write each
 * stale file, as movedBy finds them in its per-path index) and, with the landings' diffs quoted, the sentence saying so.
 */
export function gitMergeScene(id: TwinId): GmOutcome {
  const twin = twinOf(id);
  const ft = twin.fireTrident;
  const baseIndex = new Map(Object.entries(GITMERGE.base.files).map(([path, text]) => [path, blobId(text)]));
  const base = (path: Path): Sha | null => baseIndex.get(path) ?? null;
  const trunk = new Map<Path, Sha | null>(baseIndex);
  // The landing log the colony keeps per path: who wrote each file since the base, newest last.
  const landings: MovedBy[] = [];
  const decide = (who: "A" | "B", change: SceneChange, landing: MovedBy): GmDecision => {
    const { p, baseBlobs } = proposalOf(change, base);
    const occ = validateProposal(p, (path) => trunk.get(path) ?? null, baseBlobs);
    const read = listText(change.read);
    if (occ.eligible) {
      const before = landings.map((l) => l.landingId);
      for (const w of p.writeSet) trunk.set(w.path, w.blob ?? null);
      landings.push(landing);
      const commit = landing.trunkSha ? `; landing ${landing.landingId} makes trunk commit ${landing.trunkSha.slice(0, 7)}` : "";
      return {
        kind: "lands",
        occ,
        sentence:
          before.length === 0
            ? `${who} lands first: the files it read (${read}) are still the versions it read, so its read set holds${commit}.`
            : `${who} lands next: the files it read (${read}) are still the versions it read, since ${before.length === 1 ? "landing" : "landings"} ${listText(before)} moved none of them, so its read set holds${commit}.`,
      };
    }
    const reason = `stale: ${staleDetail(occ.stale)}`;
    // Stale only on files it writes: the trunk writer would merge them line by line first (scene 1). Not this scene's case.
    if (textMergeCandidate(p, occ.stale)) return { kind: "back", occ, sentence: `${who} goes to the text merge: ${reason}; scene 1 runs that merge.` };
    return { kind: "back", occ, sentence: `${who} goes back to its agent: ${reason}.` };
  };
  const aLanding: MovedBy = { landingId: GM_LANDING, paths: Object.keys(GITMERGE.a.writes), intentId: GM_INTENT, agentId: GM_AGENT, ...(ft.a.commit ? { trunkSha: ft.a.commit } : {}) };
  const a = decide("A", GITMERGE.a, aLanding);
  const bLanding: MovedBy = { landingId: GM_LANDING_B, paths: Object.keys(twin.b.writes), ...(ft.b.commit ? { trunkSha: ft.b.commit } : {}) };
  const b = decide("B", twin.b, bLanding);

  // B goes back: the landings that moved the files it was found stale on, each with its diffs of them, quoted.
  const moved: MovedBy[] = [];
  if (b.kind === "back") {
    for (const s of b.occ.stale) {
      const by = [...landings].reverse().find((l) => l.paths.includes(s.path));
      if (!by) continue;
      const entry = moved.find((m) => m.landingId === by.landingId);
      if (entry) entry.paths.push(s.path);
      else moved.push({ ...by, paths: [s.path] });
    }
    // Newest landing first, each landing's files sorted, as movedBy lists them.
    moved.sort((x, y) => landings.findIndex((l) => l.landingId === y.landingId) - landings.findIndex((l) => l.landingId === x.landingId));
    for (const m of moved) {
      m.paths.sort();
      const hunks: MovedHunk[] = m.paths
        .slice(0, QUOTED_PATHS)
        .flatMap((path) => ft.quoted.filter((q) => q.path === path && q.commit === m.trunkSha).map((q) => ({ path, trunkSha: q.commit, diff: q.diff, truncated: q.truncated })));
      if (hunks.length > 0) m.hunks = hunks;
    }
    if (moved.length > 0) {
      const quoted = moved.some((m) => m.hunks !== undefined) ? ` ${QUOTED_SENTENCE}` : "";
      b.sentence = `${b.sentence} ${movedText(moved)}${quoted}`;
    }
  }

  const g = twin.git;
  const merge = g.clean
    ? { kind: "lands" as const, sentence: `After A, git merge ${twin.b.branch} merges with no conflict: A changed ${listText(g.a)}, B changed ${listText(g.b)}, and ${g.both.length === 0 ? "no file is in both" : `both changed ${listText(g.both)}, on different lines`}.` }
    : { kind: "back" as const, sentence: `After A, git merge ${twin.b.branch} stops on a conflict in ${listText(g.conflicts)}.` };
  return {
    twin,
    git: { merge, run: g.run ? runText(g.run, "on the merged trunk") : null },
    a,
    b,
    moved,
    run: runText(ft.run, `on trunk, with ${a.kind === "lands" ? "A landed" : "A back with its agent"} and ${b.kind === "lands" ? "B landed" : "B back with its agent"},`),
  };
}
