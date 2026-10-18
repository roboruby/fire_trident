import { describe, expect, it } from "vitest";
import { helpText, parseCommand } from "../src/args.ts";
import { formatIssues, repoArg } from "../src/issues.ts";
import { colors } from "../src/format.ts";
import { main, type Io } from "../src/run.ts";

/** `ft issues import <colony> <owner/repo>`: the CLI asks the colony to import a repository's open issues; the server reads GitHub. */

interface Call {
  method: string;
  path: string;
  auth: string | null;
  body?: unknown;
}

/** An Io whose fetch answers `answer` for the import route and records every call (no network, no GitHub). */
function io(answer: unknown, status = 201): Io & { out: string[]; err: string[]; calls: Call[] } {
  const out: string[] = [];
  const err: string[] = [];
  const calls: Call[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = { method: init?.method ?? "GET", path: new URL(String(input)).pathname, auth: new Headers(init?.headers).get("authorization") };
    if (typeof init?.body === "string") call.body = JSON.parse(init.body);
    calls.push(call);
    return new Response(JSON.stringify(answer), { status, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  return {
    env: { FT_URL: "https://ft.test", FT_TOKEN: "tok", FT_USER: "tester", NO_COLOR: "1" },
    stdout: (l) => void out.push(l),
    stderr: (l) => void err.push(l),
    isTTY: false,
    fetch,
    readFile: async () => "",
    sleep: async () => {},
    now: () => 0,
    WebSocket: globalThis.WebSocket,
    onInterrupt: () => {},
    out,
    err,
    calls,
  };
}

const ANSWER = {
  colonyId: "web",
  repo: "octo-org/site",
  imported: [{ number: 12, intentId: "int_a", title: "Fix the footer link (octo-org/site#12)", url: "https://github.com/octo-org/site/issues/12", footprint: ["src/footer.ts"] }],
  skipped: [
    { number: 9, url: "https://github.com/octo-org/site/issues/9", reason: "already imported as int_old", intentId: "int_old" },
    { number: 7, url: "https://github.com/octo-org/site/issues/7", reason: "its text names no file, so it has no footprint: import it again with a footprint (paths, directories ending in /, or globs)" },
  ],
  writeBack: "off",
  note: "Review reads these intents as it reads an agent's request.",
  read: { issues: 3, pullRequests: 2, unreadable: 0 },
};

describe("ft issues import: parsing", () => {
  it("takes the colony, the repository and the options", () => {
    expect(parseCommand(["issues", "import", "web", "octo-org/site", "--label", "bug", "--label", "good first issue", "--limit", "5", "--footprint", "src/**", "--close-on-land", "--close", "--by", "lee"])).toMatchObject({
      ok: true,
      command: { name: "issues", colony: "web", repo: "octo-org/site", labels: ["bug", "good first issue"], limit: 5, footprint: ["src/**"], closeOnLand: true, close: true, by: "lee" },
    });
    expect(parseCommand(["issues", "import", "web", "https://github.com/octo-org/site.git"])).toMatchObject({ ok: true, command: { repo: "octo-org/site", labels: [], footprint: [], closeOnLand: false, close: false } });
    expect(repoArg("octo-org/site/issues")).toBeNull();
    expect(repoArg("../etc")).toBeNull();
    const errors = [
      [["issues"], "missing issues action"],
      [["issues", "list", "web"], 'unknown issues action "list"'],
      [["issues", "import", "web"], "missing <owner/repo>"],
      [["issues", "import", "web", "not a repo"], "is not a GitHub repository"],
      [["issues", "import", "web", "octo-org/site", "--limit", "0"], "--limit must be a whole number from 1 to 100"],
      [["issues", "import", "web", "octo-org/site", "--close"], "--close goes with --close-on-land"],
    ] as const;
    for (const [argv, message] of errors) {
      const parsed = parseCommand(argv);
      expect(parsed.ok, argv.join(" ")).toBe(false);
      if (!parsed.ok) expect(parsed.error).toContain(message);
    }
    expect(helpText("issues")).toMatch(/^ft issues import <colony> <owner\/repo>/);
    expect(helpText()).toContain("issues import <colony> <o/repo>");
  });
});

describe("ft issues import: the request and the answer", () => {
  it("posts the import with the admin token and prints what it imported and skipped", async () => {
    const t = io(ANSWER);
    expect(await main(["issues", "import", "web", "octo-org/site", "--label", "bug", "--limit", "5"], t)).toBe(0);
    expect(t.calls).toEqual([{ method: "POST", path: "/api/colonies/web/issues/import", auth: "Bearer tok", body: { repo: "octo-org/site", labels: ["bug"], limit: 5, by: "tester" } }]);
    expect(t.out.join("\n")).toBe(
      [
        "✓ 1 issue of octo-org/site imported into web (read 3 open issues, skipped 2 pull requests)",
        "  #12 int_a Fix the footer link (octo-org/site#12)",
        "  #9 skipped: already imported as int_old",
        "  #7 skipped: its text names no file, so it has no footprint: import it again with a footprint (paths, directories ending in /, or globs)",
        "  Review reads these intents as it reads an agent's request.",
        "  To import those too: ft issues import web octo-org/site --footprint '<glob>'",
        "  Next: ft swarm web --agents <n>   or connect your own agent: ft connect web",
      ].join("\n"),
    );
  });

  it("--dry-run prints the request and sends nothing; --json prints the answer", async () => {
    const dry = io(ANSWER);
    expect(await main(["issues", "import", "web", "octo-org/site", "--footprint", "src/**", "--close-on-land", "--dry-run"], dry)).toBe(0);
    expect(dry.calls).toEqual([]);
    expect(JSON.parse(dry.out.join("\n"))).toEqual({ method: "POST", url: "https://ft.test/api/colonies/web/issues/import", authorization: "Bearer ***", body: { repo: "octo-org/site", footprint: ["src/**"], closeOnLand: true, by: "tester" } });
    const json = io(ANSWER);
    expect(await main(["issues", "import", "web", "octo-org/site", "--json"], json)).toBe(0);
    expect(JSON.parse(json.out.join("\n"))).toEqual(ANSWER);
  });

  it("an answer that imported nothing says so without a next step, and an odd answer does not crash", () => {
    const c = colors(false);
    const cmd = { name: "issues" as const, colony: "web", repo: "octo-org/site", labels: [], footprint: [], closeOnLand: false, close: false };
    expect(formatIssues(cmd, { imported: [], skipped: [], note: "n" }, c)).toBe("· 0 issues of octo-org/site imported into web\n  n");
    expect(formatIssues(cmd, null, c)).toBe("· 0 issues of octo-org/site imported into web");
  });
});
