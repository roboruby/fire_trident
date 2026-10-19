import type { Env } from "../../src/env.ts";
import { AccountsStore, type SqlLike, type SqlValue } from "../../src/accounts/store.ts";
export { CookieJar, FakeGithub, type FakeUser } from "./fake-github.ts";

/**
 * Stand-ins for the accounts tests, all in Node with no network: the accounts object over an in-memory SQLite database
 * (its answers cloned as RPC would) and colony objects that answer every method, with the GitHub and the cookie jar of
 * fake-github.ts (re-exported here).
 */

/** The part of node:sqlite these tests use (the worker compiles against workers types, not Node's). */
interface DatabaseSync {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
  exec(sql: string): void;
}
const SQLITE = "node:sqlite";
const { DatabaseSync } = (await import(SQLITE)) as { DatabaseSync: new (path: string) => DatabaseSync };

/** A fresh accounts store on an in-memory database. */
export function memoryStore(): AccountsStore {
  const db = new DatabaseSync(":memory:");
  const sql: SqlLike = {
    exec<T extends Record<string, SqlValue>>(query: string, ...bindings: SqlValue[]) {
      const rows = db.prepare(query).all(...bindings) as T[];
      return { toArray: () => rows.map((r) => ({ ...r })) };
    },
  };
  const transaction = <T>(fn: () => T): T => {
    db.exec("BEGIN");
    try {
      const out = fn();
      db.exec("COMMIT");
      return out;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  };
  return new AccountsStore(sql, { transaction });
}

/** An ACCOUNTS namespace whose one object is `store`, every answer async and cloned as RPC would clone it. */
export function accountsNamespace(store: AccountsStore): NonNullable<Env["ACCOUNTS"]> {
  const stub = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then") return undefined;
        const fn = (store as unknown as Record<string | symbol, unknown>)[prop];
        if (typeof fn !== "function") return undefined;
        return async (...args: unknown[]) => structuredClone(await (fn as (...a: unknown[]) => unknown).apply(store, structuredClone(args)));
      },
    },
  );
  return { idFromName: () => ({}) as DurableObjectId, get: () => stub } as unknown as NonNullable<Env["ACCOUNTS"]>;
}

/** Calls made to a fake object's methods, in order. */
export type Calls = Array<{ object: string; method: string; args: unknown[] }>;

/**
 * A Durable Object namespace whose objects answer every method: `answers[method]` (a value or a function of the object
 * name and the arguments), else an empty object. Each call is recorded.
 */
export function anyNamespace(kind: string, calls: Calls, answers: Record<string, unknown> = {}): DurableObjectNamespace {
  return {
    idFromName: (name: string) => ({ name }) as unknown as DurableObjectId,
    get: (id: { name: string }) =>
      new Proxy(
        {},
        {
          get(_t, prop) {
            if (prop === "then" || typeof prop !== "string") return undefined;
            return async (...args: unknown[]) => {
              calls.push({ object: `${kind}:${id.name}`, method: prop, args });
              const a = answers[prop];
              return typeof a === "function" ? (a as (name: string, ...rest: unknown[]) => unknown)(id.name, ...args) : (a ?? {});
            };
          },
        },
      ),
  } as unknown as DurableObjectNamespace;
}

export const ORIGIN = "https://ft.test";
export const ADMIN = "test-admin";
export const MCP = "test-mcp";

/** The env of a deployment with accounts on, the accounts object over `store`, and colonies made of `answers`. */
export function accountsEnv(store: AccountsStore, opts: { calls?: Calls; colonies?: Record<string, unknown>; vars?: Partial<Env> } = {}): Env {
  const calls = opts.calls ?? [];
  return {
    FT_ACCOUNTS: "on",
    FT_PUBLIC_URL: ORIGIN,
    FT_GITHUB_CLIENT_ID: "test-client-id",
    FT_GITHUB_CLIENT_SECRET: "test-client-secret",
    FT_SESSION_KEY: "test-session-key-test-session-key-0123",
    FT_ADMIN_TOKEN: ADMIN,
    FT_MCP_TOKEN: MCP,
    ACCOUNTS: accountsNamespace(store),
    COLONY: anyNamespace("colony", calls, { getAgent: null, listAgents: [], listRegions: [], getColony: null, ...opts.colonies }),
    TRUNK: anyNamespace("trunk", calls, { init: { trunkSha: "a".repeat(40) } }),
    POOL: anyNamespace("pool", calls),
    REGION: anyNamespace("region", calls),
    ...opts.vars,
  } as unknown as Env;
}
