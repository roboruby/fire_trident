import type { Path } from "@fire_trident/core";
import { foldPath } from "./pathfold.ts";

/**
 * Handoff: files another tool runs or obeys. Review judges what a change does in the repository, but these files act
 * outside it, on the machine of whoever checks the repository out: an agent client starts the MCP servers `.mcp.json`
 * lists and sends them the credentials it names, an editor runs the tasks under `.vscode/`, a shell loader runs
 * `.envrc` when a shell enters the directory, a hook manager runs `.husky/` on commit, git clones what `.gitmodules`
 * names and runs the drivers `.gitattributes` selects, and other coding agents obey their own instruction files. An
 * agent that rewrites one acts through someone else's tools, so a change to any of them is the must-human danger
 * class "handoff" (decide/danger.ts): like governance, no policy, antibody, intent text or earned autonomy waives it,
 * and deleting such a file counts as much as writing one. The colony's own memory and the agent instructions
 * FireTrident's agents read (`.firetrident/`, `AGENTS.md`, `CLAUDE.md`, `.claude/`) are governance, not repeated here.
 * Every pattern tests the folded path (decide/pathfold.ts), so `.MCP.json` and `.VSCode/` hit too. Pure.
 */

/** One kind of file another tool runs or obeys. */
export interface HandoffPath {
  /** Pattern id (the danger pattern is `handoff:<id>`). */
  id: string;
  /** Tested against the folded path, so it is written in lower case. */
  re: RegExp;
  /** What the other tool does with the file, as the person deciding reads it. */
  why: string;
}

/**
 * Every handoff path, matched anywhere in the tree (a nested project's files are read by the same tools). This is the
 * one list: the danger scan reads it and the tests walk it. A `.gitattributes` file is not on it: only its lines that
 * select a filter, diff or merge driver are handoff (handoffMatches).
 */
export const HANDOFF_PATHS: readonly HandoffPath[] = [
  // Any MCP client configuration (`.mcp.json`, and the `mcp.json` or `mcp_config.json` an agent's or editor's directory holds).
  { id: "mcp-config", re: /(^|\/)\.?mcp(?:_config)?\.json$/, why: "agent clients start or call the MCP servers it lists and send them the credentials it names" },
  { id: "editor-config", re: /(^|\/)\.(?:vscode|idea)\//, why: "editors run the tasks, launch commands and servers it configures" },
  { id: "agent-config", re: /(^|\/)\.(?:cursor|gemini|windsurf)\//, why: "coding agents load the rules, MCP servers and hooks it configures" },
  {
    id: "agent-instructions",
    re: /(^|\/)(?:(?:gemini|agent|claude\.local)\.md$|\.cursorrules$|\.windsurfrules$|\.clinerules(?:\/|$)|\.aider[^/]*(?:\/|$)|\.github\/(?:copilot-instructions\.md$|instructions\/))/,
    why: "coding agents obey it as instructions",
  },
  { id: "dev-container", re: /(^|\/)(?:\.devcontainer\/|\.devcontainer\.json$)/, why: "editors build and start a container from it and run the commands it lists" },
  { id: "shell-env", re: /(^|\/)\.envrc$/, why: "a shell environment loader runs it when a shell enters the directory" },
  { id: "git-hooks", re: /(^|\/)(?:\.husky\/|\.githooks\/|\.pre-commit-config\.yaml$)/, why: "git hook managers run it on commit and push" },
  { id: "submodules", re: /(^|\/)\.gitmodules$/, why: "git clones the repositories it names" },
  { id: "nested-git", re: /(^|\/)\.git(?:\/|$)/, why: "git reads it as repository metadata, hooks and configuration" },
  { id: "python-env", re: /(^|\/)(?:pyvenv\.cfg|bin\/python[^/]*)$/, why: "tools run the Python interpreter a virtual environment names" },
];

/** A `.gitattributes` file, anywhere in the tree (each one sets attributes for its directory). */
const GITATTRIBUTES = /(^|\/)\.gitattributes$/;
/** An attribute line that selects a filter, diff or merge driver by name (`*.dat filter=x`, `[attr]bin merge=y`). */
const DRIVER = /(?:^|\s)(?:filter|diff|merge)=\S/i;
const DRIVER_WHY = "git runs the filter, diff or merge driver it selects on checkout, diff or merge";

/** One handoff finding: a whole file (`line` 0) or one `.gitattributes` line that selects a driver. */
export interface HandoffMatch {
  id: string;
  /** 1-based line in the new text; 0 for the whole file. */
  line: number;
  /** The driver line, for a line finding. */
  text?: string;
  why: string;
}

/** One written or deleted file as the danger scan sees it. */
export interface HandoffFile {
  path: Path;
  before: string | null;
  /** New text; null when the change deletes the file or it could not be read. */
  after: string | null;
  deleted?: boolean;
  /** The new text could not be read (binary, too large or unreadable): `after` is not what the file holds. */
  opaque?: boolean;
}

/** The attribute lines of `text` that select a driver, each with its 1-based line and its whitespace-collapsed form. */
function driverLines(text: string): Array<{ line: number; text: string; key: string }> {
  const out: Array<{ line: number; text: string; key: string }> = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!.trim();
    if (t === "" || t.startsWith("#") || !DRIVER.test(t)) continue;
    out.push({ line: i + 1, text: t, key: t.split(/\s+/).join(" ") });
  }
  return out;
}

/**
 * The handoff findings of one file: the whole file when its path is a handoff path (written or deleted), and every
 * `.gitattributes` line that selects a filter, diff or merge driver and that the old text did not have (a line added
 * or altered; one only moved is no finding, nor is one removed). A `.gitattributes` whose new text could not be read
 * is a finding as a whole: the check fails closed.
 */
export function handoffMatches(f: HandoffFile): HandoffMatch[] {
  const folded = foldPath(f.path);
  const kind = HANDOFF_PATHS.find((h) => h.re.test(folded));
  if (kind) return [{ id: kind.id, line: 0, why: kind.why }];
  if (!GITATTRIBUTES.test(folded) || f.deleted) return [];
  if (f.after === null || f.opaque) return [{ id: "git-drivers", line: 0, why: `its text could not be read, so the drivers it may select were not checked (${DRIVER_WHY})` }];
  const had = new Set(driverLines(f.before ?? "").map((l) => l.key));
  return driverLines(f.after)
    .filter((l) => !had.has(l.key))
    .map((l) => ({ id: "git-drivers", line: l.line, text: l.text, why: DRIVER_WHY }));
}
