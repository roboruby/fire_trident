import { quantile } from "./stats.ts";

/**
 * The headline numbers of one live run (live.ts), as a showcase card and the README quote them: who joined, what landed,
 * how fast over the whole run (from its first landing to its last, not a steady-state window), and how long a change
 * took to land.
 */
export interface RunSummary {
  /** Agents that registered in this run. */
  agentsJoined: number;
  /** Trunk commits the run landed (the colony's `landings` metric, after minus before). */
  landings: number | null;
  /** Changes the run landed (the colony's `landedProposals`). */
  landedProposals: number | null;
  /** Intents the run landed (the colony's `landedIntents`). */
  landedIntents: number | null;
  /**
   * Changes closed as already on trunk (the colony's `alreadyOnTrunk`, FT_ALREADY_ON_TRUNK): their content was on trunk
   * already, so nothing landed for them; counted in neither number above. Null when the colony does not count them.
   */
  alreadyOnTrunk: number | null;
  /** The run's first and last landing on the live feed, by the colony's clock (ISO), and the seconds between them. */
  firstLandingAt: string | null;
  lastLandingAt: string | null;
  spanS: number | null;
  /** Over that span: trunk commits a minute, and changes landed a minute. */
  landingsPerMin: number | null;
  landedPerMin: number | null;
  /** Time to land of the run's landed proposals (from the colony's proposal time to its landing's), p50 and p95. */
  timeToLandP50Ms: number | null;
  timeToLandP95Ms: number | null;
}

/** What runSummary reads: the live feed's landings, the time to land of each landed proposal, and the metric deltas. */
export interface RunSummaryInput {
  registered: number;
  /** Landings seen on the live feed during the run (the colony's `at`, and the proposals each landed). */
  landings: ReadonlyArray<{ at: number; proposalIds: readonly string[] }>;
  /** Time to land of each landed proposal, in ms. */
  timeToLand: readonly number[];
  /** The colony's metrics after the run minus before (`landings`, `landedProposals`, `landedIntents`). */
  delta: Readonly<Record<string, number>>;
}

/** The run's headline numbers (see RunSummary). Rates are null when fewer than two landings bound the span. */
export function runSummary(input: RunSummaryInput): RunSummary {
  const times = input.landings.map((l) => l.at).filter((t) => Number.isFinite(t));
  const first = times.length > 0 ? Math.min(...times) : null;
  const last = times.length > 0 ? Math.max(...times) : null;
  const spanMs = first !== null && last !== null && last > first ? last - first : null;
  const minutes = spanMs !== null ? spanMs / 60_000 : null;
  const changes = input.landings.reduce((n, l) => n + l.proposalIds.length, 0);
  const sorted = [...input.timeToLand].filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  const metric = (k: string): number | null => (typeof input.delta[k] === "number" && Number.isFinite(input.delta[k]) ? (input.delta[k] as number) : null);
  return {
    agentsJoined: input.registered,
    landings: metric("landings"),
    landedProposals: metric("landedProposals"),
    landedIntents: metric("landedIntents"),
    alreadyOnTrunk: metric("alreadyOnTrunk"),
    firstLandingAt: first !== null ? new Date(first).toISOString() : null,
    lastLandingAt: last !== null ? new Date(last).toISOString() : null,
    spanS: spanMs !== null ? spanMs / 1000 : null,
    landingsPerMin: minutes !== null ? input.landings.length / minutes : null,
    landedPerMin: minutes !== null ? changes / minutes : null,
    timeToLandP50Ms: quantile(sorted, 0.5),
    timeToLandP95Ms: quantile(sorted, 0.95),
  };
}
