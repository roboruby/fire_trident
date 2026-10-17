import { afterEach, describe, expect, it, vi } from "vitest";
import type { ColonyEvent, ColonySnapshot, RecordedEvent } from "@fire_trident/core";
import { encodeRecording, recordColony, requestHeaders, scrub, UsageError } from "../../../scripts/record_colony.ts";
import { fetchAbout } from "../src/about.ts";
import { HttpError } from "../src/api.ts";
import { answerRead, installRecording, keyOf, loadBundledRecording, readRecording, recordingFetch, type Recording } from "../src/playback/recording.ts";
import { ReplayBackend } from "../src/replay.ts";
import { colonyHref, parseRoute } from "../src/route.ts";
import { ColonyStore } from "../src/store.ts";
import { ReadError } from "../src/verified.ts";

/**
 * Offline playback: the recorder reads a deployment's public routes into one file, and the page answers every read the
 * replay, the director and the tour make from it, with no network.
 */

const T = 1_791_797_000_000;
const BASE = "https://staging.example.test";
const sha = (c: string) => c.repeat(40);
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const ACCESS_ID = "access-client-id-4f2a9c.access";
const ACCESS_SECRET = "access-client-secret-9b8c7d6e5f4a3b2c1d0e";

/** A finished run: two intents, two agents, two landings (the second also creates a file), 30 events in all. */
function events(): RecordedEvent[] {
  const list: ColonyEvent[] = [
    { t: "intent", at: T + 1_000, intentId: "i1", status: "open", title: "Fix a.ts", footprint: ["src/a.ts"] },
    { t: "intent", at: T + 1_000, intentId: "i2", status: "open", title: "Fix b.ts", footprint: ["src/b.ts"] },
    { t: "violations", at: T + 1_001, total: 2, byRule: { r1: 2 } },
    { t: "agent", at: T + 2_000, agentId: "a1", kind: "internal", state: "idle" },
    { t: "agent", at: T + 2_000, agentId: "a2", kind: "internal", state: "idle" },
    { t: "intent", at: T + 2_500, intentId: "i1", status: "claimed", title: "Fix a.ts", footprint: ["src/a.ts"] },
    { t: "agent", at: T + 2_500, agentId: "a1", kind: "internal", state: "working", intentId: "i1", paths: ["src/a.ts"] },
    { t: "intent", at: T + 2_600, intentId: "i2", status: "claimed", title: "Fix b.ts", footprint: ["src/b.ts"] },
    { t: "agent", at: T + 2_600, agentId: "a2", kind: "internal", state: "working", intentId: "i2", paths: ["src/b.ts"] },
    { t: "proposal", at: T + 4_000, proposalId: "p1", intentId: "i1", agentId: "a1", status: "checking" },
    { t: "proposal", at: T + 4_200, proposalId: "p1", intentId: "i1", agentId: "a1", status: "ready" },
    { t: "metric", at: T + 4_400, name: "funnel.proof", value: 1 },
    { t: "proposal", at: T + 5_000, proposalId: "p1", intentId: "i1", agentId: "a1", status: "landed" },
    { t: "agent", at: T + 5_000, agentId: "a1", kind: "internal", state: "idle" },
    { t: "intent", at: T + 5_000, intentId: "i1", status: "landed", title: "Fix a.ts", footprint: ["src/a.ts"] },
    { t: "violations", at: T + 5_000, total: 1, byRule: { r1: 1 } },
    { t: "landing", at: T + 5_000, landingId: "l1", trunkSha: sha("1"), proposalIds: ["p1"], paths: ["src/a.ts"] },
    { t: "proposal", at: T + 6_000, proposalId: "p2", intentId: "i2", agentId: "a2", status: "ready" },
    { t: "proposal", at: T + 6_500, proposalId: "p2", intentId: "i2", agentId: "a2", status: "returned", reason: "stale read: src/b.ts" },
    { t: "intent", at: T + 6_500, intentId: "i2", status: "open", title: "Fix b.ts", footprint: ["src/b.ts"] },
    { t: "intent", at: T + 7_000, intentId: "i2", status: "claimed", title: "Fix b.ts", footprint: ["src/b.ts"] },
    { t: "proposal", at: T + 8_000, proposalId: "p3", intentId: "i2", agentId: "a2", status: "ready" },
    { t: "metric", at: T + 8_100, name: "funnel.proof", value: 2 },
    { t: "proposal", at: T + 9_000, proposalId: "p3", intentId: "i2", agentId: "a2", status: "landed" },
    { t: "intent", at: T + 9_000, intentId: "i2", status: "landed", title: "Fix b.ts", footprint: ["src/b.ts"] },
    { t: "violations", at: T + 9_000, total: 0, byRule: { r1: 0 } },
    { t: "landing", at: T + 9_000, landingId: "l2", trunkSha: sha("2"), proposalIds: ["p3"], paths: ["src/b.ts", "src/new.ts"] },
    { t: "sigma", at: T + 9_100, region: "src", sigma: 0.4 },
    { t: "agent", at: T + 10_000, agentId: "a1", kind: "internal", state: "dead" },
    { t: "agent", at: T + 10_000, agentId: "a2", kind: "internal", state: "dead" },
  ];
  return list.map((e, i) => ({ ...e, seq: (i + 1) * 3 }));
}

