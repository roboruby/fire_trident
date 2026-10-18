import { describe, expect, it } from "vitest";
import type { Sha } from "@fire_trident/core";
import { MainWalk, WALK_MAX, changedFields, layeredMain, placeOnMain, type MainCommit, type MainSource } from "../../src/trunk/onmain.ts";

/**
 * Landings against main (trunk/onmain.ts): a history of commits by id, read through a source that counts what it was
 * asked, and the walk, the stopping point, merges and the cache between checks.
 */

const sha = (n: number | string): Sha => String(n).padStart(40, "0");

/** A history where each commit names its parents, read as a first-parent chain; `asked` counts the commits handed out. */
function history(commits: Record<string, Sha[]>): MainSource & { asked: number; down: boolean } {
  const src = {
    asked: 0,
    down: false,
    async chain(from: Sha, limit: number): Promise<MainCommit[]> {
      if (src.down) throw new Error("binding unavailable");
      const out: MainCommit[] = [];
      for (let at: Sha | undefined = from; at !== undefined && out.length < limit; ) {
        const parents: Sha[] | undefined = commits[at];
        if (parents === undefined) break;
        out.push({ hash: at, parents });
        at = parents[0];
      }
      src.asked += out.length;
      return out;
    },
  };
  return src;
}

/** A linear history 0 <- 1 <- ... <- n. */
function linear(n: number, extra: Record<string, Sha[]> = {}): Record<string, Sha[]> {
  const out: Record<string, Sha[]> = { [sha(0)]: [] };
  for (let i = 1; i <= n; i++) out[sha(i)] = [sha(i - 1)];
  return { ...out, ...extra };
}

const target = (i: number | string, unpublished = false) => ({ landingId: `lnd_${i}`, sha: sha(i), unpublished });

describe("placeOnMain", () => {
  it("finds landings main reaches, reading no deeper than the oldest of them", async () => {
    const src = history(linear(100));
    const r = await placeOnMain([target(100), target(99), target(98)], { tip: sha(100), src, walk: new MainWalk(), stops: new Set([sha(97)]), depth: 2 });
    expect([...r.checks.values()]).toEqual([{ status: "on-main" }, { status: "on-main" }, { status: "on-main" }]);
    // The three landings and the commit below them, nothing deeper.
    expect(src.asked).toBe(4);
  });

  it("says a landing main no longer reaches was dropped, once main reaches a commit older than it", async () => {
    // Main was rewritten from 98 up: 98' and 99' sit where 98, 99 and 100 were.
    const src = history(linear(100, { [sha("98r")]: [sha(97)], [sha("99r")]: [sha("98r")] }));
    const r = await placeOnMain([target(100), target(99), target(98)], { tip: sha("99r"), src, walk: new MainWalk(), stops: new Set([sha(97)]), depth: 2 });
    expect(r.checks.get("lnd_100")).toEqual({ status: "dropped", detail: `main (at ${sha("99r").slice(0, 12)}) no longer reaches this landing's commit: it was dropped from main, or main was rewritten` });
    expect(r.checks.get("lnd_98")?.status).toBe("dropped");
    // The commits main holds above the stopping point, for the search of a replacement.
    expect(r.above).toEqual([sha("99r"), sha("98r")]);
    // Reset back to 99: only 100 is dropped.
    const reset = await placeOnMain([target(100), target(99)], { tip: sha(99), src, walk: new MainWalk(), stops: new Set([sha(98)]), depth: 1 });
    expect([reset.checks.get("lnd_100")?.status, reset.checks.get("lnd_99")?.status]).toEqual(["dropped", "on-main"]);
  });

  it("follows the other parents of a merge above the stopping point, as git's reachability does", async () => {
    // 100 merges 50 (the first-parent chain) with 99, which holds the landing.
    const src = history(linear(98, { [sha(99)]: [sha(98)], [sha("m")]: [sha(98), sha(99)] }));
    const r = await placeOnMain([target(99)], { tip: sha("m"), src, walk: new MainWalk(), stops: new Set([sha(98)]), depth: 1 });
    expect(r.checks.get("lnd_99")).toEqual({ status: "on-main" });
  });

  it("keeps a landing that is not published yet pending, and reads the history from the root when nothing older is known", async () => {
    const src = history(linear(5));
    const r = await placeOnMain([target(7, true), target(6)], { tip: sha(5), src, walk: new MainWalk(), stops: new Set(), depth: 0 });
    expect([r.checks.get("lnd_7"), r.checks.get("lnd_6")?.status]).toEqual([{ status: "pending" }, "dropped"]);
    expect(src.asked).toBe(6);
    const none = await placeOnMain([target(6)], { tip: null, src, walk: new MainWalk(), stops: new Set(), depth: 0 });
    expect(none.checks.get("lnd_6")).toEqual({ status: "dropped", detail: "the trunk repository has no main branch, so main does not reach this landing's commit" });
  });

  it("leaves a landing unchecked when main's history cannot be read far enough, and fails one past the depth it should sit at", async () => {
    // 3 is missing from every source: the walk cannot get past 4.
    const commits = linear(10);
    delete commits[sha(3)];
    const r = await placeOnMain([target(2)], { tip: sha(10), src: history(commits), walk: new MainWalk(), stops: new Set([sha(1)]), depth: 8 });
    expect(r.checks.get("lnd_2")).toEqual({ status: "unchecked", detail: `main's history (at ${sha(10).slice(0, 12)}) could not be read past ${sha(4).slice(0, 12)}, so whether it reaches this landing's commit is not known` });
    // 400 commits nobody recorded on top of where the landing should be (1 deep): the walk gives up after depth + 256.
    const deep = await placeOnMain([target(1)], { tip: sha(400), src: history(linear(400)), walk: new MainWalk(), stops: new Set([sha(0)]), depth: 1 });
    expect(deep.checks.get("lnd_1")?.detail).toMatch(/^main's newest 257 commits \(from 0{12}\) reach neither this landing's commit nor the landings recorded before it: main was rewritten/);
    const far = await placeOnMain([target(1)], { tip: sha(400), src: history(linear(400)), walk: new MainWalk(), stops: new Set([sha(0)]), depth: WALK_MAX });
    expect(far.checks.get("lnd_1")?.status).toBe("on-main");
  });
});

