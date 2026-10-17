import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ArtifactsTrunkAccess,
  MAX_REQUEST_BYTES,
  PUSH_REFUSED,
  pushRefused,
  READ_TOKEN_MARGIN_MS,
  READ_TOKEN_TTL_S,
  handleGitRequest,
  isColonyName,
  publicColonies,
  routeGitRequest,
  type GitProxyDeps,
} from "../../src/api/git-proxy.ts";

const BASE = "https://ft.example";
const REMOTE = "https://acct.artifacts.example/git/ft-trunk/hono--trunk.git";
const PUBLIC = "hono,shortlinks";
const ADVERT = "application/x-git-upload-pack-advertisement";
const RESULT = "application/x-git-upload-pack-result";
const enc = new TextEncoder();

/** Gzip bytes the way git compresses a large request body. */
async function gzip(data: string | Uint8Array): Promise<Uint8Array> {
  const bytes = typeof data === "string" ? enc.encode(data) : data;
  return new Uint8Array(await new Response(new Response(bytes).body!.pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
}

interface Call {
  url: string;
  method: string;
  headers: Headers;
  body: Uint8Array | null;
}

/** Fake trunk access and upstream: records every upstream call, answers with `replies` in order (then 200). */
function fake(replies: Array<(call: Call) => Response> = [], remotes: Record<string, string | null> = { hono: REMOTE, shortlinks: null }) {
  const calls: Call[] = [];
  const stats = { lookups: 0, tokens: 0, invalidations: 0 };
  let generation = 1;
  const deps: GitProxyDeps = {
    trunk: {
      remote: async (colony) => {
        stats.lookups++;
        return remotes[colony] ?? null;
      },
      token: async () => {
        stats.tokens++;
        return `read-token-${generation}`;
      },
      invalidate: () => {
        stats.invalidations++;
        generation++;
      },
    },
    fetch: async (url, init) => {
      // Like a real upstream, read the whole request before answering (a body that errors rejects here).
      const body = init.body ? new Uint8Array(await new Response(init.body as ReadableStream).arrayBuffer()) : null;
      const call: Call = { url, method: init.method ?? "GET", headers: new Headers(init.headers), body };
      calls.push(call);
      const reply = replies.shift();
      return reply ? reply(call) : new Response(enc.encode("0008NAK\n"), { status: 200, headers: { "Content-Type": RESULT } });
    },
  };
  return { deps, calls, stats };
}

function get(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`${BASE}${path}`, { headers });
}

function post(path: string, body: BodyInit | ReadableStream<Uint8Array>, headers: Record<string, string> = {}): Request {
  return new Request(`${BASE}${path}`, { method: "POST", body, headers, duplex: "half" } as RequestInit);
}

function chunks(total: number, size = 64 * 1024): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (sent >= total) return c.close();
      const n = Math.min(size, total - sent);
      sent += n;
      c.enqueue(new Uint8Array(n));
    },
  });
}

const ADVERTISE = "/git/hono.git/info/refs?service=git-upload-pack";
const UPLOAD = "/git/hono.git/git-upload-pack";
const PKT_REQUEST = "0014command=ls-refs\n0001000csymrefs\n001bref-prefix refs/notes/\n0000";

describe("colony names and the allowlist", () => {
  it("accepts colony slugs only", () => {
    for (const ok of ["hono", "byo-demo", "p1-proof", "a", "0", "a1-b2-c3", "x".repeat(48)]) expect(isColonyName(ok)).toBe(true);
    const bad = ["", "Hono", "-a", "a-", "a--b", "a.b", "a_b", "..", ".", "a/b", "a%2Fb", "x".repeat(49), " hono", "hono\n", "hono.git"];
    for (const name of bad) expect(isColonyName(name)).toBe(false);
  });

  it("reads FT_PUBLIC_GIT as a comma-separated list and drops anything that is not a colony name", () => {
    expect([...publicColonies(" hono, shortlinks ,,byo-demo, ../etc, Hono, a--b, x/y ")].sort()).toEqual(["byo-demo", "hono", "shortlinks"]);
    expect(publicColonies(undefined).size).toBe(0);
    expect(publicColonies("").size).toBe(0);
    expect(publicColonies(" , ").size).toBe(0);
  });
});

