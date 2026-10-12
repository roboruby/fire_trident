import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/index.ts";
import { MemoryStore } from "../src/store/memory.ts";

const errors: Response[] = [];
function app(random?: () => number) {
  let i = 0;
  const seq = () => ((i++ % 9) + 1) / 10;
  return createApp({ store: new MemoryStore(), random: random ?? seq, now: () => 1_700_000_000_000, adminToken: "test-admin" });
}
const req = (method: string, path: string, body?: string, headers: Record<string, string> = {}) =>
  new Request(`https://sho.rt${path}`, { method, body, headers: body ? { "content-type": "application/json", ...headers } : headers });
async function expectError(res: Response, status: number, code: string) {
  assert.equal(res.status, status);
  errors.push(res.clone());
  const body = await res.json();
  assert.equal(body.error.code, code);
}

test("A1 create", async () => {
  const res = await app(() => 0.5)(req("POST", "/api/links", JSON.stringify({ url: "https://example.com/docs?a=1" })));
  assert.equal(res.status, 201);
  assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
  assert.deepEqual(await res.json(), { slug: "VVVVVVV", url: "https://example.com/docs?a=1", shortUrl: "https://sho.rt/VVVVVVV", createdAt: 1_700_000_000_000 });
});

test("A2 redirect and count", async () => {
  const a = app();
  const { slug } = await (await a(req("POST", "/api/links", JSON.stringify({ url: "https://example.com/x" })))).json();
  for (let k = 0; k < 2; k++) {
    const r = await a(req("GET", `/${slug}`));
    assert.equal(r.status, 302);
    assert.equal(r.headers.get("location"), "https://example.com/x");
  }
  const stats = await (await a(req("GET", `/api/links/${slug}`))).json();
  assert.equal(stats.clicks, 2);
});

test("A3 validation", async () => {
  const a = app();
  for (const url of ["ftp://example.com", "not a url", undefined, "https://user:pw@example.com"]) {
    await expectError(await a(req("POST", "/api/links", JSON.stringify(url === undefined ? {} : { url }))), 400, "invalid_url");
  }
  await expectError(await a(req("POST", "/api/links", "{")), 400, "invalid_json");
  await expectError(await a(req("POST", "/api/links", JSON.stringify({ url: "https://e.com", pad: "x".repeat(5000) }))), 413, "payload_too_large");
});

test("A4 custom slugs", async () => {
  const a = app();
  const first = await a(req("POST", "/api/links", JSON.stringify({ url: "https://example.com", slug: "docs" })));
  assert.equal(first.status, 201);
  assert.equal((await first.json()).slug, "docs");
  await expectError(await a(req("POST", "/api/links", JSON.stringify({ url: "https://example.com", slug: "docs" }))), 409, "slug_taken");
  await expectError(await a(req("POST", "/api/links", JSON.stringify({ url: "https://example.com", slug: "a b" }))), 400, "invalid_slug");
  await expectError(await a(req("POST", "/api/links", JSON.stringify({ url: "https://example.com", slug: "api" }))), 400, "invalid_slug");
});

test("A5 routing", async () => {
  const a = app();
  await expectError(await a(req("GET", "/nope123")), 404, "not_found");
  const put = await a(req("PUT", "/api/links"));
  assert.equal(put.headers.get("allow"), "POST");
  await expectError(put, 405, "method_not_allowed");
  const health = await a(req("GET", "/healthz"));
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });
  await a(req("POST", "/api/links", JSON.stringify({ url: "https://example.com", slug: "docs" })));
  assert.equal((await a(req("GET", "/api/links/docs/"))).status, 200);
});

test("A6 delete", async () => {
  const a = app();
  await a(req("POST", "/api/links", JSON.stringify({ url: "https://example.com", slug: "docs" })));
  await expectError(await a(req("DELETE", "/api/links/docs")), 401, "unauthorized");
  await expectError(await a(req("DELETE", "/api/links/docs", undefined, { authorization: "Bearer wrong" })), 401, "unauthorized");
  const ok = await a(req("DELETE", "/api/links/docs", undefined, { authorization: "Bearer test-admin" }));
  assert.equal(ok.status, 204);
  assert.equal(await ok.text(), "");
  await expectError(await a(req("GET", "/docs")), 404, "not_found");
});

test("A7 error shape", async () => {
  assert.ok(errors.length >= 10);
  for (const res of errors) {
    assert.match(res.headers.get("content-type") ?? "", /^application\/json; charset=utf-8$/);
    const body = await res.json();
    assert.deepEqual(Object.keys(body), ["error"]);
    assert.deepEqual(Object.keys(body.error).sort(), ["code", "message"]);
    assert.ok(body.error.message.length > 0);
  }
});
