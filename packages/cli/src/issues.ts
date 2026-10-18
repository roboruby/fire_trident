import type { ApiRequest } from "./api.ts";
import type { Colors } from "./format.ts";

/**
 * GitHub issues as intents, in the CLI (packages/worker/src/colony/issues.ts on the server): `ft issues import <colony>
 * <owner/repo>` asks the colony to read the repository's open issues from GitHub and declare one intent per issue it
 * has not imported before. A stranger wrote each issue, so the colony reviews these intents as it reviews an agent's
 * request. `--close-on-land` (with FT_GITHUB_TOKEN set on the server) has the colony comment on each issue when its
 * change lands, and `--close` closes it too. The CLI only sends the request: the server talks to GitHub.
 */

/** One `ft issues import` invocation. */
export interface IssuesCommand {
  name: "issues";
  colony: string;
  repo: string;
  labels: string[];
  limit?: number;
  footprint: string[];
  closeOnLand: boolean;
  close: boolean;
  by?: string;
}

/** The options `ft issues` takes. */
export const ISSUES_OPTIONS: Record<string, { type: "string" | "boolean"; multiple?: boolean }> = {
  label: { type: "string", multiple: true },
  limit: { type: "string" },
  footprint: { type: "string", multiple: true },
  "close-on-land": { type: "boolean" },
  close: { type: "boolean" },
  by: { type: "string" },
};

/** How `ft issues` is used. */
export const ISSUES_USAGE = "ft issues import <colony> <owner/repo> [--label <name>]... [--limit <1-100>] [--footprint <glob>]... [--close-on-land [--close]]";

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;

/** owner/name from owner/name or a https://github.com URL (with or without .git), or null. */
export function repoArg(raw: string): string | null {
  let s = raw.trim().replace(/\/+$/, "");
  const url = /^https:\/\/(?:www\.)?github\.com\/(.+)$/i.exec(s);
  if (url) s = url[1] ?? "";
  s = s.replace(/\.git$/i, "");
  const parts = s.split("/");
  if (parts.length !== 2) return null;
  const [owner, name] = parts as [string, string];
  return OWNER.test(owner) && NAME.test(name) && name !== "." && name !== ".." ? `${owner}/${name}` : null;
}

function strings(v: unknown): string[] {
  return (Array.isArray(v) ? v : []).filter((s): s is string => typeof s === "string").map((s) => s.trim()).filter(Boolean);
}

/** `ft issues import ...`, parsed; a usage error as a string. */
export function parseIssuesCommand(v: Record<string, unknown>, p: string[]): IssuesCommand | string {
  if (p[0] !== "import") return p[0] ? `unknown issues action "${p[0]}": the one action is import. Usage: ${ISSUES_USAGE}` : `missing issues action. Usage: ${ISSUES_USAGE}`;
  const colony = p[1]?.trim();
  if (!colony) return `missing <colony>. Usage: ${ISSUES_USAGE}`;
  if (!p[2]) return `missing <owner/repo>, the GitHub repository whose open issues to import. Usage: ${ISSUES_USAGE}`;
  if (p.length > 3) return `unexpected argument "${p[3]}". Usage: ${ISSUES_USAGE}`;
  const repo = repoArg(p[2]);
  if (!repo) return `"${p[2]}" is not a GitHub repository: give it as owner/name, such as octo-org/hello-world`;
  const labels = strings(v.label).flatMap((l) => l.split(",")).map((l) => l.trim()).filter(Boolean);
  if (labels.length > 10) return "at most 10 labels: an issue must carry every label given";
  const cmd: IssuesCommand = { name: "issues", colony, repo, labels: [...new Set(labels)], footprint: strings(v.footprint), closeOnLand: v["close-on-land"] === true, close: v.close === true };
  const limit = typeof v.limit === "string" ? v.limit.trim() : undefined;
  if (limit !== undefined) {
    if (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 100) return `--limit must be a whole number from 1 to 100, got "${limit}"`;
    cmd.limit = Number(limit);
  }
  if (cmd.close && !cmd.closeOnLand) return "--close goes with --close-on-land: the colony closes an issue only after it comments on it at landing";
  const by = typeof v.by === "string" ? v.by.trim() : "";
  if (by) cmd.by = by;
  return cmd;
}

/** POST /api/colonies/:id/issues/import with what the command asks. */
export function issuesRequest(cmd: IssuesCommand, by: string, colonyPath: (colony: string, suffix?: string) => string): ApiRequest {
  return {
    method: "POST",
    path: colonyPath(cmd.colony, "/issues/import"),
    body: {
      repo: cmd.repo,
      ...(cmd.labels.length > 0 ? { labels: cmd.labels } : {}),
      ...(cmd.limit !== undefined ? { limit: cmd.limit } : {}),
      ...(cmd.footprint.length > 0 ? { footprint: cmd.footprint } : {}),
      ...(cmd.closeOnLand ? { closeOnLand: true } : {}),
      ...(cmd.close ? { close: true } : {}),
      by: cmd.by ?? by,
    },
  };
}

interface ImportAnswer {
  repo?: unknown;
  imported?: unknown;
  skipped?: unknown;
  note?: unknown;
  read?: { issues?: unknown; pullRequests?: unknown };
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** The answer as terminal lines: each issue imported (its intent and title), each skipped and why, and the note. */
export function formatIssues(cmd: IssuesCommand, res: unknown, c: Colors): string {
  const a = (res && typeof res === "object" ? res : {}) as ImportAnswer;
  const imported = (Array.isArray(a.imported) ? a.imported : []) as Array<Record<string, unknown>>;
  const skipped = (Array.isArray(a.skipped) ? a.skipped : []) as Array<Record<string, unknown>>;
  const repo = str(a.repo) || cmd.repo;
  const out: string[] = [];
  const read = num(a.read?.issues);
  const pulls = num(a.read?.pullRequests);
  const from = read === null ? "" : c.dim(` (read ${read} open issue${read === 1 ? "" : "s"}${pulls ? `, skipped ${pulls} pull request${pulls === 1 ? "" : "s"}` : ""})`);
  out.push(`${imported.length > 0 ? c.green("✓") : c.yellow("·")} ${imported.length} issue${imported.length === 1 ? "" : "s"} of ${c.bold(repo)} imported into ${c.bold(cmd.colony)}${from}`);
  for (const i of imported) out.push(`  #${num(i.number) ?? "?"} ${c.bold(str(i.intentId))} ${str(i.title)}`);
  for (const s of skipped) out.push(c.dim(`  #${num(s.number) ?? "?"} skipped: ${str(s.reason)}`));
  if (str(a.note)) out.push(c.dim(`  ${str(a.note)}`));
  if (skipped.some((s) => /no footprint/.test(str(s.reason)))) out.push(c.dim(`  To import those too: ft issues import ${cmd.colony} ${repo} --footprint '<glob>'`));
  if (imported.length > 0) out.push(c.dim(`  Next: ft swarm ${cmd.colony} --agents <n>   or connect your own agent: ft connect ${cmd.colony}`));
  return out.join("\n");
}