describe("routeGitRequest", () => {
  const route = (method: string, path: string) => routeGitRequest(method, new URL(`${BASE}${path}`));

  it("recognizes the two upload-pack endpoints and both push endpoints", () => {
    expect(route("GET", ADVERTISE)).toEqual({ kind: "advertise", colony: "hono" });
    expect(route("GET", `${ADVERTISE}&extra=1`)).toEqual({ kind: "advertise", colony: "hono" });
    expect(route("POST", UPLOAD)).toEqual({ kind: "upload-pack", colony: "hono" });
    expect(route("GET", "/git/hono.git/info/refs?service=git-receive-pack")).toEqual({ kind: "push", colony: "hono" });
    expect(route("POST", "/git/hono.git/git-receive-pack")).toEqual({ kind: "push", colony: "hono" });
  });

  it("rejects every other method, path, service and name", () => {
    const none = [
      ["GET", "/git/hono.git/info/refs"],
      ["GET", "/git/hono.git/info/refs?service=git-upload-archive"],
      ["POST", ADVERTISE],
      ["HEAD", ADVERTISE],
      ["GET", UPLOAD],
      ["PUT", UPLOAD],
      ["GET", "/git/hono.git/git-receive-pack"],
      ["GET", "/git/hono/info/refs?service=git-upload-pack"],
      ["GET", "/git/hono.git/info/refs/?service=git-upload-pack"],
      ["GET", "/git/hono.git/HEAD"],
      ["GET", "/git/hono.git/objects/info/packs"],
      ["GET", "/git/hono.git"],
      ["GET", "/git/"],
      ["GET", "/git/team/hono.git/info/refs?service=git-upload-pack"],
      ["GET", "/git/..%2Fhono.git/info/refs?service=git-upload-pack"],
      ["GET", "/git/hono%2F...git/info/refs?service=git-upload-pack"],
      ["GET", "/git/%2e%2e.git/info/refs?service=git-upload-pack"],
      ["GET", "/git/Hono.git/info/refs?service=git-upload-pack"],
      ["GET", "/git/a--trunk.git/info/refs?service=git-upload-pack"],
      ["GET", "/git/hono.git.git/info/refs?service=git-upload-pack"],
      ["POST", "/git/.git/git-upload-pack"],
    ] as const;
    for (const [method, path] of none) expect(route(method, path), `${method} ${path}`).toEqual({ kind: "none" });
  });
});

