/**
 * Coordination tokens per take (scripts/coordination.rb, definition 12): how much a take hands an agent beyond its
 * intent and lease, counted when the take is handed, since takes are in no lineage note. Each part is measured as the
 * characters of its JSON as the take result carries it: the why-context (`context`: the latest landings on the intent's
 * files, each with its intent's why), the field guide's lessons (`guide`), the last return (`lastReturn`) and the review
 * preview (`review`: the antibody questions and the rules that cover the footprint). The heads-up comes on later replies
 * while the agent holds the intent (mcp/headsup.ts asks ColonyDO.headsUp), so each answer with something to say adds its
 * characters to a counter of its own. A take hands no field reading: `sense` is a separate call the regions answer.
 *
 * Beside each take the meter counts the agents active at the time and a "read everything" counterfactual: the characters
 * of every landed intent's why and every active field guide lesson, what an agent would read to learn the same things
 * with no selection. Both come from the colony's tables, read at most every READ_EVERY_MS. The same three sums are kept
 * per bucket of active agents (1, 2-3, 4-7, ...), so a report can say whether the context a take hands stays flat as
 * agents grow while reading everything does not. Tokens are estimated as characters / CHARS_PER_TOKEN.
 *
 * Counters only (`coord.*`, in the metrics every snapshot and GET /api/colonies/:id/metrics serve): nothing here changes
 * what a take returns, and a failure is logged and never fails a take.
 */

/** The parts of a take the meter counts, as the take result names them. */
export const COORD_PARTS = ["context", "guide", "lastReturn", "review"] as const;
export type CoordPart = (typeof COORD_PARTS)[number];

/** Takes counted, and the sums kept beside them: the agents active at each take and the read-everything characters. */
export const COORD_TAKES = "coord.takes";
export const COORD_AGENTS = "coord.agents";
export const COORD_EVERYTHING = "coord.everything";
/** Heads-up answers with something to say, and their characters. */
export const COORD_HEADS_UPS = "coord.headsUps";
export const COORD_HEADS_UP_CHARS = "coord.chars.headsUp";
/** Characters per token for the estimate (labeled as one wherever it is shown). */
export const CHARS_PER_TOKEN = 4;
/** How long the meter reuses its read of the active agents and the read-everything size (ms). */
export const READ_EVERY_MS = 10_000;

/** The SQL the meter runs (a Durable Object's storage, or node:sqlite in unit tests). */
export interface SqlRunner {
  exec(query: string, ...bindings: unknown[]): { toArray(): unknown[] };
}

/** The counter of one part's characters. */
export function partMetric(part: CoordPart): string {
  return `coord.chars.${part}`;
}

/** The counter of one sum in one bucket of active agents. */
export function bucketMetric(bucket: number, what: "takes" | "chars" | "everything"): string {
  return `coord.byAgents.${bucket}.${what}`;
}

/** The bucket of a count of active agents: the largest power of two at or below it (1 for anything below 2). */
export function agentBucket(agents: number): number {
  const n = Number.isFinite(agents) ? Math.floor(agents) : 1;
  let b = 1;
  while (b * 2 <= n) b *= 2;
  return b;
}