describe("MainWalk", () => {
  it("keeps what it read: the same tip reads nothing again, and a tip that moved forward reads only the new commits", async () => {
    const commits = linear(300);
    const src = history(commits);
    const walk = new MainWalk();
    const ask = (tip: Sha, t: number, stop: number) => placeOnMain([target(t)], { tip, src, walk, stops: new Set([sha(stop)]), depth: 300 - t });
    expect((await ask(sha(300), 10, 9)).checks.get("lnd_10")?.status).toBe("on-main");
    const first = src.asked;
    expect(first).toBe(292);
    expect((await ask(sha(300), 200, 199)).checks.get("lnd_200")?.status).toBe("on-main");
    expect(src.asked).toBe(first);
    // Two new commits on top: they are read, the rest is taken over.
    commits[sha(301)] = [sha(300)];
    commits[sha(302)] = [sha(301)];
    expect((await ask(sha(302), 10, 9)).checks.get("lnd_10")?.status).toBe("on-main");
    // A few commits from the new tip, until it meets the old one.
    expect(src.asked).toBe(first + 8);
  });

  it("asks again for a commit that could not be read before", async () => {
    const src = history(linear(5));
    const walk = new MainWalk();
    src.down = true;
    await expect(placeOnMain([target(1)], { tip: sha(5), src, walk, stops: new Set([sha(0)]), depth: 4 })).rejects.toThrow("binding unavailable");
    src.down = false;
    expect((await placeOnMain([target(1)], { tip: sha(5), src, walk, stops: new Set([sha(0)]), depth: 4 })).checks.get("lnd_1")?.status).toBe("on-main");
  });
});

describe("layeredMain", () => {
  it("reads the local chain first, then the second source from the first commit the local one does not have", async () => {
    const all = linear(10);
    const local = history(Object.fromEntries(Object.entries(all).filter(([k]) => k >= sha(6))));
    const remote = history(all);
    const chain = await layeredMain(local, remote).chain(sha(10), 8);
    expect(chain.map((c) => c.hash)).toEqual([10, 9, 8, 7, 6, 5, 4, 3].map((n) => sha(n)));
    expect([local.asked, remote.asked]).toEqual([5, 3]);
  });
});

describe("changedFields", () => {
  it("names what a rewritten commit changed from the one it stands for", () => {
    const person = (name: string, at = 1) => ({ name, email: `${name}@x.invalid`, at });
    const was = { tree: "t", parents: ["p"], message: "Land 1 change: x\n\nFT-Landing: lnd_1\nFT-Note: sha256:aa\n", author: person("FireTrident"), committer: person("FireTrident") };
    expect(changedFields(was, { ...was })).toBeNull();
    expect(changedFields(was, { ...was, message: "Land 1 change: y\n\nFT-Landing: lnd_1\nFT-Note: sha256:aa" })).toBe("its message");
    expect(changedFields(was, { ...was, message: "Land 1 change: x\n\nFT-Landing: lnd_1\nApproved-by: M\nFT-Note: sha256:aa" })).toBe("its trailers");
    expect(changedFields(was, { ...was, author: person("Mallory"), committer: person("FireTrident", 2) })).toBe("its author and its commit date");
    expect(changedFields(was, { ...was, tree: "u", parents: ["q"] })).toBe("its files and its parent");
  });
});
