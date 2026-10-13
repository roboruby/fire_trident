import { describe, expect, it, vi } from "vitest";
import type { Path, Proposal } from "@fire_trident/core";
import { landed, withPublisher, type Publisher } from "./publisher.ts";

/**
 * Asynchronous publishing (FT_ASYNC_PUBLISH) in the real trunk writer, cycle after cycle (publisher.ts: TrunkDO over a
 * Durable Object's storage, the trunk repository a fake whose main moves only by compare-and-swap).
 */

const FILES: Record<Path, string> = {
  "src/a.ts": "export const a = 1;\n",
  "src/b.ts": "export const b = 1;\n",
  "src/c.ts": "export const c = 1;\n",
  "README.md": "# publish\n",
};

/** Poll until `check` holds (background publishing), at most `ms`. */
async function waitFor(check: () => boolean, ms = 3_000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 2));
  }
}

const edit = (w: Publisher, path: Path, text: string): Promise<Proposal> => w.proposal({ [path]: text });

describe("asynchronous publishing in the trunk writer (FT_ASYNC_PUBLISH)", () => {
  it("records a landing and answers its lane before the push, then publishes it and starts its note", async () => {
    await withPublisher(FILES, { publish: "on" }, async (w) => {
      w.remote.plan.push("held");
      const l = landed(await w.land(await edit(w, "src/a.ts", "export const a = 2;\n")));
      // Recorded is landed: the lane has its answer and trunk's head moved; main has not.
      expect(w.head()).toBe(l.trunkSha);
      expect(w.remote.main).toBe(w.initial);
      expect(w.journal("recorded")).toEqual([l.id]);
      expect(await w.trunk.landingsOf(l.proposalIds)).toEqual({ [l.proposalIds[0]!]: l });
      expect(await w.publishState()).toMatchObject({ on: true, publishedSha: w.initial, trunkSha: l.trunkSha, unpublished: 1, failures: 0 });
      // The cycle did not push; its stat names the publish queue as it ended.
      const stat = (await w.trunk.stats()).recentCycles.at(-1)!;
      expect(stat.ms.push).toBeUndefined();
      expect(stat.publish).toEqual({ publishedSha: w.initial, unpublished: 1, lagMs: expect.any(Number) });
      // No note goes out for a commit the trunk repository does not have.
      expect(w.notes.some((n) => n.has(l.id))).toBe(false);
      // The push goes on: main moves to the landing, its row waits for its note, and the notes flush starts.
      await waitFor(() => w.remote.waiting() === 1);
      w.remote.release();
      await w.settle();
      expect(w.remote.moves).toEqual([{ from: w.initial, to: l.trunkSha, objects: 4 }]);
      expect(w.journal("recorded")).toEqual([]);
      expect(w.journal("pending_note")).toEqual([l.id]);
      expect(w.notes.at(-1)?.has(l.id)).toBe(true);
      expect(await w.publishState()).toMatchObject({ publishedSha: l.trunkSha, trunkSha: l.trunkSha, unpublished: 0, lagMs: 0, publishedAt: expect.any(Number) });
    });
  });

  it("answers its own reads for a commit not published yet from its store", async () => {
    await withPublisher(FILES, { publish: "on" }, async (w) => {
      w.remote.plan.push("held");
      const p = await edit(w, "src/b.ts", "export const b = 2;\n");
      const l = landed(await w.land(p));
      const blob = p.writeSet[0]!.blob!;
      expect(await w.trunk.baseBlobs(l.trunkSha, ["src/b.ts"])).toEqual([{ path: "src/b.ts", blob }]);
      expect(await w.trunk.blobsFor(["src/b.ts"])).toEqual({ "src/b.ts": blob });
      expect(await w.trunk.readBlobs([blob])).toEqual({ [blob]: "export const b = 2;\n" });
      expect(await w.trunk.readFile("src/b.ts")).toBe("export const b = 2;\n");
      expect((await w.trunk.files()).find((f) => f.path === "src/b.ts")?.blob).toBe(blob);
      expect((await w.trunk.why("src/b.ts")).map((x) => x.landing.id)).toEqual([l.id]);
      // Certification runs on the recorded head.
      expect((await w.trunk.certifySnapshot()).trunkSha).toBe(l.trunkSha);
      expect(w.remote.main).toBe(w.initial);
      w.remote.release();
      await w.settle();
    });
  });

  it("batches every commit recorded since the last push into the next one, in order", async () => {
    await withPublisher(FILES, { publish: "on" }, async (w) => {
      w.remote.plan.push("held");
      const l1 = landed(await w.land(await edit(w, "src/a.ts", "1")));
      await waitFor(() => w.remote.waiting() === 1);
      const l2 = landed(await w.land(await edit(w, "src/b.ts", "2")));
      const l3 = landed(await w.land(await edit(w, "README.md", "3")));
      expect([l2.parentSha, l3.parentSha]).toEqual([l1.trunkSha, l2.trunkSha]);
      expect(await w.publishState()).toMatchObject({ publishedSha: w.initial, unpublished: 3 });
      w.remote.release();
      await w.settle();
      // One push for the first landing, one for the two recorded while it ran (their new objects together).
      expect(w.remote.moves.map((m) => [m.from, m.to])).toEqual([
        [w.initial, l1.trunkSha],
        [l1.trunkSha, l3.trunkSha],
      ]);
      expect(w.remote.moves.map((m) => m.objects)).toEqual([4, 7]);
      expect(w.publishedOrder()).toEqual([l1.trunkSha, l2.trunkSha, l3.trunkSha]);
      expect(w.journal("pending_note")).toEqual([l1.id, l2.id, l3.id]);
    });
  });

  it("retries a failed push with backoff, logging each failure and showing it in its state", async () => {
    await withPublisher(FILES, { publish: "on" }, async (w) => {
      const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        w.remote.plan.push("fail", "held", "refuse", "fail");
        const l = landed(await w.land(await edit(w, "src/a.ts", "2")));
        await waitFor(() => w.remote.waiting() === 1);
        const failing = await w.publishState();
        expect(failing).toMatchObject({ failures: 1, unpublished: 1, publishedSha: w.initial });
        expect(failing.lastError).toMatch(/publish push failed: network: connection reset before the update/);
        // The held attempt is the second; it lands.
        w.remote.release();
        await w.settle();
        expect(w.remote.attempts).toBe(2);
        expect(w.publishedOrder()).toEqual([l.trunkSha]);
        // The next landing meets a refusal and a failure before its push lands.
        const l2 = landed(await w.land(await edit(w, "src/b.ts", "2")));
        await w.settle();
        expect(w.remote.attempts).toBe(5);
        expect(w.publishedOrder()).toEqual([l.trunkSha, l2.trunkSha]);
        const logged = errors.mock.calls
          .map((c) => String(c[0]))
          .filter((s) => s.includes('"trunk-publish-failed"'))
          .map((s) => JSON.parse(s) as { failures: number; error: string; retryInMs: number });
        expect(logged.map((f) => f.failures)).toEqual([1, 1, 2]);
        expect(logged[1]!.error).toMatch(/publish push rejected: unpack error/);
        expect(await w.publishState()).toMatchObject({ failures: 0, unpublished: 0 });
        expect((await w.publishState()).lastError).toBeUndefined();
      } finally {
        errors.mockRestore();
      }
    });
  });

  it("settles a push whose answer was lost from where main is, and never pushes those commits again", async () => {
    await withPublisher(FILES, { publish: "on" }, async (w) => {
      const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        // Main moved and the answer was lost: the writer asks where main is and records the publish.
        w.remote.plan.push("lost");
        const l1 = landed(await w.land(await edit(w, "src/a.ts", "1")));
        await w.settle();
        expect(w.remote.attempts).toBe(1);
        expect(w.journal("recorded")).toEqual([]);
        // Lost again, and where main is cannot be learned either: the next attempt's compare-and-swap finds main
        // already there and settles from it, without moving it again.
        w.remote.plan.push("lost");
        w.remote.headFails = true;
        const l2 = landed(await w.land(await edit(w, "src/b.ts", "2")));
        await w.settle();
        expect(w.remote.attempts).toBe(3);
        expect(w.remote.moves.map((m) => m.to)).toEqual([l1.trunkSha, l2.trunkSha]);
        expect(w.publishedOrder()).toEqual([l1.trunkSha, l2.trunkSha]);
        expect(await w.publishState()).toMatchObject({ publishedSha: l2.trunkSha, unpublished: 0, failures: 0 });
      } finally {
        errors.mockRestore();
      }
    });
  });

  it("after a restart mid-publish, publishes every recorded commit before anything else, each once", async () => {
    for (const hang of ["hang", "hang-after"] as const) {
      await withPublisher(FILES, { publish: "on" }, async (w) => {
        // The push hangs (before reaching main, or after it moved main) and the object goes away.
        w.remote.plan.push(hang);
        const l1 = landed(await w.land(await edit(w, "src/a.ts", "1")));
        const l2 = landed(await w.land(await edit(w, "src/b.ts", "2")));
        await waitFor(() => w.remote.hung === 1);
        expect(w.remote.main).toBe(hang === "hang" ? w.initial : l1.trunkSha);
        w.restart();
        // The next writer's first cycle publishes the backlog before it records its own landing.
        const seen: number[] = [];
        w.remote.onPush = () => seen.push(w.landingCommits().length);
        const l3 = landed(await w.land(await edit(w, "src/c.ts", "3")));
        expect(seen[0]).toBe(2);
        expect(w.journal("recorded")).toEqual([l3.id]);
        await w.settle();
        expect(w.publishedOrder()).toEqual([l1.trunkSha, l2.trunkSha, l3.trunkSha]);
        expect(w.remote.moves.map((m) => m.to)).toEqual(hang === "hang" ? [l2.trunkSha, l3.trunkSha] : [l1.trunkSha, l2.trunkSha, l3.trunkSha]);
      });
    }
  });

  it("publishes what waits from the alarm after a restart, with no cycle to come", async () => {
    await withPublisher(FILES, { publish: "on" }, async (w) => {
      w.remote.plan.push("hang");
      const l1 = landed(await w.land(await edit(w, "src/a.ts", "1")));
      await waitFor(() => w.remote.hung === 1);
      expect(w.alarms.length).toBeGreaterThan(0);
      w.restart();
      await w.trunk.alarm();
      expect(w.publishedOrder()).toEqual([l1.trunkSha]);
      expect(w.journal("recorded")).toEqual([]);
    });
  });

  it("writes nothing from a publish that outlives its erased trunk", async () => {
    await withPublisher(FILES, { publish: "on" }, async (w) => {
      w.remote.plan.push("held");
      landed(await w.land(await edit(w, "src/a.ts", "1")));
      await waitFor(() => w.remote.waiting() === 1);
      await w.trunk.destroy();
      w.remote.release();
      await waitFor(() => w.remote.moves.length === 1);
      await new Promise((r) => setTimeout(r, 20));
      expect(w.rows("SELECT key FROM ft_meta")).toEqual([]);
      expect(w.rows("SELECT landing_id FROM ft_journal")).toEqual([]);
      expect(await w.trunk.stats()).toMatchObject({ trunkSha: null, unpublished: 0 });
    });
  });

  it("gives leases' bases from the published head: a commit main has, never one only recorded", async () => {
    await withPublisher(FILES, { publish: "on" }, async (w) => {
      w.remote.plan.push("held");
      const l1 = landed(await w.land(await edit(w, "src/a.ts", "1")));
      const l2 = landed(await w.land(await edit(w, "src/b.ts", "2")));
      const s = await w.publishState();
      expect(s.publishedSha).toBe(w.remote.main);
      expect(s.trunkSha).toBe(l2.trunkSha);
      expect((await w.trunk.stats()).publishedSha).toBe(w.initial);
      w.remote.release();
      // While publishing goes on, every answer names a commit main has held.
      const held = (): string[] => [w.initial, ...w.remote.moves.map((m) => m.to)];
      for (let i = 0; i < 20; i++) {
        expect(held()).toContain((await w.publishState()).publishedSha);
        await new Promise((r) => setTimeout(r, 1));
      }
      await w.settle();
      expect((await w.publishState()).publishedSha).toBe(l2.trunkSha);
      expect(w.publishedOrder()).toEqual([l1.trunkSha, l2.trunkSha]);
    });
  });

  it("moves `certified` only to published commits: a recorded one waits for its publish, the newest wins", async () => {
    await withPublisher(FILES, { publish: "on" }, async (w) => {
      w.remote.plan.push("held");
      const l1 = landed(await w.land(await edit(w, "src/a.ts", "1")));
      const l2 = landed(await w.land(await edit(w, "src/b.ts", "2")));
      // Certification ran on the recorded head and found it green: nothing moves yet.
      expect(await w.trunk.markCertified(l2.trunkSha)).toBe(false);
      expect(await w.trunk.markCertified(l1.trunkSha)).toBe(false);
      expect(w.certifiedPushes).toEqual([]);
      await waitFor(() => w.remote.waiting() === 1);
      w.remote.release();
      await w.settle();
      await waitFor(() => w.remote.certified === l2.trunkSha);
      expect(w.certifiedPushes).toEqual([{ expectedOld: null, sha: l2.trunkSha }]);
      // A published commit moves it at once.
      const l3 = landed(await w.land(await edit(w, "src/c.ts", "3")));
      await w.settle();
      expect(await w.trunk.markCertified(l3.trunkSha)).toBe(true);
      expect(w.remote.certified).toBe(l3.trunkSha);
    });
  });

  it("builds system commits on the recorded head and publishes them in order with the landings", async () => {
    await withPublisher(FILES, { publish: "on" }, async (w) => {
      w.remote.plan.push("held");
      const l1 = landed(await w.land(await edit(w, "src/a.ts", "1")));
      const sys = await w.systemCommit(".firetrident/antibodies/ab_1.json", '{"id":"ab_1"}\n');
      expect(sys.parentSha).toBe(l1.trunkSha);
      const l2 = landed(await w.land(await edit(w, "src/b.ts", "2")));
      expect(l2.parentSha).toBe(sys.trunkSha);
      expect(w.remote.main).toBe(w.initial);
      w.remote.release();
      await w.settle();
      expect(w.publishedOrder()).toEqual([l1.trunkSha, sys.trunkSha, l2.trunkSha]);
      expect(w.journal("pending_note")).toEqual([l1.id, sys.id, l2.id]);
    });
  });

  it("holds a cycle past the bound until publishing catches up", async () => {
    // By count: two landings wait. By age: the oldest waiting landing is past the limit.
    for (const by of ["count", "age"] as const) {
      const bound = by === "count" ? { landings: 2, ageMs: 60_000, waitMs: 5_000 } : { landings: 100, ageMs: 50, waitMs: 5_000 };
      await withPublisher(FILES, { publish: "on", bound }, async (w) => {
        w.remote.plan.push("held");
        landed(await w.land(await edit(w, "src/a.ts", "1")));
        await waitFor(() => w.remote.waiting() === 1);
        if (by === "count") landed(await w.land(await edit(w, "src/b.ts", "2")));
        else await new Promise((r) => setTimeout(r, 80));
        const before = w.landingCommits().length;
        let done = false;
        const waiting = w.land(await edit(w, "src/c.ts", "3")).then((r) => {
          done = true;
          return r;
        });
        await new Promise((r) => setTimeout(r, 80));
        expect(done).toBe(false);
        expect(w.landingCommits().length).toBe(before);
        w.remote.release();
        const l = landed(await waiting);
        expect((await w.trunk.stats()).recentCycles.at(-1)!.ms.publishWait).toBeGreaterThanOrEqual(80);
        await w.settle();
        expect(w.publishedOrder().at(-1)).toBe(l.trunkSha);
      });
    }
  });

  it("fails a cycle past the bound when publishing cannot catch up, recording nothing of it", async () => {
    await withPublisher(FILES, { publish: "on", bound: { landings: 2, ageMs: 60_000, waitMs: 150 } }, async (w) => {
      const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        w.remote.fallback = () => "fail";
        const l1 = landed(await w.land(await edit(w, "src/a.ts", "1")));
        const l2 = landed(await w.land(await edit(w, "src/b.ts", "2")));
        const late = await edit(w, "src/c.ts", "3");
        await expect(w.land(late)).rejects.toThrow(/publishing is behind: 2 landing\(s\) recorded and not published/);
        expect(w.landingCommits()).toEqual([l1.trunkSha, l2.trunkSha]);
        expect(await w.trunk.landingsOf([late.id])).toEqual({});
        expect(w.remote.moves).toEqual([]);
        // Publishing comes back: the backlog goes out and the change lands when its lane sends it again.
        w.remote.fallback = null;
        await w.settle();
        const l3 = landed(await w.land(late));
        await w.settle();
        expect(w.publishedOrder()).toEqual([l1.trunkSha, l2.trunkSha, l3.trunkSha]);
      } finally {
        errors.mockRestore();
      }
    });
  });

  it("names a landing recorded before a change of direction at the fence, published or not", async () => {
    await withPublisher(FILES, { publish: "on" }, async (w) => {
      w.remote.plan.push("held");
      const p = await edit(w, "src/a.ts", "2");
      const l = landed(await w.land(p));
      const answer = await w.trunk.direction({ intents: { [p.intentId]: { status: "withdrawn", withdrawnReason: "not needed" } }, proposalIds: [p.id] });
      expect(answer).toEqual({ landed: [{ proposalId: p.id, landingId: l.id, trunkSha: l.trunkSha }], landings: [l], undetermined: [] });
      expect(w.remote.main).toBe(w.initial);
      // A later change for the withdrawn intent goes back at the next cycle's direction check.
      const again = { ...(await edit(w, "src/b.ts", "2")), intentId: p.intentId };
      const res = await w.land(again);
      expect(res.landing).toBeUndefined();
      expect(res.returned.map((r) => r.proposalId)).toEqual([again.id]);
      w.remote.release();
      await w.settle();
      expect(w.publishedOrder()).toEqual([l.trunkSha]);
    });
  });

  it("publishes commits recorded while publishing was asynchronous before the first cycle that pushes its own chain", async () => {
    await withPublisher(FILES, { publish: "on" }, async (w) => {
      w.remote.plan.push("hang");
      const l1 = landed(await w.land(await edit(w, "src/a.ts", "1")));
      await waitFor(() => w.remote.hung === 1);
      // A deploy turns it off: the next writer publishes l1 first, then pushes its own chain on top.
      w.restart({ publish: undefined });
      const l2 = landed(await w.land(await edit(w, "src/b.ts", "2")));
      expect(w.chainPushes).toEqual([{ parent: l1.trunkSha, tip: l2.trunkSha }]);
      expect(w.publishedOrder()).toEqual([l1.trunkSha, l2.trunkSha]);
      expect(w.journal("recorded")).toEqual([]);
    });
  });

  it("changes nothing with publishing off (absent, off, or on for another colony)", async () => {
    for (const publish of [undefined, "off", "col_other"]) {
      await withPublisher(FILES, { publish }, async (w) => {
        const l = landed(await w.land(await edit(w, "src/a.ts", "2")));
        // The cycle pushed its chain with compare-and-swap on its parent; the publish loop never ran.
        expect(w.chainPushes).toEqual([{ parent: w.initial, tip: l.trunkSha }]);
        expect(w.remote.main).toBe(l.trunkSha);
        expect(w.remote.attempts).toBe(0);
        expect(w.journal("recorded")).toEqual([]);
        // The cycle started the notes flush itself, as before.
        expect(w.notes.length).toBe(1);
        const stat = (await w.trunk.stats()).recentCycles.at(-1)!;
        expect(stat.publish).toBeUndefined();
        expect(stat.ms.publishWait).toBeUndefined();
        expect(stat.ms.push).toEqual(expect.any(Number));
        expect(await w.publishState()).toMatchObject({ on: false, publishedSha: l.trunkSha, trunkSha: l.trunkSha, unpublished: 0, running: false });
        expect(await w.trunk.markCertified(l.trunkSha)).toBe(true);
        expect(w.certifiedPushes).toEqual([{ expectedOld: null, sha: l.trunkSha }]);
      });
    }
  });
});

