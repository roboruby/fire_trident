import type { Id, Landing, LineageNote, Path, Sha } from "@fire_trident/core";
import { importsOf } from "@fire_trident/core";
import { isRelative, resolveModule, specifierTarget } from "../decide/mechanical.ts";
import type { ObjectSource } from "./verify.ts";

/**
 * Undoing a landing (`ft revert`). A revert is a person's decision, written as a new commit on
 * current main that puts every path the landing wrote back to the blob it had before. It is
 * guarded like any landing: a path that no longer holds the blob the landing produced has had work
 * land on top of it, and undoing would overwrite that work, so the revert is refused with the paths
 * and the landings that moved them. Each file goes back by blob id, byte for byte (text or not), and
 * a file the landing deleted comes back with the mode it had (an executable stays executable). A
 * file the landing created is deleted by its revert, so the revert is refused too while other trunk
 * files import it (resolved as the decide stage resolves relative imports). A revert can also undo
 * one proposal of a landing (a landing is one lane batch, and the write sets of its proposals never
 * overlap): then only the paths that proposal wrote go back, and the same guards apply to them. The
 * planning functions are pure; runRevert reads trunk and commits through a RevertTrunk (TrunkDO's
 * tables and serial chain, or a stand-in in tests).
 */

/** One path of a landing as the trunk writer recorded it (null: absent). */
export interface LandedPath {
  path: Path;
  before: Sha | null;
  after: Sha | null;
}

/** A path that changed again after the landing: what trunk holds now, and the latest landing that changed it (undo that one first). */
export interface Moved {
  path: Path;
  now: Sha | null;
  by: Id | null;
}

/** What a revert writes for one path: its blob before the landing (null: delete it), if trunk still holds `expect`. */
export interface Restore {
  path: Path;
  blob: Sha | null;
  expect: Sha | null;
}

export type RevertPlan = { ok: true; restore: Restore[] } | { ok: false; moved: Moved[] };

/** A file the revert would delete that other trunk files import. */
export interface Imported {
  path: Path;
  /** The trunk files whose relative imports resolve to it, sorted. */
  by: Path[];
}

/** The proposal a revert undid on its own, and its intent (null: not recorded). */
export interface RevertedProposal {
  id: Id;
  intentId: Id | null;
}

/** The answer of TrunkDO.revert and TrunkDO.revertProposal (`proposal`: only that proposal of the landing was undone). */
export type RevertResult =
  | { ok: true; landing: Landing; reverted: Landing; proposal?: RevertedProposal }
  | { ok: false; status: 400 | 404 | 409 | 422; error: string; moved?: Moved[]; imported?: Imported[] };

/** Plan the revert of one landing's paths against current trunk (`later` names the latest landing that changed a path since). */
export function planRevert(paths: readonly LandedPath[], current: (path: Path) => Sha | null, later: (path: Path) => Id | null): RevertPlan {
  const moved: Moved[] = [];
  for (const p of paths) {
    const now = current(p.path);
    if (now !== p.after) moved.push({ path: p.path, now, by: later(p.path) });
  }
  if (moved.length > 0) return { ok: false, moved };
  return { ok: true, restore: paths.filter((p) => p.before !== p.after).map((p) => ({ path: p.path, blob: p.before, expect: p.after })) };
}

/** The refused paths in one line, e.g. "src/a.ts changed since, last by lnd_x; src/b.ts deleted since". */
export function movedText(moved: readonly Moved[], max = 5): string {
  const parts = moved.slice(0, max).map((m) => `${m.path} ${m.now === null ? "deleted" : "changed"} since${m.by ? `, last by ${m.by}` : ""}`);
  if (moved.length > max) parts.push(`and ${moved.length - max} more`);
  return parts.join("; ");
}

/** JS/TS files: the family whose relative imports the decide stage resolves. */
export const SCRIPT_FILE = /\.[cm]?[jt]sx?$/i;

/**
 * How much of trunk the import check of one revert reads at most: script files, and their bytes.
 * Past either limit the revert is refused (422) rather than done unchecked.
 */
