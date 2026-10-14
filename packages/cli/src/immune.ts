import { ago, num, table, type Colors } from "./format.ts";

/**
 * Earned autonomy in the CLI, from the colony's immune report (GET /api/colonies/:id/immune, a public read): one line in
 * `ft status`, and `ft immune` for each region's standing, the latest to move first, then the antibodies, the detectors
 * and the alert budget. A region earns autonomy once enough of its changes land approved by a deterministic proof, a
 * second model or a person (the policy's autonomyAfter); then the reflex alone may land a change there, for an intent a
 * person or a rule wrote. An escalation to a person there, or a person's rejection, takes it back until as many land
 * approved again.
 */

/** One region's standing as the colony reports it. */
export interface AutonomyRegionLike {
  region: string;
  /** Approved landings since the region's last revocation. */
  approved: number;
  earned: boolean;
  revokedAt: number | null;
  reason: string | null;
  /** When the region last moved; null from a server that predates it. */
  lastAt: number | null;
}

/** The autonomy part of the immune report. */
export interface AutonomyLike {
  enabled: boolean;
  /** Approved landings a region needs. */
  after: number;
  regions: AutonomyRegionLike[];
}

/** Detectors `ft immune` names before it counts the rest. */
const DETECTORS_SHOWN = 6;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const time = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

/** Server text on one terminal line: no control characters. */
function plain(v: unknown): string {
  return typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim() : "";
}

/** The autonomy part of an immune report, or null when there is none (an older server, a malformed reply). */
export function autonomyOf(res: unknown): AutonomyLike | null {
  if (!isObj(res) || !Array.isArray(res.autonomy)) return null;
  const policy = isObj(res.policy) ? res.policy : {};
  const after = count(policy.autonomyAfter) || 3;
  const regions: AutonomyRegionLike[] = [];
  for (const r of res.autonomy) {
    if (!isObj(r) || !plain(r.region)) continue;
    const approved = count(r.approved);
    regions.push({
      region: plain(r.region),
      approved,
      earned: typeof r.earned === "boolean" ? r.earned : approved >= after,
      revokedAt: time(r.revokedAt),
      reason: plain(r.reason) || null,
      lastAt: time(r.lastAt),
    });
  }
  return { enabled: res.enabled !== false && policy.enabled !== false, after, regions };
}

/** What revoked a region, as a clause: "a person rejected prp_…", "prp_… was sent to a person"; null for any other reason. */
export function revokedBy(reason: string | null): string | null {
  const rejected = /^rejected (\S+) by /.exec(reason ?? "");
  if (rejected?.[1]) return `a person rejected ${rejected[1]}`;
  const escalated = /^escalated (\S+)$/.exec(reason ?? "");
  if (escalated?.[1]) return `${escalated[1]} was sent to a person`;
  return null;
}

/** "1 more approved landing earns it", "3 more approved landings earn it back". */
function earnsIt(more: number, back: boolean): string {
  return `${num(more)} more approved landing${more === 1 ? " earns" : "s earn"} it${back ? " back" : ""}.`;
}

/** What was earned, what revoked it, and what earns it back, in plain sentences (relative times). */
export function regionSentence(r: AutonomyRegionLike, after: number, now: number): string {
  const landings = `${num(r.approved)} approved landing${r.approved === 1 ? "" : "s"}`;
  const more = Math.max(1, after - r.approved);
  if (r.revokedAt === null) return r.earned ? `Earned with ${landings}.` : earnsIt(more, false);
  const cause = revokedBy(r.reason);
  const when = ago(r.revokedAt, now);
  if (r.earned) return `Earned back with ${landings} since ${cause ? `${cause} ${when}` : `its revocation ${when}`}.`;
  const why = cause ? ` when ${cause}` : r.reason ? ` (${r.reason.length > 80 ? `${r.reason.slice(0, 79)}…` : r.reason})` : "";
  return `Revoked ${when}${why}. ${earnsIt(more, true)}`;
}

/** Regions the latest to move first: by lastAt, else by revocation (an older server); ties keep the server's order. */
export function latestFirst(regions: readonly AutonomyRegionLike[]): AutonomyRegionLike[] {
  const moved = (r: AutonomyRegionLike) => r.lastAt ?? r.revokedAt ?? 0;
  return regions
    .map((r, i) => ({ r, i }))
    .sort((a, b) => moved(b.r) - moved(a.r) || a.i - b.i)
    .map(({ r }) => r);
}

/** "3 of 12 regions earned, 1 revoked" (the count of regions that lost autonomy and have not earned it back). */
function tally(a: AutonomyLike, c: Colors): string {
  const earned = a.regions.filter((r) => r.earned).length;
  const revoked = a.regions.filter((r) => !r.earned && r.revokedAt !== null).length;
  const head = `${num(earned)} of ${num(a.regions.length)} region${a.regions.length === 1 ? "" : "s"} earned`;
  return `${earned > 0 ? c.green(head) : head}${revoked > 0 ? `, ${c.yellow(`${num(revoked)} revoked`)}` : ""}`;
}