/** Characters of a value's JSON; 0 for nothing, and for a value that cannot be serialized. */
export function charsOf(value: unknown): number {
  if (value === undefined || value === null) return 0;
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

/** What one take handed beyond its intent, as the take result carries it. */
export type TakeParts = Partial<Record<CoordPart, unknown>>;

/** The counter deltas of one take, given the active agents and the read-everything characters at the time. */
export function takeBumps(parts: TakeParts, at: { agents: number; everything: number }): Array<[string, number]> {
  const out: Array<[string, number]> = [[COORD_TAKES, 1]];
  let chars = 0;
  for (const part of COORD_PARTS) {
    const n = charsOf(parts[part]);
    chars += n;
    if (n > 0) out.push([partMetric(part), n]);
  }
  const agents = Math.max(0, Math.floor(at.agents));
  const everything = Math.max(0, Math.floor(at.everything));
  if (agents > 0) out.push([COORD_AGENTS, agents]);
  if (everything > 0) out.push([COORD_EVERYTHING, everything]);
  const bucket = agentBucket(agents);
  out.push([bucketMetric(bucket, "takes"), 1]);
  if (chars > 0) out.push([bucketMetric(bucket, "chars"), chars]);
  if (everything > 0) out.push([bucketMetric(bucket, "everything"), everything]);
  return out;
}

/** The counter deltas of one heads-up answer: none when it has nothing to say. */
export function headsUpBumps(report: unknown): Array<[string, number]> {
  const n = charsOf(report);
  return n > 0 ? [[COORD_HEADS_UPS, 1], [COORD_HEADS_UP_CHARS, n]] : [];
}

/** Coordination tokens per take as GET /api/colonies/:id/metrics serves them (`coordTokens`). */
export interface CoordTokensReport {
  /** Says that every token count is characters / CHARS_PER_TOKEN. */
  estimate: string;
  takes: number;
  /** Estimated tokens per take of each part, the heads-up included (its answers over the takes counted). */
  perTake: Record<CoordPart | "headsUp", number>;
  /** All of it per take, and what the take reply itself carries (the heads-up left out). */
  tokensPerTake: number;
  atTakeTokensPerTake: number;
  /** The counterfactual per take: every landed intent's why and every active lesson at the time of the take. */
  readEverythingTokensPerTake: number;
  /** Active agents at a take, on average. */
  agentsPerTake: number;
  /** Per bucket of active agents at the take (`from` to `to` agents): takes, and tokens per take at take and to read everything. */
  byAgents: Array<{ from: number; to: number; takes: number; tokensPerTake: number; readEverythingTokensPerTake: number }>;
}

function tokens(chars: number, takes: number): number {
  return takes > 0 ? Math.round((chars / CHARS_PER_TOKEN / takes) * 10) / 10 : 0;
}

/** The report from the colony's counters, or undefined before the first counted take. */
export function coordTokensReport(metrics: Record<string, number>): CoordTokensReport | undefined {
  const n = (name: string): number => {
    const v = metrics[name];
    return typeof v === "number" && Number.isFinite(v) ? v : 0;
  };
  const takes = n(COORD_TAKES);
  if (takes <= 0) return undefined;
  const perTake = {} as Record<CoordPart | "headsUp", number>;
  let atTake = 0;
  for (const part of COORD_PARTS) {
    atTake += n(partMetric(part));
    perTake[part] = tokens(n(partMetric(part)), takes);
  }
  perTake.headsUp = tokens(n(COORD_HEADS_UP_CHARS), takes);
  const buckets = new Set<number>();
  for (const name of Object.keys(metrics)) {
    const m = /^coord\.byAgents\.(\d+)\.takes$/.exec(name);
    if (m) buckets.add(Number(m[1]));
  }
  const byAgents = [...buckets]
    .sort((a, b) => a - b)
    .map((from) => {
      const t = n(bucketMetric(from, "takes"));
      return { from, to: from * 2 - 1, takes: t, tokensPerTake: tokens(n(bucketMetric(from, "chars")), t), readEverythingTokensPerTake: tokens(n(bucketMetric(from, "everything")), t) };
    })
    .filter((b) => b.takes > 0);
  return {
    estimate: `tokens are estimated as characters / ${CHARS_PER_TOKEN}`,
    takes,
    perTake,
    tokensPerTake: tokens(atTake + n(COORD_HEADS_UP_CHARS), takes),
    atTakeTokensPerTake: tokens(atTake, takes),
    readEverythingTokensPerTake: tokens(n(COORD_EVERYTHING), takes),
    agentsPerTake: Math.round((n(COORD_AGENTS) / takes) * 10) / 10,
    byAgents,
  };
}

/** What the meter reads from the colony. */
export interface CoordHost {
  sql: SqlRunner;
  now(): number;
}

/** One colony's meter (see the module comment). */
export class CoordMeter {
  private read: { at: number; agents: number; everything: number } | null = null;

  constructor(private readonly host: CoordHost) {}

  /** The counter deltas of one take; none when anything fails (logged), so a take never fails over it. */
  take(parts: TakeParts): Array<[string, number]> {
    try {
      return takeBumps(parts, this.state());
    } catch (err) {
      console.warn(`coordination tokens not counted: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /** The active agents and the read-everything characters, reused for READ_EVERY_MS. */
  private state(): { agents: number; everything: number } {
    const now = this.host.now();
    if (this.read && now - this.read.at < READ_EVERY_MS) return this.read;
    const agents = this.count("SELECT COUNT(*) AS n FROM agents WHERE state <> 'dead'");
    const whys = this.count("SELECT COALESCE(SUM(LENGTH(why)), 0) AS n FROM intents WHERE status = 'landed'");
    // The guide's own table is made on first use: a colony with the guide off has none, and holds no lessons.
    const lessons = this.count("SELECT COALESCE(SUM(LENGTH(json_extract(data, '$.text'))), 0) AS n FROM guide_lessons WHERE status = 'active'");
    this.read = { at: now, agents, everything: whys + lessons };
    return this.read;
  }

  /** One number from the colony's tables; 0 when the table is missing or the read fails. */
  private count(query: string): number {
    try {
      const row = this.host.sql.exec(query).toArray()[0] as { n?: unknown } | undefined;
      const n = Number(row?.n ?? 0);
      return Number.isFinite(n) ? n : 0;
    } catch {
      return 0;
    }
  }
}
