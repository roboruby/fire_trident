import type { Id } from "@fire_trident/core";
import { WORKSPACE_SHARDS, type Env } from "../env.ts";

/** Namespace of trunks and lane repos (binding ARTIFACTS). */
export const TRUNK_NAMESPACE = "ft-trunk";
/** Namespace of in-platform agent session repos (binding SESSIONS). */
export const SESSIONS_NAMESPACE = "ft-sessions";
const WORKSPACE_PREFIX = "ft-ws-";
/** Longest colony slug, so `<slug>--ws-<n>` stays a short, valid repo name. */
const SLUG_MAX = 40;

/** Shard (0..WORKSPACE_SHARDS-1) that holds workspace number `n`. */
export function shardOf(n: number): number {
  return ((Math.floor(n) % WORKSPACE_SHARDS) + WORKSPACE_SHARDS) % WORKSPACE_SHARDS;
}

/** Namespace name of workspace shard `shard` (ft-ws-0..3). */
export function workspaceNamespace(shard: number): string {
  return `${WORKSPACE_PREFIX}${shardOf(shard)}`;
}

/** The Artifacts binding for workspace shard `shard` (WS0..WS3). */
export function workspaceBinding(env: Env, shard: number): Artifacts {
  switch (shardOf(shard)) {
    case 0:
      return env.WS0;
    case 1:
      return env.WS1;
    case 2:
      return env.WS2;
    default:
      return env.WS3;
  }
}

/** The binding that serves `namespace`, or null when this Worker has none for it. */
export function bindingFor(env: Env, namespace: string): Artifacts | null {
  if (namespace === TRUNK_NAMESPACE) return env.ARTIFACTS;
  if (namespace === SESSIONS_NAMESPACE) return env.SESSIONS ?? null;
  if (namespace.startsWith(WORKSPACE_PREFIX)) {
    const shard = Number(namespace.slice(WORKSPACE_PREFIX.length));
    if (Number.isInteger(shard) && shard >= 0 && shard < WORKSPACE_SHARDS) return workspaceBinding(env, shard);
  }
  return null;
}

/**
 * Repo-name-safe form of a colony id. Artifacts names start with a letter or digit and
 * continue with letters, digits, ".", "_" or "-"; anything else becomes "-".
 */
export function colonySlug(colonyId: Id): string {
  let slug = colonyId.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, SLUG_MAX);
  if (!/^[A-Za-z0-9]/.test(slug)) slug = `c${slug}`.slice(0, SLUG_MAX);
  return slug;
}

/** Trunk repo of a colony, in TRUNK_NAMESPACE: `<colony>--trunk`. */
export function trunkRepoName(colonyId: Id): string {
  return `${colonySlug(colonyId)}--trunk`;
}

/** Workspace repo number `n` of a colony, in shard `shardOf(n)`: `<colony>--ws-<n>`. */
export function workspaceRepoName(colonyId: Id, n: number): string {
  return `${colonySlug(colonyId)}--ws-${Math.floor(n)}`;
}

/**
 * Per-shard fork source of a colony's workspaces: `<colony>--seed`. Forks stay in their
 * source namespace, so every workspace shard holds one seed that mirrors trunk.
 */
export function seedRepoName(colonyId: Id): string {
  return `${colonySlug(colonyId)}--seed`;
}
