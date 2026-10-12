import { describe, expect, it } from "vitest";
import { Recorder, quantile, summarize, table } from "../src/stats.ts";
import { SYNTHETIC_NOTE, fakeSha, formatReport, parseOptions, proposalBody, runBench, writePaths } from "../src/swarm.ts";
import type { Options } from "../src/swarm.ts";

describe("stats", () => {
  it("computes nearest-rank quantiles", () => {
    const s = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(quantile(s, 0.5)).toBe(50);
    expect(quantile(s, 0.99)).toBe(99);
    expect(quantile(s, 1)).toBe(100);
    expect(quantile([], 0.5)).toBeNull();
    expect(summarize([3, 1, 2])).toMatchObject({ n: 3, min: 1, p50: 2, max: 3, mean: 2 });
  });

  it("records latencies and errors per op", () => {
    const r = new Recorder();
    r.record("take", 10);
    r.error("take", 30, "500 boom");
    r.error("take", 31, "500 boom");
    expect(r.ops()).toEqual(["take"]);
    expect(r.summary("take").n).toBe(3);
    expect(r.errors("take")).toBe(2);
    expect(r.errorSamples).toEqual(["take: 500 boom"]);
  });

  it("aligns tables", () => {
    expect(table([["op", "n"], ["take", 12], ["propose", 3]])).toBe("op        n\ntake     12\npropose   3");
  });
});

describe("options and fake proposals", () => {
  it("parses flags and env", () => {
    const o = parseOptions(["--url", "https://x.dev/", "--colony", "c1", "--agents", "40", "--duration", "5"], { FT_TOKEN: "t" });
    expect(o).toMatchObject({ url: "https://x.dev", colony: "c1", agents: 40, durationS: 5, rampS: 2, token: "t", readSet: false });
    expect(() => parseOptions(["--colony", "c"], {})).toThrow(/--url is required/);
    expect(() => parseOptions(["--url", "https://x", "--colony", "c", "--agents", "0"], {})).toThrow(/--agents/);
  });

  it("builds write sets from literal footprints, or a file under the static prefix", () => {
    expect(writePaths(["src/a.ts", "src/"], "agt_123456789")).toEqual(["src/a.ts"]);
    expect(writePaths(["src/"], "agt_123456789")).toEqual(["src/bench-23456789.txt"]);
    expect(writePaths(["src/**/*.ts"], "agt_123456789")).toEqual(["src/bench-23456789.txt"]);
    expect(writePaths(["**/*.md"], "agt_123456789")).toEqual(["bench-23456789.txt"]);
  });

  it("makes valid-looking proposal bodies with fake 40-hex ids", () => {
    const lease = { repo: { namespace: "ft-ws-0", name: "c--ws-0", remote: "https://r" }, token: "", tokenExpiresAt: 0, baseSha: "b".repeat(40), leasedAt: 0, trunk: { remote: "", token: "", sha: "" } };
    const intent = { id: "int_1", footprint: ["src/a.ts"] } as never;
    const body = proposalBody("agt_1", { intent, lease }, true, 1) as Record<string, any>;
    expect(body.headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(body.writeSet).toEqual([{ path: "src/a.ts", blob: fakeSha("blob", "agt_1", "int_1", "src/a.ts", "1") }]);
    expect(body.readSet).toHaveLength(1);
    expect(body.evidence.notVerified).toBe(SYNTHETIC_NOTE);
  });
});

describe("runBench", () => {
  it("drives register, take, propose and heartbeat against a fake server and reports rates", async () => {
    let landings = 0;
    let open = 6;
    const calls: string[] = [];
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const path = url.pathname.replace("/api/colonies/col", "");
      calls.push(`${init?.method} ${path}`);
      const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
      if (path === "") return json({ metrics: { landings, landedProposals: landings }, recentLandings: [] });
      if (path === "/agents") return json({ id: `agt_${calls.length}` }, 201);
      if (path.endsWith("/heartbeat")) return json({ ok: true });
      if (path.endsWith("/take")) {
        if (open <= 0) return json({ wait: true, retryInMs: 20, reason: "no open intents" });
        open--;
        return json({ intent: { id: `int_${open}`, footprint: [`src/f${open}.ts`] }, lease: { repo: { namespace: "ft-ws-0", name: "w", remote: "https://w" }, baseSha: "a".repeat(40) } });
      }
      if (path === "/proposals") {
        const body = JSON.parse(String(init?.body));
        if (!/^[0-9a-f]{40}$/.test(body.headSha)) return json({ error: "bad sha" }, 400);
        landings++;
        return json({ id: `prp_${landings}`, status: "ready" }, 201);
      }
      return json({ error: "no route" }, 404);
    }) as typeof fetch;
    const opts: Options = { url: "https://ft.test", colony: "col", agents: 3, durationS: 0.3, rampS: 0, heartbeatMs: 100, workMs: 0, readSet: false, timeoutMs: 5000, json: false };
    const r = await runBench(opts, fakeFetch);
    expect(r.counts).toMatchObject({ registered: 3, assigned: 6, proposals: 6 });
    expect(r.counts.waits).toBeGreaterThan(0);
    expect(r.landings).toMatchObject({ before: 0, after: 6, source: "snapshot metrics.landings" });
    expect(r.rates.landingsPerMin).toBeGreaterThan(0);
    expect(r.ops.map((o) => o.op)).toEqual(expect.arrayContaining(["snapshot", "register", "take", "propose"]));
    const text = formatReport(r);
    expect(text.startsWith("FireTrident coordination benchmark\n" + SYNTHETIC_NOTE)).toBe(true);
    expect(text.trimEnd().endsWith(SYNTHETIC_NOTE)).toBe(true);
    expect(text).toContain("landings/min");
  });
});
