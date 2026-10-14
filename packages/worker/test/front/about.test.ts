import { describe, expect, it } from "vitest";
import { COLONY_FLAGS, NOT_FLAGS, OTHER_FLAGS, about, aboutResponse, flagsOn, type AboutEnv } from "../../src/front/about.ts";

/** GET /api/about: which build is serving and which flags are on, by name only, from the Worker's env. */

/** The part of node:fs these tests use (the worker compiles against workers types, not Node's). */
interface Fs {
  readFileSync(path: URL, encoding: "utf8"): string;
}
const FS = "node:fs";
const { readFileSync } = (await import(FS)) as Fs;
// The tests run in Node, where a module knows its own URL (the workers types leave it out).
const HERE = (import.meta as ImportMeta & { url: string }).url;

const META = { id: "3f2a1b9c-0d4e-4f6a-9b8c-7d6e5f4a3b2c", tag: "f9c7aad", timestamp: "2026-10-14T18:02:11.123Z" };
const FLAG_NAMES = new Set([...COLONY_FLAGS, ...Object.keys(OTHER_FLAGS)]);
const env = (vars: Record<string, unknown>) => vars as AboutEnv;

describe("GET /api/about", () => {
  it("names the commit, the Worker version, its tag and when it was deployed", () => {
    expect(about(env({ FT_BUILD: "f9c7aad", CF_VERSION_METADATA: META }))).toEqual({
      service: "firetrident",
      commit: "f9c7aad",
      versionId: META.id,
      versionTag: "f9c7aad",
      deployedAt: "2026-10-14T18:02:11.123Z",
      flags: [],
      noteKey: null,
    });
  });

  it("names the key that signs lineage notes, as its caller derived it, and only a key id", () => {
    expect(about(env({ FT_BUILD: "f9c7aad" }), "0123456789abcdef").noteKey).toBe("0123456789abcdef");
    for (const odd of ["0123456789ABCDEF", "0123456789abcdef0", "", null]) expect(about(env({}), odd).noteKey).toBeNull();
  });

  it("answers null for what the deployment does not say, and for odd values", () => {
    expect(about(env({}))).toEqual({ service: "firetrident", commit: null, versionId: null, versionTag: null, deployedAt: null, flags: [], noteKey: null });
    const odd = about(env({ FT_BUILD: "f9c7aad; echo hi", CF_VERSION_METADATA: { id: "not an id", tag: "", timestamp: "yesterday" } }));
    expect(odd).toMatchObject({ commit: null, versionId: null, versionTag: null, deployedAt: null });
    expect(about(env({ FT_BUILD: " f9c7aad-dirty ", CF_VERSION_METADATA: { id: META.id, tag: "x\u0007", timestamp: META.timestamp } }))).toMatchObject({
      commit: "f9c7aad-dirty",
      versionId: META.id,
      versionTag: null,
    });
  });

  it("lists the flags that are on, for every colony or for some, sorted, and never one that is off", () => {
    const on = {
      FT_TEXT_MERGE: "on",
      FT_REVALIDATE: "hono, shortlinks",
      FT_INLINE: "ON",
      FT_AGENT_CALL_BUDGET: "8,40",
      FT_TRUNK_TESTS: "on",
      FT_IMPORT_WEIGHT: 1,
      FT_PUBLIC_GIT: "hono,byo-demo",
      FT_PUBLIC_MCP: "hono",
      FT_TEST_PUSH_DELAY_MS: "8000",
    };
    const off = {
      FT_RESOLVER: "off",
      FT_MEGAFILE: "",
      FT_CULPRITS: " , ",
      FT_AGENT_CALL_BUDGET_X: "on",
      FT_GOAL_CONFLICT: undefined,
      FT_FIELD_GUIDE: true,
      FT_ASYNC_PUBLISH: 1,
    };
    expect(flagsOn({ ...on, ...off })).toEqual([
      "FT_AGENT_CALL_BUDGET",
      "FT_IMPORT_WEIGHT",
      "FT_INLINE",
      "FT_PUBLIC_GIT",
      "FT_PUBLIC_MCP",
      "FT_REVALIDATE",
      "FT_TEST_PUSH_DELAY_MS",
      "FT_TEXT_MERGE",
      "FT_TRUNK_TESTS",
    ]);
    // Each flag is read the way the code that uses it reads it.
    expect(flagsOn({ FT_AGENT_CALL_BUDGET: "fast", FT_TRUNK_TESTS: "yes", FT_IMPORT_WEIGHT: "0", FT_PUBLIC_GIT: "BAD--name", FT_TEST_PUSH_DELAY_MS: "-5" })).toEqual([]);
    expect(flagsOn({ FT_IMPORT_WEIGHT: "Infinity", FT_LAG_PROBE: "1" })).toEqual(["FT_LAG_PROBE"]);
  });

  it("never shows a secret or a setting, by value or by name", () => {
    const secrets = { FT_ADMIN_TOKEN: "s3cret-admin-token", FT_MCP_TOKEN: "on", ANTHROPIC_API_KEY: "not-a-real-model-key", FT_OPEN_WRITES: "1", FT_NOTE_KEY: '{"kty":"OKP","crv":"Ed25519","d":"not-a-real-key"}' };
    const settings = { FT_PUBLIC_URL: "https://firetrident.com", FT_DEFAULT_MODEL: "@cf/model", FT_COCHANGE_WEIGHT: "5", FT_LATERAL_INHIBITION: "on" };
    const text = JSON.stringify(about(env({ ...secrets, ...settings, FT_DELETION_GUARD: "on" })));
    expect(JSON.parse(text).flags).toEqual(["FT_DELETION_GUARD"]);
    for (const [name, value] of Object.entries({ ...secrets, ...settings })) {
      expect(text).not.toContain(name);
      if (value.length > 2) expect(text).not.toContain(value);
    }
  });

  it("answers JSON that no cache keeps", async () => {
    const res = aboutResponse(env({ FT_BUILD: "abc1234", FT_INLINE: "on" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toMatchObject({ service: "firetrident", commit: "abc1234", flags: ["FT_INLINE"] });
  });
});

describe("which names are flags", () => {
  const envSource = readFileSync(new URL("../../src/env.ts", HERE), "utf8");
  const declared = [...envSource.matchAll(/^\s+(FT_[A-Z0-9_]+)\??:/gm)].map((m) => m[1] as string);
  const config = JSON.parse(readFileSync(new URL("../../wrangler.jsonc", HERE), "utf8")) as { vars: Record<string, string>; previews: { vars: Record<string, string> } };

  it("every FT_ variable in env.ts is a flag or a setting, so a new flag cannot go unlisted", () => {
    expect(declared.length).toBeGreaterThan(20);
    const unclassified = declared.filter((name) => !FLAG_NAMES.has(name) && !NOT_FLAGS.includes(name));
    expect(unclassified, "add each to COLONY_FLAGS or OTHER_FLAGS (or NOT_FLAGS) in src/front/about.ts").toEqual([]);
  });

  it("the lists name only variables env.ts declares, and none twice", () => {
    const all = [...COLONY_FLAGS, ...Object.keys(OTHER_FLAGS), ...NOT_FLAGS];
    expect(new Set(all).size).toBe(all.length);
    expect(all.filter((name) => !declared.includes(name))).toEqual([]);
  });

  it("every variable production and previews set is classified, and the settings among them are never listed", () => {
    for (const vars of [config.vars, config.previews.vars]) {
      const names = Object.keys(vars).filter((name) => name.startsWith("FT_"));
      expect(names.filter((name) => !FLAG_NAMES.has(name) && !NOT_FLAGS.includes(name))).toEqual([]);
      expect(flagsOn(vars).filter((name) => NOT_FLAGS.includes(name))).toEqual([]);
      expect(flagsOn(vars)).toContain("FT_TRUNK_TESTS");
    }
  });
});
