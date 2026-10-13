/**
 * The import index of a colony's trunk: the direct relative import edges between trunk script
 * files, resolved with the decide stage's rules (decide/mechanical.ts), for import-aware take().
 * A claim on a file that a candidate's files import, or on a file that imports them, repels the
 * candidate: those are the landings that would make its reads stale, and the agents whose reads its
 * own landing would make stale (packages/bench/results/2026-10-13-papers, Q4).
 *
 * TrunkDO keeps it in its SQLite storage (ft_imp_ tables):
 * - it is built the first time it is read (only when FT_IMPORT_WEIGHT turns the term on), from every
 *   script file of the trunk index within the caps;
 * - finalizeRows marks each landing's changed paths (markLanded), and the next read re-parses the
 *   files whose blob changed and resolves again the specifiers a path that appeared or disappeared
 *   can change;
 * - when trunk moved outside the landing path (an external push, a replaced trunk), the next read
 *   compares the index with the trunk index file by file and reads only what differs, so a restart
 *   never rebuilds it unless it must.
 *
 * Each edge keeps the specifier's target (the path before extensions and index files are tried),
 * so resolution can be redone without reading the importing file again.
 *
 * importNeighbors is the caller's side: ColonyDO.take turns each path's imports and importers into
 * repulsion neighbors at weight 1 for core neighborRepulsion, the way it uses co-change neighbors.
 */
import type { Neighbor, Path, Sha } from "@fire_trident/core";
import { importsOf } from "@fire_trident/core";
import { RESOLVE_EXTS, isRelative, resolutionCandidates, resolveModule, specifierTarget } from "../decide/mechanical.ts";
import { SCRIPT_FILE } from "./revert.ts";

/** Imports and importers returned per path at most, and paths per `links` call at most. */
export const IMPORT_LINKS_MAX = 128;
export const IMPORT_PATHS_MAX = 2_000;
/** Links (imports plus importers) one `links` answer holds at most; paths past it are left out. */
const LINKS_TOTAL_MAX = 20_000;
/** Relative specifiers kept per file at most. */
const SPECIFIERS_MAX = 200;
/** Blob reads in flight while syncing, and stored edges resolved again per round after a move outside landings. */
const READ_CONCURRENCY = 8;
const RESOLVE_CHUNK = 2_000;
/** Paths per IN (...) list. */
const IN_CHUNK = 500;
/** Directory prefixes and globs (footprint entries that are not files). */
const PATTERN = /[*?{]|\/$/;
/** JavaScript extensions whose TypeScript twins resolution also tries (see resolutionCandidates). */
const JS_EXTS = [".js", ".jsx", ".mjs", ".cjs"];

/** How much of trunk the index reads. Files past the file caps are skipped: they have no edges. */
export interface ImportCaps {
  /** Script files indexed at most. */
  files: number;
  /** Script files larger than this (bytes) are skipped: generated or vendored code. */
  fileBytes: number;
  /** One sync's wall-clock budget (ms) and bytes read; what is left waits for the next sync. */
  budgetMs: number;
  budgetBytes: number;
  /** Changed paths settled per round. */
  round: number;
}

/** Default caps. */
export const IMPORT_CAPS: Readonly<ImportCaps> = Object.freeze({
  files: 10_000,
  fileBytes: 256 * 1024,
  budgetMs: 15_000,
  budgetBytes: 32 * 1024 * 1024,
  round: 256,
});

/** Tables (ft_ prefix: TrunkDO.destroy replays ft_ DDL). */
export const IMPORT_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS ft_imp_files (path TEXT PRIMARY KEY, blob TEXT NOT NULL, skipped INTEGER NOT NULL DEFAULT 0)",
  "CREATE TABLE IF NOT EXISTS ft_imp_edges (src TEXT NOT NULL, target TEXT NOT NULL, dst TEXT, PRIMARY KEY (src, target))",
  "CREATE INDEX IF NOT EXISTS ft_imp_edges_dst ON ft_imp_edges(dst)",
  "CREATE INDEX IF NOT EXISTS ft_imp_edges_target ON ft_imp_edges(target)",
  "CREATE TABLE IF NOT EXISTS ft_imp_dirty (path TEXT PRIMARY KEY, moved INTEGER NOT NULL DEFAULT 0)",
  "CREATE TABLE IF NOT EXISTS ft_imp_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
];