export const IMPORT_SCAN = { files: 20_000, bytes: 64 * 1024 * 1024 } as const;

/** The relative import specifiers in a script's text. */
export function relativeSpecifiers(text: string): string[] {
  return importsOf(text)
    .map((i) => i.specifier)
    .filter(isRelative);
}

/**
 * The files a revert would delete that other trunk files import. Every relative specifier of every
 * script file is resolved against the current trunk tree (`exists`) with the decide stage's rules,
 * and one that resolves to a deleted path makes its file an importer of it. The caller leaves out
 * the files the revert itself writes: they go back to what they were before the landing.
 */
export function importedDeletions(deleted: readonly Path[], files: Iterable<{ path: Path; specifiers: readonly string[] }>, exists: (p: Path) => boolean): Imported[] {
  const gone = new Set(deleted);
  const by = new Map<Path, Set<Path>>();
  for (const f of files) {
    if (!SCRIPT_FILE.test(f.path) || gone.has(f.path)) continue;
    for (const spec of f.specifiers) {
      const target = resolveModule(specifierTarget(f.path, spec), exists);
      if (target === null || !gone.has(target)) continue;
      const set = by.get(target) ?? new Set<Path>();
      set.add(f.path);
      by.set(target, set);
    }
  }
  return deleted.filter((p) => by.has(p)).map((p) => ({ path: p, by: [...by.get(p)!].sort() }));
}

/**
 * The imported files in one line, each importer with the latest landing that changed it when known
 * (undo that one first), e.g. "src/new.ts is imported by src/a.ts (last changed by lnd_x), src/b.ts".
 */
export function importedText(list: readonly Imported[], lastBy: (path: Path) => Id | null = () => null, max = 5): string {
  const parts = list.slice(0, max).map((m) => {
    const names = m.by.slice(0, max).map((p) => {
      const l = lastBy(p);
      return l ? `${p} (last changed by ${l})` : p;
    });
    if (m.by.length > max) names.push(`${m.by.length - max} more`);
    return `${m.path} is imported by ${names.join(", ")}`;
  });
  if (list.length > max) parts.push(`and ${list.length - max} more`);
  return parts.join("; ");
}

/**
 * What one proposal of a landing wrote, from the landing's lineage note: its intent (null: not
 * recorded) and the paths of its write set. Null when the note does not list it or cannot be read.
 */
export function proposalWrites(note: unknown, proposalId: Id): { intentId: Id | null; paths: Path[] } | null {
  const list = note !== null && typeof note === "object" ? (note as { proposals?: unknown }).proposals : undefined;
  if (!Array.isArray(list)) return null;
  for (const entry of list as unknown[]) {
    if (entry === null || typeof entry !== "object") continue;
    const e = entry as { id?: unknown; intent?: unknown; writeSet?: unknown };
    if (e.id !== proposalId || !Array.isArray(e.writeSet)) continue;
    const paths = (e.writeSet as unknown[]).flatMap((w) => (w !== null && typeof w === "object" && typeof (w as { path?: unknown }).path === "string" ? [(w as { path: string }).path] : []));
    const intent = e.intent !== null && typeof e.intent === "object" ? (e.intent as { id?: unknown }).id : undefined;
    return { intentId: typeof intent === "string" && intent !== "" ? intent : null, paths };
  }
  return null;
}

/**
 * One file of a revert commit: the bytes of the blob it goes back to (null: delete it), written only while trunk still
 * holds `expect`; `mode`, for a file the landing deleted, the mode it had before (absent: as trunk has it, else 100644).
 */
export interface RevertFile extends Restore {
  content: Uint8Array | null;
  mode?: string;
}

/** The modes a revert puts a deleted file back with: a file, an executable file, a symbolic link. */
export const RESTORABLE_MODES: ReadonlySet<string> = new Set(["100644", "100755", "120000"]);

