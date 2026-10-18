import { ftError } from "./errors.ts";

/**
 * GitHub's REST API (api.github.com): the few calls issue import makes (colony/issues.ts, api/issues.ts). Reads go
 * unauthenticated for public repositories, or with FT_GITHUB_TOKEN when the deployment sets it (a higher rate limit);
 * the write-back (one comment, and a close when asked) needs the token. Every call names FireTrident as its user agent,
 * asks for JSON of API version 2022-11-28 and gives up after 10 seconds. Issue text is untrusted: it comes back as
 * plain strings, and nothing here acts on it. The token is sent only to api.github.com and never written anywhere.
 */

/** Where every call goes. */
export const GITHUB_API = "https://api.github.com";
/** How long one call may take. */
const TIMEOUT_MS = 10_000;
/** Issues per page read, and pages read at most (pull requests share the list, so a page can hold fewer issues). */
const PER_PAGE = 100;
const MAX_PAGES = 3;
/** Largest page body read (100 issues of long text). */
const PAGE_BYTES = 8_000_000;

/** A fetch: the global one in the Worker, a fake in tests. */
export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

/** One open issue as the import reads it: its number, title, text, the login that opened it and its labels. */
export interface GithubIssue {
  number: number;
  title: string;
  body: string;
  author: string;
  labels: string[];
}

/** What a list read found: the issues, how many pull requests it skipped and how many items it could not read. */
export interface IssueList {
  issues: GithubIssue[];
  pulls: number;
  malformed: number;
}

/** A GitHub login as it appears on an issue (bots end in [bot]); anything else reads as unknown. */
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/;

/** The request headers of every call: JSON, the API version, FireTrident's user agent, and the token when there is one. */
function headers(token: string | undefined, json = false): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "FireTrident",
    ...(json ? { "content-type": "application/json" } : {}),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

