import { describe, expect, it } from "vitest";
import { helpText, parseCommand } from "../src/args.ts";
import { planRequest } from "../src/api.ts";
import { formatCommitAuthor } from "../src/commitauthor.ts";
import { colors } from "../src/format.ts";

/** `ft commit-author` (people as commit authors, packages/worker/src/colony/commitauthor.ts). */

const c = colors(false);

function parsed(argv: string[]) {
  const r = parseCommand(argv);
  if (!r.ok) throw new Error(r.error);
  return r.command;
}

function refused(argv: string[]): string {
  const r = parseCommand(argv);
  if (r.ok) throw new Error("expected a usage error");
  return r.error;
}

describe("ft commit-author", () => {
  it("names a person, goes back to FireTrident with off, and shows the setting with neither", () => {
    expect(parsed(["commit-author", "web", "--name", "Dana Reviewer", "--email", "dana@example.com"])).toEqual({ name: "commit-author", colony: "web", author: { name: "Dana Reviewer", email: "dana@example.com" } });
    expect(parsed(["commit-author", "web", "off", "--by", "lee"])).toEqual({ name: "commit-author", colony: "web", off: true, by: "lee" });
    expect(parsed(["commit-author", "web"])).toEqual({ name: "commit-author", colony: "web" });
    expect(planRequest(parsed(["commit-author", "web", "--name", "Dana Reviewer", "--email", "dana@example.com"]), "maya")).toEqual({
      method: "POST",
      path: "/api/colonies/web/commit-author",
      body: { name: "Dana Reviewer", email: "dana@example.com", by: "maya" },
    });
    expect(planRequest(parsed(["commit-author", "web", "off"]), "maya")).toEqual({ method: "POST", path: "/api/colonies/web/commit-author", body: { name: null, by: "maya" } });
    expect(planRequest(parsed(["commit-author", "web"]), "maya")).toEqual({ method: "GET", path: "/api/colonies/web/commit-author" });
  });

  it("refuses half an identity and stray words, saying how it is used", () => {
    expect(refused(["commit-author", "web", "--name", "Dana"])).toMatch(/give both --name and --email/);
    expect(refused(["commit-author", "web", "dana"])).toMatch(/unexpected argument "dana"/);
    expect(refused(["commit-author", "web", "off", "--name", "Dana"])).toMatch(/do not apply when going back to FireTrident/);
    expect(refused(["commit-author"])).toMatch(/missing <colony>/);
    expect(helpText("commit-author")).toContain("ft commit-author <colony> --name <name> --email <email>");
  });

  it("says what changed and how to check it on a clone", () => {
    const set = formatCommitAuthor({ name: "commit-author", colony: "web", author: { name: "Dana Reviewer", email: "dana@example.com" } }, { author: { name: "Dana Reviewer", email: "dana@example.com", by: "maya", at: 1 } }, c);
    expect(set).toContain("Named Dana Reviewer <dana@example.com> as the author of web's landing commits.");
    expect(set).toContain("git log --format='%an %cn'");
    expect(formatCommitAuthor({ name: "commit-author", colony: "web", off: true }, { author: null, cleared: true }, c)).toBe("FireTrident authors web's landing commits again; agents are credited as before.");
    expect(formatCommitAuthor({ name: "commit-author", colony: "web" }, { author: null }, c)).toContain("FireTrident authors web's landing commits.");
    expect(formatCommitAuthor({ name: "commit-author", colony: "web" }, { author: { name: "Dana Reviewer", by: "maya", at: 1 } }, c)).toContain("Commit author of web: Dana Reviewer (set by maya)");
  });
});
