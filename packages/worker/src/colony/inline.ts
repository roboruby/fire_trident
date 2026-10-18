import type { Id, Proposal, ProposalStatus, Sha } from "@fire_trident/core";
import { INLINE_LIMITS, changesetId, inlineProblem, revalidationEnabled } from "@fire_trident/core";

/**
 * Inline changes at the colony (core/changeset.ts): a proposal that carries the text of every file it writes
 * instead of a commit pushed to its workspace. The colony checks the contents when the proposal arrives and keeps
 * them in their own table, apart from the proposal row, so lanes, inboxes, snapshots and the trunk writer's queue
 * never carry file text. The decide stage reads them where it would read the workspace, the trunk writer fetches
 * them in one call per landing cycle, and they go once the proposal has settled: at landing (trunk holds the blobs
 * then), or CONTENTS_GRACE_MS after it went back or was rejected.
 */

/** Text one trunk-writer fetch returns at most (UTF-8 bytes): its answer stays far under the 32 MiB RPC limit, whatever the strings' encoding. */
export const INLINE_FETCH_BYTES = 8 * 1024 * 1024;
/**
 * How long a change that went back or was rejected keeps its contents. A landing cycle that read the direction
 * before a person withdrew or amended the intent still lands the change (the direction fence), and an antibody
 * minted from a rejection reads the change: both happen well within this.
 */
export const CONTENTS_GRACE_MS = 10 * 60_000;
/** Proposals one fetch looks up at most (a landing cycle holds at most 200). */
const FETCH_MAX_IDS = 1_000;
/** The sweep of contents past their grace runs at most this often. */
const SWEEP_EVERY_MS = 60_000;

const ENCODER = new TextEncoder();

/**
 * FT_INLINE: whether this colony takes inline changes from outside (`contents` on POST /proposals, `files` on MCP
 * propose): "on", or a comma-separated list of colony ids; off when absent.
 */
export function inlineEnabled(setting: string | undefined, colonyId: Id): boolean {
  return revalidationEnabled(setting, colonyId);
}

/** Whether FT_INLINE turns inline changes on for any colony (the MCP server then offers `files` and says so). */
export function inlineOffered(setting: string | undefined): boolean {
  const s = typeof setting === "string" ? setting.trim() : "";
  if (s === "" || s.toLowerCase() === "off") return false;
  return s.toLowerCase() === "on" || s.split(",").some((id) => id.trim() !== "");
}

/**
 * Whether a proposal is an inline change: its head is the changeset id of its base and write set, which a pushed
 * commit's id never is. A change writing more files than an inline change may is never one.
 */
export function isInlineChange(p: Pick<Proposal, "baseSha" | "headSha" | "writeSet">): boolean {
  if (!p || typeof p.headSha !== "string" || typeof p.baseSha !== "string" || !Array.isArray(p.writeSet)) return false;
  if (p.writeSet.filter((w) => w?.blob !== null).length > INLINE_LIMITS.files) return false;
  try {
    return p.headSha === changesetId(p.baseSha, p.writeSet);
  } catch {
    return false;
  }
}

/**
 * Why an inline change cannot be accepted, or null when it can: its contents pass core's check (every written blob
 * has its text, each text hashes to its blob id, no NUL byte, nothing extra, within INLINE_LIMITS) and its head is
 * the changeset id of its base and write set.
 */
export function inlineRefusal(p: Pick<Proposal, "baseSha" | "headSha" | "writeSet">, contents: unknown): string | null {
  if (!contents || typeof contents !== "object" || Array.isArray(contents)) return "contents must map the blob id of every file written to its text";
  const problem = inlineProblem(p.writeSet, contents as Record<string, unknown>);
  if (problem) return problem;
  const id = changesetId(p.baseSha, p.writeSet);
  if (p.headSha !== id) return `the head of an inline change is the changeset id of its base and write set (${id}), not ${p.headSha}`;
  return null;
}

/** The SQL the store runs (a Durable Object's storage, or node:sqlite in unit tests). */
export interface SqlRunner {
  exec(query: string, ...bindings: unknown[]): { toArray(): unknown[] };
}

/** Create the contents table (additive: nothing existing is touched). */
export function migrateContents(sql: SqlRunner): void {
  sql.exec(
    `CREATE TABLE IF NOT EXISTS proposal_contents (
      proposal_id TEXT NOT NULL, blob TEXT NOT NULL, text TEXT NOT NULL, bytes INTEGER NOT NULL, settled_at INTEGER,
      PRIMARY KEY (proposal_id, blob))`,
  );
  sql.exec("CREATE INDEX IF NOT EXISTS proposal_contents_by_settled ON proposal_contents(settled_at) WHERE settled_at IS NOT NULL");
}

