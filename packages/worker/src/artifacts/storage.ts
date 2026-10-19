import type { Id, RepoRef, Sha } from "@fire_trident/core";
import { WORKSPACE_SHARDS, type Env } from "../env.ts";
import { provisionTrunk } from "./colony.ts";
import { errorText } from "./git.ts";
import { ArtifactsRestError, artifactsOverRest, type RestArtifactsOptions, type RestCredentials } from "./rest.ts";
import { SESSIONS_NAMESPACE, TRUNK_NAMESPACE, bindingFor, shardOf, workspaceBinding, workspaceNamespace } from "./shards.ts";

/**
 * Where a colony's repositories live. A colony with no owner is an operator colony: its trunk, workspaces and session
 * repositories are in the deployment's own Artifacts bindings (env.ARTIFACTS, WS0..WS3, SESSIONS), exactly as before
 * accounts, and storageFor hands back those binding objects themselves, unwrapped. A colony a person owns keeps them in
 * that person's Cloudflare account, which they connected to FireTrident: the same namespaces under other names
 * (firetrident-trunk, firetrident-ws-0..3, firetrident-sessions), reached over the Artifacts REST API (artifacts/rest.ts)
 * with the connection's access token, asked for again on every call so a refreshed token is always the one used. Each
 * namespace is created on its first repository. Git needs no change: the API returns a remote and a repository token
 * like the binding does.
 *
 * RepoRefs keep the namespace names FireTrident uses for its bindings (ft-trunk, ft-ws-N, ft-sessions) on an owned
 * colony too: the name says which of the colony's namespaces holds the repository, and the remote names the real one.
 * The colony's trunk RepoRef carries `owner`, set when the trunk is provisioned here (provisionOwnedTrunk), so the
 * objects that serve one colony learn its owner once, from what they are initialized with, and keep it in their own
 * storage: TrunkDO and PoolDO from their stored trunk, ColonyDO from its colony record, AgentDO from its start
 * parameters. A RepoRef's owner is only read from refs the platform recorded itself, never from one a request sent.
 *
 * Accounts and Cloudflare connections belong to other modules. This one takes them through a resolver the Worker
 * installs once (setStorageResolver): the owner of a colony, and the connection of an account. Until one is installed,
 * and whenever FT_ACCOUNTS is not "on", no colony is looked up as owned, and an owned colony's calls are refused with a
 * plain sentence instead of falling back to the deployment's bindings.
 */

/** A FireTrident account id (`acc_...`). */
export type AccountId = string;

/** A person's Cloudflare connection: the Cloudflare account it reaches, a current access token, and the scopes granted. */
export interface CloudflareGrant {
  /** The Cloudflare account. */
  accountId: string;
  accessToken: string;
  scopes: string[];
}

/** The connection of a FireTrident account, refreshed when needed; null when it has none or the refresh failed. */
export type GrantFor = (account: AccountId) => Promise<CloudflareGrant | null>;

/** A colony's Artifacts storage, with the interface of the bindings the code uses. */
export interface ColonyStorage {
  /** The FireTrident account whose Cloudflare account holds the repositories; null for the deployment's own bindings. */
  readonly owner: AccountId | null;
  /** Trunks and lane repos (the deployment's env.ARTIFACTS, namespace ft-trunk). */
  readonly trunk: Artifacts;
  /** Workspace shard `shard` (the deployment's workspaceBinding(env, shard), namespaces ft-ws-0..3). */
  workspace(shard: number): Artifacts;
  /** Agent session and quarantine repos (the deployment's env.SESSIONS, namespace ft-sessions). */
  readonly sessions: Artifacts;
  /** The binding for a namespace a RepoRef names, or null (shards.ts bindingFor for the deployment's own). */
  bindingFor(namespace: string): Artifacts | null;
  /** Every namespace holding the colony's repositories, by its real name, with its binding (colony deletion sweeps them). */
  namespaces(): Array<{ namespace: string; binding: Artifacts }>;
}

/** Namespace names in a person's Cloudflare account. */
export const OWNED_TRUNK_NAMESPACE = "firetrident-trunk";
export const OWNED_SESSIONS_NAMESPACE = "firetrident-sessions";
const OWNED_WORKSPACE_PREFIX = "firetrident-ws-";

