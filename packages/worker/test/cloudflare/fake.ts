import { connectConfig } from "../../src/cloudflare/config.ts";
import type { GrantObject } from "../../src/cloudflare/grant.ts";
import { GrantService, type SqlRunner } from "../../src/cloudflare/service.ts";
import { CLIENT_ID, CLIENT_SECRET, GRANT_KEY, PUBLIC_URL, type FakeCloudflare } from "./fake-cloudflare.ts";
export * from "./fake-cloudflare.ts";

/**
 * The connect tests' deployment (no network): the fake Cloudflare (fake-cloudflare.ts, re-exported here) and a CF_GRANTS
 * whose objects are GrantServices on in-memory SQLite.
 */

/** The part of node:sqlite these tests use (the worker compiles against workers types, not Node's). */
interface DatabaseSync {
  prepare(sql: string): { all(...params: unknown[]): unknown[]; run(...params: unknown[]): unknown };
  exec(sql: string): void;
}
const SQLITE = "node:sqlite";
const { DatabaseSync } = (await import(SQLITE)) as { DatabaseSync: new (path: string) => DatabaseSync };

/** An in-memory SQLite as a Durable Object's sql. */
export function memorySql(): { sql: SqlRunner; db: DatabaseSync } {
  const db = new DatabaseSync(":memory:");
  // Run at once, as a Durable Object's sql.exec does (a write never calls toArray).
  const exec = (query: string, ...bindings: unknown[]) => {
    const rows = db.prepare(query).all(...bindings);
    return { toArray: () => rows };
  };
  return { db, sql: { exec } };
}

/** A deployment's env for the connect routes, with a fake CF_GRANTS: one GrantService per account on in-memory SQLite. */
export function connectEnv(fake: FakeCloudflare, over: Record<string, unknown> = {}) {
  const services = new Map<string, { service: GrantService; db: DatabaseSync }>();
  const env: Record<string, unknown> = {
    FT_ACCOUNTS: "on",
    FT_PUBLIC_URL: PUBLIC_URL,
    FT_CF_CLIENT_ID: CLIENT_ID,
    FT_CF_CLIENT_SECRET: CLIENT_SECRET,
    FT_GRANT_KEY: GRANT_KEY,
    ...over,
  };
  env.CF_GRANTS = {
    idFromName: (name: string) => name,
    get: (id: string): GrantObject => {
      let s = services.get(id);
      if (!s) {
        const { sql, db } = memorySql();
        const service = new GrantService({ sql, config: connectConfig(env as never), fetch: fake.fetch, now: () => fake.clock.now });
        service.migrate();
        s = { service, db };
        services.set(id, s);
      }
      return s.service;
    },
  };
  return { env, services };
}
