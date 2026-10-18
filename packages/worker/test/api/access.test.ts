import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACCESS_HEADER, accessConfig, approverIdentity, resetAccessKeys, verifyAccessToken, type AccessConfig } from "../../src/api/access.ts";
import { createApi, type ApiDeps } from "../../src/api/app.ts";
import type { Env } from "../../src/env.ts";

/**
 * Verified approvers behind Cloudflare Access (api/access.ts): the Cf-Access-Jwt-Assertion header verified against the
 * team's keys, with a key pair generated here (no key is part of the repository) and the keys' fetch stubbed.
 */

const TEAM = "example-team.cloudflareaccess.com";
const AUD = "f00dbabe0123456789abcdef0123456789abcdef0123456789abcdef01234567";
const ENV = { FT_ACCESS_TEAM_DOMAIN: TEAM, FT_ACCESS_AUD: AUD };
const NOW = 1_800_000_000_000;

const enc = new TextEncoder();
const b64url = (bytes: Uint8Array | string): string => {
  const b = typeof bytes === "string" ? enc.encode(bytes) : bytes;
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

interface Signer {
  kid: string;
  jwk: JsonWebKey & { kid: string };
  sign(claims: Record<string, unknown>, header?: Record<string, unknown>): Promise<string>;
}

async function signer(kid: string): Promise<Signer> {
  const pair = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const pub = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  return {
    kid,
    jwk: { kty: "RSA", n: pub.n, e: pub.e, alg: "RS256", use: "sig", kid },
    async sign(claims, header = {}) {
      const h = b64url(JSON.stringify({ alg: "RS256", kid, typ: "JWT", ...header }));
      const p = b64url(JSON.stringify(claims));
      const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, enc.encode(`${h}.${p}`)));
      return `${h}.${p}.${b64url(sig)}`;
    },
  };
}

/** Claims as Access issues them for a person, valid at NOW. */
const claims = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  aud: [AUD],
  email: "dana@example.com",
  exp: NOW / 1000 + 600,
  iat: NOW / 1000 - 60,
  nbf: NOW / 1000 - 60,
  iss: `https://${TEAM}`,
  type: "app",
  sub: "0b1c2d3e",
  ...over,
});

/** A stubbed fetch of the team's keys that counts its calls. */
function certs(keys: () => Signer[]): { fetch: (url: string) => Promise<Response>; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    fetch: async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify({ keys: keys().map((k) => k.jwk), public_cert: { kid: "x", cert: "-----BEGIN CERTIFICATE-----" } }), { headers: { "content-type": "application/json" } });
    },
  };
}

const cfg = accessConfig(ENV) as AccessConfig;

beforeEach(() => resetAccessKeys());

describe("Access settings", () => {
  it("is off unless both are set, and takes the team domain with or without a scheme", () => {
    expect(accessConfig({})).toBeNull();
    expect(accessConfig({ FT_ACCESS_TEAM_DOMAIN: TEAM })).toBeNull();
    expect(accessConfig({ FT_ACCESS_AUD: AUD })).toBeNull();
    expect(accessConfig({ FT_ACCESS_TEAM_DOMAIN: ` https://${TEAM.toUpperCase()}/ `, FT_ACCESS_AUD: AUD })).toEqual({ team: TEAM, aud: AUD, issuer: `https://${TEAM}`, certs: `https://${TEAM}/cdn-cgi/access/certs` });
    expect(accessConfig({ FT_ACCESS_TEAM_DOMAIN: "not a host/../x", FT_ACCESS_AUD: AUD })).toEqual({ error: expect.stringContaining("is not a host name") });
  });
});

