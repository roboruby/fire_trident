import type { PauseState } from "@fire_trident/core";
import type { Command } from "./args.ts";
import type { ApiRequest } from "./api.ts";
import type { Colors } from "./format.ts";

/**
 * The pause switch in the CLI (packages/worker/src/colony/pause.ts): `ft pause <colony> --reason <text>` stops every
 * agent of a colony, `ft pause --deployment --reason <text>` every agent on the server, `ft resume` lets them go on,
 * and `ft status` leads with the pauses in force.
 */

type PauseCommand = Extract<Command, { name: "pause" | "resume" }>;

/** Server text (a person's name or words) on one terminal line: no control characters. */
function plain(s: unknown): string {
  return typeof s === "string" ? s.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim() : "";
}

/** The request of `ft pause` or `ft resume`: the colony's route, or the deployment's when no colony is named. */
export function pauseRequest(cmd: PauseCommand, by: string, colonyPath: (colony: string, suffix: string) => string): ApiRequest {
  const action = cmd.name === "pause" ? "pause" : "resume";
  const path = cmd.colony ? colonyPath(cmd.colony, `/${action}`) : `/api/${action}`;
  const body: Record<string, string> = { by: cmd.by ?? by };
  if (cmd.reason) body.reason = cmd.reason;
  return { method: "POST", path, body };
}

/** "the colony web" or "every colony on the server". */
function where(cmd: PauseCommand): string {
  return cmd.colony ? `the colony ${cmd.colony}` : "every colony on the server";
}

/** The command that resumes what `p` paused. */
export function resumeCommand(p: Pick<PauseState, "scope">, colony: string): string {
  return p.scope === "deployment" ? "ft resume --deployment" : `ft resume ${colony}`;
}

/** The answer of `ft pause` or `ft resume`, in words. */
export function formatPause(cmd: PauseCommand, res: unknown, c: Colors): string {
  const r = (res ?? {}) as {
    pause?: Partial<PauseState>;
    already?: boolean;
    writer?: boolean;
    resumed?: { by?: string } | null;
    pauses?: Array<Partial<PauseState>>;
    colonies?: { total?: number; told?: number; failed?: unknown[] };
    spendCap?: string;
  };
  const told =
    r.colonies && typeof r.colonies.total === "number"
      ? c.dim(`  ${r.colonies.told ?? 0} of ${r.colonies.total} colonies told now${Array.isArray(r.colonies.failed) && r.colonies.failed.length > 0 ? "; the others read it again within seconds" : ""}.`)
      : null;
  if (cmd.name === "pause") {
    const p = r.pause;
    if (!p) return JSON.stringify(res);
    const head = `${r.already ? c.yellow("Already paused") : c.red("Paused")} ${where(cmd)}: ${plain(p.by) || "someone"}: ${plain(p.reason)}`;
    return [
      head,
      c.dim("  Agents cannot take work, propose, declare, report or start, and changes in the lanes wait there; reads and every"),
      c.dim("  person's action (review, amend, withdraw, revert) still work."),
      ...(told ? [told] : []),
      c.dim(`  Resume: ${cmd.colony ? `ft resume ${cmd.colony}` : "ft resume --deployment"}`),
    ].join("\n");
  }
  if (r.already || !r.resumed) {
    return [`${c.yellow("Not paused")}: nothing to resume for ${where(cmd)}.`, ...stillPaused(r.pauses, cmd.colony ?? "", c), ...(told ? [told] : [])].join("\n");
  }
  // The spend cap (spendcap.ts): resumed while still over the cap, the next model call pauses the agents again.
  const capNote = typeof r.spendCap === "string" && r.spendCap ? [c.yellow(`  ${plain(r.spendCap)}`)] : [];
  return [`${c.green("Resumed")} ${where(cmd)}: agents may work again, and the lanes land what waited in them.`, ...stillPaused(r.pauses, cmd.colony ?? "", c), ...capNote, ...(told ? [told] : [])].join("\n");
}

/** Lines for pauses still in force after a resume (a colony's own pause outlives the deployment's, and the other way round). */
function stillPaused(pauses: Array<Partial<PauseState>> | undefined, colony: string, c: Colors): string[] {
  return (Array.isArray(pauses) ? pauses : [])
    .filter((p) => p && (p.scope === "colony" || p.scope === "deployment"))
    .map((p) => c.yellow(`  Still paused (${p.scope}) by ${plain(p.by) || "someone"}: ${plain(p.reason)}. Resume: ${resumeCommand(p as PauseState, colony)}`));
}

/** The lines `ft status` leads with while agents are paused (none while they may work). */
export function pauseLines(pauses: unknown, colony: string, c: Colors): string[] {
  const list = (Array.isArray(pauses) ? pauses : []).filter((p): p is PauseState => !!p && typeof p === "object" && (p.scope === "colony" || p.scope === "deployment"));
  return list.map(
    (p) =>
      `${c.dim("paused".padEnd(11))}${c.red(p.scope === "deployment" ? "the whole deployment" : "this colony")} by ${plain(p.by) || "someone"}: ${plain(p.reason)}  ${c.dim(`→ ${resumeCommand(p, colony)}`)}`,
  );
}