/** A path's direct relative imports and the trunk script files that import it, each sorted. */
export interface ImportLinks {
  imports: Path[];
  importers: Path[];
}

/** Where the index reads trunk: the current trunk commit (null once erased) and blob contents by id. */
export interface ImportSource {
  head(): Sha | null;
  read(blob: Sha): Promise<Uint8Array | null>;
  /** Named in the log line (the colony id). */
  label?: string;
}

/** What one sync did. */
export interface ImportSyncResult {
  /** Files read and parsed. */
  read: number;
  /** Files dropped (gone from trunk, or no longer scripts). */
  removed: number;
  /** Files skipped by the caps, or unreadable. */
  skipped: number;
  /** Stored edges resolved again. */
  resolved: number;
  /** Changed paths still waiting (a budget ran out, or a read failed). */
  pending: number;
  ms: number;
}

/** Index counts, for status and tests. */
export interface ImportStats {
  files: number;
  skipped: number;
  /** Edges between script files. */
  edges: number;
  pending: number;
  /** The trunk commit the index describes, with its pending paths (null before the first build). */
  sha: Sha | null;
  /** Stored edges still waiting to be resolved again after trunk moved outside the landing path. */
  resolving: boolean;
}

/** One landing's change to a path, as TrunkDO stages it (a null blob deletes; a null `before` creates). */
export interface LandedChange {
  blob: Sha | null;
  before?: Sha | null;
}

/**
 * The distinct targets of a script's relative import specifiers (specifierTarget: the path before
 * extensions and index files are tried), at most SPECIFIERS_MAX.
 */
export function importTargets(path: Path, text: string): string[] {
  const out = new Set<string>();
  for (const imp of importsOf(text)) {
    if (out.size >= SPECIFIERS_MAX) break;
    if (!isRelative(imp.specifier)) continue;
    const target = specifierTarget(path, imp.specifier);
    if (target !== null) out.add(target);
  }
  return [...out];
}

/** The trunk script file a specifier target resolves to with the decide stage's rules, or null (nothing, or not a script). */
export function resolveScript(target: string, exists: (p: Path) => boolean): Path | null {
  const file = resolveModule(target, exists);
  return file !== null && SCRIPT_FILE.test(file) ? file : null;
}

/**
 * Every specifier target whose resolution `path` takes part in (the targets whose
 * resolutionCandidates include it): when `path` appears or disappears, only specifiers with these
 * targets can resolve differently.
 */
export function dependentTargets(path: Path): string[] {
  const stems = new Set<string>([path]);
  for (const ext of RESOLVE_EXTS) if (path.length > ext.length && path.endsWith(ext)) stems.add(path.slice(0, -ext.length));
  const guesses = new Set<string>(stems);
  for (const stem of stems) for (const js of JS_EXTS) guesses.add(stem + js);
  const slash = path.lastIndexOf("/");
  if (path.slice(slash + 1).startsWith("index.")) guesses.add(slash === -1 ? "" : path.slice(0, slash));
  return [...guesses].filter((t) => resolutionCandidates(t).includes(path));
}

/**
 * Note one landing's changed paths for the import index (TrunkDO.finalizeRows calls this inside the
 * landing's transaction). Changed script files are re-read by the next sync, and a path that was
 * created or deleted is marked `moved`, so the specifiers whose resolution it takes part in are
 * resolved again. Nothing is marked before the index is first built, or when the landing does not
 * continue the trunk commit the index describes (the next sync then compares the whole index with
 * trunk). Never throws: the import index must not fail a landing.
 */