/** The mode `path` has in `commit` (100644, 100755, 120000, ...), read through `src`; null when the commit, a tree or the path cannot be found. */
export async function modeAt(src: ObjectSource, commit: Sha, path: Path): Promise<string | null> {
  const c = await src.commit(commit);
  if (!c) return null;
  const parts = path.split("/");
  let tree = c.tree;
  for (let i = 0; i < parts.length; i++) {
    const entry = (await src.tree(tree))?.find((e) => e.name === parts[i]);
    if (!entry) return null;
    if (i === parts.length - 1) return entry.type === "tree" || entry.type === "commit" || entry.type === "gitlink" ? null : (entry.mode ?? null);
    if (entry.type !== "tree") return null;
    tree = entry.oid;
  }
  return null;
}

/** The revert commit the trunk writer is asked to make. */
export interface RevertCommit {
  files: RevertFile[];
  message: string;
  note: LineageNote & Record<string, unknown>;
}

/** What a revert takes from the trunk writer besides its tables (sqlRevertTrunk adds those). */
export interface RevertWriter {
  /** The landing `ref` names (a landing id, or a trunk commit or a unique prefix of 7+), or null. */
  landing(ref: string): Landing | null;
  /** A blob's bytes, or null when it cannot be read. */
  read(blob: Sha): Promise<Uint8Array | null>;
  /** The mode `path` had in `commit`, or null when it cannot be read (absent: deleted files come back as 100644). */
  modeAt?(commit: Sha, path: Path): Promise<string | null>;
  /** Run `fn` on the trunk writer's serial chain: no landing cycle runs while it does. */
  serial<T>(fn: () => Promise<T>): Promise<T>;
  /** Write and push the commit now (call inside `serial`); `stale` when a file no longer holds its `expect`, and nothing was written. */
  commitNow(commit: RevertCommit): Promise<{ landing: Landing } | { stale: string }>;
  /** Start pushing the new lineage note. */
  notesSoon(): Promise<void>;
}

/** The trunk as a revert reads it: the writer, the landing records, and the current tree. */
export interface RevertTrunk extends RevertWriter {
  /** The paths a landing changed, with their blobs before and after it, sorted by path. */
  landed(landingId: Id): LandedPath[];
  /** A landing's lineage note (parsed JSON), or null. */
  note(landingId: Id): unknown;
  /** The landing a proposal landed in, or null. */
  landingOf(proposalId: Id): Id | null;
  /** The latest landing after `landingId` that changed `path`, or null. */
  later(landingId: Id, path: Path): Id | null;
  /** The blob trunk holds at `path` now (null: absent). */
  blob(path: Path): Sha | null;
  /** Every trunk file now, with its blob and size. */
  files(): Array<{ path: Path; blob: Sha; size: number }>;
}

/** A RevertTrunk over the trunk writer's tables: ft_landings, ft_landing_paths, ft_notes, ft_landed and ft_files. */
export function sqlRevertTrunk(sql: SqlStorage, w: RevertWriter): RevertTrunk {
  return {
    landing: (ref) => w.landing(ref),
    read: (blob) => w.read(blob),
    ...(w.modeAt ? { modeAt: (commit: Sha, path: Path) => w.modeAt!(commit, path) } : {}),
    serial: (fn) => w.serial(fn),
    commitNow: (commit) => w.commitNow(commit),
    notesSoon: () => w.notesSoon(),
    landed: (landingId) =>
      sql
        .exec<{ path: string; before_blob: string | null; after_blob: string | null }>(`SELECT path, before_blob, after_blob FROM ft_landing_paths WHERE landing_id = ? ORDER BY path`, landingId)
        .toArray()
        .map((r) => ({ path: r.path, before: r.before_blob, after: r.after_blob })),
    note: (landingId) => {
      const text = sql.exec<{ note: string }>(`SELECT note FROM ft_notes WHERE landing_id = ?`, landingId).toArray()[0]?.note;
      if (text === undefined) return null;
      try {
        return JSON.parse(text) as unknown;
      } catch {
        return null;
      }
    },
    landingOf: (proposalId) => sql.exec<{ landing_id: string }>(`SELECT landing_id FROM ft_landed WHERE proposal_id = ?`, proposalId).toArray()[0]?.landing_id ?? null,
    later: (landingId, path) =>
      sql
        .exec<{ landing_id: string }>(
          `SELECT landing_id FROM ft_landing_paths WHERE path = ? AND seq > (SELECT seq FROM ft_landings WHERE id = ?) ORDER BY seq DESC LIMIT 1`,
          path,
          landingId,
        )
        .toArray()[0]?.landing_id ?? null,
    blob: (path) => sql.exec<{ blob: string }>(`SELECT blob FROM ft_files WHERE path = ?`, path).toArray()[0]?.blob ?? null,
    files: () => sql.exec<{ path: string; blob: string; size: number }>(`SELECT path, blob, size FROM ft_files`).toArray(),
  };
}

