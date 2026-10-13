import { fmtInt, shortSha } from "./format.ts";
import type { CertView } from "./store.ts";

/** Trunk certification as the UI words it (the trunk bar, the Why tab, the event log). */

/** "60/60 tests" or "5 failing". */
export function certCounts(c: Pick<CertView, "counts">): string {
  const k = c.counts;
  if (!k) return "";
  const bad = k.fail + k.cancelled;
  return bad === 0 ? `${fmtInt(k.pass)}/${fmtInt(k.tests - k.skipped - k.todo)} tests` : `${fmtInt(bad)} failing`;
}

/** The hover text of a certification: what ran and, when red, which tests failed and why. */
export function certTitle(c: CertView): string {
  const k = c.counts;
  const took = typeof c.durationMs === "number" ? `, ${(c.durationMs / 1000).toFixed(1)} s` : "";
  const reused = c.reusedFrom ? `\nSame tested files as ${shortSha(c.reusedFrom)}: its result holds.` : "";
  if (c.status === "running") return `Running the project's own tests on ${shortSha(c.trunkSha)}…`;
  if (c.status === "error") return `The tests could not run on ${shortSha(c.trunkSha)}: ${c.detail ?? "unknown error"}`;
  if (c.status === "skipped") return c.detail ?? "Nothing to certify";
  if (c.status === "green") return `${shortSha(c.trunkSha)}: all ${fmtInt(k?.pass ?? 0)} tests pass (node:test in a Dynamic Worker${took})${reused}`;
  const lines = (c.failing ?? []).slice(0, 10).map((f) => `• ${f.name}${f.error ? `: ${f.error}` : ""}`);
  const more = k ? k.fail + k.cancelled - lines.length : 0;
  return `${shortSha(c.trunkSha)}: ${fmtInt(k ? k.fail + k.cancelled : lines.length)} of ${fmtInt(k?.tests ?? 0)} tests failing${took}\n${lines.join("\n")}${more > 0 ? `\n… and ${more} more` : ""}${reused}`;
}
