import { CONFIRM_KINDS, type ConfirmKind, type DecidesReport, type DecidesSplit } from "@fire_trident/core";
import type { DecidePolicy } from "./policy.ts";
import { PRESET_FIELDS, PRESETS, letsLand, presetOf, presetValues } from "./presets.ts";

/**
 * How a colony decides (GET /api/colonies/:id/decides, a public read like the colony's other reads): the preset its
 * decide policy equals, or custom and how it differs from the nearest preset (decide/presets.ts), what its policy lets
 * land without a person, and the last 30 days of landed changes split by what confirmed them.
 *
 * The split reads the colony's own records, no note: each landed proposal's outcome row (decide_outcomes, which the
 * pipeline writes for every proposal it decides and a person's decision updates), joined to the proposals table. A
 * person's approval counts as a person; otherwise the final layer of a landing decision says what confirmed it: a
 * deterministic proof (D3, M1), the reflex on earned autonomy (R3, the only rule where the reflex lands a change), or the
 * second opinion (L3). A landed proposal with no landing decision recorded (review off, or a change of direction that
 * raced it) counts as no review recorded. Vaccines never land and are left out. A change counts on the day it landed
 * (its proposal's last update); to keep the read bounded on a large colony, only proposals created in the window before
 * it too are read, so a change that waited longer than that for a person is left out.
 */

/** The days the split covers. */
export const DECIDES_DAYS = 30;
const DAY_MS = 24 * 60 * 60_000;
/** A colony's split is read again at most this often (the route is public; the counts move slowly). */
const SPLIT_TTL_MS = 60_000;

/** The kind of one outcome row of a landed proposal (see the module comment). */
export function confirmKind(row: { layer: string | null; action: string | null; human: string | null }): ConfirmKind {
  if (row.human === "approve") return "person";
  if (row.action === "land") {
    if (row.layer === "deterministic") return "deterministic";
    if (row.layer === "reflex") return "autonomy";
    if (row.layer === "llm") return "model";
  }
  return "unreviewed";
}

/** The landed changes of the last `days` days by what confirmed them, from the colony's proposals and outcome rows. */
export function landedSplit(sql: SqlStorage, now: number, days = DECIDES_DAYS): DecidesSplit {
  const since = now - days * DAY_MS;
  const rows = sql
    .exec<{ layer: string | null; action: string | null; human: string | null; n: number }>(
      `SELECT d.layer AS layer, d.action AS action, d.human AS human, COUNT(*) AS n
         FROM proposals p LEFT JOIN decide_outcomes d ON d.proposal_id = p.id
        WHERE p.status = 'landed' AND p.updated_at >= ? AND p.created_at >= ? AND COALESCE(d.vaccine, 0) = 0
        GROUP BY d.layer, d.action, d.human`,
      since,
      since - days * DAY_MS,
    )
    .toArray();
  const counts = Object.fromEntries(CONFIRM_KINDS.map((k) => [k, 0])) as Record<ConfirmKind, number>;
  for (const r of rows) counts[confirmKind(r)] += Number(r.n) || 0;
  return { days, since, total: CONFIRM_KINDS.reduce((n, k) => n + counts[k], 0), counts };
}

/** The last split read per colony database, so a public read does not scan the proposals more than once a minute. */
const cache = new WeakMap<object, { at: number; split: DecidesSplit }>();

/** landedSplit, answered from the last read when it is under a minute old. */
export function cachedSplit(sql: SqlStorage, now: number): DecidesSplit {
  const hit = cache.get(sql);
  if (hit && now - hit.at < SPLIT_TTL_MS && now >= hit.at) return hit.split;
  const split = landedSplit(sql, now);
  cache.set(sql, { at: now, split });
  return split;
}

/** What waits for a person whatever the preset (decide/gate.ts rules P1, P3, P4, P2, L5, L7, M2, L8). */
export const ALWAYS_A_PERSON =
  "Whatever the preset, a person decides a change with a danger pattern, one that writes a protected path, one that undoes a recent landing for another goal, the next change of an intent after a security finding, one too large for model review, one whose acceptance lines are not shown met, and one no model could review.";

/** The settings a report lists: each preset field with its label and value. */
function settings(values: Record<string, number | boolean>): DecidesReport["settings"] {
  return PRESET_FIELDS.map((f) => ({ field: f.key, label: f.label, value: values[f.key]! }));
}

/** How one colony decides (see the module comment). `reviewing`: review runs now (the policy turns it on and the server has the model binding). */
export function decidesReport(x: { colonyId: string; policy: DecidePolicy; reviewing: boolean; split: DecidesSplit; now: number }): DecidesReport {
  const match = presetOf(x.policy);
  const values = presetValues(x.policy);
  return {
    colonyId: x.colonyId,
    preset: match.preset,
    nearest: match.nearest,
    differs: match.differs.map((d) => ({ field: d.field, label: d.label, value: d.value, preset: d.preset })),
    settings: settings(values),
    lets: letsLand(values),
    reviewing: x.reviewing,
    protectedPaths: x.policy.protectedPaths.length,
    dangerAllow: x.policy.dangerAllow.length,
    always: ALWAYS_A_PERSON,
    presets: PRESETS.map((p) => ({ name: p.name, label: p.label, lets: letsLand(p.values), settings: settings(p.values) })),
    split: x.split,
    at: x.now,
  };
}