/** Namespace of workspace shard `shard` in a person's Cloudflare account (firetrident-ws-0..3). */
export function ownedWorkspaceNamespace(shard: number): string {
  return `${OWNED_WORKSPACE_PREFIX}${shardOf(shard)}`;
}

/** The deployment's own bindings, the very objects the code used before accounts. */
export function operatorStorage(env: Env): ColonyStorage {
  return {
    owner: null,
    trunk: env.ARTIFACTS,
    workspace: (shard) => workspaceBinding(env, shard),
    sessions: env.SESSIONS,
    bindingFor: (namespace) => bindingFor(env, namespace),
    namespaces: () => {
      const all: Array<{ namespace: string; binding: Artifacts | undefined }> = [
        { namespace: TRUNK_NAMESPACE, binding: env.ARTIFACTS },
        ...Array.from({ length: WORKSPACE_SHARDS }, (_, shard) => ({ namespace: workspaceNamespace(shard), binding: workspaceBinding(env, shard) })),
        { namespace: SESSIONS_NAMESPACE, binding: env.SESSIONS },
      ];
      return all.filter((b): b is { namespace: string; binding: Artifacts } => !!b.binding);
    },
  };
}

/** Options for ownedStorage (tests pass a fake server). */
export type OwnedStorageOptions = Pick<RestArtifactsOptions, "fetch" | "base">;

/**
 * A person's storage: the namespaces in the Cloudflare account their connection reaches, over the REST API. The
 * connection is asked for on every call; without one, calls are refused with a plain sentence.
 */
export function ownedStorage(owner: AccountId, grantFor: GrantFor, label: string, opts: OwnedStorageOptions = {}): ColonyStorage {
  const notConnected = `${label}'s repositories are in its owner's Cloudflare account, and that account has no working Cloudflare connection now. The owner can connect Cloudflare again on the account page.`;
  const credentials = async (): Promise<RestCredentials | null> => {
    let grant: CloudflareGrant | null;
    try {
      grant = await grantFor(owner);
    } catch (e) {
      throw new ArtifactsRestError("INTERNAL_ERROR", 0, 0, `The Cloudflare connection of ${label}'s owner could not be read: ${errorText(e)}`);
    }
    return grant && grant.accountId && grant.accessToken ? { accountId: grant.accountId, accessToken: grant.accessToken } : null;
  };
  const make = (namespace: string): Artifacts => artifactsOverRest({ namespace, credentials, notConnected, ...opts });
  const trunk = make(OWNED_TRUNK_NAMESPACE);
  const shards = Array.from({ length: WORKSPACE_SHARDS }, (_, shard) => make(ownedWorkspaceNamespace(shard)));
  const sessions = make(OWNED_SESSIONS_NAMESPACE);
  const workspace = (shard: number): Artifacts => shards[shardOf(shard)]!;
  return {
    owner,
    trunk,
    workspace,
    sessions,
    bindingFor: (namespace) => {
      if (namespace === TRUNK_NAMESPACE || namespace === OWNED_TRUNK_NAMESPACE) return trunk;
      if (namespace === SESSIONS_NAMESPACE || namespace === OWNED_SESSIONS_NAMESPACE) return sessions;
      for (let shard = 0; shard < WORKSPACE_SHARDS; shard++) {
        if (namespace === workspaceNamespace(shard) || namespace === ownedWorkspaceNamespace(shard)) return workspace(shard);
      }
      return null;
    },
    namespaces: () => [
      { namespace: OWNED_TRUNK_NAMESPACE, binding: trunk },
      ...shards.map((binding, shard) => ({ namespace: ownedWorkspaceNamespace(shard), binding })),
      { namespace: OWNED_SESSIONS_NAMESPACE, binding: sessions },
    ],
  };
}

/**
 * A colony's storage. For `owner === null` (an operator colony) it is the deployment's own bindings, the same
 * objects, unwrapped; for an owned colony, the owner's Cloudflare account, the connection refreshed per call through
 * `grantFor`.
 */