/** The `ft status` row: "autonomy   3 of 12 regions earned, 1 revoked". Null for a server that sends no immune report. */
export function autonomyLine(res: unknown, colony: string, c: Colors): string | null {
  const a = autonomyOf(res);
  if (!a) return null;
  const label = c.dim("autonomy".padEnd(11));
  if (!a.enabled) return `${label}${c.yellow("not used: review is off")}`;
  if (a.regions.length === 0) return `${label}${c.dim("no region yet: nothing has been reviewed")}`;
  return `${label}${tally(a, c)}${c.dim(` · ft immune ${colony}`)}`;
}

/** The rule in words, a sentence a line: what earns autonomy, what it allows, and what takes it back. */
export function autonomyRule(after: number): string[] {
  const n = num(after);
  return [
    `A region earns autonomy once ${n} of its changes land approved by a proof, a second model or a person.`,
    "Then the reflex alone may land a change there when a person or a rule wrote its intent.",
    `An escalation to a person or a rejection there takes it back until ${n} more land approved.`,
  ];
}

/** The antibodies row: how many in each state, and the rejections they caught again. */
function antibodyRow(raw: unknown): string {
  const list = (Array.isArray(raw) ? raw : []).filter(isObj);
  if (list.length === 0) return "none yet: a person's rejection that no antibody caught mints one";
  const states = new Map<string, number>();
  for (const a of list) states.set(plain(a.state) || "active", (states.get(plain(a.state) || "active") ?? 0) + 1);
  const caught = list.reduce((n, a) => n + count(a.recurrences), 0);
  return `${[...states].map(([s, n]) => `${num(n)} ${s}`).join(", ")}${caught > 0 ? `; they caught ${num(caught)} later rejection${caught === 1 ? "" : "s"} again` : ""}`;
}

/** The detectors row: each detector's probation state with its fires and verdicts. */
function detectorRow(raw: unknown, c: Colors): string {
  const list = (Array.isArray(raw) ? raw : []).filter((d): d is Record<string, unknown> => isObj(d) && plain(d.id) !== "");
  if (list.length === 0) return "none has fired yet";
  const shown = list.slice(0, DETECTORS_SHOWN).map((d) => {
    const state = plain(d.state) || "active";
    const verdicts = [count(d.useful) ? `${num(count(d.useful))} useful` : "", count(d.notUseful) ? `${num(count(d.notUseful))} not useful` : ""].filter(Boolean).join(", ");
    return `${plain(d.id)} ${state === "active" ? state : c.yellow(state)} (fired ${num(count(d.fires))}${verdicts ? `, ${verdicts}` : ""})`;
  });
  return `${shown.join(c.dim(" · "))}${list.length > DETECTORS_SHOWN ? c.dim(` +${num(list.length - DETECTORS_SHOWN)} more`) : ""}`;
}

/**
 * What `ft immune` prints: earned autonomy in a line, each region (the latest to move first) with its approved landings
 * and what was earned, what revoked it and what earns it back; then the antibodies, the detectors, the alert budget and
 * the rule in words.
 */
export function formatImmune(colony: string, res: unknown, c: Colors, now: number): string {
  const a = autonomyOf(res);
  if (!a) return `${c.bold(colony)}: the server sent no earned autonomy (it predates the immune report)`;
  const out: string[] = [];
  out.push(a.regions.length === 0 ? `${c.bold(colony)}: no region has earned autonomy yet` : `${c.bold(colony)}: autonomy ${tally(a, c)}`);
  if (!a.enabled) out.push(c.yellow("Review is off in this colony: changes go to their lanes without review, so earned autonomy is not used."));
  if (a.regions.length === 0) out.push(c.dim("Nothing has been reviewed in this colony yet, so no region has approved landings to count."));
  else {
    const rows = latestFirst(a.regions).map((r) => [
      r.region === "." ? "(root)" : r.region,
      r.earned ? c.green("earned") : r.revokedAt !== null ? c.red("revoked") : c.dim("not yet"),
      r.earned ? num(r.approved) : `${num(r.approved)} of ${num(a.after)}`,
      r.lastAt !== null ? ago(r.lastAt, now) : "-",
      regionSentence(r, a.after, now),
    ]);
    out.push("", ...table(["REGION", "AUTONOMY", "APPROVED", "MOVED", "WHAT HAPPENED"], rows, new Set([2]), c));
  }
  const o = res as Record<string, unknown>;
  const alerts = isObj(o.alerts) ? o.alerts : {};
  const row = (label: string, value: string) => `${c.dim(label.padEnd(11))}${value}`;
  out.push("", row("antibodies", antibodyRow(o.antibodies)), row("detectors", detectorRow(o.detectors, c)));
  if (typeof alerts.budget === "number") out.push(row("alerts", `${num(count(alerts.lastHour))} of ${num(count(alerts.budget))} escalations to a person in the last hour`));
  out.push("", ...autonomyRule(a.after).map((s) => c.dim(s)));
  return out.join("\n");
}
