import { describe, expect, it } from "vitest";
import { connectConfig } from "../../src/cloudflare/config.ts";
import { cloudflareGrantFor } from "../../src/cloudflare/grant.ts";
import { authorizeUrl, pkceChallenge, randomToken, sha256Hex } from "../../src/cloudflare/oauth.ts";
import { BROKEN, GrantService, REFRESH_MARGIN_MS } from "../../src/cloudflare/service.ts";
import { ACCOUNT_A, ALL_SCOPES, connectEnv, FakeCloudflare, memorySql, NO_AI_SCOPES } from "./fake.ts";

/**
 * cloudflareGrantFor and the stored grant: a current access token while it is fresh, renewed near expiry (once, however
 * many callers ask at the same time; the rotated refresh token kept), broken with a sentence when Cloudflare refuses
 * the renewal or the record does not decrypt, and kept as it is when Cloudflare does not answer.
 */

const ME = "acc_me";

async function connected(granted = ALL_SCOPES) {
  const clock = { now: Date.parse("2026-10-19T10:00:00Z") };
  const fake = new FakeCloudflare(clock);
  const { env } = connectEnv(fake);
  const cfg = connectConfig(env as never);
  if (!cfg) throw new Error("config");
  const { sql, db } = memorySql();
  const service = new GrantService({ sql, config: cfg, fetch: fake.fetch, now: () => clock.now });
  service.migrate();
  const state = randomToken();
  const verifier = randomToken(48);
  await service.begin(ME, await sha256Hex(state), verifier);
  const { code } = fake.authorize(authorizeUrl(cfg, state, await pkceChallenge(verifier)), granted);
  const r = await service.complete(ME, await sha256Hex(state), code);
  if (!r.ok) throw new Error(r.message);
  return { clock, fake, service, db, env };
}

describe("the stored grant", () => {
  it("hands out the current access token while it is fresh, without calling Cloudflare", async () => {
    const t = await connected();
    const calls = t.fake.calls.length;
    const g = await t.service.grant(ME);
    expect(g).toMatchObject({ accountId: ACCOUNT_A.id, scopes: ALL_SCOPES });
    expect(t.fake.tokens.get(g?.accessToken ?? "")?.kind).toBe("access");
    expect(t.fake.calls.length).toBe(calls);
  });

  it("renews near expiry once for concurrent callers, and keeps the rotated refresh token", async () => {
    const t = await connected();
    const first = await t.service.grant(ME);
    t.clock.now += 3600_000 - REFRESH_MARGIN_MS + 1000;
    const [a, b, c] = await Promise.all([t.service.grant(ME), t.service.grant(ME), t.service.grant(ME)]);
    expect(t.fake.tokenCalls().filter((x) => new URLSearchParams(x.body).get("grant_type") === "refresh_token")).toHaveLength(1);
    expect(a?.accessToken).not.toBe(first?.accessToken);
    expect(b?.accessToken).toBe(a?.accessToken);
    expect(c?.accessToken).toBe(a?.accessToken);
    // A second renewal works only with the rotated refresh token (the fake spends the old one).
    t.clock.now += 3600_000;
    const again = await t.service.grant(ME);
    expect(again?.accessToken).toBeTruthy();
    expect(again?.accessToken).not.toBe(a?.accessToken);
    expect(t.service.status(ME).state).toBe("connected");
  });

  it("marks the connection broken with a sentence when Cloudflare refuses the renewal", async () => {
    const t = await connected();
    t.fake.refreshAnswer = "invalid_grant";
    t.clock.now += 3600_000;
    expect(await t.service.grant(ME)).toBeNull();
    expect(t.service.status(ME)).toMatchObject({ state: "broken", reason: BROKEN.refused, account: ACCOUNT_A });
    // Broken stays broken (no more calls) until the person connects again.
    t.fake.refreshAnswer = "ok";
    const calls = t.fake.calls.length;
    expect(await t.service.grant(ME)).toBeNull();
    expect(t.fake.calls.length).toBe(calls);
  });

  it("keeps a connection Cloudflare did not answer for: the current token while valid, then null, never broken", async () => {
    const t = await connected();
    const first = await t.service.grant(ME);
    t.fake.refreshAnswer = "unavailable";
    t.clock.now += 3600_000 - 60_000;
    expect((await t.service.grant(ME))?.accessToken).toBe(first?.accessToken);
    t.clock.now += 120_000;
    expect(await t.service.grant(ME)).toBeNull();
    expect(t.service.status(ME).state).toBe("connected");
    t.fake.refreshAnswer = "ok";
    expect(await t.service.grant(ME)).not.toBeNull();
  });

  it("breaks a connection with no refresh token once its access token expired", async () => {
    const t = await connected(ALL_SCOPES.filter((s) => s !== "offline_access"));
    t.clock.now += 3600_000 + 1;
    expect(await t.service.grant(ME)).toBeNull();
    expect(t.service.status(ME)).toMatchObject({ state: "broken", reason: BROKEN.noRefresh });
  });

  it("refuses a record that was changed, and says so", async () => {
    const t = await connected();
    const row = t.db.prepare("SELECT tokens FROM cf_grants").all()[0] as { tokens: string };
    const tampered = row.tokens.slice(0, -2) + (row.tokens.endsWith("A") ? "BB" : "AA");
    t.db.prepare("UPDATE cf_grants SET tokens = ?").run(tampered);
    expect(await t.service.grant(ME)).toBeNull();
    expect(t.service.status(ME)).toMatchObject({ state: "broken", reason: BROKEN.unreadable });
  });

  it("is bound to its account: a record copied to another account does not open", async () => {
    const t = await connected();
    t.db.prepare("UPDATE cf_grants SET account = 'acc_thief'").run();
    expect(await t.service.grant("acc_thief")).toBeNull();
    expect(t.service.status("acc_thief")).toMatchObject({ state: "broken", reason: BROKEN.unreadable });
  });

  it("records the scopes granted, Workers AI or not", async () => {
    const t = await connected(NO_AI_SCOPES);
    expect((await t.service.grant(ME))?.scopes).toEqual(NO_AI_SCOPES);
    expect(t.service.status(ME).workersAi).toBe(false);
  });
});

describe("cloudflareGrantFor", () => {
  it("reads the account's grant object, and is null with FT_ACCOUNTS off, connecting not set up, or no connection", async () => {
    const clock = { now: Date.parse("2026-10-19T10:00:00Z") };
    const fake = new FakeCloudflare(clock);
    const { env } = connectEnv(fake);
    expect(await cloudflareGrantFor(env as never, ME)).toBeNull();
    const t = await connected();
    expect(await cloudflareGrantFor(t.env as never, ME)).toBeNull();
    // Wire the connected service in as the account's object.
    const on = { ...t.env, CF_GRANTS: { idFromName: (n: string) => n, get: () => t.service } };
    expect((await cloudflareGrantFor(on as never, ME))?.accountId).toBe(ACCOUNT_A.id);
    expect(await cloudflareGrantFor({ ...on, FT_ACCOUNTS: undefined } as never, ME)).toBeNull();
    expect(await cloudflareGrantFor({ ...on, FT_GRANT_KEY: undefined } as never, ME)).toBeNull();
    expect(await cloudflareGrantFor({ ...on, CF_GRANTS: undefined } as never, ME)).toBeNull();
  });
});