export async function storageFor(env: Env, colonyId: Id, owner: AccountId | null, grantFor: GrantFor): Promise<ColonyStorage> {
  return owner === null ? operatorStorage(env) : ownedStorage(owner, grantFor, `Colony ${colonyId}`);
}

// ---------------------------------------------------------------------------
// The resolver the Worker installs (accounts and Cloudflare connections live in other modules)
// ---------------------------------------------------------------------------

/** How this module finds a colony's owner and an account's Cloudflare connection. */
export interface StorageResolver {
  /** The account that owns colony `colonyId`, or null for an operator colony. */
  ownerOf(env: Env, colonyId: Id): Promise<AccountId | null>;
  /** The account's Cloudflare connection, refreshed when needed; null when it has none. */
  grantFor(env: Env, account: AccountId): Promise<CloudflareGrant | null>;
}

let resolver: StorageResolver | null = null;

/** Install the resolver (once, where the Worker starts); null removes it (tests). */
export function setStorageResolver(r: StorageResolver | null): void {
  resolver = r;
}

/** Whether accounts are on for this deployment (FT_ACCOUNTS is "on"). */
function accountsOn(env: Env): boolean {
  return (env as unknown as { FT_ACCOUNTS?: string }).FT_ACCOUNTS?.trim() === "on";
}

/** The installed resolver's grantFor for this env; with none installed every account reads as not connected. */
export function resolverGrantFor(env: Env): GrantFor {
  return (account) => (resolver ? resolver.grantFor(env, account) : Promise.resolve(null));
}

/**
 * The owner of a colony, from the installed resolver, for code that knows only the colony id. Null, with no lookup at
 * all, when no resolver is installed or FT_ACCOUNTS is not "on". Code that holds the colony's trunk RepoRef reads its
 * `owner` instead.
 */
export async function colonyOwnerOf(env: Env, colonyId: Id): Promise<AccountId | null> {
  if (!resolver || !accountsOn(env)) return null;
  return (await resolver.ownerOf(env, colonyId)) ?? null;
}

/**
 * The storage of a colony whose owner is known (a trunk RepoRef's `owner`, or what an object stored): the deployment's
 * own bindings when there is none, else the owner's Cloudflare account through the installed resolver.
 */
export function colonyStorage(env: Env, owner: AccountId | null | undefined): ColonyStorage {
  return owner ? ownedStorage(owner, resolverGrantFor(env), "This colony") : operatorStorage(env);
}

/**
 * `env` with its Artifacts bindings (ARTIFACTS, WS0..WS3, SESSIONS) answered by `storage`, for code that takes an Env
 * and reads the bindings from it (shards.ts bindingFor, the innate checks' blob reader, the quarantine repo). For an
 * operator colony it is `env` itself; otherwise every other binding and variable is the env's own.
 */
export function storageEnv(env: Env, storage: ColonyStorage): Env {
  if (storage.owner === null) return env;
  const value = (binding: Artifacts): PropertyDescriptor => ({ value: binding, enumerable: true });
  return Object.create(env, {
    ARTIFACTS: value(storage.trunk),
    WS0: value(storage.workspace(0)),
    WS1: value(storage.workspace(1)),
    WS2: value(storage.workspace(2)),
    WS3: value(storage.workspace(3)),
    SESSIONS: value(storage.sessions),
  }) as Env;
}

/**
 * Provision an owned colony's trunk in its owner's Cloudflare account (provisionTrunk on that storage): created empty
 * with a README commit, or imported from a public git URL. The trunk RepoRef it returns carries `owner`; pass it to
 * TrunkDO.init, PoolDO.init and ColonyDO.init unchanged, and those objects keep using the owner's account.
 */
export async function provisionOwnedTrunk(
  env: Env,
  colonyId: Id,
  owner: AccountId,
  source?: { url: string; branch?: string },
  grantFor: GrantFor = resolverGrantFor(env),
): Promise<{ trunk: RepoRef; trunkSha: Sha }> {
  return provisionTrunk(env, colonyId, source, await storageFor(env, colonyId, owner, grantFor));
}
