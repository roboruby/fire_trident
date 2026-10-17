import { describe, expect, it } from "vitest";
import type { IntentSource } from "@fire_trident/core";
import { applyAllowances, dangerLabels, MUST_HUMAN, scanDanger, triageDanger, UNWAIVABLE, type DangerFile, type DangerIntent } from "../../src/decide/danger.ts";
import { HANDOFF_PATHS, handoffMatches } from "../../src/decide/handoff.ts";
import { foldPath } from "../../src/decide/pathfold.ts";
import { protectedHits, sensitiveReason } from "../../src/decide/signals.ts";
import { antibodyAllows } from "../../src/decide/antibodies.ts";
import { DEFAULT_POLICY, mergePolicy } from "../../src/decide/policy.ts";
import { gate, type GateInput } from "../../src/decide/gate.ts";

/**
 * Handoff (decide/handoff.ts): files another tool runs or obeys reach a person, and nothing an agent or a policy says
 * waives it; every safety matcher reads paths in their folded form (decide/pathfold.ts).
 */

function intent(title: string, source: IntentSource = "human"): DangerIntent {
  return { title, why: "", source };
}

/** The handoff hits a person must decide, for one changed file. */
function handoff(file: DangerFile, title = "Edit the project", source: IntentSource = "human") {
  return triageDanger(scanDanger([file], intent(title, source))).mustHuman.filter((h) => h.cls === "handoff");
}

const edit = (path: string, before = "a\n", after = "b\n"): DangerFile => ({ path, before, after });

/** At least one path per entry of the list, each written as a repository would hold it. */
const EXAMPLES: Record<string, string[]> = {
  "mcp-config": [".mcp.json", "packages/app/.mcp.json", ".vscode/mcp.json", ".cursor/mcp.json", ".tool/settings/mcp.json", "mcp_config.json"],
  "editor-config": [".vscode/settings.json", ".vscode/tasks.json", ".idea/workspace.xml"],
  "agent-config": [".cursor/rules/style.mdc", ".gemini/settings.json", ".windsurf/rules/a.md"],
  "agent-instructions": ["GEMINI.md", "AGENT.md", "CLAUDE.local.md", ".cursorrules", ".windsurfrules", ".clinerules", ".clinerules/style.md", ".aider.conf.yml", ".aiderignore", ".github/copilot-instructions.md", ".github/instructions/ts.instructions.md"],
  "dev-container": [".devcontainer/devcontainer.json", ".devcontainer/setup.sh", ".devcontainer.json"],
  "shell-env": [".envrc", "services/api/.envrc"],
  "git-hooks": [".husky/pre-commit", ".githooks/pre-push", ".pre-commit-config.yaml"],
  submodules: [".gitmodules"],
  "nested-git": ["vendor/lib/.git/config", "vendor/lib/.git/hooks/post-checkout", "vendor/lib/.git"],
  "python-env": [".venv/pyvenv.cfg", ".venv/bin/python", "env/bin/python3.12"],
};

describe("handoff paths", () => {
  it("are one exported list, and every entry has an example here", () => {
    expect(Object.keys(EXAMPLES).sort()).toEqual(HANDOFF_PATHS.map((h) => h.id).sort());
  });

  it("each path is a handoff hit a person decides, the label naming the file and why another tool makes it matter", () => {
    for (const [id, paths] of Object.entries(EXAMPLES)) {
      for (const path of paths) {
        const hits = handoff(edit(path));
        expect(hits.map((h) => h.pattern), path).toEqual([`handoff:${id}`]);
        const label = dangerLabels(hits)[0]!;
        expect(label.startsWith(`handoff (${id}) at ${path}: changed: another tool runs or obeys this file (`), label).toBe(true);
      }
    }
    expect(dangerLabels(handoff(edit(".mcp.json")))).toEqual([
      "handoff (mcp-config) at .mcp.json: changed: another tool runs or obeys this file (agent clients start or call the MCP servers it lists and send them the credentials it names)",
    ]);
  });

  it("new and deleted files count, like governance", () => {
    expect(handoff({ path: ".envrc", before: null, after: "export X=1\n" })[0]!.excerpt).toMatch(/^new file: /);
    expect(handoff({ path: ".husky/pre-commit", before: "npm test\n", after: null, deleted: true })[0]!.excerpt).toMatch(/^deleted: /);
  });

  it("look-alikes are not handoff", () => {
    for (const path of ["src/mcp.ts", "docs/mcp.json.md", "docs/vscode.md", "src/cursor.ts", "envrc", "src/.envrc.ts", "gitmodules", "src/git/config.ts", "docs/.github.md", "src/agent.ts", "bin/pythonic/x.ts", "src/husky/a.ts", "docs/aider.md"]) {
      expect(handoff(edit(path)), path).toEqual([]);
    }
  });

  it("case and Unicode variants hit: the paths are folded first", () => {
    for (const path of [".MCP.json", ".VSCode/tasks.json", ".Husky/pre-commit", ".ENVRC", "Gemini.MD", ".GITMODULES", "vendor/x/.GIT/config", ".Cur\u017Forrules", ".mcp\u200B.json"]) {
      expect(handoff(edit(path)).length, path).toBe(1);
    }
  });

  it("governance matches case-folded too: .Firetrident/, claude.md, Agents.MD, .CLAUDE/", () => {
    const governance = (path: string) => triageDanger(scanDanger([edit(path)], intent("Edit"))).mustHuman.filter((h) => h.cls === "governance").map((h) => h.pattern);
    expect(governance(".Firetrident/antibodies/ab_x.json")).toEqual(["governance:colony-memory"]);
    expect(governance(".FIRETRIDENT/antibodies/ab_x.json")).toEqual(["governance:colony-memory"]);
    for (const path of ["claude.md", "Agents.MD", ".CLAUDE/settings.json", "CLAUDE\u200D.md"]) expect(governance(path), path).toEqual(["governance:agent-instructions"]);
  });
});