const SNAPSHOT: ColonySnapshot = {
  colony: { id: "c", name: "Colony C", trunk: { namespace: "n", name: "t", remote: `https://${ACCOUNT}.artifacts.cloudflare.net/git/n/t.git` }, trunkSha: sha("2"), createdAt: T, regionDepth: 1, source: { url: "https://example.test/c.git", branch: "main" } },
  files: [
    { path: "src/a.ts", size: 100 },
    { path: "src/b.ts", size: 200 },
    { path: "src/new.ts", size: 300 },
    { path: "README.md", size: 50 },
  ],
  intents: [],
  rules: [{ id: "r1", colonyId: "c", kind: "forbid-pattern", spec: {}, description: "No console", approvedBy: "someone@example.test", createdAt: T + 1_000 }],
  agents: [],
  recentLandings: [],
  violations: { total: 0, byRule: { r1: 0 } },
  funnel: { proof: 2, reflex: 0, llm: 0, human: 0 },
  metrics: {},
};

const landing = (id: string, paths: string[], at: number) => ({ id, colonyId: "c", trunkSha: sha(id.slice(-1)), parentSha: sha("0"), proposalIds: ["p"], intentIds: ["i"], paths, regions: ["src"], at });
const note = (id: string) => ({ colonyId: "c", landingId: id, proposals: [], intent: { id: "i", title: "Fix" } });
const diff = (id: string, path: string) => ({ colonyId: "c", landingId: id, trunkSha: sha("1"), parentSha: sha("0"), path, before: sha("a"), after: sha("b"), status: "modified", added: 1, removed: 1, hunks: "@@ -1 +1 @@\n-a\n+b", truncated: false });

