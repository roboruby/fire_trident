import git from "isomorphic-git";
import type { Id, NoteCheck, NoteMainCheck, NotesVerification, Sha } from "@fire_trident/core";
import { errorText, type GitRepo } from "../artifacts/git.ts";
import { flagLateSignatures } from "./commitsig.ts";
import { summarize, type ObjectSource, type SourcePerson } from "./verify.ts";

/**
 * Landings against the trunk repository's main, as its git endpoint advertises it (refs/heads/main in the ref
 * advertisement the trunk writer already reads for the notes ref). A landing check (trunk/verify.ts) reads the trunk
 * writer's own record of each landing, so a history rewritten on the trunk repository (an operator's force-push) leaves
 * every recorded commit readable and every note intact. This says, for each landing, whether main still reaches its
 * commit: main's first-parent chain is read from the advertised tip (the local repository first, then the Artifacts read
 * path for what it does not have), and kept between checks, so a later check reads only the commits main gained.
 *
 * A walk stops as soon as it has met every landing asked about, or a commit older than all of them (the parent of the
 * oldest, or one of the landings recorded just before it): a landing not met above that point is not on main's
 * first-parent chain. The other parents of any merge commit above that point are walked too, so the answer is git's own
 * reachability (`git merge-base --is-ancestor`). The walk is bounded by how deep the landings should sit (the landings
 * recorded after them) plus a margin, and by WALK_MAX in all. For a landing main no longer reaches, the commits main now
 * holds above that point are searched for one carrying the same FT-Landing trailer, and what differs from the recorded
 * commit (its message, author, committer, files or parent) is said. Read only.
 */

/** Commits one walk holds at most; past it a landing is not checked. */
export const WALK_MAX = 20_000;
/** Commits read beyond how deep the landings should sit before a walk gives up. */
const MARGIN = 256;
/** Commits read from one place at a time. */
const BATCH = 1000;
/** Commits read first from a tip that may have moved only a little past the one read before. */
const AHEAD = 8;
/** Landings recorded just before the oldest one asked about, whose commits stop the walk. */
const STOPS = 16;
/** Commits above the stopping point searched for a landing's replacement at most. */
const SEARCH_MAX = 64;

/** One commit of main's history: its id and its parents. */
export interface MainCommit {
  hash: Sha;
  parents: Sha[];
}

/**
 * Main's history from one place: the first-parent chain from `from` (included), newest first, at most `limit` commits;
 * fewer when the chain reaches its first commit, or when this place does not have the next one.
 */
export interface MainSource {
  chain(from: Sha, limit: number): Promise<MainCommit[]>;
}

/** The local repository as a history source (isomorphic-git; it stops at the first commit it does not have). */
export function localMain(repo: GitRepo): MainSource {
  return {
    async chain(from, limit) {
      const out: MainCommit[] = [];
      let at: Sha | undefined = from;
      while (at !== undefined && out.length < limit) {
        let parents: string[];
        try {
          parents = (await git.readCommit({ fs: repo.fs, dir: repo.dir, oid: at, cache: repo.cache })).commit.parent;
        } catch (e) {
          if ((e as { code?: string } | null)?.code === "NotFoundError") break;
          throw e;
        }
        out.push({ hash: at, parents });
        at = parents[0];
      }
      return out;
    },
  };
}

/** The trunk repository through the Artifacts binding (its first-parent log, up to 1000 commits a call; the handle opened on first use by `open`). */
export function bindingMain(open: () => Promise<ArtifactsRepo>): MainSource {
  return {
    async chain(from, limit) {
      const log = await (await open()).log({ ref: from, limit: Math.max(1, Math.min(BATCH, limit)) });
      return log.map((c) => ({ hash: c.hash, parents: Array.isArray(c.parents) ? c.parents : [] }));
    },
  };
}