/** The contents of a colony's inline changes, one row per text (see the module comment). */
export class InlineContents {
  private lastSweep = 0;

  constructor(private readonly sql: SqlRunner) {}

  /** Keep an accepted change's texts (checked by inlineRefusal first). */
  put(proposalId: Id, contents: Readonly<Record<Sha, string>>): void {
    for (const [blob, text] of Object.entries(contents)) {
      this.sql.exec(
        "INSERT OR REPLACE INTO proposal_contents (proposal_id, blob, text, bytes, settled_at) VALUES (?, ?, ?, ?, NULL)",
        proposalId,
        blob,
        text,
        ENCODER.encode(text).length,
      );
    }
  }

  /** A change's texts by blob id; null when none are kept (gone, or it writes no text). */
  get(proposalId: Id): Record<Sha, string> | null {
    const rows = this.sql.exec("SELECT blob, text FROM proposal_contents WHERE proposal_id = ?", proposalId).toArray() as Array<{ blob: string; text: string }>;
    return rows.length === 0 ? null : Object.fromEntries(rows.map((r) => [r.blob, r.text]));
  }

  /**
   * A change settled. Landed, or already on trunk (FT_ALREADY_ON_TRUNK): its texts go now (trunk holds its blobs). Sent
   * back or rejected: they stay CONTENTS_GRACE_MS from the first time it settled, then sweep() removes them.
   */
  settle(proposalId: Id, status: ProposalStatus, now: number): void {
    if (status === "landed" || status === "already_on_trunk") this.sql.exec("DELETE FROM proposal_contents WHERE proposal_id = ?", proposalId);
    else if (status === "returned" || status === "rejected") this.sql.exec("UPDATE proposal_contents SET settled_at = ? WHERE proposal_id = ? AND settled_at IS NULL", now, proposalId);
  }

  /** Remove the texts of changes that settled more than CONTENTS_GRACE_MS ago (at most every minute unless `force`). */
  sweep(now: number, force = false): void {
    if (!force && now - this.lastSweep < SWEEP_EVERY_MS) return;
    this.lastSweep = now;
    this.sql.exec("DELETE FROM proposal_contents WHERE settled_at IS NOT NULL AND settled_at <= ?", now - CONTENTS_GRACE_MS);
  }

  /**
   * Texts for the trunk writer, by proposal id then blob id, in the order asked: at most `maxBytes` of text (always
   * at least one change), the ids past the budget in `more` for the next call. Sizes are read first, so texts past
   * the budget never leave storage. An id with nothing kept is in neither.
   */
  fetch(ids: readonly Id[], maxBytes = INLINE_FETCH_BYTES): { contents: Record<Id, Record<Sha, string>>; more: Id[] } {
    const wanted = [...new Set(ids.filter((x): x is Id => typeof x === "string" && x !== ""))].slice(0, FETCH_MAX_IDS);
    if (wanted.length === 0) return { contents: {}, more: [] };
    const sized = this.sql
      .exec("SELECT proposal_id AS id, SUM(bytes) AS n FROM proposal_contents WHERE proposal_id IN (SELECT value FROM json_each(?)) GROUP BY proposal_id", JSON.stringify(wanted))
      .toArray() as Array<{ id: string; n: number }>;
    const sizes = new Map(sized.map((r) => [r.id, Number(r.n)]));
    const take: Id[] = [];
    const more: Id[] = [];
    let left = maxBytes;
    for (const id of wanted) {
      const n = sizes.get(id);
      if (n === undefined) continue;
      if (more.length > 0 || (take.length > 0 && n > left)) {
        more.push(id);
        continue;
      }
      take.push(id);
      left -= n;
    }
    const byProposal = new Map<Id, Map<Sha, string>>();
    if (take.length > 0) {
      const rows = this.sql
        .exec("SELECT proposal_id AS id, blob, text FROM proposal_contents WHERE proposal_id IN (SELECT value FROM json_each(?))", JSON.stringify(take))
        .toArray() as Array<{ id: string; blob: string; text: string }>;
      for (const r of rows) {
        const texts = byProposal.get(r.id) ?? new Map<Sha, string>();
        texts.set(r.blob, r.text);
        byProposal.set(r.id, texts);
      }
    }
    // Built with fromEntries: an id is only ever an own key, whatever it is.
    return { contents: Object.fromEntries([...byProposal].map(([id, texts]) => [id, Object.fromEntries(texts)])), more };
  }
}
