import { describe, expect, it } from "vitest";
import { ROOT_PAGE, ROOT_RETRY_MS, findRoot, rootAnswer, type RootRepo } from "../../src/trunk/root.ts";

/** The colony's root commit (trunk/root.ts): the first commit of trunk, first parent from the tip, read through the binding's log. */

const id = (n: number): string => n.toString(16).padStart(40, "0");

/** A first-parent chain of `length` commits (commit i's parent is i - 1; commit 0 has `rootParent` or none), held from `held` on. */
function chain(length: number, p: { rootParent?: string; held?: number } = {}): RootRepo & { pages: string[] } {
  const held = p.held ?? 0;
  const pages: string[] = [];
  const commit = (i: number) => ({ hash: id(i + 1), parents: i > 0 ? [id(i)] : p.rootParent ? [p.rootParent] : [] });
  const index = (hash: string): number => parseInt(hash, 16) - 1;
  return {
    pages,
    async log({ ref, limit }) {
      pages.push(ref);
      const at = index(ref);
      if (!(at >= held && at < length)) return [];
      const out = [];
      for (let i = at; i >= held && out.length < limit; i--) out.push(commit(i));
      return out;
    },
    async readCommit(hash) {
      const at = index(hash);
      return at >= held && at < length ? { hash } : null;
    },
  };
}

describe("findRoot", () => {
  it("walks the first-parent chain page by page to a commit with no parent", async () => {
    const repo = chain(2_500);
    expect(await findRoot(repo, id(2_500))).toEqual({ sha: id(1), shallow: false });
    expect(repo.pages).toEqual([id(2_500), id(2_500 - ROOT_PAGE), id(2_500 - 2 * ROOT_PAGE)]);
    expect(await findRoot(chain(1), id(1))).toEqual({ sha: id(1), shallow: false });
  });

  it("stops at an import's shallow boundary: a commit whose parent the repository does not hold", async () => {
    // 300 commits, the oldest 100 not held: the root is commit 100, whose parent is missing.
    expect(await findRoot(chain(300, { held: 100 }), id(300))).toEqual({ sha: id(101), shallow: true });
    // The boundary falls exactly on a page's last commit: the next page is empty.
    expect(await findRoot(chain(ROOT_PAGE + 5, { held: 5 }), id(ROOT_PAGE + 5))).toEqual({ sha: id(6), shallow: true });
  });

  it("goes on past a short page whose last parent is held (a log that lists fewer than asked)", async () => {
    const full = chain(10);
    const short: RootRepo = { log: async (o) => (await full.log(o)).slice(0, 3), readCommit: full.readCommit };
    expect(await findRoot(short, id(10))).toEqual({ sha: id(1), shallow: false });
  });

  it("refuses to guess: an unknown head, a log that lists nothing for a held commit, a failing page", async () => {
    await expect(findRoot(chain(3), id(9))).rejects.toThrow(`does not list commit ${id(9)}`);
    const full = chain(ROOT_PAGE + 5);
    const blank: RootRepo = { log: async (o) => (o.ref === id(ROOT_PAGE + 5) ? full.log(o) : []), readCommit: full.readCommit };
    await expect(findRoot(blank, id(ROOT_PAGE + 5))).rejects.toThrow("though it holds that commit");
    const failing: RootRepo = { log: async () => Promise.reject(new Error("boom")), readCommit: async () => null };
    await expect(findRoot(failing, id(1))).rejects.toThrow("boom");
  });
});

describe("rootAnswer", () => {
  it("reads the root once and keeps it; a kept root is answered without reading", async () => {
    let kept: string | null = null;
    let walks = 0;
    const p = { colonyId: "web", trunk: "web--trunk", keep: (v: string) => void (kept = v), walk: async () => (walks++, { sha: id(1), shallow: true }), now: () => 1_000 };
    const [a, b] = await Promise.all([rootAnswer({ ...p, kept }), rootAnswer({ ...p, kept })]);
    expect(a).toEqual({ colonyId: "web", rootSha: id(1), shallow: true, at: 1_000 });
    expect(b).toEqual(a);
    expect(walks).toBe(1);
    expect(JSON.parse(kept!)).toEqual({ sha: id(1), shallow: true, at: 1_000 });
    expect(await rootAnswer({ ...p, kept, walk: async () => ({ sha: id(2), shallow: false }) })).toEqual(a);
    // A kept value that is not a root is read again.
    expect(await rootAnswer({ ...p, kept: "{", walk: async () => ({ sha: id(3), shallow: false }) })).toMatchObject({ rootSha: id(3) });
  });

  it("answers a failed read with why, keeps nothing, and asks again only after a while", async () => {
    let now = 5_000;
    let walks = 0;
    let kept: string | null = null;
    const p = { colonyId: "web2", trunk: "web2--trunk", kept: null, keep: (v: string) => void (kept = v), now: () => now };
    const failing = { ...p, walk: async () => (walks++, Promise.reject(new Error("the binding is down"))) };
    expect(await rootAnswer(failing)).toEqual({ colonyId: "web2", rootSha: null, shallow: false, at: 5_000, detail: "the trunk repository's first commit could not be read: the binding is down" });
    expect(await rootAnswer(failing)).toMatchObject({ rootSha: null });
    expect(walks).toBe(1);
    expect(kept).toBeNull();
    now += ROOT_RETRY_MS;
    expect(await rootAnswer({ ...p, walk: async () => ({ sha: id(7), shallow: false }) })).toMatchObject({ rootSha: id(7) });
  });
});
