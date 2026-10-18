import { describe, expect, it } from "vitest";
import { closeIssue, commentOnIssue, listOpenIssues, readIssue, tokenCanWrite } from "../../src/colony/github.ts";

/** GitHub's REST API as issue import calls it, against a fake: no test reaches GitHub. */

type Answer = { status?: number; body?: unknown; headers?: Record<string, string> };

/** A GitHub that answers each call from `route` and records it. */
function github(route: (url: URL, init: RequestInit) => Answer | Error) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
  const fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input);
    calls.push({ url: input, method: init.method ?? "GET", headers: Object.fromEntries(new Headers(init.headers).entries()) });
    const a = route(url, init);
    if (a instanceof Error) throw a;
    return new Response(JSON.stringify(a.body ?? []), { status: a.status ?? 200, headers: a.headers ?? {} });
  };
  return { calls, fetch };
}

const item = (n: number, extra: Record<string, unknown> = {}) => ({ number: n, title: `Issue ${n}`, body: `Text ${n}`, user: { login: "octocat" }, labels: [{ name: "bug" }, "help"], ...extra });

describe("reading open issues", () => {
  it("skips pull requests, reads the fields it needs, and sends the labels, the version and its user agent", async () => {
    const gh = github(() => ({ body: [item(3), item(2, { pull_request: { url: "x" } }), item(1, { body: null, user: { login: "bad login" } }), { number: "x" }] }));
    const res = await listOpenIssues(gh.fetch, "octo-org/site", { limit: 20, labels: ["bug", "good first issue"] });
    expect(res).toEqual({
      issues: [
        { number: 3, title: "Issue 3", body: "Text 3", author: "octocat", labels: ["bug", "help"] },
        { number: 1, title: "Issue 1", body: "", author: "", labels: ["bug", "help"] },
      ],
      pulls: 1,
      malformed: 1,
    });
    expect(gh.calls).toHaveLength(1);
    expect(gh.calls[0]!.url).toBe("https://api.github.com/repos/octo-org/site/issues?state=open&per_page=100&page=1&labels=bug%2Cgood+first+issue");
    expect(gh.calls[0]!.headers).toEqual({ accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "FireTrident" });
  });

  it("pages until it has enough issues or a short page, three pages at most, and sends the token when there is one", async () => {
    const page = (p: number) => Array.from({ length: 100 }, (_, i) => item(1000 - (p - 1) * 100 - i, i % 2 === 0 ? { pull_request: {} } : {}));
    const gh = github((url) => ({ body: page(Number(url.searchParams.get("page"))) }));
    const res = await listOpenIssues(gh.fetch, "o/r", { limit: 120, token: "ghp_test_not_a_real_token" });
    expect(res.issues).toHaveLength(120);
    expect(res.pulls).toBe(150);
    expect(gh.calls.map((c) => new URL(c.url).searchParams.get("page"))).toEqual(["1", "2", "3"]);
    expect(gh.calls[0]!.headers.authorization).toBe("Bearer ghp_test_not_a_real_token");
    const few = github(() => ({ body: [item(1)] }));
    expect((await listOpenIssues(few.fetch, "o/r", { limit: 50 })).issues).toHaveLength(1);
    expect(few.calls).toHaveLength(1);
  });

  it("says plainly why GitHub refused: no such repository, issues off, the rate limit, a bad token, no answer", async () => {
    const fail = async (a: Answer | Error, token?: string) => {
      try {
        await listOpenIssues(github(() => a).fetch, "o/r", { limit: 5, ...(token ? { token } : {}) });
      } catch (e) {
        return (e as Error).message;
      }
      return "no error";
    };
    expect(await fail({ status: 404 })).toBe("[ft:404] GitHub has no public repository o/r: check the owner and name (a private repository needs FT_GITHUB_TOKEN with access to it)");
    expect(await fail({ status: 410 })).toBe("[ft:404] o/r has issues turned off on GitHub, so there are none to import");
    expect(await fail({ status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1760000000" } })).toBe(
      "[ft:429] GitHub's rate limit for reads without a token is used up until 08:53 UTC: set the FT_GITHUB_TOKEN secret on the deployment to read with a token's limit, or wait and import again",
    );
    expect(await fail({ status: 429 }, "t0ken_t0ken")).toBe("[ft:429] GitHub's rate limit for this token is used up: wait and import again");
    expect(await fail({ status: 401 }, "t0ken_t0ken")).toContain("GitHub refused FT_GITHUB_TOKEN (401)");
    expect(await fail({ status: 500 })).toBe("[ft:502] GitHub answered 500 for the issues of o/r: try again in a minute");
    expect(await fail({ body: { message: "x" } })).toBe("[ft:502] GitHub's answer for the issues of o/r was not a list: try again in a minute");
    expect(await fail(Object.assign(new Error("timed out"), { name: "TimeoutError" }))).toBe("[ft:502] GitHub did not answer within 10 s: try again in a minute");
    expect(await fail(new Error("dns"))).toBe("[ft:502] GitHub could not be reached: try again in a minute");
  });

  it("reads a list item as an issue, a pull request, or nothing", () => {
    expect(readIssue(item(1, { user: { login: "renovate[bot]" } }))).toMatchObject({ author: "renovate[bot]" });
    expect(readIssue(item(1, { pull_request: {} }))).toBe("pull");
    expect(readIssue({ number: 0, title: "x" })).toBeNull();
    expect(readIssue(null)).toBeNull();
  });
});

describe("the write-back calls", () => {
  it("asks whether the token may change issues, then comments and closes", async () => {
    const gh = github((url, init) => (init.method === undefined || init.method === "GET" ? { body: { permissions: { triage: true } } } : { status: init.method === "POST" ? 201 : 200, body: {} }));
    expect(await tokenCanWrite(gh.fetch, "o/r", "t0ken_t0ken")).toBe(true);
    expect(await commentOnIssue(gh.fetch, "o/r", 4, "landed", "t0ken_t0ken")).toBeNull();
    expect(await closeIssue(gh.fetch, "o/r", 4, "t0ken_t0ken")).toBeNull();
    expect(gh.calls.map((c) => `${c.method} ${c.url}`)).toEqual(["GET https://api.github.com/repos/o/r", "POST https://api.github.com/repos/o/r/issues/4/comments", "PATCH https://api.github.com/repos/o/r/issues/4"]);
    expect(gh.calls.every((c) => c.headers.authorization === "Bearer t0ken_t0ken")).toBe(true);
    expect(await tokenCanWrite(github(() => ({ body: { permissions: { pull: true } } })).fetch, "o/r", "t")).toBe("FT_GITHUB_TOKEN may not change issues of o/r");
    expect(await tokenCanWrite(github(() => ({ status: 404 })).fetch, "o/r", "t")).toBe("GitHub answered 404 when asked whether FT_GITHUB_TOKEN may write to o/r");
    expect(await commentOnIssue(github(() => new Error("x")).fetch, "o/r", 4, "b", "t")).toBe("GitHub did not answer the comment on o/r#4");
    expect(await closeIssue(github(() => ({ status: 422 })).fetch, "o/r", 4, "t")).toBe("GitHub answered 422 when FireTrident closed o/r#4");
  });
});
