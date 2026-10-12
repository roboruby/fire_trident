import { describe, expect, it } from "vitest";
import { CLEAN_AFTER_MS, SlotBook, TOKEN_MIN_LIFE_MS, reusable, type SlotToken, type TokenOps } from "../../src/pool/slots.ts";

/** The part of node:sqlite these tests use (the worker compiles against workers types, not Node's). */
interface DatabaseSync {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
  exec(sql: string): void;
}
const SQLITE = "node:sqlite";
const { DatabaseSync } = (await import(SQLITE)) as { DatabaseSync: new (path: string) => DatabaseSync };

function sqlStorage(): { sql: SqlStorage; db: DatabaseSync } {
  const db = new DatabaseSync(":memory:");
  const sql = {
    exec(query: string, ...bindings: unknown[]) {
      const rows = db.prepare(query).all(...bindings);
      return {
        toArray: () => rows,
        one: () => {
          if (rows.length !== 1) throw new Error(`expected one row, got ${rows.length}`);
          return rows[0];
        },
        [Symbol.iterator]: () => rows[Symbol.iterator](),
      };
    },
  } as unknown as SqlStorage;
  return { sql, db };
}

/** Token service that records every call; tokens expire two hours after minting. */
class FakeTokens implements TokenOps {
  minted: string[] = [];
  revoked: string[] = [];
  failRevoke = false;
  /** Repositories that no longer exist: minting a token for one fails with NOT_FOUND. */
  gone = new Set<string>();
  private seq = 0;
  constructor(private readonly clock: () => number) {}
  async mint(slot: { name: string }): Promise<SlotToken> {
    if (this.gone.has(slot.name)) throw Object.assign(new Error(`repository ${slot.name} not found`), { code: "NOT_FOUND" });
    const id = `tok_${++this.seq}`;
    this.minted.push(`${slot.name}:${id}`);
    return { id, token: `secret-${id}`, expiresAt: this.clock() + 2 * 3600_000 };
  }
  async revoke(_slot: { name: string }, tokenId: string): Promise<void> {
    if (this.failRevoke) throw new Error("revoke failed");
    this.revoked.push(tokenId);
  }
}

function pool(slots: number) {
  let now = 1_000_000;
  const clock = () => now;
  const { sql } = sqlStorage();
  const tokens = new FakeTokens(clock);
  const book = new SlotBook(sql, tokens, clock);
  for (let n = 0; n < slots; n++) {
    sql.exec(`INSERT INTO ft_pool_ws (n, shard, name, remote, state, created_at) VALUES (?, ?, ?, ?, 'ready', ?)`, n, n % 4, `ws-${n}`, `https://x.invalid/ws-${n}.git`, 0);
  }
  return { book, tokens, sql, advance: (ms: number) => (now += ms), now: () => now };
}

async function lease(book: SlotBook, agentId: string): Promise<{ name: string; token: string; minted: boolean }> {
  const row = book.take(agentId);
  if (!row) throw new Error("pool empty");
  const armed = await book.arm(row, agentId);
  return { name: row.name, token: armed.token.token, minted: armed.minted };
}

