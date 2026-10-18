import type { CommitAuthor, Millis } from "@fire_trident/core";
import { ftError } from "./errors.ts";
import type { SqlRunner } from "./pause.ts";

/**
 * People as commit authors (no flag: nothing changes until a person sets one). Some teams want the accountable person as
 * the author of every commit, with agents named only in the lineage. A colony may name one person (POST
 * /api/colonies/:id/commit-author, `ft commit-author`); then each landing commit is authored by that person, the
 * committer stays FireTrident (so the FT-Note-Signature and the gpgsig header are made and checked exactly as before), and
 * agents get no Co-authored-by trailers. The lineage note is unchanged: it still names every agent, its model, its
 * provenance and the review receipt. Clearing the setting goes back to FireTrident as the author.
 *
 * Stored in the colony's own storage (`commit_author`, one row, also when cleared, so its time orders it). Each lane
 * reads it with its lineage context (ColonyDO.landContext `author`) and the trunk writer keeps the newest record it is
 * handed (trunk/commitauthor.ts), so a batch that came without one still lands with the setting in force.
 */

/** The colony's table: one row, `name` and `email` null once cleared. */
export const COMMIT_AUTHOR_SCHEMA =
  "CREATE TABLE IF NOT EXISTS commit_author (k INTEGER PRIMARY KEY CHECK (k = 1), name TEXT, email TEXT, by TEXT NOT NULL, at INTEGER NOT NULL)";

/** Longest name and address a commit author may have. */
export const MAX_AUTHOR_NAME = 100;
export const MAX_AUTHOR_EMAIL = 254;
/** Longest `by` kept. */
const MAX_BY = 200;

/** The record lanes pass to the trunk writer: the person in force, or `name: null` once cleared; `at` orders records. */
export type CommitAuthorRecord = { name: string; email: string; at: Millis } | { name: null; email: null; at: Millis };

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const EMAIL = /^[^\s@<>()",;:\\[\]]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

/**
 * Why a name and address cannot author a git commit, or null. A git identity line is `Name <email> time zone`, so neither
 * may hold angle brackets or control characters; the name has no leading or trailing space and the address is one
 * mailbox (local part, @, a domain with a dot).
 */
export function commitAuthorProblem(name: unknown, email: unknown): string | null {
  if (typeof name !== "string" || name.trim() === "") return "name the person: a name such as Dana Reviewer";
  if (name !== name.trim() || /\s{2,}/.test(name)) return "the name has spaces at its ends or in a row; write it as it should appear in git log";
  if (name.length > MAX_AUTHOR_NAME) return `the name is longer than ${MAX_AUTHOR_NAME} characters`;
  if (CONTROL.test(name) || /[<>]/.test(name)) return "the name may not hold angle brackets or control characters";
  if (typeof email !== "string" || email.trim() === "") return "give the person's email address: git names the author by it";
  if (email.length > MAX_AUTHOR_EMAIL || CONTROL.test(email) || !EMAIL.test(email)) return `${JSON.stringify(email.slice(0, 80))} is not one email address such as dana@example.com`;
  return null;
}

/** A record lanes passed, read defensively (the trunk writer checks it again): undefined when it is not one. */
export function parseCommitAuthorRecord(raw: unknown): CommitAuthorRecord | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  if (typeof o.at !== "number" || !Number.isFinite(o.at)) return undefined;
  if (o.name === null) return { name: null, email: null, at: o.at };
  if (commitAuthorProblem(o.name, o.email) !== null) return undefined;
  return { name: o.name as string, email: o.email as string, at: o.at };
}

type Row = { name: string | null; email: string | null; by: string; at: number };

/** The colony's commit author setting over its storage. */
export class CommitAuthors {
  constructor(private readonly sql: SqlRunner) {
    sql.exec(COMMIT_AUTHOR_SCHEMA);
  }

  private row(): Row | undefined {
    return this.sql.exec("SELECT name, email, by, at FROM commit_author WHERE k = 1").toArray()[0] as Row | undefined;
  }

  /** The person in force, or null (never set, or cleared). */
  get(): CommitAuthor | null {
    const r = this.row();
    if (!r || r.name === null || r.email === null) return null;
    return { name: r.name, email: r.email, by: r.by, at: r.at };
  }

  /** The record a lane hands the trunk writer; undefined when the colony never set one (the writer keeps what it has). */
  record(): CommitAuthorRecord | undefined {
    const r = this.row();
    if (!r) return undefined;
    return r.name === null || r.email === null ? { name: null, email: null, at: r.at } : { name: r.name, email: r.email, at: r.at };
  }

  /** Name the person who authors the colony's landing commits from now on (400 with what to fix when git cannot use it). */
  set(p: { name?: unknown; email?: unknown; by: string }, now: Millis): CommitAuthor {
    const problem = commitAuthorProblem(p.name, p.email);
    if (problem) throw ftError(400, `${problem}. Send { "name": "Dana Reviewer", "email": "dana@example.com" }, or { "name": null } to go back to FireTrident as the author.`);
    const at = this.next(now);
    const by = p.by.slice(0, MAX_BY);
    this.sql.exec("INSERT OR REPLACE INTO commit_author (k, name, email, by, at) VALUES (1, ?, ?, ?, ?)", p.name as string, p.email as string, by, at);
    return { name: p.name as string, email: p.email as string, by, at };
  }

  /** Go back to FireTrident as the author. Returns whether a person was named before. */
  clear(by: string, now: Millis): boolean {
    const was = this.get() !== null;
    this.sql.exec("INSERT OR REPLACE INTO commit_author (k, name, email, by, at) VALUES (1, NULL, NULL, ?, ?)", by.slice(0, MAX_BY), this.next(now));
    return was;
  }

  /** A time after the stored one, so the newest record always wins at the trunk writer even within one millisecond. */
  private next(now: Millis): Millis {
    const prev = this.row()?.at ?? 0;
    return Math.max(now, prev + 1);
  }
}
