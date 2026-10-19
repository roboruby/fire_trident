import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getRepoIfExists, listRemoteRefs, mintToken, withArtifactsRetry } from "../../src/artifacts/git.ts";
import { ArtifactsRestError, artifactsOverRest, forgetKnownNamespaces, restErrorCode, type RestCredentials } from "../../src/artifacts/rest.ts";
import { FakeArtifacts } from "./fake-artifacts.ts";
import { pushReadme } from "./rest-helpers.ts";

let fake: FakeArtifacts;
let asked = 0;

/** A namespace of the fake account through the adapter; `cred` answers each call's credentials. */
function ns(namespace = "firetrident-trunk", cred: () => RestCredentials | null = () => ({ accountId: fake.accountId, accessToken: fake.accessToken })): Artifacts {
  return artifactsOverRest({
    namespace,
    credentials: async () => {
      asked++;
      return cred();
    },
    fetch: fake.fetch,
  });
}

beforeEach(() => {
  fake = new FakeArtifacts();
  asked = 0;
  forgetKnownNamespaces();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Artifacts over REST: repositories", () => {
  it("creates a repo, making its namespace first (once), and answers in the binding's shape", async () => {
    const a = ns();
    const made = await a.create("c1--trunk", { description: "trunk", setDefaultBranch: "main" });
    expect(made).toMatchObject({ name: "c1--trunk", description: "trunk", defaultBranch: "main", remote: `${fake.gitHost}/git/firetrident-trunk/c1--trunk.git` });
    expect(made.token).toMatch(/^art_v1_[0-9a-f]{40}\?expires=\d+$/);
    expect(fake.createdNamespaces).toEqual(["firetrident-trunk"]);
    await a.create("c1--seed");
    const nsCalls = fake.calls.filter((c) => c.path.startsWith("/namespaces/firetrident-trunk") && !c.path.includes("/repos"));
    expect(nsCalls).toHaveLength(1);
    // Every call carried the connection's token to its account, in the header only.
    expect(fake.calls.every((c) => c.bearer === fake.accessToken && c.account === fake.accountId)).toBe(true);
  });

  it("answers ALREADY_EXISTS for a repo that exists, with Cloudflare's numeric code", async () => {
    const a = ns();
    await a.create("dup");
    const e = await a.create("dup").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ArtifactsRestError);
    expect(e).toMatchObject({ name: "ArtifactsError", code: "ALREADY_EXISTS", numericCode: 10201, status: 409 });
  });

  it("gets a handle with fresh info, and NOT_FOUND for a missing repo (getRepoIfExists reads null)", async () => {
    const a = ns();
    await a.create("here", { description: "d" });
    const repo = await a.get("here");
    expect(await repo.info()).toMatchObject({ name: "here", description: "d", defaultBranch: "main", readOnly: false, source: null, lastPushAt: null, remote: `${fake.gitHost}/git/firetrident-trunk/here.git` });
    await expect(a.get("gone")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await getRepoIfExists(a, "gone")).toBeNull();
  });

  it("imports a public remote, and names a missing one NOT_FOUND", async () => {
    await fake.addSource("https://git.example.invalid/acme/app", { "README.md": "# app\n", "src/a.ts": "export const a = 1;\n" }, "trunk");
    const a = ns();
    const made = await a.import({ source: { url: "https://git.example.invalid/acme/app", depth: 200 }, target: { name: "app--trunk", opts: { description: "ignored" } } });
    expect(made).toMatchObject({ name: "app--trunk", defaultBranch: "trunk" });
    expect(fake.createdNamespaces).toEqual(["firetrident-trunk"]);
    expect(await fake.readText("firetrident-trunk", "app--trunk", "src/a.ts", "refs/heads/trunk")).toBe("export const a = 1;\n");
    await expect(a.import({ source: { url: "https://git.example.invalid/none" }, target: { name: "none" } })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(a.import({ source: { url: "https://git.example.invalid/acme/app" }, target: { name: "app--trunk" } })).rejects.toMatchObject({ code: "ALREADY_EXISTS" });
  });

  it("lists by pages with a cursor, without remotes", async () => {
    const a = ns("firetrident-ws-0");
    for (const n of ["c--ws-0", "c--ws-4", "c--seed"]) await a.create(n);
    const first = await a.list({ limit: 2 });
    expect(first.repos.map((r) => r.name)).toEqual(["c--seed", "c--ws-0"]);
    expect(first.cursor).toBeDefined();
    expect("remote" in first.repos[0]!).toBe(false);
    const second = await a.list({ limit: 2, cursor: first.cursor! });
    expect(second.repos.map((r) => r.name)).toEqual(["c--ws-4"]);
    expect(second.cursor).toBeUndefined();
  });

  it("deletes: true once, then false", async () => {
    const a = ns();
    await a.create("bye");
    expect(await a.delete("bye")).toBe(true);
    expect(await a.delete("bye")).toBe(false);
  });

  it("forks within the namespace, and a taken name is ALREADY_EXISTS", async () => {
    const a = ns("firetrident-ws-1");
    const seed = await a.create("c--seed");
    vi.stubGlobal("fetch", fake.fetch);
    await pushReadme(seed.remote, seed.token, "seed\n");
    const forked = await (await a.get("c--seed")).fork("c--ws-1", { description: "workspace 1", defaultBranchOnly: true });
    expect(forked).toMatchObject({ name: "c--ws-1", remote: `${fake.gitHost}/git/firetrident-ws-1/c--ws-1.git` });
    expect(await fake.readText("firetrident-ws-1", "c--ws-1", "README.md")).toBe("seed\n");
    await expect((await a.get("c--seed")).fork("c--ws-1")).rejects.toMatchObject({ code: "ALREADY_EXISTS" });
  });
});