describe("handleGitRequest", () => {
  it("is off when FT_PUBLIC_GIT is empty or unset", async () => {
    for (const list of [undefined, "", " , "]) {
      const f = fake();
      const res = await handleGitRequest(get(ADVERTISE), list, f.deps);
      expect(res.status).toBe(404);
      expect((await handleGitRequest(post("/git/hono.git/git-receive-pack", "x"), list, f.deps)).status).toBe(404);
      expect(f.calls).toHaveLength(0);
      expect(f.stats).toEqual({ lookups: 0, tokens: 0, invalidations: 0 });
    }
  });

  it("answers 404 for a colony that is not listed, without touching its trunk", async () => {
    const f = fake([], { hono: REMOTE, "byo-demo": REMOTE });
    for (const req of [
      get("/git/byo-demo.git/info/refs?service=git-upload-pack"),
      post("/git/byo-demo.git/git-upload-pack", PKT_REQUEST),
      get("/git/byo-demo.git/info/refs?service=git-receive-pack"),
      get("/git/..%2Fhono.git/info/refs?service=git-upload-pack"),
    ]) {
      const res = await handleGitRequest(req, PUBLIC, f.deps);
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toMatch(/^text\/plain/);
    }
    expect(f.calls).toHaveLength(0);
    expect(f.stats.lookups + f.stats.tokens).toBe(0);
  });

  it("refuses pushes with 403 and a plain-text reason git prints, before any token exists", async () => {
    const f = fake();
    for (const req of [get("/git/hono.git/info/refs?service=git-receive-pack"), post("/git/hono.git/git-receive-pack", "0000")]) {
      const res = await handleGitRequest(req, PUBLIC, f.deps);
      expect(res.status).toBe(403);
      expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      // The helpful answer (test/api/git-push.test.ts reads it through stock git): the colony, its page, how to connect.
      const body = await res.text();
      expect(body).toBe(`${pushRefused(new URL(BASE), "hono")}\n`);
      expect(body).toContain(`${BASE}/c/hono`);
      expect(body).not.toContain(PUSH_REFUSED);
    }
    expect(f.calls).toHaveLength(0);
    expect(f.stats.tokens).toBe(0);
  });

  it("forwards the ref advertisement with the server's token and the client's protocol version, and nothing else of the client's", async () => {
    const advert = "000eversion 2\n0013ls-refs=unborn\n0000";
    const f = fake([() => new Response(advert, { status: 200, headers: { "Content-Type": ADVERT, "Set-Cookie": "s=1", "WWW-Authenticate": "Basic" } })]);
    const res = await handleGitRequest(
      get(`${ADVERTISE}&evil=1`, { "Git-Protocol": "version=2", Authorization: "Bearer client-secret", Cookie: "c=1", "User-Agent": "git/2.47.0" }),
      PUBLIC,
      f.deps,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(ADVERT);
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("www-authenticate")).toBeNull();
    expect(await res.text()).toBe(advert);
    expect(f.calls).toHaveLength(1);
    const up = f.calls[0]!;
    expect(up.url).toBe(`${REMOTE}/info/refs?service=git-upload-pack`);
    expect(up.method).toBe("GET");
    expect(up.headers.get("authorization")).toBe("Bearer read-token-1");
    expect(up.headers.get("git-protocol")).toBe("version=2");
    expect(up.headers.get("user-agent")).toBe("git/2.47.0");
    expect(up.headers.get("cookie")).toBeNull();
  });

  it("drops a malformed Git-Protocol header instead of forwarding it", async () => {
    const f = fake([() => new Response("0000", { headers: { "Content-Type": ADVERT } })]);
    expect((await handleGitRequest(get(ADVERTISE, { "Git-Protocol": "version=2 x; y" }), PUBLIC, f.deps)).status).toBe(200);
    expect(f.calls[0]!.headers.get("git-protocol")).toBeNull();
  });

  it("streams an upload-pack request up and its result back, keeping content types", async () => {
    const pack = new Uint8Array([0x30, 0x30, 0x30, 0x38, 0x4e, 0x41, 0x4b, 0x0a, 1, 2, 3, 255]);
    const f = fake([() => new Response(pack, { status: 200, headers: { "Content-Type": RESULT } })]);
    const res = await handleGitRequest(
      post(UPLOAD, PKT_REQUEST, { "Content-Type": "application/x-git-upload-pack-request", "Git-Protocol": "version=2" }),
      PUBLIC,
      f.deps,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(RESULT);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(pack);
    const up = f.calls[0]!;
    expect(up.url).toBe(`${REMOTE}/git-upload-pack`);
    expect(up.method).toBe("POST");
    expect(up.headers.get("content-type")).toBe("application/x-git-upload-pack-request");
    expect(up.headers.get("accept")).toBe(RESULT);
    expect(up.headers.get("git-protocol")).toBe("version=2");
    expect(up.headers.get("authorization")).toBe("Bearer read-token-1");
    expect(new TextDecoder().decode(up.body!)).toBe(PKT_REQUEST);
  });

  it("passes a body of declared length through and decodes gzip bodies before forwarding them", async () => {
    const f = fake();
    const plainBody = enc.encode(PKT_REQUEST);
    expect((await handleGitRequest(post(UPLOAD, plainBody, { "Content-Length": String(plainBody.byteLength) }), PUBLIC, f.deps)).status).toBe(200);
    expect(f.calls[0]!.body).toEqual(plainBody);

    const large = `${PKT_REQUEST}${"0032want 0123456789abcdef0123456789abcdef01234567\n".repeat(400)}0009done\n`;
    for (const encoding of ["gzip", "x-gzip"]) {
      const zipped = await gzip(large);
      const res = await handleGitRequest(post(UPLOAD, zipped, { "Content-Encoding": encoding, "Content-Length": String(zipped.byteLength) }), PUBLIC, f.deps);
      expect(res.status).toBe(200);
      const up = f.calls.at(-1)!;
      expect(new TextDecoder().decode(up.body!)).toBe(large);
      expect(up.headers.get("content-encoding")).toBeNull();
    }
  });

  it("caps request bodies as declared, as streamed and after gzip decoding", async () => {
    const f = fake();
    const declared = await handleGitRequest(post(UPLOAD, "0000", { "Content-Length": String(MAX_REQUEST_BYTES + 1) }), PUBLIC, f.deps);
    expect(declared.status).toBe(413);
    expect(f.stats.lookups).toBe(0);

    const streamed = await handleGitRequest(post(UPLOAD, chunks(MAX_REQUEST_BYTES + 1)), PUBLIC, f.deps);
    expect(streamed.status).toBe(413);

    const bomb = await gzip(new Uint8Array(MAX_REQUEST_BYTES + 1));
    expect(bomb.byteLength).toBeLessThan(64 * 1024);
    const inflated = await handleGitRequest(post(UPLOAD, bomb, { "Content-Encoding": "gzip" }), PUBLIC, f.deps);
    expect(inflated.status).toBe(413);

    expect((await handleGitRequest(post(UPLOAD, chunks(MAX_REQUEST_BYTES)), PUBLIC, f.deps)).status).toBe(200);
    expect(f.calls.at(-1)!.body!.byteLength).toBe(MAX_REQUEST_BYTES);
  });

  it("refuses bodies it cannot read: broken gzip, other encodings, a bad length", async () => {
    const f = fake();
    expect((await handleGitRequest(post(UPLOAD, enc.encode("not gzip at all"), { "Content-Encoding": "gzip" }), PUBLIC, f.deps)).status).toBe(400);
    expect((await handleGitRequest(post(UPLOAD, enc.encode("0000"), { "Content-Encoding": "br" }), PUBLIC, f.deps)).status).toBe(415);
    expect((await handleGitRequest(post(UPLOAD, enc.encode("0000"), { "Content-Length": "4x" }), PUBLIC, f.deps)).status).toBe(400);
  });

  it("re-mints the token once when the remote refuses the cached one", async () => {
    const f = fake([() => new Response("expired", { status: 401 }), (call) => new Response(`ok ${call.headers.get("authorization")}`, { headers: { "Content-Type": ADVERT } })]);
    const res = await handleGitRequest(get(ADVERTISE), PUBLIC, f.deps);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok Bearer read-token-2");
    expect(f.calls.map((c) => c.headers.get("authorization"))).toEqual(["Bearer read-token-1", "Bearer read-token-2"]);
    expect(f.stats.invalidations).toBe(1);
  });

  it("never hands git a 401 (git would ask for a password), and maps upstream failures", async () => {
    const refused = fake([() => new Response("no", { status: 401 }), () => new Response("no", { status: 403, headers: { "WWW-Authenticate": "Basic" } })]);
    const advert = await handleGitRequest(get(ADVERTISE), PUBLIC, refused.deps);
    expect(advert.status).toBe(503);
    expect(advert.headers.get("www-authenticate")).toBeNull();

    const upload = fake([() => new Response("no", { status: 401 })]);
    expect((await handleGitRequest(post(UPLOAD, PKT_REQUEST), PUBLIC, upload.deps)).status).toBe(503);
    expect(upload.stats.invalidations).toBe(1);

    const missing = fake([() => new Response("gone", { status: 404 })]);
    expect((await handleGitRequest(get(ADVERTISE), PUBLIC, missing.deps)).status).toBe(404);
    const broken = fake([() => new Response("boom", { status: 500 })]);
    const res = await handleGitRequest(post(UPLOAD, PKT_REQUEST), PUBLIC, broken.deps);
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain("boom");
  });

  it("answers 404 when a listed colony has no trunk, and 503 when the lookup fails", async () => {
    const f = fake();
    expect((await handleGitRequest(get("/git/shortlinks.git/info/refs?service=git-upload-pack"), PUBLIC, f.deps)).status).toBe(404);
    expect(f.calls).toHaveLength(0);
    const failing = fake();
    failing.deps.trunk.remote = async () => {
      throw new Error("control plane down");
    };
    expect((await handleGitRequest(get(ADVERTISE), PUBLIC, failing.deps)).status).toBe(503);
  });
});

describe("ArtifactsTrunkAccess", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A fake ARTIFACTS binding with one repo, hono--trunk. */
  function binding() {
    const stats = { gets: 0, infos: 0, mints: [] as Array<{ scope: string | undefined; ttl: number | undefined }> };
    const fakeBinding = {
      async get(name: string) {
        stats.gets++;
        if (name !== "hono--trunk") throw Object.assign(new Error(`no repo ${name}`), { code: "NOT_FOUND" });
        return {
          async info() {
            stats.infos++;
            return { name, remote: REMOTE };
          },
          async createToken(scope?: "read" | "write", ttl = 86_400) {
            stats.mints.push({ scope, ttl });
            const expires = Math.floor(Date.now() / 1000) + ttl;
            return { id: `tok${stats.mints.length}`, plaintext: `art_v1_${stats.mints.length}?expires=${expires}`, scope, expiresAt: new Date(expires * 1000).toISOString() };
          },
        };
      },
    };
    return { stats, artifacts: fakeBinding as unknown as Artifacts };
  }

  it("mints one short-lived read token per colony and shares it", async () => {
    const b = binding();
    const access = new ArtifactsTrunkAccess(b.artifacts);
    const tokens = await Promise.all([access.token("hono"), access.token("hono"), access.token("hono")]);
    expect(new Set(tokens).size).toBe(1);
    expect(b.stats.mints).toEqual([{ scope: "read", ttl: READ_TOKEN_TTL_S }]);
    access.invalidate("hono");
    expect(await access.token("hono")).not.toBe(tokens[0]);
    expect(b.stats.mints).toHaveLength(2);
  });

  it("replaces the token shortly before it expires", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.parse("2026-10-12T12:00:00Z");
    vi.setSystemTime(t0);
    const b = binding();
    const access = new ArtifactsTrunkAccess(b.artifacts);
    const first = await access.token("hono");
    vi.setSystemTime(t0 + READ_TOKEN_TTL_S * 1000 - READ_TOKEN_MARGIN_MS - 60_000);
    expect(await access.token("hono")).toBe(first);
    vi.setSystemTime(t0 + READ_TOKEN_TTL_S * 1000 - READ_TOKEN_MARGIN_MS + 1_000);
    expect(await access.token("hono")).not.toBe(first);
    expect(b.stats.mints).toHaveLength(2);
  });

  it("looks a trunk's remote up once, and does not cache a missing trunk", async () => {
    const b = binding();
    const access = new ArtifactsTrunkAccess(b.artifacts);
    expect(await access.remote("hono")).toBe(REMOTE);
    expect(await access.remote("hono")).toBe(REMOTE);
    expect(b.stats.infos).toBe(1);
    expect(await access.remote("nope")).toBeNull();
    expect(await access.remote("nope")).toBeNull();
    expect(b.stats.gets).toBe(3);
  });
});