describe("no policy, antibody, intent text or agent's words waive it", () => {
  it("is must-human and unwaivable, like governance", () => {
    expect(MUST_HUMAN.has("handoff")).toBe(true);
    expect(UNWAIVABLE.has("handoff")).toBe(true);
  });

  it("an allowance from a policy or an antibody, for every path or for the file itself, leaves it with a person", () => {
    const hits = scanDanger([edit(".mcp.json", '{"mcpServers":{}}\n', '{"mcpServers":{"x":{"url":"https://example.invalid/mcp"}}}\n')], intent("Edit"));
    const allowed = applyAllowances(hits, [
      { cls: "handoff", by: "policy" },
      { cls: "handoff", paths: [".mcp.json"], by: "antibody ab_y" },
    ]);
    expect(triageDanger(allowed).mustHuman.map((h) => h.cls)).toEqual(["handoff"]);
    expect(allowed.find((h) => h.cls === "handoff")?.allowedBy).toBeUndefined();
  });

  it("neither a colony policy nor an antibody file can even name it", () => {
    expect(antibodyAllows({ allows: ["handoff", "capability"] })).toEqual(["capability"]);
    expect(mergePolicy(DEFAULT_POLICY, { dangerAllow: [{ cls: "handoff" }, { cls: "capability" }] }).dangerAllow).toEqual([{ cls: "capability" }]);
  });

  it("an intent that asks for the change in so many words, from a person, a rule or an agent, still sends it to a person", () => {
    for (const source of ["human", "rule", "agent", "certify"] as IntentSource[]) {
      const hits = handoff(edit(".vscode/settings.json"), "Update .vscode/settings.json and point .mcp.json at the new MCP server", source);
      expect(hits.length, source).toBe(1);
      expect(hits[0]!.requested).toBeUndefined();
    }
  });
});

describe("the gate: no proof, autonomy, model approval or spent alert budget lands it", () => {
  const labels = dangerLabels(handoff(edit(".devcontainer/devcontainer.json")));
  const base: GateInput = {
    innate: { ok: true, failures: [] },
    damage: { sensitivePaths: [], residual: [], capabilities: [] },
    danger: { mustHuman: labels, signals: [] },
    mechanical: { verdict: "pass", reasons: ["1 file proven comment-only (.devcontainer/devcontainer.json)"] },
    autonomy: true,
    whyBy: "person",
    alerts: { used: 30, max: 30 },
    detectors: {},
    policy: DEFAULT_POLICY,
  };
  const clean = { needsHuman: 0.02, sensitive: 0.02, offIntent: 0.02, risk: 0.2, antibodies: [] };
  const approve = { verdict: "approve" as const, needsHuman: 0.02, offIntent: false, sensitive: false, confidence: 0.98, reason: "fine", model: "m" };

  it("escalates in every phase: before any model, after a quiet reflex, after a second opinion's approval", () => {
    for (const v of [gate(base), gate({ ...base, reflex: clean }), gate({ ...base, reflex: clean, llm: approve })]) {
      expect(v).toMatchObject({ action: "escalate", rule: "P1 danger pattern", detectors: ["danger:handoff"] });
      expect(v.reasons[0]).toBe(`danger patterns need a human: ${labels[0]}`);
    }
  });

  it("a change failing its checks goes back first, and its agent learns only the class", () => {
    const v = gate({ ...base, innate: { ok: false, failures: ["1 violation"] } });
    expect(v).toMatchObject({ action: "return", rule: "P0 danger+innate", security: ["handoff"] });
  });
});

