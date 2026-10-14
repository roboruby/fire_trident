import { fmtInt, plural, shortId } from "./format.ts";

/**
 * Earned autonomy per region, from the colony's immune report (GET /api/colonies/:id/immune), read defensively: the
 * reply crosses the network as plain JSON, and an older server sends less. A region earns autonomy once enough of its
 * changes land approved by a deterministic proof, a second model or a person (the policy's autonomyAfter); then the
 * reflex alone may land a change there, for an intent a person or a rule wrote. An escalation to a person there, or a
 * person's rejection, takes it back until as many land approved again. The Review tab's strip shows it.
 */

/** One region's standing as the colony reports it. */
export interface AutonomyRegion {
  region: string;
  /** Approved landings since the region's last revocation. */
  approved: number;
  earned: boolean;
  revokedAt: number | null;
  /** Why it was revoked, as the colony recorded it ("escalated prp_…" or "rejected prp_… by …"). */
  reason: string | null;
  /** When the region last moved (a decision or its revocation); null from a server that predates it. */
  lastAt: number | null;
}

/** The autonomy part of the immune report. */
export interface AutonomyReport {
  /** Whether review runs in the colony: without it, earned autonomy is not used. */
  enabled: boolean;
  /** Approved landings a region needs (the policy's autonomyAfter). */
  after: number;
  regions: AutonomyRegion[];
}

/** What revoked a region: a person's rejection, an escalation to a person, or a reason this page does not know. */
export type Revocation = { kind: "rejected"; proposalId: string } | { kind: "escalated"; proposalId: string } | { kind: "other"; text: string };

/** A region's state on the strip. */
export type AutonomyState = "earned" | "progress" | "revoked";

/** One row of the strip. */
export interface AutonomyRow {
  region: string;
  state: AutonomyState;
  /** The badge: "earned", "revoked", or the progress ("2 of 3"). */
  badge: string;
  /** What was earned, what revoked it, and what earns it back, in plain sentences. */
  text: string;
  /** The proposal a revocation names (the row's tooltip). */
  proposalId?: string;
}

/** What the strip shows. */
export interface AutonomyView {
  /** "Autonomy earned in 3 of 12 regions · 1 revoked", or "No region has earned autonomy yet". */
  headline: string;
  /** What earns autonomy, what it allows, and what takes it back. */
  explain: string;
  /** Set when review is off in the colony. */
  off: string | null;
  /** Set when the colony has no review decisions yet. */
  empty: string | null;
  earned: number;
  revoked: number;
  /** Every region, the latest to move first. */
  rows: AutonomyRow[];
}

/** Approved landings a region needs when the report does not say (the decide policy's default). */
const DEFAULT_AFTER = 3;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const time = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);

/** Server text on one line: no control characters. */
function oneLine(v: unknown): string {
  return typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim() : "";
}

/** The autonomy part of an immune report, or null when there is none (an older server, a malformed reply). */
export function parseAutonomy(raw: unknown): AutonomyReport | null {
  if (!isObj(raw) || !Array.isArray(raw.autonomy)) return null;
  const policy = isObj(raw.policy) ? raw.policy : {};
  const n = policy.autonomyAfter;
  const after = typeof n === "number" && Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_AFTER;
  const regions: AutonomyRegion[] = [];
  for (const r of raw.autonomy) {
    if (!isObj(r)) continue;
    const region = oneLine(r.region);
    if (!region) continue;
    const approved = typeof r.approved === "number" && Number.isFinite(r.approved) && r.approved > 0 ? Math.floor(r.approved) : 0;
    const reason = oneLine(r.reason);
    regions.push({
      region,
      approved,
      earned: typeof r.earned === "boolean" ? r.earned : approved >= after,
      revokedAt: time(r.revokedAt),
      reason: reason || null,
      lastAt: time(r.lastAt),
    });
  }
  return { enabled: raw.enabled !== false && policy.enabled !== false, after, regions };
}

/** What revoked a region, from the reason the colony recorded (null when it never was). */
export function revocationOf(reason: string | null): Revocation | null {
  if (!reason) return null;
  const rejected = /^rejected (\S+) by /.exec(reason);
  if (rejected?.[1]) return { kind: "rejected", proposalId: rejected[1] };
  const escalated = /^escalated (\S+)$/.exec(reason);
  if (escalated?.[1]) return { kind: "escalated", proposalId: escalated[1] };
  return { kind: "other", text: reason };
}

