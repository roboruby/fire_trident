import type { Millis, Path } from "./types.ts";
import { footprintCovers } from "./residual.ts";

/*
 * Co-change map: Hebbian learning with spike-timing-dependent plasticity (STDP).
 *
 * Files that change together wire together. Every change strengthens the directed edges between
 * its files. Each file keeps its own clock (how many changes it has been part of), and its
 * outgoing evidence decays only as that clock advances (`retain` per own change), so a burst of
 * unrelated work elsewhere never erases what a file has learned. The Hebbian weight of an edge
 * a -> b is the retained co-change mass over a's retained change mass plus a prior: an estimate of
 * P(b changes | a changes) that stays small until the pair has co-changed more than once.
 *
 * Order gives direction (STDP). When a change follows a causally related earlier change (the same
 * author's follow-up commit, or a follow-up intent of a landed intent), the edges from the earlier
 * change's files to the later change's files are potentiated (pre before post) and the reverse
 * edges depressed, with amplitudes that fall with the lag.
 *
 * Self-assignment uses the map to extend repulsion: a claim on a file repels work on its strongly
 * coupled neighbors, weighted by the coupling.
 *
 * Everything here is pure: stored records in, records to store out. TrunkDO keeps them in SQLite;
 * the simulator and tests keep them in memory (CoChangeGraph).
 */

/** Learning parameters. */
export interface CoChangeParams {
  /** Changes touching more files than this are mass edits and teach nothing (default 30). */
  maxFiles: number;
  /** Share of a file's evidence kept per later change of that file (default 0.98, a memory of about 50 own changes). */
  retain: number;
  /** Pseudo-count added to a file's change mass when normalizing (default 1): one co-change gives at most 0.5. */
  prior: number;
  /** STDP potentiation of earlier-file -> later-file edges at lag 1 (default 0.25). */
  stdpPlus: number;
  /** STDP depression of the reverse edges at lag 1 (default 0.25). */
  stdpMinus: number;
  /** Factor applied to both STDP amplitudes per extra step of lag (default 0.5). */
  stdpLagDecay: number;
}

/** Default learning parameters. */
export const COCHANGE_DEFAULTS: Readonly<CoChangeParams> = Object.freeze({
  maxFiles: 30,
  retain: 0.98,
  prior: 1,
  stdpPlus: 0.25,
  stdpMinus: 0.25,
  stdpLagDecay: 0.5,
});

/** A file's learning state: its clock (changes it was part of) and their retained mass. */
export interface CoFile {
  n: number;
  mass: number;
}

/**
 * A directed edge src -> dst, kept in src's clock: retained co-change mass (`hebb`), retained STDP
 * balance (`stdp`, negative when depressed), and src's clock when the edge was last written (`at`).
 */
export interface CoEdge {
  hebb: number;
  stdp: number;
  at: number;
}

/** Read access to stored records (a SQLite table, a Map). */
export interface CoChangeReader {
  file(path: Path): CoFile | undefined;
  edge(src: Path, dst: Path): CoEdge | undefined;
}

/** Records written by one learning step (upserts). */
export interface CoChangeUpdate {
  files: Array<{ path: Path; file: CoFile }>;
  edges: Array<{ src: Path; dst: Path; edge: CoEdge }>;
}

/** An earlier change that a new change follows, `lag` changes back (1 = the most recent). */
export interface Predecessor {
  paths: Path[];
  lag: number;
}

/** A neighbor of a file and how strongly a claim on it repels work on the file, in (0, 1]. */
export interface Neighbor {
  path: Path;
  weight: number;
}

/** Directed weights of one edge, normalized by its source: Hebbian in [0, 1), STDP in [-1, 1]. */
export interface EdgeWeights {
  hebb: number;
  stdp: number;
}

/** The stored edges around one file, as rankNeighbors needs them. */
export interface FileEdges {
  /** The file's own state (undefined when it never changed). */
  file: CoFile | undefined;
  /** Edges out of the file: file -> path. */
  out: Array<{ path: Path; edge: CoEdge }>;
  /** Edges into the file: path -> file, with the source's state. */
  in: Array<{ path: Path; edge: CoEdge; file: CoFile | undefined }>;
}

