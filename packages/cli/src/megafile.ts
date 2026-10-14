import type { MegafileHold, MegafileReport } from "@fire_trident/core";
import type { Colors } from "./format.ts";

/**
 * The megafile alarm in the CLI (FT_MEGAFILE on the server): the held files in `ft status`, and `ft megafile` to list
 * them, or to hold or release one.
 */

/** Holds lifted lately that the status lists at most. */
const LIFTED_SHOWN = 3;

/** A duration in the CLI's short form ("54m", "2h", "30s"). */
function span(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

/** Server text (a path, a person's name) on one terminal line: no control characters. */
function plain(s: unknown): string {
  return typeof s === "string" ? s.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim() : "";
}

/** What made a file hot, with its numbers: "growth: 830 lines, from 650 (+28%) in 30m, 5 agents, 0 returns". */
export function holdNumbers(h: Partial<MegafileHold>): string {
  const lines = typeof h.lines === "number" ? `${h.lines} lines` : "length not known";
  const from = typeof h.baseline === "number" && typeof h.lines === "number" ? `, from ${h.baseline}${typeof h.growth === "number" ? ` (+${Math.round(h.growth * 100)}%)` : ""} in ${span(h.windowMs ?? 0)}` : "";
  const agents = typeof h.agents === "number" ? `, ${h.agents} agent${h.agents === 1 ? "" : "s"}` : "";
  const returns = typeof h.returns === "number" ? `, ${h.returns} return${h.returns === 1 ? "" : "s"}` : "";
  return `${plain(h.signal) || "held"}: ${lines}${from}${agents}${returns}`;
}

/**
 * The megafile rows of `ft status` (and `ft megafile`): the held files, each with its split intent, when the hold lifts
 * by itself, its numbers and the command that releases it; then the holds lifted lately, each with why and the file's
 * lines before and after its split.
 */
export function megafileLines(report: Partial<MegafileReport>, colony: string, c: Colors, now: number): string[] {
  const held = (Array.isArray(report.held) ? report.held : []).filter((h) => h && typeof h.path === "string");
  const lifted = (Array.isArray(report.lifted) ? report.lifted : []).filter((h) => h && typeof h.path === "string").slice(0, LIFTED_SHOWN);
  const out = [`${c.dim("megafiles".padEnd(11))}${held.length === 0 ? c.green("none held") : c.yellow(`${held.length} held for a split`)}`];
  for (const h of held) {
    const left = typeof h.until === "number" ? `, lifts in ${span(h.until - now)}` : "";
    out.push(`  ${c.bold(plain(h.path))}  ${c.dim(`split by ${plain(h.intentId)}${left}`)}  ${holdNumbers(h)}`);
    out.push(`        ${c.dim("→")} release it: ${c.cyan(`ft megafile ${colony} ${plain(h.path)} --release`)}`);
  }
  for (const h of lifted) {
    const at = typeof h.liftedAt === "number" ? ` ${span(now - h.liftedAt)} ago` : "";
    const sizes = typeof h.lines === "number" && typeof h.linesAfter === "number" ? `, ${h.lines} → ${h.linesAfter} lines` : "";
    out.push(c.dim(`  lifted${at}: ${plain(h.path)} (${plain(h.lifted) || "lifted"}${sizes})`));
  }
  return out;
}

/** The answer of `ft megafile`: the colony's held files, or the hold or release a person asked for. */
export function formatMegafile(cmd: { colony: string; path?: string; release: boolean }, res: unknown, c: Colors, now: number): string {
  const r = (res ?? {}) as Partial<MegafileReport> & { on?: boolean; hold?: MegafileHold; already?: boolean; released?: MegafileHold };
  if (!cmd.path) {
    if (r.on === false) return `${c.yellow("off")}  the megafile alarm is off for ${cmd.colony} (FT_MEGAFILE on the server); nothing is held`;
    return megafileLines(r, cmd.colony, c, now).join("\n");
  }
  if (r.released) {
    return [`${c.green("Released")} ${c.bold(plain(r.released.path))} (${plain(r.released.lifted)})`, c.dim(`  Its split intent ${plain(r.released.intentId)} stays open for any agent.`)].join("\n");
  }
  const h = r.hold;
  if (!h) return JSON.stringify(res);
  const left = typeof h.until === "number" ? ` It lifts by itself in ${span(h.until - now)}.` : "";
  return [
    `${r.already ? c.yellow("Already held") : c.green("Held")} ${c.bold(plain(h.path))} for its split: intent ${c.bold(plain(h.intentId))}`,
    c.dim(`  No other intent that covers it is offered, and changes that write it go back until the split lands.${left}`),
    c.dim(`  Release it: ft megafile ${cmd.colony} ${plain(h.path)} --release`),
  ].join("\n");
}