describe("verifying an Access token", () => {
  it("verifies a person's token against the team's keys and names their email; the keys are read once and kept", async () => {
    const k = await signer("k1");
    const f = certs(() => [k]);
    const deps = { fetch: f.fetch, now: () => NOW };
    expect(await verifyAccessToken(await k.sign(claims()), cfg, deps)).toEqual({ ok: true, email: "dana@example.com" });
    expect(await verifyAccessToken(await k.sign(claims({ aud: AUD })), cfg, deps)).toEqual({ ok: true, email: "dana@example.com" });
    expect(f.calls).toEqual([`https://${TEAM}/cdn-cgi/access/certs`]);
  });

  it("refuses a token for another audience, issuer, expired, not yet valid, or with no person, each with why", async () => {
    const k = await signer("k1");
    const deps = { fetch: certs(() => [k]).fetch, now: () => NOW };
    const why = async (c: Record<string, unknown>): Promise<string> => {
      const v = await verifyAccessToken(await k.sign(c), cfg, deps);
      return v.ok ? "verified" : v.why;
    };
    expect(await why(claims({ aud: ["another-app"] }))).toMatch(/audience does not match FT_ACCESS_AUD/);
    expect(await why(claims({ iss: "https://other-team.cloudflareaccess.com" }))).toMatch(/issued by another team/);
    expect(await why(claims({ exp: NOW / 1000 - 1 }))).toMatch(/has expired/);
    expect(await why(claims({ exp: undefined }))).toMatch(/has expired/);
    expect(await why(claims({ nbf: NOW / 1000 + 3_600 }))).toMatch(/not valid yet/);
    // A service token carries a common name, not an email.
    expect(await why(claims({ email: undefined, common_name: "ci.access" }))).toMatch(/names no person/);
    expect(await why(claims({ email: "dana@example.com>\nevil" }))).toMatch(/names no person/);
  });

  it("refuses a forged or altered token, another algorithm, and a key the team does not publish", async () => {
    const k = await signer("k1");
    const stranger = await signer("k1");
    const deps = { fetch: certs(() => [k]).fetch, now: () => NOW };
    const good = await k.sign(claims());
    const [h, , s] = good.split(".");
    const altered = `${h}.${b64url(JSON.stringify(claims({ email: "mallory@example.com" })))}.${s}`;
    expect(await verifyAccessToken(altered, cfg, deps)).toEqual({ ok: false, why: "the Access token's signature does not verify" });
    expect(await verifyAccessToken(await stranger.sign(claims()), cfg, deps)).toEqual({ ok: false, why: "the Access token's signature does not verify" });
    const none = `${b64url(JSON.stringify({ alg: "none", kid: "k1" }))}.${b64url(JSON.stringify(claims()))}.`;
    expect(await verifyAccessToken(none, cfg, deps)).toMatchObject({ ok: false });
    expect(await verifyAccessToken(await k.sign(claims(), { alg: "HS256" }), cfg, deps)).toEqual({ ok: false, why: "the Access token is not signed with RS256" });
    expect(await verifyAccessToken(await (await signer("k9")).sign(claims()), cfg, deps)).toEqual({ ok: false, why: "the Access token is signed by a key the team does not publish" });
    expect(await verifyAccessToken("not.a-jwt", cfg, deps)).toEqual({ ok: false, why: "the Access token is not a JWT" });
  });

  it("reads the keys again for a key id it has not seen (rotation), at most once a minute", async () => {
    const k1 = await signer("k1");
    const k2 = await signer("k2");
    let ring = [k1];
    const f = certs(() => ring);
    let now = NOW;
    const deps = { fetch: f.fetch, now: () => now };
    expect((await verifyAccessToken(await k1.sign(claims()), cfg, deps)).ok).toBe(true);
    ring = [k1, k2];
    // Within the minute an unknown key id is not fetched for again.
    expect(await verifyAccessToken(await k2.sign(claims()), cfg, deps)).toMatchObject({ ok: false });
    expect(f.calls).toHaveLength(1);
    now += 61_000;
    expect(await verifyAccessToken(await k2.sign(claims({ exp: now / 1000 + 600 })), cfg, deps)).toEqual({ ok: true, email: "dana@example.com" });
    expect(f.calls).toHaveLength(2);
  });

  it("records the stated name when the keys cannot be read", async () => {
    const k = await signer("k1");
    const down = async (): Promise<Response> => new Response("no", { status: 503 });
    expect(await verifyAccessToken(await k.sign(claims()), cfg, { fetch: down, now: () => NOW })).toEqual({ ok: false, why: "the Access team's keys could not be read (HTTP 503)" });
  });
});

describe("who a decision names", () => {
  it("is the stated name, stated, with nothing verified when Access is not configured", async () => {
    const k = await signer("k1");
    const headers = new Headers({ [ACCESS_HEADER]: await k.sign(claims()) });
    expect(await approverIdentity({}, headers, "matt")).toEqual({ by: "matt", identity: "stated" });
    expect(await approverIdentity({}, new Headers(), undefined)).toEqual({ by: "human", identity: "stated" });
  });

  it("is the token's email, verified, and keeps the stated name beside it when it differs", async () => {
    const k = await signer("k1");
    const deps = { fetch: certs(() => [k]).fetch, now: () => NOW };
    const headers = new Headers({ [ACCESS_HEADER]: await k.sign(claims()) });
    expect(await approverIdentity(ENV, headers, "matt", deps)).toEqual({ by: "dana@example.com", identity: "verified", stated: "matt" });
    expect(await approverIdentity(ENV, headers, undefined, deps)).toEqual({ by: "dana@example.com", identity: "verified" });
  });

  it("never trusts the plain email header: without a valid assertion the stated name is recorded as stated, with why", async () => {
    const deps = { fetch: certs(() => []).fetch, now: () => NOW };
    const plain = new Headers({ "cf-access-authenticated-user-email": "ceo@example.com" });
    expect(await approverIdentity(ENV, plain, "matt", deps)).toEqual({ by: "matt", identity: "stated", why: "no Access token came with the request" });
    const bad = new Headers({ "cf-access-authenticated-user-email": "ceo@example.com", [ACCESS_HEADER]: "x.y.z" });
    expect(await approverIdentity(ENV, bad, "matt", deps)).toEqual({ by: "matt", identity: "stated", why: "the Access token is not a JWT" });
  });
});