const PATTERN = /[*?{]|\/$/;

function params(over: Partial<CoChangeParams> | undefined): CoChangeParams {
  const p = { ...COCHANGE_DEFAULTS, ...(over ?? {}) };
  return {
    maxFiles: Number.isFinite(p.maxFiles) && p.maxFiles >= 1 ? Math.floor(p.maxFiles) : COCHANGE_DEFAULTS.maxFiles,
    retain: p.retain > 0 && p.retain <= 1 ? p.retain : COCHANGE_DEFAULTS.retain,
    prior: p.prior >= 0 && Number.isFinite(p.prior) ? p.prior : COCHANGE_DEFAULTS.prior,
    stdpPlus: p.stdpPlus >= 0 && Number.isFinite(p.stdpPlus) ? p.stdpPlus : COCHANGE_DEFAULTS.stdpPlus,
    stdpMinus: p.stdpMinus >= 0 && Number.isFinite(p.stdpMinus) ? p.stdpMinus : COCHANGE_DEFAULTS.stdpMinus,
    stdpLagDecay: p.stdpLagDecay >= 0 && p.stdpLagDecay <= 1 ? p.stdpLagDecay : COCHANGE_DEFAULTS.stdpLagDecay,
  };
}

/**
 * The files of one change as learning sees them: distinct non-empty paths in first-seen order,
 * directory and glob entries dropped. Null when nothing is left or the change is a mass edit
 * (more than `maxFiles` files).
 */
export function changeFiles(paths: Iterable<Path>, maxFiles: number = COCHANGE_DEFAULTS.maxFiles): Path[] | null {
  const out: Path[] = [];
  const seen = new Set<Path>();
  for (const path of paths) {
    if (typeof path !== "string" || path === "" || PATTERN.test(path) || seen.has(path)) continue;
    seen.add(path);
    out.push(path);
  }
  return out.length === 0 || out.length > maxFiles ? null : out;
}

/** An edge's stored values carried forward to its source's clock `clock`. */
function carried(e: CoEdge, clock: number, retain: number): CoEdge {
  const steps = clock - e.at;
  if (!(steps > 0) || retain === 1) return { hebb: e.hebb, stdp: e.stdp, at: Math.max(clock, e.at) };
  const f = retain ** steps;
  return { hebb: e.hebb * f, stdp: e.stdp * f, at: clock };
}

/**
 * Learn from one change. Hebbian: every ordered pair (a, b) of its files gains 1 in a's clock.
 * STDP: for each predecessor at lag d, every file a that changed only before and every file b that
 * changes only now gets a -> b potentiated by stdpPlus * stdpLagDecay^(d-1) and b -> a depressed by
 * stdpMinus * stdpLagDecay^(d-1). Each file's clock advances by one and its mass becomes
 * mass * retain + 1. Returns the records to upsert; reads go through `read` only.
 * Mass edits, empty changes, and predecessors that are mass edits teach nothing.
 */
export function learnChange(read: CoChangeReader, paths: Iterable<Path>, predecessors: Predecessor[] = [], over?: Partial<CoChangeParams>): CoChangeUpdate {
  const p = params(over);
  const change = changeFiles(paths, p.maxFiles);
  if (change === null) return { files: [], edges: [] };
  const files = new Map<Path, CoFile>();
  for (const a of change) {
    const f = read.file(a) ?? { n: 0, mass: 0 };
    files.set(a, { n: f.n + 1, mass: f.mass * p.retain + 1 });
  }
  const clock = (path: Path): number => files.get(path)?.n ?? read.file(path)?.n ?? 0;
  const edges = new Map<string, { src: Path; dst: Path; edge: CoEdge }>();
  const edge = (src: Path, dst: Path): CoEdge => {
    const key = `${src}\u0000${dst}`;
    let entry = edges.get(key);
    if (entry === undefined) {
      const stored = read.edge(src, dst);
      const c = clock(src);
      entry = { src, dst, edge: stored ? carried(stored, c, p.retain) : { hebb: 0, stdp: 0, at: c } };
      edges.set(key, entry);
    }
    return entry.edge;
  };
  for (const a of change) for (const b of change) if (a !== b) edge(a, b).hebb += 1;
  const now = new Set(change);
  for (const pred of predecessors) {
    const lag = Math.floor(pred.lag);
    if (!(lag >= 1)) continue;
    const before = changeFiles(pred.paths, p.maxFiles);
    if (before === null) continue;
    const amp = p.stdpLagDecay ** (lag - 1);
    if (!(amp > 0)) continue;
    const earlier = new Set(before);
    for (const a of before) {
      if (now.has(a)) continue;
      for (const b of change) {
        if (earlier.has(b)) continue;
        if (p.stdpPlus > 0) edge(a, b).stdp += p.stdpPlus * amp;
        if (p.stdpMinus > 0) edge(b, a).stdp -= p.stdpMinus * amp;
      }
    }
  }
  return {
    files: [...files].map(([path, file]) => ({ path, file })),
    edges: [...edges.values()],
  };
}

/**
 * Directed weights of the edge src -> dst at src's current clock: the Hebbian confidence
 * hebb / (mass + prior), in [0, 1), and the STDP balance stdp / (mass + prior), clamped to [-1, 1].
 * Zeros when either record is missing.
 */
export function edgeWeights(src: CoFile | undefined, e: CoEdge | undefined, over?: Partial<CoChangeParams>): EdgeWeights {
  if (!src || !e) return { hebb: 0, stdp: 0 };
  const p = params(over);
  const c = carried(e, src.n, p.retain);
  const denom = src.mass + p.prior;
  if (!(denom > 0)) return { hebb: 0, stdp: 0 };
  const hebb = c.hebb / denom;
  const stdp = c.stdp / denom;
  return {
    hebb: Number.isFinite(hebb) ? Math.min(1, Math.max(0, hebb)) : 0,
    stdp: Number.isFinite(stdp) ? Math.min(1, Math.max(-1, stdp)) : 0,
  };
}

/**
 * How strongly a claim on g should repel work on f, in [0, 1]: the larger of the two Hebbian
 * confidences (whichever change lands second is the one redone, so co-change risk is symmetric)
 * plus g -> f potentiation when f tends to follow g (downstream work waits for upstream work).
 * Depression never lowers the Hebbian part.
 */
export function repulsionCoupling(fToG: EdgeWeights, gToF: EdgeWeights): number {
  const w = Math.max(fToG.hebb, gToF.hebb) + Math.max(0, gToF.stdp);
  return Number.isFinite(w) ? Math.min(1, Math.max(0, w)) : 0;
}

/**
 * The neighbors of `path` ranked by repulsionCoupling (strongest first, ties by path), at most `k`
 * of them, each with weight >= `minWeight` and > 0. `edges` holds the stored edges around the file.
 */
export function rankNeighbors(path: Path, edges: FileEdges, k: number, minWeight = 0, over?: Partial<CoChangeParams>): Neighbor[] {
  const limit = Math.floor(k);
  if (!(limit >= 1)) return [];
  const none: EdgeWeights = { hebb: 0, stdp: 0 };
  const pairs = new Map<Path, { out: EdgeWeights; in: EdgeWeights }>();
  for (const o of edges.out) {
    if (o.path === path) continue;
    const entry = pairs.get(o.path) ?? { out: none, in: none };
    entry.out = edgeWeights(edges.file, o.edge, over);
    pairs.set(o.path, entry);
  }
  for (const i of edges.in) {
    if (i.path === path) continue;
    const entry = pairs.get(i.path) ?? { out: none, in: none };
    entry.in = edgeWeights(i.file, i.edge, over);
    pairs.set(i.path, entry);
  }
  const out: Neighbor[] = [];
  for (const [g, w] of pairs) {
    const weight = repulsionCoupling(w.out, w.in);
    if (weight > 0 && weight >= minWeight) out.push({ path: g, weight });
  }
  out.sort((a, b) => b.weight - a.weight || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out.slice(0, limit);
}

/**
 * Repulsion a footprint feels from claims on the co-changing neighbors of its files. Each neighbor g
 * outside the footprint couples to it by the noisy-or of its weights to the footprint's files,
 * 1 - prod(1 - w), and contributes that coupling times claimOn(g), the claim value other agents
 * hold on g. Neighbors covered by a footprint entry (already repelled directly) and non-positive
 * or non-finite values are skipped. `neighbors(f)` lists f's neighbors, as rankNeighbors does.
 */
export function neighborRepulsion(
  footprint: Path[],
  neighbors: (path: Path) => readonly Neighbor[] | undefined,
  claimOn: (path: Path) => number,
): number {
  if (footprint.length === 0) return 0;
  const exact = new Set(footprint);
  const patterns = footprint.filter((e) => PATTERN.test(e));
  const inside = (g: Path): boolean => exact.has(g) || patterns.some((e) => footprintCovers(e, g));
  const miss = new Map<Path, number>();
  for (const f of exact) {
    if (PATTERN.test(f)) continue;
    for (const nb of neighbors(f) ?? []) {
      const w = nb.weight;
      if (!(w > 0) || !Number.isFinite(w) || inside(nb.path)) continue;
      miss.set(nb.path, (miss.get(nb.path) ?? 1) * (1 - Math.min(1, w)));
    }
  }
  let total = 0;
  for (const [g, m] of miss) {
    const claim = claimOn(g);
    if (claim > 0 && Number.isFinite(claim)) total += (1 - m) * claim;
  }
  return total;
}

/**
 * STDP predecessors for each commit of a history given oldest first: the same author's previous
 * `window` commits (default 3) no older than `horizonMs` (default 6 hours, one working session), the
 * most recent at lag 1. A developer's follow-up commits reveal what a change set in motion.
 * Commits without an author, or without a time when a horizon applies, get none.
 */
export function followUps(commits: ReadonlyArray<{ paths: Path[]; author?: string; at?: Millis }>, window = 3, horizonMs = 6 * 3_600_000): Predecessor[][] {
  const w = Math.floor(window);
  const recent = new Map<string, Array<{ paths: Path[]; at: Millis | undefined }>>();
  return commits.map((c) => {
    if (!c.author || !(w >= 1)) return [];
    const list = recent.get(c.author) ?? [];
    const preds: Predecessor[] = [];
    for (let i = list.length - 1, lag = 1; i >= 0 && lag <= w; i--, lag++) {
      const prev = list[i]!;
      if (Number.isFinite(horizonMs)) {
        if (c.at === undefined || prev.at === undefined || c.at - prev.at > horizonMs || c.at < prev.at) break;
      }
      preds.push({ paths: prev.paths, lag });
    }
    list.push({ paths: c.paths, at: c.at });
    if (list.length > w) list.splice(0, list.length - w);
    recent.set(c.author, list);
    return preds;
  });
}

/**
 * The co-change map in memory (simulator, tests): learns changes and answers neighbor queries
 * with the same functions TrunkDO applies to its SQLite tables.
 */
export class CoChangeGraph implements CoChangeReader {
  private readonly files = new Map<Path, CoFile>();
  private readonly outEdges = new Map<Path, Map<Path, CoEdge>>();
  private readonly inEdges = new Map<Path, Set<Path>>();
  private changes = 0;
  readonly params: CoChangeParams;

  constructor(over?: Partial<CoChangeParams>) {
    this.params = params(over);
  }

  /** A file's state. */
  file(path: Path): CoFile | undefined {
    return this.files.get(path);
  }

  /** The stored edge src -> dst. */
  edge(src: Path, dst: Path): CoEdge | undefined {
    return this.outEdges.get(src)?.get(dst);
  }

  /** Store the records of a learning step. */
  apply(update: CoChangeUpdate): void {
    for (const { path, file } of update.files) this.files.set(path, { ...file });
    for (const { src, dst, edge } of update.edges) {
      let m = this.outEdges.get(src);
      if (!m) {
        m = new Map();
        this.outEdges.set(src, m);
      }
      m.set(dst, { ...edge });
      let s = this.inEdges.get(dst);
      if (!s) {
        s = new Set();
        this.inEdges.set(dst, s);
      }
      s.add(src);
    }
  }

  /** Learn one change (see learnChange) and store it. Returns the update. */
  learn(paths: Iterable<Path>, predecessors: Predecessor[] = []): CoChangeUpdate {
    const update = learnChange(this, paths, predecessors, this.params);
    if (update.files.length > 0) this.changes++;
    this.apply(update);
    return update;
  }

  /** The stored edges around one file. */
  edgesOf(path: Path): FileEdges {
    const out = [...(this.outEdges.get(path) ?? new Map<Path, CoEdge>())].map(([p, edge]) => ({ path: p, edge }));
    const inc = [...(this.inEdges.get(path) ?? new Set<Path>())].map((src) => ({ path: src, edge: this.edge(src, path)!, file: this.files.get(src) }));
    return { file: this.files.get(path), out, in: inc };
  }

  /** Neighbors of `path` (see rankNeighbors). */
  neighbors(path: Path, k: number, minWeight = 0): Neighbor[] {
    return rankNeighbors(path, this.edgesOf(path), k, minWeight, this.params);
  }

  /** Every file that has changed, in first-learned order. */
  paths(): Path[] {
    return [...this.files.keys()];
  }

  /** Counts: changes learned, files, directed edges. */
  stats(): { changes: number; files: number; edges: number } {
    let edges = 0;
    for (const m of this.outEdges.values()) edges += m.size;
    return { changes: this.changes, files: this.files.size, edges };
  }
}
