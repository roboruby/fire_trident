import { describe, expect, it } from "vitest";
import { helpText, nameFromUrl, normalizeGitUrl, parseCommand, parseLocation } from "../src/args.ts";
import type { Command, Parsed } from "../src/args.ts";

function ok(argv: string[]): { command: Command; flags: Extract<Parsed, { ok: true }>["flags"] } {
  const r = parseCommand(argv);
  if (!r.ok) throw new Error(`expected success, got: ${r.error}`);
  return r;
}

function err(argv: string[]): string {
  const r = parseCommand(argv);
  if (r.ok) throw new Error(`expected a usage error for ${argv.join(" ")}`);
  return r.error;
}

describe("help and version", () => {
  it("prints help with no arguments, --help, or help <topic>", () => {
    expect(ok([]).command).toEqual({ name: "help" });
    expect(ok(["--help"]).command).toEqual({ name: "help" });
    expect(ok(["-h"]).command).toEqual({ name: "help" });
    expect(ok(["help", "rule"]).command).toEqual({ name: "help", topic: "rule" });
    expect(ok(["rule", "add", "--help"]).command).toEqual({ name: "help", topic: "rule" });
    expect(ok(["swarm", "-h"]).command).toEqual({ name: "help", topic: "swarm" });
  });

  it("prints the version", () => {
    expect(ok(["--version"]).command).toEqual({ name: "version" });
  });

  it("has help for every command and falls back to the main help", () => {
    for (const t of ["import", "new", "status", "rule", "swarm", "why", "review", "watch"]) expect(helpText(t)).toContain(`ft ${t}`);
    expect(helpText("nope")).toBe(helpText());
    expect(helpText("constructor")).toBe(helpText());
  });

  it("rejects unknown commands, including inherited object keys", () => {
    expect(err(["frobnicate"])).toMatch(/unknown command "frobnicate"/);
    expect(err(["constructor"])).toMatch(/unknown command/);
  });
});

describe("global flags", () => {
  it("accepts --json, --dry-run, and --url before or after the command", () => {
    const a = ok(["--json", "--url", "http://localhost:8787", "status", "web"]);
    expect(a.command).toEqual({ name: "status", colony: "web" });
    expect(a.flags).toEqual({ json: true, dryRun: false, url: "http://localhost:8787" });
    const b = ok(["status", "web", "--dry-run", "--url=https://x.example"]);
    expect(b.flags).toEqual({ json: false, dryRun: true, url: "https://x.example" });
  });

  it("does not mistake the --url value for the command", () => {
    expect(ok(["--url", "status", "why", "web", "a.ts"]).command).toEqual({ name: "why", colony: "web", path: "a.ts" });
  });
});

describe("import", () => {
  it("parses a URL with name, branch, and pool", () => {
    expect(ok(["import", "https://github.com/org/repo.git", "--name", "demo", "--branch", "main", "--pool", "200"]).command).toEqual({
      name: "import",
      url: "https://github.com/org/repo.git",
      colonyName: "demo",
      branch: "main",
      pool: 200,
      wait: true,
      timeoutSec: 600,
    });
  });

  it("defaults the name to the repository and supports --no-wait and --timeout", () => {
    expect(ok(["import", "https://github.com/org/my-repo", "--no-wait", "--timeout", "30"]).command).toEqual({
      name: "import",
      url: "https://github.com/org/my-repo",
      colonyName: "my-repo",
      wait: false,
      timeoutSec: 30,
    });
  });

  it("expands GitHub shorthand and host-relative URLs", () => {
    expect(ok(["import", "org/repo"]).command).toMatchObject({ url: "https://github.com/org/repo", colonyName: "repo" });
    expect(ok(["import", "gitlab.com/group/sub/proj"]).command).toMatchObject({ url: "https://gitlab.com/group/sub/proj", colonyName: "proj" });
  });

  it("rejects SSH remotes, bad pools, and missing URLs", () => {
    expect(err(["import", "git@github.com:org/repo.git"])).toMatch(/HTTPS/);
    expect(err(["import", "https://github.com/org/repo", "--pool", "0"])).toMatch(/--pool/);
    expect(err(["import", "https://github.com/org/repo", "--pool", "ten"])).toMatch(/positive integer/);
    expect(err(["import"])).toMatch(/missing <git-url>/);
    expect(err(["import", "a", "b"])).toMatch(/unexpected argument "b"/);
    expect(err(["import", "https://github.com/org/repo", "--pool"])).toMatch(/argument missing/);
  });
});

describe("status", () => {
  it("needs exactly one colony", () => {
    expect(ok(["status", "web"]).command).toEqual({ name: "status", colony: "web" });
    expect(err(["status"])).toMatch(/missing <colony>/);
    expect(err(["status", "web", "extra"])).toMatch(/unexpected argument/);
  });
});

