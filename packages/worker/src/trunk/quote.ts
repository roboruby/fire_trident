import { mergeContentProblem } from "@fire_trident/core";
import type { ContestedRegion, Id, Path, Sha } from "@fire_trident/core";
import { diffLines, renderHunks, splitLines } from "../decide/diff.ts";
import { HUNK_LINES, cutDiff, cutRegions, firstLines } from "../colony/hunks.ts";
import { mergeSides } from "../colony/resolver-merge.ts";
import { CONFLICT_ASKS, HUNK_ASKS, type ReturnHunksAnswer, type ReturnHunksQuery } from "../colony/returnhunks.ts";
import { maskSecrets } from "./mask.ts";

/**
 * Return hunks (FT_RETURN_HUNKS, colony/returnhunks.ts), the trunk writer's part (TrunkDO.returnHunks): the quotes a
 * returned change carries. For each (landing, file) asked, the landing's change to the file: its blobs before and after
 * from the landing log (ft_landing_paths, which `why` reads), both versions read from the blob store, diffed as review
 * diffs are (decide/diff.ts: unified hunks, two lines of context). For each text merge conflict asked, its contested
 * regions: the change's base, the version it would have landed on and its own, split as the conflict resolver splits
 * them (colony/resolver-merge.ts mergeSides: the same line diff and region rules as core/textmerge.ts), the regions the
 * conflict named kept. Each quote is cut to HUNK_LINES lines and masked where a line looks like a secret (trunk/mask.ts).
 *
 * Read only and bounded: at most HUNK_ASKS diffs and CONFLICT_ASKS conflicts, versions of at most 512 KB that are UTF-8
 * text (core mergeContentProblem), and the budget the colony gives (at most QUOTE_MAX_MS): past it, nothing more is read
 * and what is done is answered. A file that cannot be read, is not text, or was not changed by the landing is left out.
 */

/** The longest budget the writer accepts, in ms, whatever the colony asks. */
export const QUOTE_MAX_MS = 2_000;

/** What a quote reads (TrunkDO: its landing log and blob store; tests fake it). */
export interface QuoteSource {
  /** The commit landing `landingId` made, and the blobs it left `path` with before and after it (null: absent); null when it did not change the path. */
  landingPath(landingId: Id, path: Path): { trunkSha: Sha; before: Sha | null; after: Sha | null } | null;
  /** A blob's bytes, or null when it cannot be read. */
  read(blob: Sha): Promise<Uint8Array | string | null>;
  now(): number;
}

/** The SQL a quote source runs (the trunk writer's storage). */
interface QuoteSql {
  exec<T extends Record<string, SqlStorageValue>>(query: string, ...bindings: unknown[]): { toArray(): T[] };
}

/** A quote source over the trunk writer's tables: ft_landing_paths joined to ft_landings for the commit. */
export function sqlQuoteSource(sql: QuoteSql, read: (blob: Sha) => Promise<Uint8Array | null>, now: () => number = Date.now): QuoteSource {
  return {
    landingPath: (landingId, path) => {
      const row = sql
        .exec<{ trunk_sha: string; before_blob: string | null; after_blob: string | null }>(
          `SELECT l.trunk_sha AS trunk_sha, lp.before_blob AS before_blob, lp.after_blob AS after_blob
             FROM ft_landing_paths lp JOIN ft_landings l ON l.seq = lp.seq
            WHERE lp.path = ? AND lp.landing_id = ? LIMIT 1`,
          path,
          landingId,
        )
        .toArray()[0];
      return row ? { trunkSha: row.trunk_sha, before: row.before_blob, after: row.after_blob } : null;
    },
    read,
    now,
  };
}

/** Lines without their endings. */
function bare(lines: readonly string[]): string[] {
  return lines.map((l) => l.replace(/\r?\n$/, ""));
}

/** One side of a region, masked as one text (a private key block spans lines). */
function maskedSide(lines: readonly string[]): string[] {
  return lines.length === 0 ? [] : maskSecrets(bare(lines).join("\n")).split("\n");
}

/** The quotes asked for (see the module comment): what could be read and computed within the budget. Never throws. */
export async function quoteReturns(src: QuoteSource, q: ReturnHunksQuery): Promise<ReturnHunksAnswer> {
  const out: ReturnHunksAnswer = { diffs: [], conflicts: [] };
  const budget = Math.min(QUOTE_MAX_MS, Math.max(0, Number.isFinite(q?.budgetMs) ? q.budgetMs : 0));
  const deadline = src.now() + budget;
  const late = (): boolean => src.now() >= deadline;
  const texts = new Map<Sha, string | null>();
  // A version's text (null: not readable as text, or past the budget). Fatal and BOM-keeping, like the text merge reads.
  const text = async (blob: Sha): Promise<string | null> => {
    if (texts.has(blob)) return texts.get(blob)!;
    if (late()) return null;
    let t: string | null = null;
    try {
      const data = await src.read(blob);
      if (typeof data === "string") t = mergeContentProblem([data]) === null ? data : null;
      else if (data) t = mergeContentProblem([data]) === null ? new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data) : null;
    } catch {
      t = null;
    }
    texts.set(blob, t);
    return t;
  };

  // Contested regions first: they are where the change itself collided.
  for (const c of (Array.isArray(q?.conflicts) ? q.conflicts : []).slice(0, CONFLICT_ASKS)) {
    if (late()) break;
    try {
      const [base, ours, theirs] = [await text(c.base), await text(c.trunk), await text(c.theirs)];
      if (base === null || ours === null || theirs === null) continue;
      const merge = mergeSides(base, ours, theirs);
      if (merge.clean || merge.limited) continue;
      const named = new Set(Array.isArray(c.lines) ? c.lines : []);
      const regions: ContestedRegion[] = merge.conflicts
        .filter((r) => named.size === 0 || named.has(r.line))
        .map((r) => ({ path: c.path, line: r.line, base: maskedSide(r.base), trunk: maskedSide(r.ours), own: maskedSide(r.theirs) }));
      const kept = cutRegions(regions, HUNK_LINES);
      if (kept.length > 0) out.conflicts.push({ path: c.path, base: c.base, trunk: c.trunk, theirs: c.theirs, regions: kept });
    } catch (err) {
      console.warn(`return hunks: the conflict on ${c?.path} was not quoted: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  for (const d of (Array.isArray(q?.diffs) ? q.diffs : []).slice(0, HUNK_ASKS)) {
    if (late()) break;
    try {
      const lp = src.landingPath(d.landingId, d.path);
      if (!lp || lp.before === lp.after) continue;
      const was = lp.before === null ? "" : await text(lp.before);
      const now = lp.after === null ? "" : await text(lp.after);
      if (was === null || now === null) continue;
      const hunks = renderHunks(diffLines(splitLines(was), splitLines(now)), 2);
      if (hunks === "") continue;
      // Masked before lines are cut to length, so a secret is never cut short of what the detector recognizes.
      const lines = hunks.split("\n", HUNK_LINES + 1).length;
      const cut = cutDiff(maskSecrets(firstLines(hunks, HUNK_LINES)), HUNK_LINES, lines > HUNK_LINES);
      out.diffs.push({ landingId: d.landingId, path: d.path, trunkSha: lp.trunkSha, diff: cut.diff, truncated: cut.truncated });
    } catch (err) {
      console.warn(`return hunks: ${d?.path} of ${d?.landingId} was not quoted: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}
