import type { SpendCap } from "@fire_trident/core";
import type { Command } from "./args.ts";
import type { ApiRequest } from "./api.ts";
import type { Colors } from "./format.ts";
import { usdText } from "./spend.ts";

/**
 * The spend cap in the CLI (packages/worker/src/colony/spendcap.ts): `ft spend-cap <colony> <usd>` caps what the model
 * calls the platform makes for a colony may cost, keeping `--review-reserve` of it for review; `ft spend-cap <colony>
 * off` removes it, and with no amount it shows where the colony stands. `ft status` shows the cap beside the spend.
 * spendCapLine mirrors core/pricing.ts (the published CLI carries no runtime code from the core package).
 */

type SpendCapCommand = Extract<Command, { name: "spend-cap" }>;

/** How `ft spend-cap` is used. */
export const SPEND_CAP_USAGE = "ft spend-cap <colony> [<usd> [--review-reserve <usd>] | off] [--by <name>]";

/** The largest cap the server takes (colony/spendcap.ts MAX_CAP_USD). */
const MAX_USD = 1_000_000;

/** A dollar amount typed on the command line ("5", "12.50", "$5"), or null when it is not one. */
function dollars(raw: string, allowZero: boolean): number | null {
  const t = raw.trim().replace(/^\$/, "");
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n > MAX_USD || (n === 0 && !allowZero)) return null;
  return n;
}

/** `ft spend-cap <colony> [<usd> | off]`, parsed; a usage error as a string. */
export function parseSpendCap(v: Record<string, unknown>, p: string[]): SpendCapCommand | string {
  if (p.length > 2) return `unexpected argument "${p[2]}". Usage: ${SPEND_CAP_USAGE}`;
  const colony = p[0];
  if (!colony) return `missing <colony>. Usage: ${SPEND_CAP_USAGE}`;
  const by = typeof v.by === "string" ? v.by.trim() : "";
  const reserveRaw = typeof v["review-reserve"] === "string" ? (v["review-reserve"] as string) : undefined;
  const amount = p[1]?.trim();
  if (!amount) {
    if (reserveRaw !== undefined || by) return `name the cap in dollars to set it (or off to remove it). Usage: ${SPEND_CAP_USAGE}`;
    return { name: "spend-cap", colony };
  }
  if (/^(off|none|remove)$/i.test(amount)) {
    if (reserveRaw !== undefined) return `--review-reserve does not apply when removing the cap. Usage: ${SPEND_CAP_USAGE}`;
    return { name: "spend-cap", colony, usd: null, ...(by ? { by } : {}) };
  }
  const usd = dollars(amount, false);
  if (usd === null) return `the cap must be a dollar amount above 0 and at most ${MAX_USD.toLocaleString("en-US")}, such as 5 or 12.50; got "${amount}"`;
  const cmd: SpendCapCommand = { name: "spend-cap", colony, usd, ...(by ? { by } : {}) };
  if (reserveRaw !== undefined) {
    const reserve = dollars(reserveRaw, true);
    if (reserve === null || reserve >= usd) return `--review-reserve must be a dollar amount of at least 0 and below the cap of ${usdText(usd)}; got "${reserveRaw}"`;
    cmd.reviewReserveUsd = reserve;
  }
  return cmd;
}

/** The request of `ft spend-cap`: read the cap, set it, or remove it. */
export function spendCapRequest(cmd: SpendCapCommand, by: string, colonyPath: (colony: string, suffix: string) => string): ApiRequest {
  const path = colonyPath(cmd.colony, "/spend-cap");
  if (cmd.usd === undefined) return { method: "GET", path };
  const body: Record<string, unknown> = { usd: cmd.usd, by: cmd.by ?? by };
  if (cmd.reviewReserveUsd !== undefined) body.reviewReserveUsd = cmd.reviewReserveUsd;
  return { method: "POST", path, body };
}

/** A finite, non-negative amount, or 0. */
function amount(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

/** Where the colony stands against its cap, in one line, as core/pricing.ts spendCapLine writes it; null with no cap. */
export function spendCapLine(cap: Partial<SpendCap> | null | undefined): string | null {
  if (!cap || typeof cap.usd !== "number" || !(cap.usd > 0)) return null;
  const reserve = amount(cap.reviewReserveUsd);
  const spent = usdText(amount(cap.spentUsd));
  if (cap.state === "spent") return `cap ${usdText(cap.usd)} spent (${spent}): review makes no model call, changes wait for a person`;
  if (cap.state === "review-only") return `cap ${usdText(cap.usd)}: ${spent} spent, agents stopped at ${usdText(cap.usd - reserve)}; review spends its ${usdText(reserve)} reserve`;
  return `cap ${usdText(cap.usd)}: ${spent} spent, agents stop at ${usdText(cap.usd - reserve)} and review keeps ${usdText(reserve)}`;
}

/** The `ft status` row's value for the cap, colored by where the colony stands; null with no cap. */
export function spendCapStatus(cap: Partial<SpendCap> | null | undefined, c: Colors): string | null {
  const line = spendCapLine(cap);
  if (!line) return null;
  return cap?.state === "spent" ? c.red(line) : cap?.state === "review-only" ? c.yellow(line) : line;
}

/** Server text on one terminal line: no control characters. */
function plain(s: unknown): string {
  return typeof s === "string" ? s.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim() : "";
}

/** The answer of `ft spend-cap`, in words. */
export function formatSpendCap(cmd: SpendCapCommand, res: unknown, c: Colors): string {
  const r = (res ?? {}) as { cap?: Partial<SpendCap> | null; lifted?: boolean; tripped?: boolean; note?: string };
  const scope = c.dim("  It counts the model calls this platform makes for the colony, not what external agents spend on their own models.");
  if (cmd.usd === undefined) {
    const line = spendCapStatus(r.cap, c);
    if (!line) return [`${c.dim("No spend cap")} on ${cmd.colony}: model calls go on with no limit.`, c.dim(`  Set one: ft spend-cap ${cmd.colony} <usd> [--review-reserve <usd>]`)].join("\n");
    return [`${c.bold("Spend cap")} on ${cmd.colony}: ${line}`, scope].join("\n");
  }
  const head = cmd.usd === null ? `${c.green("Removed")} the spend cap on ${cmd.colony}.` : r.tripped ? `${c.red("Capped")} ${cmd.colony}: the cap is already reached.` : `${c.green("Capped")} ${cmd.colony}.`;
  const lines = [head];
  if (r.note) lines.push(`  ${plain(r.note)}`);
  if (cmd.usd !== null) lines.push(scope);
  return lines.join("\n");
}
