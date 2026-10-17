import { describe, expect, it } from "vitest";
import type { Landing } from "@fire_trident/core";
import { createApi, type ApiDeps } from "../../src/api/app.ts";
import { IMMUTABLE_CACHE, PREVIEW_CSP, PREVIEW_FILE_BYTES, PREVIEW_IN_FLIGHT, REVALIDATE_CACHE, contentTypeOf, previewPath } from "../../src/api/preview.ts";
import type { Env } from "../../src/env.ts";

/**
 * The sandboxed preview of a trunk file at a landing's commit (GET /colonies/:id/preview/:commit/<path>): served only for
 * colonies that are public already, under a sandbox policy, with nosniff, a type from a short list, a size cap, and an
 * immutable cache only for a commit named in full.
 */

const deps: ApiDeps = {
  provisionTrunk: async () => {
    throw new Error("not used");
  },
  spawnSwarm: async () => undefined,
};

const COMMIT = "2".repeat(40);
const OTHER = "3".repeat(40);
const LANDING: Landing = { id: "lnd_one", colonyId: "col", trunkSha: COMMIT, parentSha: "1".repeat(40), proposalIds: ["prp_1"], intentIds: ["int_1"], paths: ["mosaic.json"], regions: ["."], at: 5 };
const MOSAIC = '{"rows": 1, "cols": 1, "tiles": [\n  {"r": 0, "c": 0, "color": "#e63946"}\n]}\n';
const PAGE = "<!doctype html><title>Mosaic</title><script>alert(1)</script>";

interface World {
  publicGit?: string;
  publicMcp?: string;
  /** Blob of each path at each commit (baseBlobs). */
  trees?: Record<string, Record<string, string>>;
  /** Blob contents by id (readBlob); absent ids read as null. */
  blobs?: Record<string, string | Uint8Array>;
  /** Holds every landingNote call until it resolves. */
  hold?: Promise<void>;
  colony?: boolean;
}

/** An env with one public (or not) colony, a trunk writer that knows one landing, and a trunk repository of blobs. */
function env(w: World): { env: Env; asked: string[]; reads: string[] } {
  const asked: string[] = [];
  const reads: string[] = [];
  const trunkRef = { namespace: "ft-trunk", name: "col--trunk", remote: "https://example.invalid/col.git" };
  const COLONY = { idFromName: (n: string) => n, get: () => ({ getColony: async () => (w.colony === false ? null : { id: "col", trunk: trunkRef }) }) };
  const TRUNK = {
    idFromName: (n: string) => n,
    get: () => ({
      landingNote: async (ref: string) => {
        asked.push(`landingNote ${ref}`);
        await w.hold;
        return ref === LANDING.id || LANDING.trunkSha.startsWith(ref) ? { landing: LANDING, note: null } : null;
      },
      baseBlobs: async (sha: string, paths: string[]) => {
        asked.push(`baseBlobs ${sha.slice(0, 1)} ${paths.join(",")}`);
        return paths.map((path) => ({ path, blob: w.trees?.[sha]?.[path] ?? null }));
      },
    }),
  };
  const ARTIFACTS = {
    get: async (name: string) => ({
      readBlob: async (oid: string) => {
        reads.push(`${name} ${oid.slice(0, 1)}`);
        const b = w.blobs?.[oid];
        return b === undefined ? null : new Blob([b]);
      },
    }),
  };
  return { env: { COLONY, TRUNK, ARTIFACTS, FT_PUBLIC_GIT: w.publicGit, FT_PUBLIC_MCP: w.publicMcp } as unknown as Env, asked, reads };
}

const trees = { [COMMIT]: { "mosaic.json": "a".repeat(40), "index.html": "b".repeat(40), "src/app.js": "c".repeat(40), "big.txt": "d".repeat(40) } };
const blobs = { ["a".repeat(40)]: MOSAIC, ["b".repeat(40)]: PAGE, ["c".repeat(40)]: "document.title = 1;", ["d".repeat(40)]: new Uint8Array(PREVIEW_FILE_BYTES + 1) };

