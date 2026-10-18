import type { CommitAuthor } from "@fire_trident/core";
import type { Command } from "./args.ts";
import type { ApiRequest } from "./api.ts";
import type { Colors } from "./format.ts";

/**
 * People as commit authors in the CLI (packages/worker/src/colony/commitauthor.ts): `ft commit-author <colony> --name
 * <name> --email <email>` makes that person the author of every landing commit of the colony (FireTrident stays the
 * committer, so signatures are unchanged, and agents get no Co-authored-by trailers; the lineage note still names every
 * agent); `ft commit-author <colony> off` goes back to FireTrident as the author; with neither, it shows the setting.
 */

type CommitAuthorCommand = Extract<Command, { name: "commit-author" }>;

/** How `ft commit-author` is used. */
export const COMMIT_AUTHOR_USAGE = "ft commit-author <colony> [--name <name> --email <email> | off] [--by <name>]";

/** `ft commit-author <colony> [off]`, parsed; a usage error as a string. */
export function parseCommitAuthor(v: Record<string, unknown>, p: string[]): CommitAuthorCommand | string {
  if (p.length > 2) return `unexpected argument "${p[2]}". Usage: ${COMMIT_AUTHOR_USAGE}`;
  const colony = p[0];
  if (!colony) return `missing <colony>. Usage: ${COMMIT_AUTHOR_USAGE}`;
  const name = typeof v.name === "string" ? v.name.trim() : undefined;
  const email = typeof v.email === "string" ? v.email.trim() : undefined;
  const by = typeof v.by === "string" ? v.by.trim() : "";
  const word = p[1]?.trim();
  if (word !== undefined && !/^(off|none|remove)$/i.test(word)) return `unexpected argument "${word}": name the person with --name and --email, or say off. Usage: ${COMMIT_AUTHOR_USAGE}`;
  if (word !== undefined) {
    if (name !== undefined || email !== undefined) return `--name and --email do not apply when going back to FireTrident as the author. Usage: ${COMMIT_AUTHOR_USAGE}`;
    return { name: "commit-author", colony, off: true, ...(by ? { by } : {}) };
  }
  if (name === undefined && email === undefined) {
    if (by) return `name the person with --name and --email (or say off). Usage: ${COMMIT_AUTHOR_USAGE}`;
    return { name: "commit-author", colony };
  }
  if (!name || !email) return `give both --name and --email: git names a commit's author by both. Usage: ${COMMIT_AUTHOR_USAGE}`;
  return { name: "commit-author", colony, author: { name, email }, ...(by ? { by } : {}) };
}

/** The request of `ft commit-author`: read the setting, name a person, or go back to FireTrident. */
export function commitAuthorRequest(cmd: CommitAuthorCommand, by: string, colonyPath: (colony: string, suffix: string) => string): ApiRequest {
  const path = colonyPath(cmd.colony, "/commit-author");
  if (cmd.off) return { method: "POST", path, body: { name: null, by: cmd.by ?? by } };
  if (cmd.author) return { method: "POST", path, body: { name: cmd.author.name, email: cmd.author.email, by: cmd.by ?? by } };
  return { method: "GET", path };
}

/** Server text on one terminal line: no control characters. */
function plain(s: unknown): string {
  return typeof s === "string" ? s.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim() : "";
}

/** The answer of `ft commit-author`, in words. */
export function formatCommitAuthor(cmd: CommitAuthorCommand, res: unknown, c: Colors): string {
  const r = (res ?? {}) as { author?: Partial<CommitAuthor> | null; cleared?: boolean };
  const a = r.author && typeof r.author === "object" ? r.author : null;
  const who = a ? `${plain(a.name)}${a.email ? ` <${plain(a.email)}>` : ""}` : "";
  const check = c.dim(`  Check it on a clone: git log --format='%an %cn' shows the author, then FireTrident as the committer.`);
  if (cmd.off) return `${c.green("FireTrident")} authors ${cmd.colony}'s landing commits again${r.cleared === false ? " (no person was named)" : ""}; agents are credited as before.`;
  if (cmd.author) return [`${c.green("Named")} ${who} as the author of ${cmd.colony}'s landing commits.`, c.dim("  FireTrident stays the committer, so signatures check as before; agents get no Co-authored-by lines, and each lineage note still names them."), check].join("\n");
  if (!a) return [`${c.dim("FireTrident")} authors ${cmd.colony}'s landing commits.`, c.dim(`  Name a person: ft commit-author ${cmd.colony} --name <name> --email <email>`)].join("\n");
  const since = a.by ? c.dim(` (set by ${plain(a.by)})`) : "";
  return [`${c.bold("Commit author")} of ${cmd.colony}: ${who}${since}`, c.dim("  FireTrident is the committer; agents are named in the lineage notes."), check].join("\n");
}