describe("rule add", () => {
  it("collects repeated include and exclude globs", () => {
    const { command } = ok([
      "rule", "add", "web",
      "--pattern", "console\\.(log|warn)\\(",
      "--flags", "g",
      "--include", "src/**",
      "--include", "lib/**",
      "--exclude", "**/*.test.ts",
      "--hint", "Use the logger",
      "--description", "No console calls",
      "--by", "matt",
    ]);
    expect(command).toEqual({
      name: "rule-add",
      colony: "web",
      pattern: "console\\.(log|warn)\\(",
      flags: "g",
      include: ["src/**", "lib/**"],
      exclude: ["**/*.test.ts"],
      hint: "Use the logger",
      description: "No console calls",
      by: "matt",
    });
  });

  it("defaults globs to empty lists", () => {
    expect(ok(["rule", "add", "web", "--pattern", "x", "--hint", "h", "--description", "d"]).command).toMatchObject({ include: [], exclude: [] });
  });

  it("keeps a replacement verbatim, even an empty one", () => {
    expect(ok(["rule", "add", "web", "--pattern", "\\bfoo\\(", "--replacement", "bar($1", "--hint", "h", "--description", "d"]).command).toMatchObject({ replacement: "bar($1" });
    expect(ok(["rule", "add", "web", "--pattern", "x", "--replacement=", "--hint", "h", "--description", "d"]).command).toMatchObject({ replacement: "" });
    expect(ok(["rule", "add", "web", "--pattern", "x", "--hint", "h", "--description", "d"]).command).not.toHaveProperty("replacement");
    expect(err(["rule", "import-boundary", "web", "--from", "a/**", "--module", "x", "--replacement", "y", "--hint", "h", "--description", "d"])).toMatch(/--replacement does not apply/);
  });

  it("validates the pattern, flags, and required text", () => {
    expect(err(["rule", "add", "web", "--pattern", "(", "--hint", "h", "--description", "d"])).toMatch(/not a valid regular expression/);
    expect(err(["rule", "add", "web", "--pattern", "x", "--flags", "q", "--hint", "h", "--description", "d"])).toMatch(/--flags/);
    expect(err(["rule", "add", "web", "--hint", "h", "--description", "d"])).toMatch(/missing --pattern/);
    expect(err(["rule", "add", "web", "--pattern", "x", "--description", "d"])).toMatch(/missing --hint/);
    expect(err(["rule", "add", "web", "--pattern", "x", "--hint", "h"])).toMatch(/missing --description/);
    expect(err(["rule", "add", "--pattern", "x", "--hint", "h", "--description", "d"])).toMatch(/missing <colony>/);
  });

  it("rejects flags that belong to the other rule kind", () => {
    expect(err(["rule", "add", "web", "--pattern", "x", "--module", "y", "--hint", "h", "--description", "d"])).toMatch(/--module does not apply/);
  });
});

describe("rule import-boundary", () => {
  it("parses repeated --from globs and a module pattern", () => {
    expect(ok(["rule", "import-boundary", "web", "--from", "src/ui/**", "--from", "src/pages/**", "--module", "^\\.\\./db/", "--hint", "Use src/api", "--description", "UI never imports db"]).command).toEqual({
      name: "rule-import-boundary",
      colony: "web",
      from: ["src/ui/**", "src/pages/**"],
      module: "^\\.\\./db/",
      hint: "Use src/api",
      description: "UI never imports db",
    });
  });

  it("requires --from and a valid --module", () => {
    expect(err(["rule", "import-boundary", "web", "--module", "x", "--hint", "h", "--description", "d"])).toMatch(/missing --from/);
    expect(err(["rule", "import-boundary", "web", "--from", "a/**", "--module", "[", "--hint", "h", "--description", "d"])).toMatch(/--module is not a valid/);
    expect(err(["rule", "import-boundary", "web", "--from", "a/**", "--module", "x", "--pattern", "p", "--hint", "h", "--description", "d"])).toMatch(/--pattern does not apply/);
  });

  it("rejects unknown or missing rule subcommands", () => {
    expect(err(["rule", "remove", "web"])).toMatch(/unknown rule subcommand "remove"/);
    expect(err(["rule"])).toMatch(/missing rule subcommand/);
  });
});