/**
 * Undo a landing, or only `p.proposal` of it, as a new commit on current trunk (the body of
 * TrunkDO.revert and revertProposal). A proposal's paths are the landing's recorded paths that its
 * write set in the landing's lineage note names; every guard applies to the paths being undone.
 * Refused (409) while one of them holds other work than the landing produced, or while trunk files
 * import a file the revert would delete; both are checked again on the serial chain right before the
 * commit. 422 when a file to restore cannot be read (or its mode, for one the landing deleted) or
 * the import check would read too much; 404 for an unknown landing, or a proposal that did not land
 * in it.
 */
export async function runRevert(trunk: RevertTrunk, ref: string, p: { by: string; reason: string; proposal?: Id }): Promise<RevertResult> {
  const target = trunk.landing(String(ref ?? "").trim());
  if (!target) return { ok: false, status: 404, error: `no landing ${ref} on this trunk` };
  let rows = trunk.landed(target.id);
  if (rows.length === 0) return { ok: false, status: 422, error: `landing ${target.id} recorded no file changes` };
  let undone: RevertedProposal | undefined;
  if (p.proposal !== undefined) {
    const id = String(p.proposal).trim();
    if (id === "") return { ok: false, status: 400, error: "say which proposal of the landing to revert" };
    const proposals = Array.isArray(target.proposalIds) ? target.proposalIds : [];
    const landedIn = trunk.landingOf(id);
    if (!proposals.includes(id) && landedIn !== target.id) {
      return { ok: false, status: 404, error: `proposal ${id} did not land in ${target.id}${landedIn ? ` (it landed in ${landedIn})` : ""}` };
    }
    const wrote = proposalWrites(trunk.note(target.id), id);
    // The only proposal of its landing wrote all of it; otherwise the note says which paths are its own.
    if (proposals.length !== 1 || proposals[0] !== id) {
      if (wrote === null) return { ok: false, status: 422, error: `the lineage note of ${target.id} does not say which files ${id} wrote; revert the whole landing` };
      const mine = new Set(wrote.paths);
      rows = rows.filter((r) => mine.has(r.path));
    }
    const intents = Array.isArray(target.intentIds) ? target.intentIds : [];
    undone = { id, intentId: wrote?.intentId ?? (intents.length === 1 ? (intents[0] ?? null) : null) };
  }
  const what = undone ? `${undone.id} of ${target.id}` : target.id;
  const later = (path: Path): Id | null => trunk.later(target.id, path);
  const plan = planRevert(rows, (path) => trunk.blob(path), later);
  if (!plan.ok) return { ok: false, status: 409, error: `work landed on top of ${what}: ${movedText(plan.moved)}`, moved: plan.moved };
  if (plan.restore.length === 0) return { ok: false, status: 422, error: `${undone ? what : `landing ${target.id}`} changed nothing to undo` };

  // The files this revert deletes (the landing created them) must not be imported by any other
  // trunk file. Each script file is read once; a second pass rereads only files whose blob moved.
  const deleted = plan.restore.filter((r) => r.blob === null).map((r) => r.path);
  const writes = new Set(plan.restore.map((r) => r.path));
  const scanned = new Map<Path, { blob: Sha; specifiers: string[] }>();
  const text = new TextDecoder();
  const importers = async (): Promise<RevertResult | null> => {
    const index = trunk.files();
    const tree = new Set(index.map((f) => f.path));
    const files: Array<{ path: Path; specifiers: string[] }> = [];
    let bytes = 0;
    for (const f of index) {
      if (writes.has(f.path) || !SCRIPT_FILE.test(f.path)) continue;
      const known = scanned.get(f.path);
      if (known && known.blob === f.blob) {
        files.push({ path: f.path, specifiers: known.specifiers });
        continue;
      }
      bytes += f.size;
      if (scanned.size >= IMPORT_SCAN.files || bytes > IMPORT_SCAN.bytes) {
        return { ok: false, status: 422, error: `too many files to check which ones import ${deleted.slice(0, 3).join(", ")}; revert ${what} by hand` };
      }
      const data = await trunk.read(f.blob);
      if (data === null) return { ok: false, status: 422, error: `cannot read ${f.path} to check whether it imports ${deleted.slice(0, 3).join(", ")}` };
      const specifiers = relativeSpecifiers(text.decode(data));
      scanned.set(f.path, { blob: f.blob, specifiers });
      files.push({ path: f.path, specifiers });
    }
    const imported = importedDeletions(deleted, files, (path) => tree.has(path));
    return imported.length === 0 ? null : { ok: false, status: 409, error: `work landed on top of ${what}: ${importedText(imported, later)}`, imported };
  };
  if (deleted.length > 0) {
    const refused = await importers();
    if (refused) return refused;
  }

  // Each file goes back by its blob id: the bytes are the blob's own, so binary files and text in any encoding come back
  // exactly. A file the landing deleted comes back with the mode it had in the landing's parent.
  const files: RevertFile[] = [];
  for (const r of plan.restore) {
    if (r.blob === null) {
      files.push({ ...r, content: null });
      continue;
    }
    const bytes = await trunk.read(r.blob);
    if (bytes === null) return { ok: false, status: 422, error: `cannot read ${r.path} as it was before ${target.id}` };
    let mode: string | undefined;
    if (r.expect === null && trunk.modeAt) {
      const was = await trunk.modeAt(target.parentSha, r.path).catch(() => null);
      if (was === null) return { ok: false, status: 422, error: `cannot read the mode ${r.path} had before ${target.id}; revert it by hand` };
      if (!RESTORABLE_MODES.has(was)) return { ok: false, status: 422, error: `${r.path} had mode ${was} before ${target.id}, which a revert does not put back; revert it by hand` };
      mode = was;
    }
    files.push({ ...r, content: bytes, ...(mode ? { mode } : {}) });
  }
  const why = p.reason.replace(/\s+/g, " ").trim().slice(0, 500);
  const of = undone ? `${undone.id} of ${target.trunkSha}` : target.trunkSha;
  const message = `Revert ${what} (${target.trunkSha.slice(0, 7)})\n\n${p.by} reverted ${of}: ${why}\n\nFT-Revert-Of: ${target.id}${undone ? `\nFT-Revert-Proposal: ${undone.id}` : ""}`;
  const note = {
    schema: "firetrident.lineage/v1",
    landingId: "",
    colonyId: "",
    proposals: [],
    revert: { of: target.id, commit: target.trunkSha, by: p.by, reason: why, at: Date.now(), ...(undone ? { proposal: undone.id } : {}) },
  } as unknown as LineageNote & Record<string, unknown>;
  const out = await trunk.serial(async (): Promise<RevertResult> => {
    // Checked again on the serial chain, right before the commit, so no landing can slip in between:
    // the import check here, and every file's blob in commitNow.
    if (deleted.length > 0) {
      const refused = await importers();
      if (refused) return refused;
    }
    const done = await trunk.commitNow({ files, message, note });
    if ("stale" in done) return { ok: false, status: 409, error: `work landed on top of ${what}: ${done.stale}` };
    return { ok: true, landing: done.landing, reverted: target, ...(undone ? { proposal: undone } : {}) };
  });
  // The revert is recorded; failing to start the notes push must not fail it (the journal keeps the note).
  if (out.ok) await trunk.notesSoon().catch((e: unknown) => console.error(`notes flush not started after ${out.landing.id}: ${e instanceof Error ? e.message : String(e)}`));
  return out;
}