describe("Artifacts over REST: tokens", () => {
  it("mints, lists and revokes by id; a plaintext token is refused", async () => {
    const a = ns();
    await a.create("tok");
    const t = await mintToken(a, "tok", "read", 600);
    expect(t.scope).toBe("read");
    expect(t.token).toMatch(/^art_v1_/);
    expect(t.expiresAt).toBeGreaterThan(Date.now() + 500_000);
    const repo = await a.get("tok");
    const listed = await repo.listTokens();
    expect(listed.tokens.find((x) => x.id === t.id)).toMatchObject({ scope: "read", state: "active" });
    expect(JSON.stringify(listed)).not.toContain(t.token);
    expect(await repo.revokeToken(t.id)).toBe(true);
    expect((await repo.listTokens()).tokens.find((x) => x.id === t.id)?.state).toBe("revoked");
    expect(await repo.revokeToken("0123456789abcdef")).toBe(false);
    await expect(repo.revokeToken(t.token)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(repo.revokeToken("")).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("answers INVALID_TTL for a ttl out of range", async () => {
    const a = ns();
    await a.create("ttl");
    await expect((await a.get("ttl")).createToken("write", 5)).rejects.toMatchObject({ code: "INVALID_TTL", numericCode: 10103 });
  });
});

describe("Artifacts over REST: reads", () => {
  it("reads commits, trees, blobs, files and the log in the binding's shapes; missing objects read as null", async () => {
    const a = ns();
    const made = await a.create("reads");
    vi.stubGlobal("fetch", fake.fetch);
    const head = await pushReadme(made.remote, made.token, "hello\n");
    const repo = await a.get("reads");
    const commit = await repo.readCommit(head);
    expect(commit).toMatchObject({ hash: head, parents: [], message: "Initial commit", author: { name: "FireTrident" } });
    const tree = await repo.readTree(commit!.treeHash);
    expect(tree).toEqual([{ name: "README.md", mode: "100644", hash: expect.stringMatching(/^[0-9a-f]{40}$/), type: "blob" }]);
    const blob = await repo.readBlob(tree![0]!.hash);
    expect(await blob!.text()).toBe("hello\n");
    expect(await (await repo.readFile({ ref: "main", path: "README.md" }))!.text()).toBe("hello\n");
    expect((await repo.log({ ref: "main", limit: 1 })).map((c) => c.hash)).toEqual([head]);
    expect(await repo.log({ ref: "nowhere" })).toEqual([]);
    expect(await repo.readBlob("f".repeat(40))).toBeNull();
    expect(await repo.readTree("f".repeat(40))).toBeNull();
    expect(await repo.readCommit("f".repeat(40))).toBeNull();
    expect(await repo.readFile({ ref: "main", path: "nope" })).toBeNull();
    // The remote and token the API returned serve git as the binding's do.
    expect((await listRemoteRefs(made.remote, made.token)).find((r) => r.ref === "refs/heads/main")?.oid).toBe(head);
  });
});

describe("Artifacts over REST: errors", () => {
  it("maps Cloudflare's numeric codes, then the HTTP status", () => {
    expect(restErrorCode(404, 10302)).toBe("IMPORT_IN_PROGRESS");
    expect(restErrorCode(409, 10303)).toBe("FORK_IN_PROGRESS");
    expect(restErrorCode(500, 10401)).toBe("UPSTREAM_UNAVAILABLE");
    expect(restErrorCode(409, undefined)).toBe("ALREADY_EXISTS");
    expect(restErrorCode(409, undefined, "CREATE_IN_PROGRESS")).toBe("CREATE_IN_PROGRESS");
    expect(restErrorCode(403, 10000)).toBe("UNAUTHORIZED");
    expect(restErrorCode(429, undefined)).toBe("INTERNAL_ERROR");
    expect(restErrorCode(503, undefined)).toBe("UPSTREAM_UNAVAILABLE");
    expect(restErrorCode(413, undefined)).toBe("MEMORY_LIMIT");
  });

  it("refuses a rejected token as UNAUTHORIZED with a plain sentence that never shows the token", async () => {
    const secret = "cf-access-wrong-secret";
    const a = ns("firetrident-trunk", () => ({ accountId: fake.accountId, accessToken: secret }));
    const e = (await a.get("x").catch((x: unknown) => x)) as ArtifactsRestError;
    expect(e.code).toBe("UNAUTHORIZED");
    expect(e.status).toBe(401);
    expect(e.message).toMatch(/connect Cloudflare again/);
    expect(e.message).not.toContain(secret);
    // Not a transient code: withArtifactsRetry gives up at once.
    const before = fake.calls.length;
    await expect(withArtifactsRetry(() => a.get("x"), { delaysMs: [1, 1] })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(fake.calls.length - before).toBe(1);
  });

  it("retries a 5xx as INTERNAL_ERROR, and waits out a repo still being made", async () => {
    const a = ns();
    await a.create("busy");
    fake.failNext(/^GET \/namespaces\/firetrident-trunk\/repos\/busy$/, 500, undefined, "", 1);
    expect(await withArtifactsRetry(() => a.get("busy"), { delaysMs: [1] })).toBeDefined();
    fake.failNext(/^GET \/namespaces\/firetrident-trunk\/repos\/busy$/, 409, 10302, "importing", 2);
    const repo = await getRepoIfExists(a, "busy", 5_000);
    expect(repo).not.toBeNull();
  });

  it("names an unreachable API INTERNAL_ERROR", async () => {
    const a = artifactsOverRest({
      namespace: "firetrident-trunk",
      credentials: async () => ({ accountId: fake.accountId, accessToken: fake.accessToken }),
      fetch: async () => {
        throw new TypeError("network down");
      },
    });
    await expect(a.list()).rejects.toMatchObject({ code: "INTERNAL_ERROR", message: expect.stringContaining("network down") });
  });

  it("refuses with NOT_CONNECTED, sending nothing, when there are no credentials; asks for them on every call", async () => {
    const a = ns("firetrident-trunk", () => null);
    await expect(a.create("x")).rejects.toMatchObject({ code: "NOT_CONNECTED", message: expect.stringMatching(/connect Cloudflare again/) });
    expect(fake.calls).toHaveLength(0);
    let token = fake.accessToken;
    const b = ns("firetrident-trunk", () => ({ accountId: fake.accountId, accessToken: token }));
    asked = 0;
    await b.create("y");
    fake.accessToken = "cf-access-refreshed";
    token = "cf-access-refreshed";
    await b.get("y");
    expect(asked).toBeGreaterThanOrEqual(3);
    expect(fake.calls.at(-1)?.bearer).toBe("cf-access-refreshed");
  });
});
