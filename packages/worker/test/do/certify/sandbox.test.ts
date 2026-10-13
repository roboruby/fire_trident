import { describe, expect, it } from "vitest";
import type { Certification } from "@fire_trident/core";
import { api, eventually, externalLanding, newColony } from "../helpers.ts";

/**
 * The sandbox trunk certification runs a colony's tests in, checked from the inside: a test file
 * lands that tries the network and reads the environment, and it runs in a real Dynamic Worker
 * (Worker Loader) the way every certification does. The two network tests must fail with the
 * runtime's refusal, and the two environment tests must pass (nothing in process.env, no bindings).
 */

/**
 * The fixture. Its specifiers are computed so the loader's static check lets the file run: that
 * check only keeps out tests that cannot run here, it is not the boundary. The boundary is the
 * Worker itself: no outbound network (globalOutbound: null) and no env.
 */
const SANDBOX_TEST = `import { test } from "node:test";
import assert from "node:assert/strict";
test("fetch reaches the network", async () => {
  await fetch("https://example.com/");
});
test("a socket reaches the network", async () => {
  const { connect } = await import(["cloudflare", "sockets"].join(":"));
  const socket = connect("example.com:80");
  await socket.opened;
  await socket.close();
});
test("process.env is empty", () => {
  assert.deepEqual(Object.keys(process.env), []);
});
test("the Worker has no bindings", async () => {
  const { env } = await import(["cloudflare", "workers"].join(":"));
  assert.deepEqual(Object.keys(env), []);
});
`;

const REFUSED = /^Error: This worker is not permitted to access the internet via global functions like fetch\(\)\. It must use capabilities \(such as bindings in 'env'\) to talk to the outside world\./;

describe("the test Worker's sandbox (Dynamic Workers)", () => {
  it("refuses the network and holds no environment: the report says so", async () => {
    const c = await newColony();
    await api("POST", `/colonies/${c.id}/certify/policy`, { repair: false });
    const sha = await externalLanding(c.id, { "test/sandbox.test.ts": SANDBOX_TEST });
    const state = await eventually(
      () => api<{ results: Certification[] }>("GET", `/colonies/${c.id}/certifications`),
      (r) => r.body.results.some((x) => x.trunkSha === sha && x.status !== "running"),
      30_000,
    );
    const cert = state.body.results.find((x) => x.trunkSha === sha);
    expect(cert).toMatchObject({ status: "red", files: 1, counts: { tests: 4, pass: 2, fail: 2, cancelled: 0 } });
    expect(cert!.failing!.map((f) => f.name)).toEqual(["fetch reaches the network", "a socket reaches the network"]);
    for (const f of cert!.failing!) expect(f.error).toMatch(REFUSED);
  });
});