/** `first`, then `second` from the first commit `first` does not have. */
export function layeredMain(first: MainSource, second: MainSource): MainSource {
  return {
    async chain(from, limit) {
      const got = await first.chain(from, limit).catch(() => [] as MainCommit[]);
      const next = got.length === 0 ? from : got[got.length - 1]!.parents[0];
      if (got.length >= limit || next === undefined) return got;
      return [...got, ...(await second.chain(next, limit - got.length))];
    },
  };
}

/** How far a walk of main's first-parent chain got: `root` (its first commit), `missing` (its next commit could not be read), or null (there is more). */
type End = "root" | "missing" | null;

/** Main's first-parent chain as far as it was read from one tip, kept by the trunk writer between checks. */
export class MainWalk {
  private tip: Sha | null = null;
  private chain: MainCommit[] = [];
  private index = new Map<Sha, number>();
  private end: End = null;
  /** The previous tip's chain, taken over when the new tip's chain reaches it (main moved forward). */
  private earlier: { chain: MainCommit[]; end: End } | null = null;

  /**
   * Read main's chain from `tip` until `enough` (given the commits read, by id with their depth) says they answer the
   * question, the chain ends, or `max` commits are held; `hint` is how many commits the first read asks for (as deep as
   * the answer should sit), so a check reads no deeper than it needs.
   */
  async read(tip: Sha, src: MainSource, enough: (index: ReadonlyMap<Sha, number>) => boolean, max: number, hint = BATCH): Promise<{ chain: readonly MainCommit[]; index: ReadonlyMap<Sha, number>; end: End }> {
    if (this.tip !== tip) {
      this.earlier = this.tip !== null && this.chain.length > 0 ? { chain: this.chain, end: this.end } : null;
      this.tip = tip;
      this.chain = [];
      this.index = new Map();
      this.end = null;
    }
    // A commit that could not be read is asked for again (the binding may have been down).
    if (this.end === "missing") this.end = null;
    // From a new tip with an earlier one kept, a few commits first: main has usually gained only a few since.
    let size = this.earlier ? AHEAD : Math.max(1, hint);
    while (this.end === null && this.chain.length < max && !enough(this.index)) {
      const last = this.chain[this.chain.length - 1];
      const from = last === undefined ? tip : last.parents[0];
      if (from === undefined) {
        this.end = "root";
        break;
      }
      const batch = await src.chain(from, Math.min(BATCH, size, max - this.chain.length));
      size = BATCH;
      if (batch.length === 0 || batch[0]!.hash !== from) {
        this.end = "missing";
        break;
      }
      for (const c of batch) {
        if (this.earlier && c.hash === this.earlier.chain[0]?.hash) {
          // The previous tip: main moved forward, and what was read below it still holds.
          const kept = this.earlier.chain.slice(0, Math.max(0, WALK_MAX - this.chain.length));
          for (const e of kept) this.push(e);
          if (kept.length === this.earlier.chain.length) this.end = this.earlier.end;
          this.earlier = null;
          break;
        }
        this.push(c);
      }
      if (this.end === null && this.chain[this.chain.length - 1]?.parents.length === 0) this.end = "root";
    }
    return { chain: this.chain, index: this.index, end: this.end };
  }

  private push(c: MainCommit): void {
    if (this.index.has(c.hash)) return;
    this.index.set(c.hash, this.chain.length);
    this.chain.push(c);
  }
}

/** A landing to place on main: its commit, and whether it is recorded but not published yet. */
export interface MainTarget {
  landingId: Id;
  sha: Sha;
  unpublished: boolean;
}

/**
 * Each target's place on main from `tip`: `stops` are commits older than every target, `depth` how many commits should
 * sit above the oldest target. Commits main holds above the stopping point (at most SEARCH_MAX) are returned for the
 * search of a dropped landing's replacement.
 */
