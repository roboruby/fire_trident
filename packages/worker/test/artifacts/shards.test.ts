import { describe, expect, it } from "vitest";
import {
  bindingFor,
  colonySlug,
  seedRepoName,
  shardOf,
  trunkRepoName,
  workspaceBinding,
  workspaceNamespace,
  workspaceRepoName,
} from "../../src/artifacts/shards.ts";
import type { Env } from "../../src/env.ts";

const env = { ARTIFACTS: { ns: "ft-trunk" }, WS0: { ns: 0 }, WS1: { ns: 1 }, WS2: { ns: 2 }, WS3: { ns: 3 }, SESSIONS: { ns: "s" } } as unknown as Env;

describe("shards", () => {
  it("spreads workspaces over four shards by n % 4", () => {
    expect([0, 1, 2, 3, 4, 7, 255].map(shardOf)).toEqual([0, 1, 2, 3, 0, 3, 3]);
    expect(shardOf(-1)).toBe(3);
    expect(workspaceNamespace(6)).toBe("ft-ws-2");
    expect(workspaceBinding(env, 5)).toBe(env.WS1);
  });

  it("maps namespaces to bindings", () => {
    expect(bindingFor(env, "ft-trunk")).toBe(env.ARTIFACTS);
    expect(bindingFor(env, "ft-ws-3")).toBe(env.WS3);
    expect(bindingFor(env, "ft-sessions")).toBe(env.SESSIONS);
    expect(bindingFor(env, "ft-ws-4")).toBeNull();
    expect(bindingFor(env, "elsewhere")).toBeNull();
  });

  it("names repos per colony", () => {
    expect(trunkRepoName("hono")).toBe("hono--trunk");
    expect(workspaceRepoName("hono", 12)).toBe("hono--ws-12");
    expect(seedRepoName("hono")).toBe("hono--seed");
  });

  it("makes any colony id a valid repo name", () => {
    expect(colonySlug("col_mv4t8bij")).toBe("col_mv4t8bij");
    expect(colonySlug("My Colony/2")).toBe("My-Colony-2");
    expect(colonySlug("-x")).toMatch(/^[A-Za-z0-9]/);
    expect(colonySlug("a".repeat(80)).length).toBeLessThanOrEqual(40);
  });
});