const get = async (e: Env, path: string) => {
  const res = await createApi(deps).request(path, {}, e);
  return { status: res.status, headers: res.headers, text: await res.text() };
};

describe("the preview of a trunk file at a landing's commit", () => {
  it("is served only for colonies listed in FT_PUBLIC_GIT or FT_PUBLIC_MCP, reading nothing for any other", async () => {
    for (const lists of [{ publicGit: "col" }, { publicMcp: "other, col" }]) {
      expect((await get(env({ ...lists, trees, blobs }).env, `/colonies/col/preview/${COMMIT}/mosaic.json`)).status).toBe(200);
    }
    const hidden = env({ publicGit: "other", publicMcp: "another", trees, blobs });
    const res = await get(hidden.env, `/colonies/col/preview/${COMMIT}/mosaic.json`);
    expect(res.status).toBe(404);
    expect(JSON.parse(res.text).error).toMatch(/^colony col does not show file contents here: only colonies listed in FT_PUBLIC_GIT or FT_PUBLIC_MCP do/);
    expect(hidden.asked).toEqual([]);
    expect(hidden.reads).toEqual([]);
    expect((await get(env({ trees, blobs }).env, `/colonies/col/preview/${COMMIT}/mosaic.json`)).status).toBe(404);
  });

  it("serves the file's bytes as they are, sandboxed, with nosniff and an immutable cache for a commit named in full", async () => {
    const { env: e, asked, reads } = env({ publicGit: "col", trees, blobs });
    const res = await get(e, `/colonies/col/preview/${COMMIT}/mosaic.json`);
    expect(res.status).toBe(200);
    expect(res.text).toBe(MOSAIC);
    expect(JSON.parse(res.text).tiles[0].color).toBe("#e63946");
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("content-security-policy")).toBe(PREVIEW_CSP);
    expect(PREVIEW_CSP.split("; ")[0]).toBe("sandbox");
    expect(PREVIEW_CSP).not.toMatch(/allow-scripts|script-src|unsafe-eval/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe(IMMUTABLE_CACHE);
    expect(res.headers.get("x-ft-commit")).toBe(COMMIT);
    expect(asked).toEqual([`landingNote ${COMMIT}`, "baseBlobs 2 mosaic.json"]);
    expect(reads).toEqual(["col--trunk a"]);
  });

  it("serves a page under the sandbox (its script never runs) and anything else, scripts included, as plain text", async () => {
    const { env: e } = env({ publicGit: "col", trees, blobs });
    const page = await get(e, `/colonies/col/preview/${COMMIT}/index.html`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(page.headers.get("content-security-policy")).toContain("sandbox");
    // A path that is empty or ends in "/" names index.html.
    expect((await get(e, `/colonies/col/preview/${COMMIT}/`)).text).toBe(PAGE);
    const script = await get(e, `/colonies/col/preview/${COMMIT}/src/app.js`);
    expect(script.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(contentTypeOf("README")).toBe("text/plain; charset=utf-8");
    expect(contentTypeOf("a/b.SVG")).toBe("image/svg+xml");
    expect(contentTypeOf("notes.md")).toBe("text/markdown; charset=utf-8");
  });

  it("caches the answer for a commit prefix or a landing id only until it is checked again", async () => {
    const { env: e } = env({ publicGit: "col", trees, blobs });
    for (const ref of ["2222222", "lnd_one"]) {
      const res = await get(e, `/colonies/col/preview/${ref}/mosaic.json`);
      expect(res.status, ref).toBe(200);
      expect(res.headers.get("cache-control"), ref).toBe(REVALIDATE_CACHE);
      expect(res.headers.get("x-ft-commit"), ref).toBe(COMMIT);
    }
  });

  it("answers 404 for an unknown colony, a commit no landing made and a file the commit does not hold", async () => {
    const e = env({ publicGit: "col", trees, blobs }).env;
    const gone = await get(env({ publicGit: "col", colony: false }).env, `/colonies/col/preview/${COMMIT}/mosaic.json`);
    expect(gone.status).toBe(404);
    expect(JSON.parse(gone.text).error).toBe("colony not found");
    const other = await get(e, `/colonies/col/preview/${OTHER}/mosaic.json`);
    expect(other.status).toBe(404);
    expect(JSON.parse(other.text).error).toBe(`no landing ${OTHER} in colony col: name a commit a landing made (or the landing's id)`);
    const missing = await get(e, `/colonies/col/preview/${COMMIT}/roll-call.md`);
    expect(missing.status).toBe(404);
    expect(JSON.parse(missing.text).error).toBe("there is no file roll-call.md at commit 2222222: name a file the colony's trunk held there");
    // A folder is not a file: src names no blob.
    expect((await get(e, `/colonies/col/preview/${COMMIT}/src`)).status).toBe(404);
    expect((await get(e, `/colonies/Bad_Name/preview/${COMMIT}/mosaic.json`)).status).toBe(404);
  });

  it("refuses a commit that is not one, and a path that leaves the tree", async () => {
    const { env: e, asked } = env({ publicGit: "col", trees, blobs });
    for (const bad of ["HEAD", "abc", "main", "z".repeat(40)]) expect((await get(e, `/colonies/col/preview/${bad}/mosaic.json`)).status, bad).toBe(400);
    // A literal or percent-encoded . or .. segment is resolved by URL parsing before any route sees it; one hidden in an
    // encoded slash reaches the route and is refused.
    for (const bad of ["..%2Fsecret", "a/..%2Fb", "a//b", "a%5Cb", "a%00b", "%E0%A4%A"]) {
      expect((await get(e, `/colonies/col/preview/${COMMIT}/${bad}`)).status, bad).toBe(400);
    }
    for (const bad of ["a/../b", "./x", "a/.", "x/.."]) expect(() => previewPath(`/colonies/col/preview/${COMMIT}/${bad}`), bad).toThrow(/no \. or \.\. segment/);
    expect(asked).toEqual([]);
    expect(previewPath(`/api/colonies/col/preview/${COMMIT}/docs/a%20b.md`)).toBe("docs/a b.md");
    expect(previewPath(`/colonies/col/preview/${COMMIT}/site/`)).toBe("site/index.html");
    expect(previewPath(`/colonies/col/preview/${COMMIT}/`)).toBe("index.html");
    expect(previewPath(`/api/colonies/preview/preview/${COMMIT}/preview/a/b.md`)).toBe("preview/a/b.md");
    expect(() => previewPath(`/colonies/col/preview/${COMMIT}/${"a".repeat(1025)}`)).toThrow(/at most 1,024 characters/);
  });

  it("does not serve a file over the size cap", async () => {
    const res = await get(env({ publicGit: "col", trees, blobs }).env, `/colonies/col/preview/${COMMIT}/big.txt`);
    expect(res.status).toBe(413);
    expect(JSON.parse(res.text).error).toBe("big.txt is over 512 KB, too large to preview: read it from a plain git clone of the colony");
  });

  it("answers 503 when the trunk repository does not give the file, and when too many previews are read at once", async () => {
    const unreadable = await get(env({ publicGit: "col", trees, blobs: {} }).env, `/colonies/col/preview/${COMMIT}/mosaic.json`);
    expect(unreadable.status).toBe(503);
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const { env: e } = env({ publicGit: "col", trees, blobs, hold });
    const app = createApi(deps);
    const waiting = Array.from({ length: PREVIEW_IN_FLIGHT }, () => app.request(`/colonies/col/preview/${COMMIT}/mosaic.json`, {}, e));
    await new Promise((r) => setTimeout(r, 0));
    const busy = await app.request(`/colonies/col/preview/${COMMIT}/mosaic.json`, {}, e);
    expect(busy.status).toBe(503);
    expect(busy.headers.get("retry-after")).toBe("1");
    release();
    expect((await Promise.all(waiting)).map((r) => r.status)).toEqual(Array.from({ length: PREVIEW_IN_FLIGHT }, () => 200));
    expect((await app.request(`/colonies/col/preview/${COMMIT}/mosaic.json`, {}, e)).status).toBe(200);
  });
});