/** The deployment's public routes for colony c, as the recorder reads them; `asked` keeps every request. */
function deployment() {
  const asked: Array<{ url: string; headers: Record<string, string> }> = [];
  const all = events();
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    asked.push({ url: url.pathname + url.search, headers: { ...(init?.headers as Record<string, string>) } });
    const q = url.searchParams;
    const p = url.pathname;
    if (p === "/api/about") return json({ service: "firetrident", commit: "f9c7aad", versionId: null, versionTag: null, deployedAt: null, flags: [], noteKey: null });
    if (p === "/api/colonies/c") return json(SNAPSHOT);
    if (p === "/api/colonies/c/agents") return json({ colonyId: "c", total: 2, agents: [{ id: "a1", name: "ant-one", kind: "internal", token: "art_v1_shouldnevershow", note: `came in with Bearer abcdefghijklmnop and ${ACCESS_SECRET}` }, { id: "a2", name: "ant-two", kind: "internal" }] });
    if (p === "/api/colonies/c/events") {
      const after = Number(q.get("after") ?? 0);
      const limit = Number(q.get("limit") ?? 1000);
      const rest = all.filter((e) => e.seq > after);
      const page = rest.slice(0, limit);
      return json({ colonyId: "c", source: "recorded", events: page, next: rest.length > limit ? (page[page.length - 1]?.seq ?? null) : null, total: all.length, first: T + 1_000, last: T + 10_000 });
    }
    if (p === "/api/colonies/c/why") {
      const path = q.get("path");
      if (path === "src/a.ts") return json([{ landing: landing("l1", ["src/a.ts"], T + 5_000), note: note("l1") }]);
      if (path === "src/b.ts" || path === "src/new.ts") return json([{ landing: landing("l2", ["src/b.ts", "src/new.ts"], T + 9_000), note: note("l2") }]);
      return json([]);
    }
    if (p === "/api/colonies/c/notes/verify") {
      const id = q.get("landing") ?? "";
      return json({ colonyId: "c", notesTip: sha("9"), notes: [{ landingId: id, trunkSha: sha("1"), at: T, status: "intact" }] });
    }
    const d = /^\/api\/colonies\/c\/landings\/([^/]+)\/diff$/.exec(p);
    if (d?.[1]) {
      const path = q.get("path") ?? "";
      if (path === "src/new.ts") return json({ error: "the change of a file the landing created is not shown here" }, 404);
      if (path === "src/b.ts") return json({ error: "trunk is not answering" }, 503);
      return json(diff(d[1], path));
    }
    if (p === "/api/colonies/c/certifications") return json({ colonyId: "c", certifications: [] });
    if (p === "/api/colonies/c/decide/policy") return json({ enabled: true, protectedPaths: ["src/auth/**"] });
    return json({ error: `no route for GET ${p}` }, 404);
  });
  return { fetcher, asked };
}

