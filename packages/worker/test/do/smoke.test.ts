/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { SELF } from "cloudflare:test";
import { expect, it } from "vitest";

it("boots the harness worker", async () => {
  const res = await SELF.fetch("https://ft.test/api");
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ service: "firetrident" });
});