export async function placeOnMain(targets: readonly MainTarget[], p: { tip: Sha | null; src: MainSource; walk: MainWalk; stops: ReadonlySet<Sha>; depth: number }): Promise<{ checks: Map<Id, NoteMainCheck>; above: Sha[] }> {
  const out = new Map<Id, NoteMainCheck>();
  const left = (): MainTarget[] => targets.filter((t) => !out.has(t.landingId));
  const settle = (status: NoteMainCheck["status"], detail?: string): void => {
    for (const t of left()) out.set(t.landingId, t.unpublished ? { status: "pending" } : { status, ...(detail ? { detail } : {}) });
  };
  if (targets.length === 0) return { checks: out, above: [] };
  if (p.tip === null) {
    settle("dropped", "the trunk repository has no main branch, so main does not reach this landing's commit");
    return { checks: out, above: [] };
  }
  const tip = p.tip;
  const wanted = new Set(targets.map((t) => t.sha));
  const max = Math.min(WALK_MAX, p.depth + MARGIN);
  const enough = (index: ReadonlyMap<Sha, number>): boolean => [...wanted].every((s) => index.has(s)) || [...p.stops].some((s) => index.has(s));
  // The first read asks for as many commits as should sit above the oldest target, plus it and the commit below it.
  const view = await p.walk.read(tip, p.src, enough, max, p.depth + 2);
  for (const t of targets) if (view.index.has(t.sha)) out.set(t.landingId, { status: "on-main" });
  let stopAt = view.chain.length;
  for (const s of p.stops) stopAt = Math.min(stopAt, view.index.get(s) ?? stopAt);
  const above = view.chain.slice(0, Math.min(stopAt, SEARCH_MAX)).map((c) => c.hash);
  if (left().length === 0) return { checks: out, above };

  // Merge commits above the stopping point: their other parents may still reach a target (git's reachability).
  let budget = Math.max(0, WALK_MAX - view.chain.length);
  const queue = view.chain.slice(0, stopAt).flatMap((c) => c.parents.slice(1));
  const seen = new Set<Sha>();
  let cut = false;
  while (queue.length > 0 && left().length > 0) {
    const from = queue.shift()!;
    if (seen.has(from) || view.index.has(from) || p.stops.has(from)) continue;
    if (budget <= 0) {
      cut = true;
      break;
    }
    const side = await p.src.chain(from, Math.min(BATCH, budget));
    if (side.length === 0) {
      cut = true;
      continue;
    }
    for (const c of side) {
      if (seen.has(c.hash) || view.index.has(c.hash) || p.stops.has(c.hash)) break;
      seen.add(c.hash);
      budget--;
      if (wanted.has(c.hash)) for (const t of targets) if (t.sha === c.hash) out.set(t.landingId, { status: "on-main" });
      queue.push(...c.parents.slice(1));
      if (c === side[side.length - 1] && c.parents[0] !== undefined) queue.push(c.parents[0]);
    }
  }
  if (left().length === 0) return { checks: out, above };

  const short = tip.slice(0, 12);
  if (cut) settle("unchecked", `main (at ${short}) merges in history that could not be read far enough to tell whether it reaches this landing's commit`);
  else if (stopAt < view.chain.length || view.end === "root") settle("dropped", `main (at ${short}) no longer reaches this landing's commit: it was dropped from main, or main was rewritten`);
  else if (view.end === "missing") settle("unchecked", `main's history (at ${short}) could not be read past ${view.chain[view.chain.length - 1]?.hash.slice(0, 12) ?? short}, so whether it reaches this landing's commit is not known`);
  else if (p.depth + MARGIN > WALK_MAX) settle("unchecked", `this landing sits about ${p.depth.toLocaleString("en-US")} commits below main's tip, deeper than one check reads (${WALK_MAX.toLocaleString("en-US")}); check a clone with ft verify --all`);
  else settle("dropped", `main's newest ${view.chain.length.toLocaleString("en-US")} commits (from ${short}) reach neither this landing's commit nor the landings recorded before it: main was rewritten, or commits FireTrident did not write were pushed on top of it`);
  return { checks: out, above };
}