/** A small seeded generator (mulberry32), so a failing sequence replays from its seed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("every recorded landing is published exactly once, in order (randomized cycles, push failures and restarts)", () => {
  for (const seed of [7, 19, 31, 43, 57, 71, 83, 97]) {
    it(`seed ${seed}`, async () => {
      await withPublisher(FILES, { publish: "on", bound: { landings: 6, ageMs: 60_000, waitMs: 150 } }, async (w) => {
        const rand = rng(seed);
        const trace: string[] = [];
        const reported = new Set<string>();
        const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
        try {
          // Each push: lands, fails before main, moves main and loses the answer, or is refused; where main is cannot
          // always be learned afterwards either.
          w.remote.fallback = () => {
            w.remote.headFails = rand() < 0.2;
            const r = rand();
            return r < 0.55 ? "ok" : r < 0.7 ? "fail" : r < 0.88 ? "lost" : "refuse";
          };
          for (let step = 0; step < 40; step++) {
            const r = rand();
            if (r >= 0.4 && r < 0.5) {
              // Publishing stalls: the next push waits until a later step lets it go (possibly after its writer is gone).
              if (w.remote.waiting() === 0 && !w.remote.plan.includes("held")) w.remote.plan.unshift("held");
              trace.push(`${step}: hold the next push`);
            } else if (r < 0.4) {
              const batch: Proposal[] = [];
              const n = 1 + Math.floor(rand() * 3);
              for (let i = 0; i < n; i++) batch.push(await edit(w, `src/f${Math.floor(rand() * 8)}.ts`, `export const v = "${seed}-${step}-${i}";\n`));
              trace.push(`${step}: land ${batch.length}`);
              const before = w.landingCommits().length;
              try {
                const res = await w.land(...batch);
                for (const id of res.landing?.proposalIds ?? []) reported.add(id);
              } catch (e) {
                // A failed cycle (publishing behind, or failing after a restart) records nothing.
                trace.push(`  failed: ${(e as Error).message}`);
                expect(w.landingCommits().length).toBe(before);
              }
            } else if (r < 0.58) {
              trace.push(`${step}: system commit`);
              await w.systemCommit(`.firetrident/antibodies/ab_${step}.json`, `{"step":${step}}\n`).catch((e: unknown) => trace.push(`  failed: ${(e as Error).message}`));
            } else if (r < 0.76) {
              // A restart, mid-publish when there is something to publish: the push in flight hangs before or after main
              // moved (or is held, and goes on after its writer is gone).
              const hung = w.remote.hung;
              if (w.journal("recorded").length > 0 && w.remote.waiting() === 0 && rand() < 0.7) {
                w.remote.plan.unshift(rand() < 0.5 ? "hang" : "hang-after");
                w.kick();
                await waitFor(() => w.remote.hung > hung, 1_000).catch(() => undefined);
                w.remote.plan = w.remote.plan.filter((m) => m !== "hang" && m !== "hang-after");
              }
              trace.push(`${step}: restart${w.remote.hung > hung ? " mid-publish" : ""}`);
              w.restart();
            } else {
              trace.push(`${step}: release held pushes (${w.remote.waiting()}) and settle`);
              w.remote.release();
              await w.settle(2_000);
            }
            // At every step main moved only forward along the recorded chain (publishedOrder checks each move).
            w.publishedOrder();
          }
          // Publishing works again for good: held pushes go on (their writers may be gone), and the next writer publishes
          // everything first, then its own landing.
          w.remote.fallback = null;
          w.remote.headFails = false;
          w.remote.plan = [];
          w.remote.release();
          w.restart();
          const last = landed(await w.land(await edit(w, "README.md", `end ${seed}\n`)));
          for (const id of last.proposalIds) reported.add(id);
          await w.settle(5_000);
          expect(w.journal("recorded")).toEqual([]);
          const order = w.publishedOrder();
          expect(new Set(order).size).toBe(order.length);
          expect(order).toEqual(w.landingCommits());
          expect(w.remote.main).toBe(w.head());
          expect((await w.publishState()).publishedSha).toBe(w.head());
          // Every change a cycle answered as landed is in a published landing.
          const published = new Set(order);
          const of = await w.trunk.landingsOf([...reported]);
          for (const id of reported) expect(published.has(of[id]?.trunkSha ?? "")).toBe(true);
        } catch (e) {
          throw new Error(`seed ${seed}: ${(e as Error).message}\n${trace.join("\n")}`);
        } finally {
          errors.mockRestore();
        }
      });
    });
  }
});