describe("the review routes with Access configured", () => {
  const deps: ApiDeps = {
    provisionTrunk: async () => {
      throw new Error("not used");
    },
    spawnSwarm: async () => undefined,
  };
  const TOKEN = "s3cret";
  let signing: Signer;

  beforeEach(async () => {
    signing = await signer("k1");
    vi.stubGlobal("fetch", async (url: string) => certs(() => [signing]).fetch(url));
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  /** A colony stub that records each decision it is asked for. */
  function env(over: Record<string, unknown> = ENV): { env: Env; asked: unknown[][] } {
    const asked: unknown[][] = [];
    const stub = {
      getColony: async () => ({ id: "col" }),
      decide: async (...args: unknown[]) => void asked.push(args),
      decideBatch: async (d: { key: string; ids: string[]; decision: string }, who: unknown) => {
        asked.push([d, who]);
        return { key: d.key, decision: d.decision, decided: d.ids, skipped: [] };
      },
    };
    return { env: { COLONY: { idFromName: (n: string) => n, get: () => stub }, FT_ADMIN_TOKEN: TOKEN, ...over } as unknown as Env, asked };
  }

  const post = async (e: Env, path: string, body: unknown, headers: Record<string, string> = {}, token: string | null = TOKEN) => {
    const res = await createApi(deps).request(path, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: JSON.stringify(body) }, e);
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };

  it("records the verified email as the approver and says so in the answer", async () => {
    const { env: e, asked } = env();
    const res = await post(e, "/colonies/col/review/prp_1", { decision: "approve", reason: "read it", by: "matt" }, { [ACCESS_HEADER]: await signing.sign(claims()) });
    expect(res).toEqual({ status: 200, json: { ok: true, recorded: { by: "dana@example.com", identity: "verified" } } });
    expect(asked).toEqual([["prp_1", "approve", "read it", "dana@example.com", true, { by: "dana@example.com", identity: "verified", stated: "matt" }]]);
  });

  it("records the stated name as stated without a valid assertion, and still needs the admin token either way", async () => {
    const { env: e, asked } = env();
    const res = await post(e, "/colonies/col/review/prp_1", { decision: "approve", by: "matt" }, { "cf-access-authenticated-user-email": "ceo@example.com" });
    expect(res.json).toEqual({ ok: true, recorded: { by: "matt", identity: "stated", why: "no Access token came with the request" } });
    expect(asked[0]!.slice(3)).toEqual(["matt", true, { by: "matt", identity: "stated", why: "no Access token came with the request" }]);
    // A verified person without the admin token writes nothing.
    expect((await post(e, "/colonies/col/review/prp_2", { decision: "approve" }, { [ACCESS_HEADER]: await signing.sign(claims()) }, null)).status).toBe(401);
    expect(asked).toHaveLength(1);
  });

  it("answers as before when Access is not configured", async () => {
    const { env: e, asked } = env({});
    expect((await post(e, "/colonies/col/review/prp_1", { decision: "approve", by: "matt" }, { [ACCESS_HEADER]: await signing.sign(claims()) })).json).toEqual({ ok: true });
    expect(asked[0]!.slice(3)).toEqual(["matt", true, { by: "matt", identity: "stated" }]);
  });

  it("records the verified email on each change of a batch", async () => {
    const { env: e, asked } = env();
    const res = await post(e, "/colonies/col/review/batches/decide", { key: "P1|x", ids: ["prp_1"], decision: "approve", by: "matt" }, { [ACCESS_HEADER]: await signing.sign(claims()) });
    expect(res.status).toBe(200);
    expect(asked).toEqual([[{ key: "P1|x", ids: ["prp_1"], decision: "approve", reason: "", by: "dana@example.com" }, { by: "dana@example.com", identity: "verified", stated: "matt" }]]);
  });
});
