import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pushRefusal } from "@fire_trident/core";
import { handleGitRequest, type GitProxyDeps } from "../../src/api/git-proxy.ts";

/**
 * What a person sees when they `git push` to a colony's read-only git URL, read through stock git: a local HTTP server
 * answers with the proxy's own handler, and `git push` runs against it. Git prints each line of the 403's plain-text
 * body as "remote: <line>" (an ERR packet in the advertisement would print as one "fatal: remote error:" line instead),
 * so the colony's page, how a change reaches trunk and the MCP add command reach the terminal. Skipped where no git is
 * installed.
 */

/** The parts of Node these tests use (the worker compiles against workers types, not Node's). */
interface IncomingLike {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  on(event: "data", fn: (chunk: Uint8Array) => void): void;
  on(event: "end", fn: () => void): void;
}
interface ServerResponseLike {
  writeHead(status: number, headers: Record<string, string>): void;
  end(body?: Uint8Array): void;
}
interface ServerLike {
  listen(port: number, host: string, fn: () => void): void;
  address(): { port: number };
  close(fn: () => void): void;
}
interface ChildLike {
  stderr: { on(event: "data", fn: (chunk: Uint8Array) => void): void };
  on(event: "close", fn: (code: number | null) => void): void;
  on(event: "error", fn: (e: Error) => void): void;
}
interface Node {
  http: { createServer(fn: (req: IncomingLike, res: ServerResponseLike) => void): ServerLike };
  cp: { spawn(cmd: string, args: string[], opts: { cwd?: string; env: Record<string, string | undefined>; timeout: number }): ChildLike };
  fs: { mkdtempSync(prefix: string): string; rmSync(path: string, opts: { recursive: boolean; force: boolean }): void };
  os: { tmpdir(): string };
  path: { join(...parts: string[]): string };
  env: Record<string, string | undefined>;
}

const load = (name: string): Promise<unknown> => import(name);
const node: Node = {
  http: (await load("node:http")) as Node["http"],
  cp: (await load("node:child_process")) as Node["cp"],
  fs: (await load("node:fs")) as Node["fs"],
  os: (await load("node:os")) as Node["os"],
  path: (await load("node:path")) as Node["path"],
  env: (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env,
};

/**
 * Git with no user or system configuration, no credential helper and no prompt, so the answer is the server's alone.
 * Asynchronous, because the server that answers it runs in this process.
 */
function git(args: string[], cwd?: string): Promise<{ status: number | null; stderr: string; missing: boolean }> {
  const env = { PATH: node.env.PATH, HOME: node.env.HOME, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" };
  const child = node.cp.spawn("git", ["-c", "credential.helper=", "-c", "user.name=ft-test", "-c", "user.email=ft-test@example.invalid", ...args], { ...(cwd ? { cwd } : {}), env, timeout: 20_000 });
  const err: string[] = [];
  const dec = new TextDecoder();
  child.stderr.on("data", (c) => err.push(dec.decode(c, { stream: true })));
  return new Promise((resolve) => {
    child.on("error", () => resolve({ status: null, stderr: err.join(""), missing: true }));
    child.on("close", (code) => resolve({ status: code, stderr: err.join(""), missing: false }));
  });
}

const HAS_GIT = !(await git(["--version"])).missing;

/** Trunk access that must never be used: a push is answered before any token or remote is looked up. */
const deps: GitProxyDeps = {
  trunk: {
    remote: async () => {
      throw new Error("a push looked up the trunk");
    },
    token: async () => {
      throw new Error("a push minted a token");
    },
    invalidate: () => undefined,
  },
  fetch: async () => {
    throw new Error("a push reached upstream");
  },
};

let server: ServerLike | null = null;
let origin = "";
let dir = "";

beforeAll(async () => {
  if (!HAS_GIT) return;
  const s = node.http.createServer((req, res) => {
    const chunks: Uint8Array[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
      const method = req.method ?? "GET";
      const body = method === "GET" || method === "HEAD" ? null : new Blob(chunks);
      void handleGitRequest(new Request(`${origin}${req.url ?? "/"}`, { method, headers, body }), "demo", deps).then(async (out) => {
        res.writeHead(out.status, Object.fromEntries(out.headers.entries()));
        res.end(new Uint8Array(await out.arrayBuffer()));
      });
    });
  });
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  server = s;
  origin = `http://127.0.0.1:${s.address().port}`;
  dir = node.fs.mkdtempSync(node.path.join(node.os.tmpdir(), "ft-push-"));
  expect((await git(["init", "-q", "-b", "main", dir])).status).toBe(0);
  expect((await git(["commit", "-q", "--allow-empty", "-m", "a change"], dir)).status).toBe(0);
});

afterAll(async () => {
  const s = server;
  if (s) await new Promise<void>((resolve) => s.close(() => resolve()));
  if (dir) node.fs.rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!HAS_GIT)("git push to a colony's read-only git URL, with stock git", () => {
  it("prints the colony's page, how a change reaches trunk and the MCP add command as remote: lines, and fails", async () => {
    const out = await git(["push", `${origin}/git/demo.git`, "HEAD:refs/heads/main"], dir);
    expect(out.status).not.toBe(0);
    const remote = out.stderr
      .split("\n")
      .filter((l) => l.startsWith("remote: "))
      .map((l) => l.slice("remote: ".length));
    expect(remote).toEqual(pushRefusal(origin, "demo"));
    expect(remote).toContain(`The colony: ${origin}/c/demo`);
    expect(remote.join("\n")).toContain(`claude mcp add --transport http firetrident ${origin}/mcp --header "Authorization: Bearer $FT_MCP_TOKEN"`);
    expect(out.stderr).toMatch(/returned error: 403/);
  });

  it("answers a colony that is not served with git's not-found, and no help text", async () => {
    const out = await git(["push", `${origin}/git/other.git`, "HEAD:refs/heads/main"], dir);
    expect(out.status).not.toBe(0);
    expect(out.stderr).toContain("remote: Repository not found.");
    expect(out.stderr).not.toContain("read-only copy");
  });
});
