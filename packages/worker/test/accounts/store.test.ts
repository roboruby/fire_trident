import { describe, expect, it } from "vitest";
import { MAX_COLONIES_PER_ACCOUNT, MAX_LIVE_TOKENS_PER_COLONY } from "../../src/accounts/limits.ts";
import { memoryStore } from "./fakes.ts";

/** The accounts store: invite codes, sessions, ownership and scoped tokens, on SQLite, by hashes only. */

const ada = { id: 101, login: "ada", name: "Ada" };
const bob = { id: 202, login: "bob" };
const DAY = 24 * 60 * 60_000;

describe("invite codes", () => {
  it("open an account once per use, and a returning person spends none", () => {
    const s = memoryStore();
    s.mintInvite({ id: "inv_1", hash: "h-code", uses: 1, expiresAt: 10 * DAY, note: "for ada" }, 0);
    const first = s.redeemInvite("h-code", ada, "h-s1", DAY, 1);
    expect(first).toMatchObject({ ok: true, created: true, account: { github: ada } });
    // The same person again: signed in, nothing spent.
    expect(s.redeemInvite("h-code", { ...ada, login: "ada-renamed" }, "h-s2", DAY, 2)).toMatchObject({ ok: true, created: false, account: { github: { login: "ada-renamed" } } });
    // Used up for anyone else.
    expect(s.redeemInvite("h-code", bob, "h-s3", DAY, 3)).toEqual({ ok: false, why: "used" });
    expect(s.listInvites(4)).toEqual([{ id: "inv_1", uses: 1, used: 1, createdAt: 0, expiresAt: 10 * DAY, note: "for ada", live: false }]);
  });

  it("refuse an unknown, an expired and a revoked code", () => {
    const s = memoryStore();
    s.mintInvite({ id: "inv_1", hash: "h-a", uses: 5, expiresAt: 100, note: "" }, 0);
    s.mintInvite({ id: "inv_2", hash: "h-b", uses: 5, expiresAt: 10 * DAY, note: "" }, 0);
    expect(s.redeemInvite("h-nope", ada, "h-s", DAY, 1)).toEqual({ ok: false, why: "invalid" });
    expect(s.redeemInvite("h-a", ada, "h-s", DAY, 100)).toEqual({ ok: false, why: "expired" });
    expect(s.revokeInvite("inv_2", 5)?.live).toBe(false);
    expect(s.redeemInvite("h-b", ada, "h-s", DAY, 6)).toEqual({ ok: false, why: "expired" });
    expect(s.revokeInvite("inv_missing", 5)).toBeNull();
    expect(s.accountFor(ada.id)).toBeNull();
  });

  it("let several people in with a multi-use code until it runs out", () => {
    const s = memoryStore();
    s.mintInvite({ id: "inv_1", hash: "h", uses: 2, expiresAt: DAY, note: "" }, 0);
    expect(s.redeemInvite("h", ada, "s1", DAY, 1).ok).toBe(true);
    expect(s.redeemInvite("h", bob, "s2", DAY, 2).ok).toBe(true);
    expect(s.redeemInvite("h", { id: 303, login: "cy" }, "s3", DAY, 3)).toEqual({ ok: false, why: "used" });
  });
});

describe("sessions", () => {
  it("find the account until they expire or end, and sign-in refreshes the GitHub login and name", () => {
    const s = memoryStore();
    s.mintInvite({ id: "inv_1", hash: "h", uses: 1, expiresAt: DAY, note: "" }, 0);
    const acc = s.redeemInvite("h", ada, "sess-1", 1_000, 0);
    if (!acc.ok) throw new Error("no account");
    expect(s.sessionAccount("sess-1", 999)?.id).toBe(acc.account.id);
    expect(s.sessionAccount("sess-1", 1_000)).toBeNull();
    expect(s.signIn({ id: ada.id, login: "ada2" }, "sess-2", 5_000, 10)?.github).toEqual({ id: ada.id, login: "ada2" });
    expect(s.sessionAccount("sess-2", 11)?.github.login).toBe("ada2");
    s.endSession("sess-2", 12);
    expect(s.sessionAccount("sess-2", 13)).toBeNull();
    expect(s.signIn(bob, "sess-3", 5_000, 14)).toBeNull();
    expect(s.sessionAccount("unknown", 1)).toBeNull();
  });
});

function withAccount() {
  const s = memoryStore();
  s.mintInvite({ id: "inv_1", hash: "h", uses: 5, expiresAt: 100 * DAY, note: "" }, 0);
  const a = s.redeemInvite("h", ada, "s-a", 100 * DAY, 0);
  const b = s.redeemInvite("h", bob, "s-b", 100 * DAY, 0);
  if (!a.ok || !b.ok) throw new Error("no accounts");
  return { s, ada: a.account.id, bob: b.account.id };
}