/** One call, with its timeout; a network failure or a timeout is a 502 that says GitHub did not answer. */
async function call(fetcher: Fetcher, path: string, init: RequestInit): Promise<Response> {
  try {
    return await fetcher(`${GITHUB_API}${path}`, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    const timeout = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    throw ftError(502, timeout ? `GitHub did not answer within ${TIMEOUT_MS / 1000} s: try again in a minute` : "GitHub could not be reached: try again in a minute");
  }
}

/** The plain sentence for a GitHub answer that is not a success, as an error with the status the API passes on. */
function refusal(res: Response, repo: string, authed: boolean): Error {
  const remaining = res.headers.get("x-ratelimit-remaining");
  if ((res.status === 403 || res.status === 429) && (remaining === "0" || res.status === 429)) {
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    const when = Number.isFinite(reset) && reset > 0 ? ` until ${new Date(reset * 1000).toISOString().slice(11, 16)} UTC` : "";
    const fix = authed ? "wait and import again" : "set the FT_GITHUB_TOKEN secret on the deployment to read with a token's limit, or wait and import again";
    return ftError(429, `GitHub's rate limit for ${authed ? "this token" : "reads without a token"} is used up${when}: ${fix}`);
  }
  if (res.status === 401) return ftError(502, "GitHub refused FT_GITHUB_TOKEN (401): replace the secret on the deployment with a working token, or remove it to read public repositories without one");
  if (res.status === 404) return ftError(404, `GitHub has no public repository ${repo}: check the owner and name (a private repository needs FT_GITHUB_TOKEN with access to it)`);
  if (res.status === 410) return ftError(404, `${repo} has issues turned off on GitHub, so there are none to import`);
  if (res.status === 403) return ftError(502, `GitHub refused to list the issues of ${repo} (403): check that FT_GITHUB_TOKEN, if set, may read it`);
  return ftError(502, `GitHub answered ${res.status} for the issues of ${repo}: try again in a minute`);
}

/** One list item as an issue, or "pull" for a pull request, or null when it is not an issue this code can read. */
export function readIssue(x: unknown): GithubIssue | "pull" | null {
  if (!x || typeof x !== "object") return null;
  const o = x as Record<string, unknown>;
  if (o.pull_request !== undefined && o.pull_request !== null) return "pull";
  if (typeof o.number !== "number" || !Number.isInteger(o.number) || o.number < 1 || typeof o.title !== "string") return null;
  const login = o.user && typeof o.user === "object" ? (o.user as { login?: unknown }).login : undefined;
  const labels = Array.isArray(o.labels)
    ? o.labels.flatMap((l) => (typeof l === "string" ? [l] : l && typeof l === "object" && typeof (l as { name?: unknown }).name === "string" ? [(l as { name: string }).name] : [])).slice(0, 50)
    : [];
  return { number: o.number, title: o.title, body: typeof o.body === "string" ? o.body : "", author: typeof login === "string" && LOGIN.test(login) ? login : "", labels };
}

/**
 * The open issues of `repo` (owner/name), newest first as GitHub lists them, pull requests skipped, at most `limit`:
 * GET /repos/{owner}/{repo}/issues?state=open, with `labels` (issues that carry all of them), reading at most three
 * pages of 100. A refusal throws a plain sentence: no such public repository, issues off, the rate limit used up (with
 * when it resets and that FT_GITHUB_TOKEN lifts it), or a token GitHub refused.
 */
export async function listOpenIssues(fetcher: Fetcher, repo: string, opts: { limit: number; labels?: string[]; token?: string }): Promise<IssueList> {
  const out: IssueList = { issues: [], pulls: 0, malformed: 0 };
  for (let page = 1; page <= MAX_PAGES && out.issues.length < opts.limit; page++) {
    const q = new URLSearchParams({ state: "open", per_page: String(PER_PAGE), page: String(page) });
    if (opts.labels && opts.labels.length > 0) q.set("labels", opts.labels.join(","));
    const res = await call(fetcher, `/repos/${repo}/issues?${q.toString()}`, { headers: headers(opts.token) });
    if (!res.ok) throw refusal(res, repo, !!opts.token);
    const text = await res.text();
    if (text.length > PAGE_BYTES) throw ftError(502, `GitHub sent more than ${PAGE_BYTES / 1_000_000} MB for one page of ${repo}'s issues: import fewer with a lower limit or a label`);
    let items: unknown;
    try {
      items = JSON.parse(text);
    } catch {
      throw ftError(502, `GitHub's answer for the issues of ${repo} was not JSON: try again in a minute`);
    }
    if (!Array.isArray(items)) throw ftError(502, `GitHub's answer for the issues of ${repo} was not a list: try again in a minute`);
    for (const item of items) {
      const issue = readIssue(item);
      if (issue === "pull") out.pulls++;
      else if (issue === null) out.malformed++;
      else if (out.issues.length < opts.limit) out.issues.push(issue);
    }
    if (items.length < PER_PAGE) break;
  }
  return out;
}

/**
 * Whether the token may change issues of `repo` (triage, write, maintain or admin, as GET /repos/{owner}/{repo} reports
 * its permissions), or a sentence saying why it may not or could not be told. The write-back runs only on true, so
 * FireTrident never comments on a repository its token's owner cannot change.
 */
export async function tokenCanWrite(fetcher: Fetcher, repo: string, token: string): Promise<true | string> {
  let res: Response;
  try {
    res = await call(fetcher, `/repos/${repo}`, { headers: headers(token) });
  } catch {
    return `GitHub did not answer whether FT_GITHUB_TOKEN may write to ${repo}`;
  }
  if (!res.ok) return `GitHub answered ${res.status} when asked whether FT_GITHUB_TOKEN may write to ${repo}`;
  let p: Record<string, unknown> = {};
  try {
    const body = (await res.json()) as { permissions?: unknown };
    if (body.permissions && typeof body.permissions === "object") p = body.permissions as Record<string, unknown>;
  } catch {
    return `GitHub's answer about ${repo} was not JSON`;
  }
  return p.admin === true || p.maintain === true || p.push === true || p.triage === true ? true : `FT_GITHUB_TOKEN may not change issues of ${repo}`;
}

/** POST /repos/{owner}/{repo}/issues/{number}/comments with `body`; a sentence on failure, null on success. */
export async function commentOnIssue(fetcher: Fetcher, repo: string, number: number, body: string, token: string): Promise<string | null> {
  try {
    const res = await call(fetcher, `/repos/${repo}/issues/${number}/comments`, { method: "POST", headers: headers(token, true), body: JSON.stringify({ body }) });
    return res.ok ? null : `GitHub answered ${res.status} to the comment on ${repo}#${number}`;
  } catch {
    return `GitHub did not answer the comment on ${repo}#${number}`;
  }
}

/** PATCH /repos/{owner}/{repo}/issues/{number} to closed, as completed; a sentence on failure, null on success. */
export async function closeIssue(fetcher: Fetcher, repo: string, number: number, token: string): Promise<string | null> {
  try {
    const res = await call(fetcher, `/repos/${repo}/issues/${number}`, { method: "PATCH", headers: headers(token, true), body: JSON.stringify({ state: "closed", state_reason: "completed" }) });
    return res.ok ? null : `GitHub answered ${res.status} when FireTrident closed ${repo}#${number}`;
  } catch {
    return `GitHub did not answer when FireTrident closed ${repo}#${number}`;
  }
}