describe("SlotBook", () => {
  it("hands an agent its own workspace and token back with no Artifacts call", async () => {
    const p = pool(2);
    const first = await lease(p.book, "a");
    expect(first.minted).toBe(true);
    expect(p.book.release("a")).toBe(1);
    const again = await lease(p.book, "a");
    expect(again).toEqual({ ...first, minted: false });
    // A repeated lease while holding it also needs no call.
    expect(await lease(p.book, "a")).toEqual({ ...first, minted: false });
    expect(p.tokens.minted).toHaveLength(1);
    expect(p.tokens.revoked).toEqual([]);
  });

  it("never gives one agent's token to another: the old one is revoked first", async () => {
    const p = pool(1);
    const a = await lease(p.book, "a");
    p.book.release("a");
    const b = await lease(p.book, "b");
    expect(b.name).toBe(a.name);
    expect(b.token).not.toBe(a.token);
    expect(p.tokens.revoked).toEqual(["tok_1"]);
  });

  it("cleans idle slots in the background so the next agent leases without waiting", async () => {
    const p = pool(3);
    const a = await lease(p.book, "a");
    p.book.release("a");
    // New slots get clean tokens; the released one is not due yet.
    expect(await p.book.maintain(100)).toBe(2);
    expect(p.tokens.revoked).toEqual([]);
    p.advance(CLEAN_AFTER_MS);
    expect(p.book.readiness()).toEqual({ clean: 2, chores: 1 });
    expect(await p.book.maintain(100)).toBe(1);
    expect(p.tokens.revoked).toEqual(["tok_1"]);
    expect(p.book.readiness()).toEqual({ clean: 3, chores: 0 });
    // Three new agents lease with no call at all, a's old slot included.
    const minted = p.tokens.minted.length;
    const leases = [await lease(p.book, "b"), await lease(p.book, "c"), await lease(p.book, "d")];
    expect(leases.every((l) => !l.minted)).toBe(true);
    expect(leases.map((l) => l.name).sort()).toContain(a.name);
    expect(p.tokens.minted).toHaveLength(minted);
  });

  it("replaces tokens before they run short and never leases one with less than the minimum life", async () => {
    const p = pool(1);
    await p.book.maintain(10);
    p.advance(2 * 3600_000 - TOKEN_MIN_LIFE_MS + 1);
    const l = await lease(p.book, "a");
    expect(l.minted).toBe(true);
    expect(p.tokens.revoked).toEqual([]); // a clean token was never seen by anyone
    p.book.release("a");
    expect(p.book.nextChoreAt()).toBe(p.now() + CLEAN_AFTER_MS);
  });

  it("keeps a slot out of circulation when revoking fails, so its next lease by another agent revokes again", async () => {
    const p = pool(1);
    await lease(p.book, "a");
    p.book.release("a");
    p.advance(CLEAN_AFTER_MS);
    p.tokens.failRevoke = true;
    expect(await p.book.maintain(10)).toBe(0);
    // b cannot get the slot while a's token may still be valid: the lease fails and is put back.
    const row = p.book.take("b")!;
    await expect(p.book.arm(row, "b")).rejects.toThrow("revoke failed");
    p.book.unlease(row.n, "b");
    p.tokens.failRevoke = false;
    const b = await lease(p.book, "b");
    expect(b.minted).toBe(true);
    expect(p.tokens.revoked).toEqual(["tok_1"]);
  });

  it("retires a slot whose repository vanished instead of retrying its chore forever", async () => {
    const p = pool(2);
    p.tokens.gone.add("ws-0");
    expect(await p.book.maintain(10)).toBe(1);
    const states = p.sql.exec<{ name: string; state: string; error: string | null }>(`SELECT name, state, error FROM ft_pool_ws ORDER BY n`).toArray();
    expect(states.map((s) => [s.name, s.state])).toEqual([
      ["ws-0", "failed"],
      ["ws-1", "ready"],
    ]);
    expect(states[0]?.error).toMatch(/workspace vanished/);
    expect(p.book.readiness().chores).toBe(0);
    expect((await lease(p.book, "a")).name).toBe("ws-1");
  });

  it("a lease during a background clean keeps its own token", async () => {
    const p = pool(1);
    await lease(p.book, "a");
    p.book.release("a");
    p.advance(CLEAN_AFTER_MS);
    const work = p.book.maintain(10);
    // While the chore awaits the token service, agent a comes back and leases its workspace.
    const back = await lease(p.book, "a");
    expect(back.minted).toBe(true);
    expect(await work).toBe(0);
    // a's old token and the clean one the chore minted are revoked; a holds the one its lease minted.
    expect(p.tokens.revoked).toHaveLength(2);
    expect(p.tokens.revoked).toContain("tok_1");
    expect(p.tokens.revoked).not.toContain(back.token.replace("secret-", ""));
    const again = await lease(p.book, "a");
    expect(again).toEqual({ ...back, minted: false });
  });

  it("reusable() requires a token with life left that nobody else holds", () => {
    const now = 0;
    expect(reusable({ token: "t", token_exp: TOKEN_MIN_LIFE_MS, token_for: null }, "a", now)).toBe(true);
    expect(reusable({ token: "t", token_exp: TOKEN_MIN_LIFE_MS, token_for: "a" }, "a", now)).toBe(true);
    expect(reusable({ token: "t", token_exp: TOKEN_MIN_LIFE_MS, token_for: "b" }, "a", now)).toBe(false);
    expect(reusable({ token: "t", token_exp: TOKEN_MIN_LIFE_MS - 1, token_for: null }, "a", now)).toBe(false);
    expect(reusable({ token: null, token_exp: null, token_for: null }, "a", now)).toBe(false);
  });
});
