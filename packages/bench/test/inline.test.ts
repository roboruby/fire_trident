import { describe, expect, it } from "vitest";
import type { FileVersion } from "@fire_trident/core";
import { blobId, changesetId, inlineProblem } from "@fire_trident/core";
import { LIVE_INLINE_NOTE, inlineProposal, liveProposal } from "../src/live.ts";
import { INLINE_NOTE, SYNTHETIC_NOTE, parseOptions, proposalBody, runBench } from "../src/swarm.ts";
import type { Options } from "../src/swarm.ts";

/** --inline: bench proposals that carry their files' text, so the trunk writer reads no workspace. */

const lease = { repo: { namespace: "ft-ws-0", name: "c--ws-0", remote: "https://r" }, token: "", tokenExpiresAt: 0, baseSha: "b".repeat(40), leasedAt: 0, trunk: { remote: "", token: "", sha: "" } };

/** What the colony checks of an inline change: every text hashes to its blob, and the head is the changeset id. */
function expectInline(body: Record<string, unknown>): void {
  const writeSet = body.writeSet as FileVersion[];
  const contents = body.contents as Record<string, string>;
  expect(inlineProblem(writeSet, contents)).toBeNull();
  expect(body.headSha).toBe(changesetId(body.baseSha as string, writeSet));
  for (const w of writeSet) expect(blobId(contents[w.blob!]!)).toBe(w.blob);
}

describe("swarm --inline", () => {
  it("is off unless asked for", () => {
    expect(parseOptions(["--url", "https://x.dev", "--colony", "c"], {}).inline).toBe(false);
    expect(parseOptions(["--url", "https://x.dev", "--colony", "c", "--inline"], {}).inline).toBe(true);
  });

  it("makes inline changes: a short text per written file, its blob id, and the changeset id as head", () => {
    const intent = { id: "int_1", footprint: ["src/a.ts", "src/b.ts"] } as never;
    const body = proposalBody("agt_1", { intent, lease }, false, 3, true) as Record<string, unknown>;
    expectInline(body);
    expect((body.writeSet as FileVersion[]).map((w) => w.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(Object.values(body.contents as Record<string, string>)).toEqual(["synthetic bench change by agt_1 (3) at src/a.ts\n", "synthetic bench change by agt_1 (3) at src/b.ts\n"]);
    expect((body.evidence as { notVerified: string }).notVerified).toBe(INLINE_NOTE);
    // Without --inline the body is as before: fake ids, no contents.
    const plain = proposalBody("agt_1", { intent, lease }, false, 3) as Record<string, unknown>;
    expect(plain).not.toHaveProperty("contents");
    expect((plain.evidence as { notVerified: string }).notVerified).toBe(SYNTHETIC_NOTE);
  });

  it("posts inline changes and says so in the report", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    let open = 2;
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname.replace("/api/colonies/col", "");
      const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
      if (path === "") return json({ metrics: { landings: 0 }, recentLandings: [] });
      if (path === "/agents") return json({ id: "agt_1" }, 201);
      if (path.endsWith("/take")) {
        if (open <= 0) return json({ wait: true, retryInMs: 20, reason: "no open intents" });
        open--;
        return json({ intent: { id: `int_${open}`, footprint: [`bench/r00/f${open}.txt`] }, lease });
      }
      if (path === "/proposals") {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return json({ id: `prp_${bodies.length}`, status: "ready" }, 201);
      }
      return json({ error: "no route" }, 404);
    }) as typeof fetch;
    const opts: Options = { url: "https://ft.test", colony: "col", agents: 1, durationS: 0.2, rampS: 0, heartbeatMs: 100_000, workMs: 0, readSet: false, timeoutMs: 5000, json: false, inline: true };
    const r = await runBench(opts, fakeFetch);
    expect(r.note).toBe(INLINE_NOTE);
    expect(bodies).toHaveLength(2);
    for (const b of bodies) expectInline(b);
  });
});

describe("live --inline", () => {
  it("writes the same new file per intent as the live run, as an inline change", () => {
    const a = { intent: { id: "int_7", footprint: ["bench/r03/run-00007.txt"] } as never, lease };
    const body = inlineProposal("agt_9", a, 4);
    expectInline(body);
    expect(body.writeSet).toEqual([{ path: "bench/r03/run-00007.txt", blob: blobId("bench: synthetic inline landing by agt_9 (4) for int_7\n") }]);
    expect(body.workspace).toEqual(lease.repo);
    expect(body.readSet).toEqual([]);
    expect((body.evidence as { notVerified: string }).notVerified).toBe(LIVE_INLINE_NOTE);
    // The workspace path writes the same file with an existing blob and no contents.
    const pushed = liveProposal("agt_9", a, "c".repeat(40), 4);
    expect((pushed.writeSet as FileVersion[])[0]!.path).toBe("bench/r03/run-00007.txt");
    expect(pushed).not.toHaveProperty("contents");
  });
});