/** What a commit on main that carries a landing's FT-Landing trailer changed from the landing's recorded commit, in words ("its message and author"), or null when it is the same in every field read. */
export function changedFields(was: Awaited<ReturnType<ObjectSource["commit"]>>, now: Awaited<ReturnType<ObjectSource["commit"]>>): string | null {
  if (!was || !now) return null;
  const same = (a: SourcePerson | undefined, b: SourcePerson | undefined): { who: boolean; when: boolean } => ({
    who: !a || !b || (a.name === b.name && a.email === b.email),
    when: !a || !b || a.at === undefined || b.at === undefined || a.at === b.at,
  });
  const parts: string[] = [];
  if (was.message.replace(/\n+$/, "") !== now.message.replace(/\n+$/, "")) parts.push(trailersOnly(was.message, now.message) ? "its trailers" : "its message");
  const author = same(was.author, now.author);
  const committer = same(was.committer, now.committer);
  if (!author.who) parts.push("its author");
  if (!author.when) parts.push("its author date");
  if (!committer.who) parts.push("its committer");
  if (!committer.when) parts.push("its commit date");
  if (was.tree !== now.tree) parts.push("its files");
  if (Array.isArray(was.parents) && Array.isArray(now.parents) && was.parents.join(" ") !== now.parents.join(" ")) parts.push("its parent");
  if (parts.length === 0) return null;
  return parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** Whether two commit messages differ only in their last paragraph (the trailers). */
function trailersOnly(a: string, b: string): boolean {
  const body = (m: string): string => {
    const t = m.replace(/\n+$/, "");
    const i = t.lastIndexOf("\n\n");
    return i < 0 ? "" : t.slice(0, i);
  };
  return body(a) !== "" && body(a) === body(b);
}

/**
 * `checks` (newest first) with each landing's place on main: a landing main no longer reaches becomes `dropped`, with
 * why in words (and the commit that now stands for it, and what changed, when main carries one). Reads the trunk
 * writer's tables (ft_landings, ft_journal) for where each landing should sit, `tip` for main as the trunk repository
 * advertises it (a failure leaves every landing unchecked), `history` for main's commits and `src` for the commits
 * compared. Returns the main tip it checked against.
 */
export async function checkMain(checks: NoteCheck[], p: { sql: SqlStorage; tip: () => Promise<Sha | null>; history: MainSource; src: ObjectSource; walk: MainWalk }): Promise<{ checks: NoteCheck[]; tip: Sha | null | undefined }> {
  if (checks.length === 0) return { checks, tip: undefined };
  let tip: Sha | null;
  try {
    tip = await p.tip();
  } catch (e) {
    const main: NoteMainCheck = { status: "unchecked", detail: `main could not be read from the trunk repository: ${errorText(e)}` };
    return { checks: checks.map((c) => ({ ...c, main })), tip: undefined };
  }
  const ids = JSON.stringify(checks.map((c) => c.landingId));
  const rows = p.sql
    .exec<{ id: string; seq: number; parent_sha: string }>(`SELECT id, seq, parent_sha FROM ft_landings WHERE id IN (SELECT value FROM json_each(?))`, ids)
    .toArray();
  const unpublished = new Set(
    p.sql
      .exec<{ landing_id: string }>(`SELECT landing_id FROM ft_journal WHERE state IN ('recorded', 'pushing') AND landing_id IN (SELECT value FROM json_each(?))`, ids)
      .toArray()
      .map((r) => r.landing_id),
  );
  const oldest = rows.reduce<(typeof rows)[number] | null>((o, r) => (o === null || r.seq < o.seq ? r : o), null);
  const stops = new Set<Sha>();
  let depth = 0;
  if (oldest) {
    if (oldest.parent_sha) stops.add(oldest.parent_sha);
    for (const r of p.sql.exec<{ trunk_sha: string }>(`SELECT trunk_sha FROM ft_landings WHERE seq < ? ORDER BY seq DESC LIMIT ?`, oldest.seq, STOPS).toArray()) stops.add(r.trunk_sha);
    depth = p.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ft_landings WHERE seq > ?`, oldest.seq).one().n;
  }
  for (const c of checks) stops.delete(c.trunkSha);
  const targets = checks.map((c) => ({ landingId: c.landingId, sha: c.trunkSha, unpublished: unpublished.has(c.landingId) }));
  let placed: Awaited<ReturnType<typeof placeOnMain>>;
  try {
    placed = await placeOnMain(targets, { tip, src: p.history, walk: p.walk, stops, depth });
  } catch (e) {
    const main: NoteMainCheck = { status: "unchecked", detail: `main's history could not be read: ${errorText(e)}` };
    return { checks: checks.map((c) => ({ ...c, main })), tip };
  }
  const dropped = checks.filter((c) => placed.checks.get(c.landingId)?.status === "dropped");
  const replaced = dropped.length > 0 ? await replacements(dropped, placed.above, p.src) : new Map<Id, { sha: Sha; changed: string | null }>();
  return {
    tip,
    checks: checks.map((c) => {
      let main = placed.checks.get(c.landingId) ?? { status: "unchecked" as const, detail: "this landing is not in the trunk writer's record" };
      if (main.status !== "dropped") return { ...c, main };
      const r = replaced.get(c.landingId);
      if (r) {
        const what = r.changed ? `, with ${r.changed} changed` : ", with other bytes (its signature or other headers changed)";
        main = { status: "dropped", replacedBy: r.sha, detail: `main (at ${(tip ?? "").slice(0, 12)}) was rewritten: ${r.sha.slice(0, 12)} on main now stands for this landing${what}, and main no longer reaches the commit it landed as` };
      }
      return { ...c, status: "dropped" as const, main, detail: main.detail ?? "main no longer reaches this landing's commit" };
    }),
  };
}

/** For each dropped landing, the commit among `above` (main's newest commits) that carries its FT-Landing trailer, and what changed from the recorded commit. */
async function replacements(dropped: readonly NoteCheck[], above: readonly Sha[], src: ObjectSource): Promise<Map<Id, { sha: Sha; changed: string | null }>> {
  const out = new Map<Id, { sha: Sha; changed: string | null }>();
  const byId = new Map(dropped.map((c) => [c.landingId, c]));
  for (const sha of above) {
    if (out.size === byId.size) break;
    const commit = await src.commit(sha).catch(() => null);
    const id = commit ? /(?:^|\n)FT-Landing: (\S+)/.exec(commit.message)?.[1] : undefined;
    const check = id ? byId.get(id) : undefined;
    if (!check || out.has(check.landingId)) continue;
    out.set(check.landingId, { sha, changed: changedFields(await src.commit(check.trunkSha).catch(() => null), commit) });
  }
  return out;
}

/** What a note check needs from the trunk writer to place landings on main (TrunkDO.mainCheck). */
export interface MainCheckDeps {
  sql: SqlStorage;
  /** refs/heads/main as the trunk repository advertises it. */
  tip: () => Promise<Sha | null>;
  history: MainSource;
  src: ObjectSource;
  walk: MainWalk;
  /** Whether the deployment signs now (FT_NOTE_KEY loaded): only then does a commit without signatures, newer than one with them, fail. */
  signing: boolean;
  /** Why FT_NOTE_KEY is set and signs nothing (noteKeyProblem), or null. */
  signingProblem: string | null;
}

/**
 * A note verification (TrunkDO.verifyNotes, verifyLanding; checks newest first) with each landing placed on main
 * (checkMain), signatures that stopped flagged (trunk/commitsig.ts), the counts taken again, the main tip it checked
 * against, and why the deployment's key signs nothing where it is set and cannot.
 */
export async function verifyAgainstMain(v: NotesVerification, p: MainCheckDeps): Promise<NotesVerification> {
  const placed = await checkMain(flagLateSignatures(v.notes, p.signing), p);
  return {
    ...summarize(v.colonyId, v.notesTip, placed.checks, v.at),
    ...(placed.tip !== undefined ? { mainTip: placed.tip } : {}),
    ...(p.signingProblem ? { signingProblem: p.signingProblem } : {}),
  };
}
