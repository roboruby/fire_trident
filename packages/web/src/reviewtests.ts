import type { Proposal, ReviewTestFailing, ReviewTestOnTrunk, ReviewTestsRun } from "@fire_trident/core";

/**
 * Tests before approval as a review card leads with them (worker certify/reviewtests.ts): the colony's tests run on an
 * escalated change at its base while it waits for a person, how many passed, the failing tests with the first line of
 * each error and how each did on trunk, or why they did not run. The review queue sends each item's run as
 * `reviewTests` (the proposal's evidence records it too); the server writes the lead sentence. Everything is read
 * defensively, and repository text is shown as text, never as markup.
 */

/** How a failing test did on the change's base, as the card names it. */
export const ON_TRUNK: Record<ReviewTestOnTrunk, string> = {
  passes: "passes on trunk",
  fails: "fails on trunk too",
  new: "new with this change",
  unfinished: "did not finish within the run",
  unknown: "no result on trunk to compare with",
};

const text = (v: unknown): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
const STATUSES: ReadonlySet<string> = new Set(["queued", "running", "ran", "notrun"]);
const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);

/** The run a review queue item carries (`reviewTests`, else its evidence's), checked field by field; null when none. */
export function reviewTestsOf(item: Proposal): ReviewTestsRun | null {
  const raw = (item as Proposal & { reviewTests?: unknown }).reviewTests ?? item.evidence?.reviewTests;
  if (!isObj(raw) || typeof raw.status !== "string" || !STATUSES.has(raw.status)) return null;
  const failing = (Array.isArray(raw.failing) ? raw.failing : [])
    .filter((f): f is Record<string, unknown> => isObj(f) && typeof f.name === "string")
    .map((f): ReviewTestFailing => {
      const on = typeof f.onTrunk === "string" && Object.hasOwn(ON_TRUNK, f.onTrunk) ? (f.onTrunk as ReviewTestOnTrunk) : "unknown";
      return { file: text(f.file), name: text(f.name), ...(text(f.error) ? { error: text(f.error) } : {}), onTrunk: on };
    });
  const trunk = isObj(raw.trunk) && (raw.trunk.status === "green" || raw.trunk.status === "red") ? raw.trunk : null;
  const onTrunk = Object.fromEntries(Object.keys(ON_TRUNK).flatMap((k) => (isObj(raw.onTrunk) && num(raw.onTrunk[k]) > 0 ? [[k, num(raw.onTrunk[k])]] : [])));
  return {
    id: text(raw.id),
    status: raw.status as ReviewTestsRun["status"],
    by: text(raw.by),
    at: num(raw.at),
    ...(text(raw.baseSha) ? { baseSha: text(raw.baseSha) } : {}),
    tests: num(raw.tests),
    passed: num(raw.passed),
    failed: num(raw.failed),
    ...(num(raw.files) > 0 ? { files: num(raw.files) } : {}),
    ...(num(raw.ranFiles) > 0 ? { ranFiles: num(raw.ranFiles) } : {}),
    ...(failing.length > 0 ? { failing } : {}),
    ...(Object.keys(onTrunk).length > 0 ? { onTrunk } : {}),
    ...(trunk ? { trunk: { sha: text(trunk.sha), status: trunk.status as "green" | "red", tests: num(trunk.tests), passed: num(trunk.passed), failing: num(trunk.failing) } } : {}),
    ...(text(raw.reason) ? { reason: text(raw.reason) } : {}),
    ...(text(raw.text) ? { text: text(raw.text) } : {}),
  };
}

/** The sentence the card leads with: the server's, or one built from the counts when it sent none. */
export function reviewTestsLead(r: ReviewTestsRun): string {
  if (r.text) return r.text;
  if (r.status === "queued") return "Tests on this change: waiting to run.";
  if (r.status === "running") return "Tests on this change: running on its base.";
  if (r.status === "notrun") return `Tests on this change: not run: ${r.reason ?? "no reason was recorded"}.`;
  return `Tests on this change: ${r.passed ?? 0}/${r.tests ?? 0} passed${(r.failed ?? 0) > 0 ? `, ${r.failed} failed` : ""}.`;
}

/** How the card colors the result: failed (a test failed), passed (every test passed), or pending (waiting, running, not run). */
export function reviewTestsTone(r: ReviewTestsRun): "failed" | "passed" | "pending" {
  if (r.status !== "ran") return "pending";
  return Math.max(r.failed ?? 0, r.failing?.length ?? 0) > 0 ? "failed" : "passed";
}

/** Whether any item's run is still waiting or going (the review tab then reads the queue more often). */
export function testsPending(items: readonly Proposal[]): boolean {
  return items.some((p) => {
    const r = reviewTestsOf(p);
    return r !== null && (r.status === "queued" || r.status === "running");
  });
}