/** A revocation's cause as a clause: "a person rejected prp_…", "prp_… was sent to a person"; null for a reason this page does not know. */
export function revocationText(r: Revocation): string | null {
  if (r.kind === "rejected") return `a person rejected ${shortId(r.proposalId)}`;
  if (r.kind === "escalated") return `${shortId(r.proposalId)} was sent to a person`;
  return null;
}

/** When something happened, in local time: "at 12:03" on the day of `now`, "on Oct 13 at 00:14" before it. */
export function whenWords(at: number, now: number): string {
  const d = new Date(at);
  const p = (x: number) => String(x).padStart(2, "0");
  const clock = `${p(d.getHours())}:${p(d.getMinutes())}`;
  if (d.toDateString() === new Date(now).toDateString()) return `at ${clock}`;
  return `on ${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })} at ${clock}`;
}

/** A region's name for people: "(root)" for the files at the top of the repository, as the Intents tab says it. */
export function regionName(region: string): string {
  return region === "." ? "(root)" : region;
}

/** "1 more approved landing earns it", "2 more approved landings earn it back". */
function earnsIt(more: number, back: boolean): string {
  return `${plural(more, "more approved landing", "more approved landings")} ${more === 1 ? "earns" : "earn"} it${back ? " back" : ""}.`;
}

/** One region's row: its state, its badge and its sentences. */
export function autonomyRow(r: AutonomyRegion, after: number, now: number): AutonomyRow {
  const landings = plural(r.approved, "approved landing");
  if (r.revokedAt === null) {
    if (r.earned) return { region: r.region, state: "earned", badge: "earned", text: `Earned with ${landings}.` };
    const more = Math.max(1, after - r.approved);
    return { region: r.region, state: "progress", badge: `${fmtInt(r.approved)} of ${fmtInt(after)}`, text: `${fmtInt(r.approved)} of ${fmtInt(after)} approved landings. ${earnsIt(more, false)}` };
  }
  const rev: Revocation = revocationOf(r.reason) ?? { kind: "other", text: "" };
  const cause = revocationText(rev);
  const when = whenWords(r.revokedAt, now);
  const named = rev.kind === "other" ? {} : { proposalId: rev.proposalId };
  if (r.earned) {
    const text = `Earned back with ${landings} since ${cause ? `${cause} ${when}` : `its revocation ${when}`}.`;
    return { region: r.region, state: "earned", badge: "earned", text, ...named };
  }
  const why = cause ? ` when ${cause}` : rev.kind === "other" && rev.text ? ` (${rev.text.length > 80 ? `${rev.text.slice(0, 79)}…` : rev.text})` : "";
  const since = r.approved > 0 ? ` ${fmtInt(r.approved)} of ${fmtInt(after)} have landed approved since.` : "";
  const text = `Revoked ${when}${why}.${since} ${earnsIt(Math.max(1, after - r.approved), true)}`;
  return { region: r.region, state: "revoked", badge: "revoked", text, ...named };
}

/** When a region last moved, for ordering: its latest decision, else its revocation (an older server sends no lastAt). */
function movedAt(r: AutonomyRegion): number {
  return r.lastAt ?? r.revokedAt ?? 0;
}

/** What the strip shows for a report: the headline, the rule in words, and every region, the latest to move first. */
export function autonomyView(report: AutonomyReport, now: number): AutonomyView {
  const { after, regions } = report;
  const earned = regions.filter((r) => r.earned).length;
  const revoked = regions.filter((r) => !r.earned && r.revokedAt !== null).length;
  // Stable: regions that moved at the same time (or with no time at all) keep the server's order.
  const ordered = regions.map((r, i) => ({ r, i })).sort((a, b) => movedAt(b.r) - movedAt(a.r) || a.i - b.i);
  const n = fmtInt(after);
  return {
    headline: regions.length === 0 ? "No region has earned autonomy yet" : `Autonomy earned in ${fmtInt(earned)} of ${plural(regions.length, "region")}${revoked ? ` · ${fmtInt(revoked)} revoked` : ""}`,
    explain:
      `A region earns autonomy once ${n} of its changes land approved by a proof, a second model or a person. ` +
      `Then the reflex alone may land a change there when a person or a rule wrote its intent. ` +
      `An escalation to a person or a rejection there takes it back until ${n} more land approved.`,
    off: report.enabled ? null : "Review is off in this colony: changes go to their lanes without review, so earned autonomy is not used.",
    empty: regions.length === 0 ? "Nothing has been reviewed in this colony yet, so no region has approved landings to count." : null,
    earned,
    revoked,
    rows: ordered.map(({ r }) => autonomyRow(r, after, now)),
  };
}