describe("colony ownership", () => {
  it("reserves a name for one account, counts pending colonies toward the quota, and releases", () => {
    const { s, ada: a, bob: b } = withAccount();
    expect(s.reserveColony(a, "one", 1)).toEqual({ ok: true });
    expect(s.ownerOf("one")).toBe(a);
    expect(s.reserveColony(b, "one", 2)).toEqual({ ok: false, why: "taken", owned: 0 });
    s.confirmColony("one", a);
    for (const id of ["two", "three"].slice(0, MAX_COLONIES_PER_ACCOUNT - 1)) expect(s.reserveColony(a, id, 3).ok).toBe(true);
    expect(s.reserveColony(a, "four", 4)).toEqual({ ok: false, why: "quota", owned: MAX_COLONIES_PER_ACCOUNT });
    expect(s.coloniesOf(a).map((c) => [c.colonyId, c.state])).toEqual([
      ["one", "active"],
      ["three", "pending"],
      ["two", "pending"],
    ]);
    expect(s.releaseColony("two", 5)).toBe(true);
    expect(s.releaseColony("two", 5)).toBe(false);
    expect(s.ownerOf("two")).toBeNull();
    expect(s.reserveColony(a, "four", 6)).toEqual({ ok: true });
    expect(s.ownerOf("operator-colony")).toBeNull();
  });
});

describe("scoped tokens", () => {
  it("are minted only by the colony's owner, up to the live limit, and listed without secrets", () => {
    const { s, ada: a, bob: b } = withAccount();
    s.reserveColony(a, "web", 0);
    expect(s.mintToken({ id: "tok_x", hash: "hx", colonyId: "web", accountId: b, role: "owner", label: "nope", expiresAt: DAY }, 1)).toEqual({ ok: false, why: "not-owner", live: 0 });
    for (let i = 0; i < MAX_LIVE_TOKENS_PER_COLONY; i++) {
      expect(s.mintToken({ id: `tok_${i}`, hash: `h${i}`, colonyId: "web", accountId: a, role: "agent", label: `agent ${i}`, expiresAt: DAY }, 1).ok).toBe(true);
    }
    expect(s.mintToken({ id: "tok_over", hash: "hover", colonyId: "web", accountId: a, role: "agent", label: "over", expiresAt: DAY }, 2)).toEqual({ ok: false, why: "quota", live: MAX_LIVE_TOKENS_PER_COLONY });
    // A revoked token frees a place; an expired one does too.
    expect(s.revokeToken("web", "tok_0", 3)).toMatchObject({ id: "tok_0", live: false, revokedAt: 3 });
    expect(s.mintToken({ id: "tok_new", hash: "hnew", colonyId: "web", accountId: a, role: "reviewer", label: "review", expiresAt: DAY }, 4).ok).toBe(true);
    expect(s.mintToken({ id: "tok_late", hash: "hlate", colonyId: "web", accountId: a, role: "agent", label: "late", expiresAt: 2 * DAY }, DAY).ok).toBe(true);
    const listed = s.listTokens("web", DAY);
    expect(JSON.stringify(listed)).not.toMatch(/"hash"|hnew|hlate/);
    expect(listed.find((t) => t.id === "tok_late")).toMatchObject({ role: "agent", label: "late", live: true });
    expect(listed.find((t) => t.id === "tok_1")).toMatchObject({ live: false });
    expect(s.revokeToken("other", "tok_1", 5)).toBeNull();
  });

  it("check a presented token by its hash, with its colony's owner now, and stop on release", () => {
    const { s, ada: a } = withAccount();
    s.reserveColony(a, "web", 0);
    s.mintToken({ id: "tok_1", hash: "h1", colonyId: "web", accountId: a, role: "agent", label: "bot", expiresAt: 10 * DAY }, 0);
    expect(s.checkToken("h1", 1)).toMatchObject({ token: { id: "tok_1", colonyId: "web", role: "agent", live: true, lastUsedAt: 1 }, accountId: a, owner: a });
    // Its last use is written at most once a minute.
    expect(s.checkToken("h1", 30_000)?.token.lastUsedAt).toBe(1);
    expect(s.checkToken("h1", 61_001)?.token.lastUsedAt).toBe(61_001);
    expect(s.checkToken("nope", 1)).toBeNull();
    s.bindMcpSession("mcp-1", "tok_1", 10 * DAY, 2);
    expect(s.mcpSessionToken("mcp-1", 3)).toBe("tok_1");
    s.releaseColony("web", 4);
    expect(s.checkToken("h1", 5)).toMatchObject({ token: { live: false, revokedAt: 4 }, owner: null });
    expect(s.mcpSessionToken("mcp-1", 5)).toBeNull();
  });

  it("forget an MCP session when its token is revoked or it lapses", () => {
    const { s, ada: a } = withAccount();
    s.reserveColony(a, "web", 0);
    s.mintToken({ id: "tok_1", hash: "h1", colonyId: "web", accountId: a, role: "agent", label: "bot", expiresAt: 10 * DAY }, 0);
    s.bindMcpSession("mcp-1", "tok_1", 100, 1);
    expect(s.mcpSessionToken("mcp-1", 100)).toBeNull();
    s.bindMcpSession("mcp-2", "tok_1", DAY, 1);
    s.revokeToken("web", "tok_1", 2);
    expect(s.mcpSessionToken("mcp-2", 3)).toBeNull();
  });
});