export function markLanded(sql: SqlStorage, parentSha: Sha, trunkSha: Sha, changes: Iterable<readonly [Path, LandedChange]>): void {
  try {
    // Until the first read creates the index (never, while FT_IMPORT_WEIGHT is off), there is nothing to mark.
    if (sql.exec("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'ft_imp_meta'").toArray().length === 0) return;
    const at = sql.exec<{ value: string }>("SELECT value FROM ft_imp_meta WHERE key = 'sha'").toArray()[0]?.value;
    if (at === undefined || at !== parentSha) return;
    for (const [path, c] of changes) {
      // A modification keeps the path's existence; anything else (or an old journal row without `before`) may not.
      const moved = typeof c?.blob === "string" && typeof c?.before === "string" ? 0 : 1;
      if (moved === 0 && !SCRIPT_FILE.test(path)) continue;
      sql.exec("INSERT INTO ft_imp_dirty (path, moved) VALUES (?, ?) ON CONFLICT(path) DO UPDATE SET moved = max(moved, excluded.moved)", path, moved);
    }
    sql.exec("INSERT OR REPLACE INTO ft_imp_meta (key, value) VALUES ('sha', ?)", trunkSha);
  } catch (e) {
    // The index's sha did not move, so the next sync compares the whole index with trunk.
    console.warn(`import index not marked for landing ${trunkSha}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Import links as repulsion neighbors (ColonyDO.take): each distinct import or importer of a path,
 * at weight 1, the path itself left out. Malformed entries are ignored.
 */
export function importNeighbors(links: Record<Path, ImportLinks> | null | undefined): Record<Path, Neighbor[]> {
  const out: Array<[Path, Neighbor[]]> = [];
  if (!links || typeof links !== "object") return {};
  for (const [path, l] of Object.entries(links)) {
    const seen = new Set<Path>();
    for (const list of [l?.imports, l?.importers]) {
      if (!Array.isArray(list)) continue;
      for (const p of list) if (typeof p === "string" && p !== "" && p !== path) seen.add(p);
    }
    if (seen.size > 0) out.push([path, [...seen].map((p) => ({ path: p, weight: 1 }))]);
  }
  // fromEntries defines own properties, so a path such as "__proto__" stays an ordinary key.
  return Object.fromEntries(out);
}

/** What a sync round planned for one changed path. */
type Plan = { path: Path; blob: Sha; size: number } | null;

/** A read and parsed file, or a failed read. */
type Parsed = { blob: Sha; targets: string[] | null } | "error";

/**
 * The import index in TrunkDO's SQLite storage. It reads the trunk index table (ft_files) for the
 * files of trunk; everything else is in its own tables. Stateless apart from them and the sync in
 * flight.
 */
export class ImportIndex {
  private running: Promise<ImportSyncResult> | null = null;
  private readonly caps: ImportCaps;

  constructor(
    private readonly sql: SqlStorage,
    private readonly transaction: (fn: () => void) => void,
    caps: Partial<ImportCaps> = {},
  ) {
    for (const stmt of IMPORT_SCHEMA) sql.exec(stmt);
    this.caps = { ...IMPORT_CAPS, ...caps };
  }

  /**
   * Bring the index up to date with the trunk index: build it on first use, then re-read the files
   * landings changed and resolve again what a path that appeared or disappeared changes. Single
   * flight: concurrent callers share one run. Stops at the time and byte budgets; what is left
   * waits for the next sync.
   */
  sync(source: ImportSource): Promise<ImportSyncResult> {
    if (!this.running) {
      this.running = this.run(source).finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  /**
   * For each path (at most IMPORT_PATHS_MAX), its direct imports and importers among trunk script
   * files, each sorted and at most `max` (at most IMPORT_LINKS_MAX). Paths with neither, directory
   * and glob entries, and paths past LINKS_TOTAL_MAX links in all are left out.
   */
  links(paths: Path[], max = IMPORT_LINKS_MAX): Record<Path, ImportLinks> {
    const limit = Math.max(1, Math.min(IMPORT_LINKS_MAX, Math.floor(Number.isFinite(max) ? max : IMPORT_LINKS_MAX)));
    const out: Array<[Path, ImportLinks]> = [];
    let total = 0;
    for (const path of new Set(paths.slice(0, IMPORT_PATHS_MAX))) {
      if (typeof path !== "string" || path === "" || PATTERN.test(path)) continue;
      const imports = this.sql
        .exec<{ p: string }>("SELECT DISTINCT dst AS p FROM ft_imp_edges WHERE src = ? AND dst IS NOT NULL AND dst != ? ORDER BY dst LIMIT ?", path, path, limit)
        .toArray()
        .map((r) => r.p);
      const importers = this.sql
        .exec<{ p: string }>("SELECT DISTINCT src AS p FROM ft_imp_edges WHERE dst = ? AND src != ? ORDER BY src LIMIT ?", path, path, limit)
        .toArray()
        .map((r) => r.p);
      if (imports.length + importers.length === 0) continue;
      total += imports.length + importers.length;
      if (total > LINKS_TOTAL_MAX) break;
      out.push([path, { imports, importers }]);
    }
    return Object.fromEntries(out);
  }

  /** Counts and the commit the index describes. */
  stats(): ImportStats {
    const n = (sql: string): number => this.sql.exec<{ n: number }>(sql).one().n;
    return {
      files: n("SELECT COUNT(*) AS n FROM ft_imp_files WHERE skipped = 0"),
      skipped: n("SELECT COUNT(*) AS n FROM ft_imp_files WHERE skipped != 0"),
      edges: n("SELECT COUNT(*) AS n FROM ft_imp_edges WHERE dst IS NOT NULL"),
      pending: n("SELECT COUNT(*) AS n FROM ft_imp_dirty"),
      sha: this.meta("sha"),
      resolving: this.meta("resolve_from") !== null,
    };
  }

  private async run(source: ImportSource): Promise<ImportSyncResult> {
    const start = Date.now();
    const out: ImportSyncResult = { read: 0, removed: 0, skipped: 0, resolved: 0, pending: 0, ms: 0 };
    const budget = { bytes: this.caps.budgetBytes };
    // One pass walks the changed paths in order; another follows only when the pass settled some
    // (paths left behind changed during their read, or arrived behind the cursor).
    let after = "";
    let settledInPass = 0;
    let compared = false;
    while (Date.now() - start <= this.caps.budgetMs) {
      const head = source.head();
      if (head === null) break;
      if (this.meta("sha") !== head) {
        this.reconcile(head);
        compared = true;
      }
      out.resolved += this.resolveSome();
      const batch = this.sql
        .exec<{ path: string }>("SELECT path FROM ft_imp_dirty WHERE path > ? ORDER BY path LIMIT ?", after, Math.max(1, Math.floor(this.caps.round)))
        .toArray()
        .map((r) => r.path);
      if (batch.length === 0) {
        if (this.meta("resolve_from") !== null) continue;
        if (after === "" || settledInPass === 0) break;
        after = "";
        settledInPass = 0;
        continue;
      }
      after = batch[batch.length - 1]!;
      settledInPass += await this.settle(batch, source, out, budget);
      if (budget.bytes <= 0) break;
    }
    out.pending = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM ft_imp_dirty").one().n;
    out.ms = Date.now() - start;
    // Builds, comparisons after trunk moved outside landings, slow runs and leftovers are logged; landing catch-ups are not.
    if (compared || out.pending > 0 || out.ms >= 1_000) {
      const s = this.stats();
      console.log(JSON.stringify({ ft: "imports-synced", colonyId: source.label ?? null, compared, ...out, files: s.files, skippedFiles: s.skipped, edges: s.edges, sha: s.sha }));
    }
    return out;
  }

  /**
   * Trunk moved outside the landing path, or the index was never built: mark every script file
   * whose blob the index does not hold and every indexed file trunk no longer has, so the next rounds
   * read or drop them. An index built before also resolves every stored edge again (resolveSome),
   * since files it does not track (data files, directories' index files) may have come or gone.
   */
  private reconcile(head: Sha): void {
    this.transaction(() => {
      const built = this.meta("sha") !== null;
      const changed = this.sql
        .exec<{ path: string }>("SELECT f.path AS path FROM ft_files f LEFT JOIN ft_imp_files i ON i.path = f.path WHERE i.path IS NULL OR i.blob != f.blob")
        .toArray();
      for (const r of changed) if (SCRIPT_FILE.test(r.path)) this.sql.exec("INSERT OR IGNORE INTO ft_imp_dirty (path, moved) VALUES (?, 0)", r.path);
      this.sql.exec("INSERT OR IGNORE INTO ft_imp_dirty (path, moved) SELECT i.path, 0 FROM ft_imp_files i WHERE NOT EXISTS (SELECT 1 FROM ft_files f WHERE f.path = i.path)");
      if (built) this.setMeta("resolve_from", "0");
      this.setMeta("sha", head);
    });
  }

  /** Resolve the next RESOLVE_CHUNK stored edges again, while a full re-resolution is pending. Returns the edges looked at. */
  private resolveSome(): number {
    if (this.meta("resolve_from") === null) return 0;
    let n = 0;
    this.transaction(() => {
      const from = this.meta("resolve_from");
      if (from === null) return;
      const rows = this.sql
        .exec<{ id: number; target: string; dst: string | null }>("SELECT rowid AS id, target, dst FROM ft_imp_edges WHERE rowid > ? ORDER BY rowid LIMIT ?", Number(from) || 0, RESOLVE_CHUNK)
        .toArray();
      this.update(rows, this.resolver());
      n = rows.length;
      if (rows.length < RESOLVE_CHUNK) this.sql.exec("DELETE FROM ft_imp_meta WHERE key = 'resolve_from'");
      else this.setMeta("resolve_from", String(rows[rows.length - 1]!.id));
    });
    return n;
  }

  /**
   * Settle a batch of changed paths: plan what each needs, read and parse the script files whose
   * blob changed, then apply everything in one transaction against trunk as it is then. A path whose
   * blob moved again while it was read, or whose read failed, stays marked. Returns paths settled.
   */
  private async settle(paths: Path[], source: ImportSource, out: ImportSyncResult, budget: { bytes: number }): Promise<number> {
    const plans = paths.map((path): Plan => {
      const cur = this.trunkFile(path);
      if (cur === null || !SCRIPT_FILE.test(path) || cur.size > this.caps.fileBytes) return null;
      return this.known(path)?.blob === cur.blob ? null : { path, blob: cur.blob, size: cur.size };
    });
    const reads = plans.filter((p): p is NonNullable<Plan> => p !== null);
    const parsed = new Map<Path, Parsed>();
    const decoder = new TextDecoder();
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < reads.length) {
        const r = reads[next++]!;
        if (budget.bytes <= 0) continue;
        budget.bytes -= Math.max(1, r.size);
        let data: Uint8Array | null;
        try {
          data = await source.read(r.blob);
        } catch {
          // Possibly transient: the path stays marked for the next sync.
          parsed.set(r.path, "error");
          continue;
        }
        let targets: string[] | null = null;
        try {
          if (data !== null) targets = importTargets(r.path, decoder.decode(data));
        } catch {
          // Unparseable: skipped like an unreadable blob until it changes.
        }
        parsed.set(r.path, { blob: r.blob, targets });
      }
    };
    await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, reads.length) }, worker));

    let settled = 0;
    this.transaction(() => {
      const resolve = this.resolver();
      const moved: Path[] = [];
      let indexed = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM ft_imp_files WHERE skipped = 0").one().n;
      for (const path of paths) {
        const cur = this.trunkFile(path);
        const known = this.known(path);
        if (cur === null || !SCRIPT_FILE.test(path)) {
          if (known) {
            this.drop(path);
            if (!known.skipped) indexed--;
            out.removed++;
          }
        } else if (known?.blob === cur.blob) {
          // Same content as indexed: nothing to read.
        } else if (cur.size > this.caps.fileBytes) {
          this.skip(path, cur.blob);
          if (known && !known.skipped) indexed--;
          out.skipped++;
        } else {
          const got = parsed.get(path);
          if (got === undefined || got === "error" || got.blob !== cur.blob) continue;
          if (got.targets === null || ((!known || known.skipped) && indexed >= this.caps.files)) {
            this.skip(path, cur.blob);
            if (known && !known.skipped) indexed--;
            out.skipped++;
          } else {
            this.write(path, cur.blob, got.targets, resolve);
            if (!known || known.skipped) indexed++;
            out.read++;
          }
        }
        const mark = this.sql.exec<{ moved: number }>("SELECT moved FROM ft_imp_dirty WHERE path = ?", path).toArray()[0];
        if (mark && mark.moved !== 0) moved.push(path);
        this.sql.exec("DELETE FROM ft_imp_dirty WHERE path = ?", path);
        settled++;
      }
      if (moved.length > 0) out.resolved += this.reresolve(moved, resolve);
    });
    return settled;
  }

  /** Resolve again the stored edges whose targets these paths take part in (they appeared or disappeared). Returns edges looked at. */
  private reresolve(paths: Path[], resolve: (target: string) => Path | null): number {
    const targets = new Set<string>();
    for (const p of paths) for (const t of dependentTargets(p)) targets.add(t);
    const list = [...targets];
    let n = 0;
    for (let i = 0; i < list.length; i += IN_CHUNK) {
      const rows = this.sql
        .exec<{ id: number; target: string; dst: string | null }>(
          "SELECT rowid AS id, target, dst FROM ft_imp_edges WHERE target IN (SELECT value FROM json_each(?))",
          JSON.stringify(list.slice(i, i + IN_CHUNK)),
        )
        .toArray();
      this.update(rows, resolve);
      n += rows.length;
    }
    return n;
  }

  /** Store each row's target resolved now, where it changed. */
  private update(rows: Array<{ id: number; target: string; dst: string | null }>, resolve: (target: string) => Path | null): void {
    for (const r of rows) {
      const dst = resolve(r.target);
      if (dst !== r.dst) this.sql.exec("UPDATE ft_imp_edges SET dst = ? WHERE rowid = ?", dst, r.id);
    }
  }

  /** Replace a file's edges with its targets resolved against trunk now. */
  private write(path: Path, blob: Sha, targets: string[], resolve: (target: string) => Path | null): void {
    this.sql.exec("DELETE FROM ft_imp_edges WHERE src = ?", path);
    for (const t of targets) this.sql.exec("INSERT OR IGNORE INTO ft_imp_edges (src, target, dst) VALUES (?, ?, ?)", path, t, resolve(t));
    this.sql.exec("INSERT OR REPLACE INTO ft_imp_files (path, blob, skipped) VALUES (?, ?, 0)", path, blob);
  }

  /** Keep a file out of the index at this blob (no edges), so it is not read again until it changes. */
  private skip(path: Path, blob: Sha): void {
    this.sql.exec("DELETE FROM ft_imp_edges WHERE src = ?", path);
    this.sql.exec("INSERT OR REPLACE INTO ft_imp_files (path, blob, skipped) VALUES (?, ?, 1)", path, blob);
  }

  private drop(path: Path): void {
    this.sql.exec("DELETE FROM ft_imp_edges WHERE src = ?", path);
    this.sql.exec("DELETE FROM ft_imp_files WHERE path = ?", path);
  }

  /**
   * Resolution against the trunk index as it is now, memoized: use it within one synchronous step
   * only (the trunk index can change at any await).
   */
  private resolver(): (target: string) => Path | null {
    const memo = new Map<string, Path | null>();
    const exists = (p: Path): boolean => this.sql.exec("SELECT 1 AS x FROM ft_files WHERE path = ?", p).toArray().length > 0;
    return (target) => {
      let dst = memo.get(target);
      if (dst === undefined) {
        dst = resolveScript(target, exists);
        memo.set(target, dst);
      }
      return dst;
    };
  }

  private trunkFile(path: Path): { blob: Sha; size: number } | null {
    return this.sql.exec<{ blob: string; size: number }>("SELECT blob, size FROM ft_files WHERE path = ?", path).toArray()[0] ?? null;
  }

  private known(path: Path): { blob: Sha; skipped: boolean } | null {
    const r = this.sql.exec<{ blob: string; skipped: number }>("SELECT blob, skipped FROM ft_imp_files WHERE path = ?", path).toArray()[0];
    return r ? { blob: r.blob, skipped: r.skipped !== 0 } : null;
  }

  private meta(key: string): string | null {
    return this.sql.exec<{ value: string }>("SELECT value FROM ft_imp_meta WHERE key = ?", key).toArray()[0]?.value ?? null;
  }

  private setMeta(key: string, value: string): void {
    this.sql.exec("INSERT OR REPLACE INTO ft_imp_meta (key, value) VALUES (?, ?)", key, value);
  }
}