describe("swarm", () => {
  it("parses agents, model, and kind", () => {
    expect(ok(["swarm", "web", "--agents", "200", "--model", "@cf/x/y", "--kind", "synthetic"]).command).toEqual({
      name: "swarm",
      colony: "web",
      agents: 200,
      model: "@cf/x/y",
      kind: "synthetic",
    });
    expect(ok(["swarm", "web", "--agents", "5"]).command).toEqual({ name: "swarm", colony: "web", agents: 5 });
  });

  it("validates agents and kind", () => {
    expect(err(["swarm", "web"])).toMatch(/missing --agents/);
    expect(err(["swarm", "web", "--agents", "-3"])).toMatch(/ambiguous|positive integer/);
    expect(err(["swarm", "web", "--agents", "2.5"])).toMatch(/positive integer/);
    expect(err(["swarm", "web", "--agents", "3", "--kind", "external"])).toMatch(/internal or synthetic/);
    expect(err(["swarm", "web", "--agents", "3", "--unknown"])).toMatch(/Unknown option/);
  });
});

describe("why", () => {
  it("splits path and line", () => {
    expect(ok(["why", "web", "src/a.ts:42"]).command).toEqual({ name: "why", colony: "web", path: "src/a.ts", line: 42 });
    expect(ok(["why", "web", "./src/a.ts"]).command).toEqual({ name: "why", colony: "web", path: "src/a.ts" });
  });

  it("needs a colony and a path", () => {
    expect(err(["why", "web"])).toMatch(/missing <path/);
    expect(err(["why"])).toMatch(/missing <colony>/);
  });
});

describe("review", () => {
  it("lists the queue with only a colony, with full diffs on --diff", () => {
    expect(ok(["review", "web"]).command).toEqual({ name: "review-list", colony: "web", diff: false });
    expect(ok(["review", "web", "--diff"]).command).toEqual({ name: "review-list", colony: "web", diff: true });
    expect(err(["review", "web", "prp_1", "approve", "--diff"])).toMatch(/--diff applies to listing the queue: ft review web --diff/);
  });

  it("decides a proposal", () => {
    expect(ok(["review", "web", "prp_1", "reject", "--reason", "touches auth", "--by", "matt"]).command).toEqual({
      name: "review-decide",
      colony: "web",
      proposalId: "prp_1",
      decision: "reject",
      reason: "touches auth",
      by: "matt",
    });
    expect(ok(["review", "web", "prp_1", "approve"]).command).toMatchObject({ decision: "approve", reason: "approved" });
  });

  it("requires a reason to reject or return, and a known decision", () => {
    expect(err(["review", "web", "prp_1", "reject"])).toMatch(/--reason is required/);
    expect(err(["review", "web", "prp_1", "return"])).toMatch(/--reason is required/);
    expect(err(["review", "web", "prp_1", "merge"])).toMatch(/approve, reject, or return/);
    expect(err(["review", "web", "prp_1"])).toMatch(/missing decision/);
    expect(err(["review", "web", "--reason", "x"])).toMatch(/--reason does not apply/);
  });
});

describe("watch", () => {
  it("accepts comma-separated and repeated --only types", () => {
    expect(ok(["watch", "web"]).command).toEqual({ name: "watch", colony: "web", only: [] });
    expect(ok(["watch", "web", "--only", "landing,proposal", "--only", "landing"]).command).toEqual({ name: "watch", colony: "web", only: ["landing", "proposal"] });
  });

  it("rejects unknown event types", () => {
    expect(err(["watch", "web", "--only", "landing,bogus"])).toMatch(/unknown event type "bogus"/);
  });
});

describe("new", () => {
  it("needs a spec file", () => {
    expect(ok(["new", "--spec", "demo/new-project-spec.md", "--name", "links"]).command).toEqual({ name: "new", specPath: "demo/new-project-spec.md", colonyName: "links" });
    expect(err(["new"])).toMatch(/missing --spec/);
  });
});

describe("helpers", () => {
  it("normalizes git URLs", () => {
    expect(normalizeGitUrl("https://github.com/org/repo/")).toBe("https://github.com/org/repo");
    expect(() => normalizeGitUrl("ssh://git@host/org/repo")).toThrow(/HTTPS/);
    expect(() => normalizeGitUrl("https://github.com")).toThrow(/no repository path/);
    expect(() => normalizeGitUrl("not a url")).toThrow(/not a git URL/);
  });

  it("names colonies after the repository", () => {
    expect(nameFromUrl("https://github.com/org/repo.git")).toBe("repo");
    expect(nameFromUrl("https://github.com/org/repo/")).toBe("repo");
  });

  it("parses locations", () => {
    expect(parseLocation("a/b.ts:7")).toEqual({ path: "a/b.ts", line: 7 });
    expect(parseLocation("/a/b.ts")).toEqual({ path: "a/b.ts" });
    expect(parseLocation("a:b.ts")).toEqual({ path: "a:b.ts" });
    expect(() => parseLocation("a.ts:0")).toThrow(/line must be 1 or more/);
    expect(() => parseLocation(":12")).toThrow(/missing path/);
  });
});