describe(".gitattributes: the lines that select a driver", () => {
  const scan = (before: string | null, after: string) => handoff({ path: ".gitattributes", before, after });

  it("a new or altered filter, diff or merge driver line is a hit at that line", () => {
    const hits = scan("*.png binary\n", "*.png binary\n*.dat filter=crypt diff=crypt\n");
    expect(hits.map((h) => [h.pattern, h.line])).toEqual([["handoff:git-drivers", 2]]);
    expect(dangerLabels(hits)[0]).toBe("handoff (git-drivers) at .gitattributes:2: *.dat filter=crypt diff=crypt (git runs the filter, diff or merge driver it selects on checkout, diff or merge)");
    expect(scan("*.lock merge=ours\n", "*.lock merge=theirs\n").map((h) => h.line)).toEqual([1]);
    expect(scan(null, "[attr]secret filter=crypt\n*.key secret\n").map((h) => h.line)).toEqual([1]);
    expect(handoff({ path: "assets/.GitAttributes", before: null, after: "* filter=x\n" }).length).toBe(1);
  });

  it("other attribute lines, comments, moved and removed driver lines are not", () => {
    expect(scan(null, "* text=auto eol=lf\n*.png binary -diff\n*.md diff\n# *.x filter=y\n")).toEqual([]);
    expect(scan("*.dat filter=lfs diff=lfs merge=lfs -text\n*.png binary\n", "*.png binary\n*.dat   filter=lfs diff=lfs merge=lfs -text\n")).toEqual([]);
    expect(scan("*.dat filter=lfs\n", "")).toEqual([]);
    expect(handoff({ path: ".gitattributes", before: "* filter=x\n", after: null, deleted: true })).toEqual([]);
    // Still a build configuration file: a damage signal, as before.
    expect(sensitiveReason(".gitattributes")).toBe("build or platform configuration");
  });

  it("a .gitattributes whose new text could not be read is a hit as a whole: the check fails closed", () => {
    expect(handoffMatches({ path: ".gitattributes", before: "*.png binary\n", after: "", opaque: true }).map((m) => [m.id, m.line])).toEqual([["git-drivers", 0]]);
    expect(handoffMatches({ path: ".gitattributes", before: null, after: null }).map((m) => m.line)).toEqual([0]);
  });
});

describe("the shared normalizer", () => {
  it("folds case, Unicode form and characters file systems ignore", () => {
    expect(foldPath(".MCP.json")).toBe(".mcp.json");
    expect(foldPath("Cafe\u0301/R\u00C9SUM\u00C9.md")).toBe(foldPath("caf\u00E9/r\u00E9sum\u00E9.md"));
    expect(foldPath("\u212Aey.ts")).toBe("key.ts");
    expect(foldPath(".cur\u017Forrules")).toBe(".cursorrules");
    expect(foldPath("CLAUDE\u200B.md")).toBe("claude.md");
  });

  it("sensitive paths match folded: Package.JSON, .GitHub/workflows, JENKINSFILE", () => {
    expect(sensitiveReason("Package.JSON")).toBe("dependency manifest");
    expect(sensitiveReason(".GitHub/workflows/ci.yml")).toBe("CI configuration");
    expect(sensitiveReason("JENKINSFILE")).toBe("CI configuration");
    expect(sensitiveReason(".Firetrident/antibodies/a.json")).toBe("FireTrident colony memory (antibodies)");
    expect(sensitiveReason("src/add.ts")).toBeNull();
  });

  it("protected paths match folded, and the hit keeps the path and glob as written", () => {
    expect(protectedHits(["SRC/Auth/Login.ts", "src/add.ts"], ["src/auth"])).toEqual([{ path: "SRC/Auth/Login.ts", glob: "src/auth" }]);
    expect(protectedHits(["db/migrations/001.sql"], ["DB/Migrations/**"])).toEqual([{ path: "db/migrations/001.sql", glob: "DB/Migrations/**" }]);
  });
});
