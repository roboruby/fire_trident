import type { Colors } from "./format.ts";

/**
 * Trunk health in `ft status`: the `trunkHealth` object GET /api/colonies/:id/metrics serves (worker certify/health.ts),
 * read defensively. The words are the server's, so the CLI and the colony page say the same thing: one line ("red 2
 * times in 400 landings, 3.4 min to green at p50, 0 landings built on red") and the rest in sentences under it, or why
 * there are no numbers. A server that predates the report prints nothing.
 */

const LABEL = 11;
const STATUSES = new Set(["measured", "no-tests", "off", "none"]);

const isRecord = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === "object" && !Array.isArray(x);

/** One line of the server's text: control characters and line breaks out, so a report cannot draw on the terminal. */
function clean(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim();
}

/** The `health` rows of `ft status` from the answer of GET /metrics (empty when it carries no trunk health). */
export function trunkHealthLines(metrics: unknown, c: Colors): string[] {
  const h = isRecord(metrics) ? metrics.trunkHealth : undefined;
  if (!isRecord(h) || typeof h.status !== "string" || !STATUSES.has(h.status) || typeof h.text !== "string" || clean(h.text) === "") return [];
  const label = c.dim("health".padEnd(LABEL));
  const pad = " ".repeat(LABEL);
  if (h.status !== "measured") return [`${label}${c.dim(clean(h.text))}`];
  const redNow = isRecord(h.red) && typeof h.red.since === "number";
  const out = [`${label}${redNow ? c.yellow(clean(h.text)) : clean(h.text)}`];
  for (const d of Array.isArray(h.detail) ? h.detail : []) if (typeof d === "string" && clean(d) !== "") out.push(`${pad}${c.dim(clean(d))}`);
  return out;
}
