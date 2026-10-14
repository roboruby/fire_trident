import type { ImpactClaim, ImpactFile, ImpactLanding, ImpactReport } from "@fire_trident/core";
import { ago, num, shortSha, type Colors } from "./format.ts";

/**
 * `ft impact <colony> <path>...`: what a change to a file reaches through imports, and who works on it now (GET
 * /api/colonies/:id/impact): the files that import it, level by level, the live claims on them, and the latest landings
 * on them with their intents' whys.
 */

/** Files the listing shows at most (`--json` has them all), files per claim and per landing line, and characters of a why. */
const FILES_SHOWN = 40;
const PATHS_SHOWN = 3;
const WHY_SHOWN = 160;

/** What each level of the walk is called. */
const LEVELS = ["Asked about", "Imports it", "Imports those", "One level further"];

/** Server text on one terminal line: no control characters, runs of space as one, cut to `max`. */
function plain(s: unknown, max = 200): string {
  const t = typeof s === "string" ? s.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim() : "";
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** "a, b +3": the first paths and how many more. */
function some(paths: readonly unknown[] | undefined, more = 0, max = PATHS_SHOWN): string {
  const list = (paths ?? []).map((p) => plain(p)).filter(Boolean);
  const rest = Math.max(0, list.length - max) + Math.max(0, more);
  return `${list.slice(0, max).join(", ")}${rest > 0 ? ` +${rest}` : ""}`;
}

/** How an agent's kind reads. */
function kindLabel(kind: unknown): string {
  return kind === "internal" ? "in-platform" : typeof kind === "string" && kind ? plain(kind, 20) : "agent";
}

/** A duration in the CLI's short form ("12s", "4m", "2h"). */
function span(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

/** One file of the listing: its path, the file it imports on the way, and who claims it. */
function fileLine(f: Partial<ImpactFile>, c: Colors): string {
  const via = f.via ? c.dim(`  ← ${plain(f.via)}`) : "";
  const claimed = (f.claimedBy ?? []).length > 0 ? `  ${c.yellow(`claimed by ${some(f.claimedBy, 0, 2)}`)}` : "";
  return `  ${plain(f.path)}${via}${claimed}`;
}

/** One claim: the agent and its intent, the files it covers, how fresh it is, and what the agent says it is doing. */
function claimLines(k: Partial<ImpactClaim>, c: Colors, now: number): string[] {
  const who = `${c.bold(plain(k.agentId) || "?")}${k.name ? ` ${plain(k.name, 80)}` : ""} ${c.dim(`(${kindLabel(k.kind)})`)}`;
  const intent = k.intentId ? `  ${plain(k.intentId)}${k.title ? ` “${plain(k.title, 100)}”` : ""}${k.status ? c.dim(` ${plain(k.status, 20)}${typeof k.since === "number" ? ` ${ago(k.since, now)}` : ""}`) : ""}` : "";
  const fresh =
    typeof k.ageMs === "number"
      ? `claim made or renewed ${span(k.ageMs)} ago${typeof k.strength === "number" ? `, strength ${k.strength.toFixed(2)}${k.strength < 0.5 ? " (no longer holds others off)" : ""}` : ""}`
      : "claim age not known";
  const out = [`  ${who}${intent}`, c.dim(`      on ${some(k.paths, k.morePaths ?? 0)} · ${fresh}`)];
  if (k.note) out.push(c.dim(`      says “${plain(k.note, 160)}”`));
  return out;
}

/** One landing: when, its commit and intent, the reached files it changed, and the intent's why. */
function landingLines(l: Partial<ImpactLanding>, c: Colors, now: number): string[] {
  const when = typeof l.at === "number" ? ago(l.at, now) : "?";
  const intent = l.intentId ? ` ${plain(l.intentId)}` : "";
  const title = l.title ? ` “${plain(l.title, 100)}”` : "";
  const out = [`  ${c.dim(when.padEnd(8))} ${plain(l.landingId)} ${c.dim(shortSha(l.trunkSha ?? null))}${intent}${title}`, c.dim(`      changed ${some(l.paths, l.morePaths ?? 0)}`)];
  if (l.why) out.push(c.dim(`      why: ${plain(l.why, WHY_SHOWN)}`));
  return out;
}

/** The answer of `ft impact`: the files a change reaches, level by level; who works on them now; the latest landings on them. */
export function formatImpact(colony: string, res: unknown, c: Colors, now: number): string {
  const r = (res ?? {}) as Partial<ImpactReport>;
  if (!Array.isArray(r.files)) return JSON.stringify(res, null, 2);
  const files = r.files.filter((f) => f && typeof f.path === "string");
  const importers = files.filter((f) => (f.depth ?? 0) > 0).length;
  const claims = Array.isArray(r.claims) ? r.claims : [];
  const landings = Array.isArray(r.landings) ? r.landings : [];
  const asked = (r.paths ?? []).map((p) => plain(p));
  const index = r.index?.read === false ? c.yellow("importers not read") : r.index?.current === false ? c.yellow("import index catching up") : "import index current";
  const levels = r.limits?.depth ?? 3;
  const reach = `${num(importers)} file${importers === 1 ? "" : "s"} reach${importers === 1 ? "es" : ""} ${asked.length === 1 ? "it" : "them"} through imports (up to ${levels} level${levels === 1 ? "" : "s"})`;
  const out = [
    `Impact of ${c.bold(asked.join(", ") || "?")} in ${c.bold(colony)}`,
    c.dim(`  trunk ${shortSha(r.trunkSha ?? null)} · ${index} · ${reach} · ${num(claims.length)} agent${claims.length === 1 ? "" : "s"} on them now`),
  ];
  if (r.index?.note) out.push(c.yellow(`  ! ${plain(r.index.note, 300)}`));
  if ((r.missing ?? []).length > 0) out.push(c.yellow(`  ! not on trunk: ${some(r.missing, 0, 5)}`));
  let shown = 0;
  for (let depth = 0; depth < LEVELS.length; depth++) {
    const level = files.filter((f) => (f.depth ?? 0) === depth);
    if (level.length === 0 || shown >= FILES_SHOWN) continue;
    out.push("", c.bold(LEVELS[depth] ?? `Level ${depth}`));
    for (const f of level) {
      if (shown >= FILES_SHOWN) break;
      out.push(fileLine(f, c));
      shown++;
    }
  }
  if (files.length > shown) out.push(c.dim(`  … ${num(files.length - shown)} more (--json lists them all)`));
  if (r.truncated) out.push(c.dim(`  More files import these than the walk reached (it stops at ${r.limits?.depth ?? 3} levels and ${num(r.limits?.files ?? 200)} files).`));
  out.push("", c.bold("Working on them now"));
  if (claims.length === 0) out.push(c.dim("  Nobody holds a claim on these files."));
  for (const k of claims) out.push(...claimLines(k, c, now));
  if ((r.unread ?? []).length > 0) out.push(c.yellow(`  ! claims not read in ${some(r.unread, 0, 5)} (too many regions, or the read failed)`));
  out.push("", c.bold("Latest landings on them"));
  if (landings.length === 0) out.push(c.dim("  None in the colony's record."));
  for (const l of landings) out.push(...landingLines(l, c, now));
  if (r.about) out.push("", c.dim(plain(r.about, 400)));
  return out.join("\n");
}