async function record(extra: Partial<Parameters<typeof recordColony>[0]> = {}) {
  const d = deployment();
  const result = await recordColony({
    base: BASE,
    colonyId: "c",
    headers: { "CF-Access-Client-Id": ACCESS_ID, "CF-Access-Client-Secret": ACCESS_SECRET },
    fetch: d.fetcher as unknown as typeof fetch,
    pageSize: 7,
    retryMs: 0,
    extraReads: ["/certifications?limit=50", ""],
    now: () => new Date(T + 60_000),
    ...extra,
  });
  return { ...d, result };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("the recorder (scripts/record_colony.ts)", () => {
  it("pages through the event record and keeps every read the replay, the Why tab and the tour make", async () => {
    const { result, asked } = await record();
    const rec = result.recording;
    expect(rec.record.events.map((e) => e.seq)).toEqual(events().map((e) => e.seq));
    expect(result.pages).toBe(5);
    // Each page asks after the last sequence number of the one before.
    const afters = asked.filter((a) => a.url.startsWith("/api/colonies/c/events")).map((a) => new URLSearchParams(a.url.split("?")[1]).get("after"));
    expect(afters).toEqual(["0", "21", "42", "63", "84"]);
    for (const key of [
      "/api/about",
      "/api/colonies/c",
      "/api/colonies/c/agents?all=1&journal=0&limit=10000",
      "/api/colonies/c/decide/policy",
      "/api/colonies/c/certifications?limit=50",
      "/api/colonies/c/why?path=src%2Fa.ts",
      "/api/colonies/c/why?path=src%2Fnew.ts",
      "/api/colonies/c/why?path=README.md",
      "/api/colonies/c/notes/verify?landing=l1",
      "/api/colonies/c/notes/verify?landing=l2",
      "/api/colonies/c/landings/l1/diff?path=src%2Fa.ts",
    ]) {
      expect(rec.reads, key).toHaveProperty([key]);
    }
    // A refusal is kept with its sentence; a read that failed twice is listed, not recorded.
    expect(rec.refused["/api/colonies/c/landings/l2/diff?path=src%2Fnew.ts"]).toEqual({ status: 404, error: "the change of a file the landing created is not shown here" });
    expect(result.failed).toEqual(["GET /api/colonies/c/landings/l2/diff?path=src%2Fb.ts: 503: trunk is not answering"]);
    expect(rec.reads).not.toHaveProperty(["/api/colonies/c/landings/l2/diff?path=src%2Fb.ts"]);
    // The access headers went with every request, and only GETs were made.
    expect(asked.every((a) => a.headers["CF-Access-Client-Id"] === ACCESS_ID && a.headers["CF-Access-Client-Secret"] === ACCESS_SECRET)).toBe(true);
    expect(asked.every((a) => !("authorization" in a.headers) && !("Authorization" in a.headers))).toBe(true);
  });

  it("writes no header, token, account id, email or deployment address into the file", async () => {
    const { result } = await record();
    const text = JSON.stringify(result.recording);
    for (const secret of [ACCESS_ID, ACCESS_SECRET, "art_v1_shouldnevershow", "abcdefghijklmnop", ACCOUNT, "someone@example.test", "staging.example.test"]) expect(text).not.toContain(secret);
    const agents = result.recording.reads["/api/colonies/c/agents?all=1&journal=0&limit=10000"] as { agents: Array<Record<string, unknown>> };
    expect(agents.agents[0]).not.toHaveProperty("token");
    expect(agents.agents[0]?.note).toBe("came in with Bearer <redacted> and <redacted>");
    expect(text).toContain("artifacts://");
    // Model token counts are not secrets.
    expect(scrub({ usage: { inputTokens: 628, outputTokens: 24 }, accessToken: "x" })).toEqual({ usage: { inputTokens: 628, outputTokens: 24 } });
  });

  it("caps the reads besides the record, the lineage of landed files first", async () => {
    const { result } = await record({ maxReads: 3, extraReads: [] });
    expect(Object.keys(result.recording.reads).filter((k) => k.includes("/why?"))).toHaveLength(3);
    expect(result.recording.reads).not.toHaveProperty(["/api/colonies/c/why?path=README.md"]);
    expect(result.skipped).toBeGreaterThan(0);
  });

  it("refuses to record without a snapshot, and when the deployment sends a sign-in page", async () => {
    const page = vi.fn(async () => new Response("<!doctype html><title>Sign in</title>", { status: 200, headers: { "content-type": "text/html" } }));
    await expect(recordColony({ base: BASE, colonyId: "c", fetch: page as unknown as typeof fetch, retryMs: 0 })).rejects.toThrow(/a page came back, not JSON .*CF_ACCESS_CLIENT_ID/);
  });

  it("takes header values from the environment and refuses tokens on the command line", () => {
    const env = { CF_ACCESS_CLIENT_ID: ACCESS_ID, CF_ACCESS_CLIENT_SECRET: ACCESS_SECRET, MY_SECRET: "s3cr3t-value" };
    expect(requestHeaders([], env).headers).toEqual({ "CF-Access-Client-Id": ACCESS_ID, "CF-Access-Client-Secret": ACCESS_SECRET });
    expect(requestHeaders(["X-Trace: demo", "X-Api-Secret: env:MY_SECRET"], { MY_SECRET: "s3cr3t-value" }).headers).toEqual({ "X-Trace": "demo", "X-Api-Secret": "s3cr3t-value" });
    expect(requestHeaders(["CF-Access-Client-Id: env:CF_ACCESS_CLIENT_ID", "CF-Access-Client-Secret: env:CF_ACCESS_CLIENT_SECRET"], env).values).toEqual([ACCESS_ID, ACCESS_SECRET]);
    expect(() => requestHeaders(["Authorization: env:MY_SECRET"], env)).toThrow(UsageError);
    expect(() => requestHeaders([`CF-Access-Client-Secret: ${ACCESS_SECRET}`], env)).toThrow(/env:<VAR>/);
    expect(() => requestHeaders(["X-Api-Secret: env:NOT_SET"], env)).toThrow(/NOT_SET is not set/);
  });
});

/** The page's browser surface a replay touches, with no frame ever drawn. */
function stubPage() {
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("document", { hidden: false });
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
}

describe("playback with no network", () => {
  it("answers every read the replay makes from the recording, with fetch stubbed to throw", async () => {
    const { result } = await record();
    // Through the file the recorder writes, compressed, as the page loads it.
    const rec = await readRecording(encodeRecording(result.recording, "c.json.gz"));
    expect(rec).toEqual(result.recording);
    const network = vi.fn(() => {
      throw new Error("the network was used");
    });
    vi.stubGlobal("fetch", network);
    stubPage();
    const restore = installRecording(rec);
    try {
      const store = new ColonyStore("c");
      const backend = new ReplayBackend("c");
      backend.start(store);
      await vi.waitFor(() => expect(backend.state.ready).toBe(true));
      expect(backend.state.events).toBe(30);
      expect(store.conn).toBe("replay");
      expect(store.agentNames.get("a1")).toBe("ant-one");
      expect((await backend.why("src/a.ts")).map((e) => e.landing.id)).toEqual(["l1"]);
      expect((await backend.verifyNote("l2"))?.status).toBe("intact");
      expect((await backend.landingDiff("l1", "src/a.ts")).hunks).toContain("+b");
      const refused = await backend.landingDiff("l2", "src/new.ts").catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(ReadError);
      expect((refused as ReadError).message).toBe("The change of a file the landing created is not shown here.");
      expect((await fetchAbout(fetch))?.commit).toBe("f9c7aad");
      const tour = await fetch("/api/colonies/c/certifications?limit=50");
      expect(await tour.json()).toEqual({ colonyId: "c", certifications: [] });
      backend.stop();
      expect(network).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("answers a read it does not hold at once with a calm not-in-this-recording, never the network", async () => {
    const { result } = await record();
    const network = vi.fn(() => {
      throw new Error("the network was used");
    });
    vi.stubGlobal("fetch", network);
    stubPage();
    const restore = installRecording(result.recording);
    try {
      const started = performance.now();
      const res = await fetch("/api/colonies/c/why?path=src%2Fnot-recorded.ts");
      expect(performance.now() - started).toBeLessThan(50);
      expect(res.status).toBe(404);
      expect(res.statusText).toBe("Not in this recording");
      expect(((await res.json()) as { error: string }).error).toMatch(/^Not in this recording: GET \/api\/colonies\/c\/why\?path=src%2Fnot-recorded\.ts\./);
      // As each part of the page shows it: the Why tab, a note badge, a line's lineage.
      const backend = new ReplayBackend("c");
      const why = await backend.why("src/not-recorded.ts").catch((e: unknown) => e);
      expect(why).toBeInstanceOf(HttpError);
      expect((why as HttpError).message).toBe("404 Not in this recording");
      const check = await backend.verifyNote("l9").catch((e: unknown) => e);
      expect((check as ReadError).message).toMatch(/^Not in this recording: GET \/api\/colonies\/c\/notes\/verify\?landing=l9\./);
      expect((await fetch("/api/colonies/c/why?line=3&path=src%2Fa.ts")).status).toBe(404);
      // Nothing can be changed in a recording.
      const post = await fetch("/api/colonies/c/review/p1", { method: "POST", body: "{}" });
      expect(post.status).toBe(405);
      expect(network).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("answers the colony in the address bar as the recorded one, cuts pages as the colony does, and leaves other origins alone", async () => {
    const { result } = await record();
    const rec: Recording = result.recording;
    const page = answerRead(rec, "GET", "/api/colonies/other/events", "?after=21&limit=4", "other");
    expect(page.hit).toBe(true);
    expect((page.body as { events: RecordedEvent[]; next: number | null }).events.map((e) => e.seq)).toEqual([24, 27, 30, 33]);
    expect((page.body as { next: number | null }).next).toBe(33);
    expect((answerRead(rec, "GET", "/api/colonies/c/events", "?after=84&limit=5000").body as { next: number | null }).next).toBeNull();
    expect(answerRead(rec, "GET", "/api/colonies/c/events", "?source=reconstructed").hit).toBe(false);
    expect(answerRead(rec, "GET", "/api/colonies/other", "", "other").hit).toBe(true);
    expect(answerRead(rec, "GET", "/api/colonies/c/why", "?path=src%2Fa.ts").hit).toBe(true);
    expect(keyOf("/api/colonies/c/agents?limit=10000&journal=0&all=1")).toBe("/api/colonies/c/agents?all=1&journal=0&limit=10000");
    const elsewhere = vi.fn(async () => new Response("asset"));
    const shim = recordingFetch(rec, { fallback: elsewhere as unknown as typeof fetch, origin: "https://firetrident.example" });
    expect(await (await shim("/assets/index.js")).text()).toBe("asset");
    expect(await (await shim("https://other.example/api/colonies/c")).text()).toBe("asset");
    expect((await shim("https://firetrident.example/api/colonies/c")).status).toBe(200);
    expect(elsewhere).toHaveBeenCalledTimes(2);
  });

  it("loads a bundled recording, gzip or not, past the page a server sends for a path it has nothing at", async () => {
    const { result } = await record();
    const gz = encodeRecording(result.recording, "c.json.gz");
    const html = () => new Response("<!doctype html><html></html>", { headers: { "content-type": "text/html" } });
    const served = (files: Record<string, Uint8Array | null>) =>
      vi.fn(async (input: RequestInfo | URL) => {
        const body = files[String(input)];
        return body ? new Response(body as Uint8Array<ArrayBuffer>) : html();
      }) as unknown as typeof fetch;
    expect((await loadBundledRecording("c", served({ "/recordings/c.json.gz": gz }))).colonyId).toBe("c");
    expect((await loadBundledRecording("c", served({ "/recordings/c.json": encodeRecording(result.recording, "c.json") }))).record.events).toHaveLength(30);
    await expect(loadBundledRecording("c", served({}))).rejects.toThrow("No recording named “c” is bundled with this page (looked for /recordings/c.json.gz and /recordings/c.json).");
    await expect(loadBundledRecording("../etc", served({}))).rejects.toThrow(/is not a recording name/);
    await expect(readRecording(new TextEncoder().encode(JSON.stringify({ format: "firetrident-recording", version: 9, colonyId: "c", record: { events: [] } })))).rejects.toThrow(/newer FireTrident/);
    await expect(readRecording(new TextEncoder().encode("{}"))).rejects.toThrow("This file is not a FireTrident recording.");
  });

  it("is asked for with ?recording=, which implies a replay", () => {
    expect(parseRoute("/c/hono", "?replay=1&recording=hono")).toMatchObject({ colonyId: "hono", recording: "hono", replay: { source: "auto" } });
    expect(parseRoute("/c/hono", "?director=1&recording=hono")).toMatchObject({ director: true, recording: "hono", replay: { speed: 1 } });
    expect(parseRoute("/c/hono", "?recording")).toMatchObject({ recording: "", replay: { source: "auto" } });
    expect(parseRoute("/c/hono", "?recording=hono&mock=1")).toMatchObject({ recording: null, replay: null });
    expect(parseRoute("/c/hono", "?replay=1")).toMatchObject({ recording: null });
    expect(colonyHref("hono", { recording: "hono" })).toBe("/c/hono?replay=1&recording=hono");
    expect(colonyHref("hono", { tour: true, recording: "hono" })).toBe("/c/hono?tour=1&recording=hono");
    expect(colonyHref("hono", { replay: true })).toBe("/c/hono?replay=1");
  });
});
