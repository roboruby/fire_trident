import type { Id } from "@fire_trident/core";
import { messageOf } from "../api/logic.ts";
import { accountsStub } from "./client.ts";
import { accountsOn, type AccountsEnv } from "./config.ts";
import type { AccountId } from "./types.ts";

/**
 * Colony ownership. A colony a person created through POST /api/me/colonies is owned by their account from before its
 * objects are made until it is deleted; every other colony has no owner and is an operator colony, served exactly as
 * before (the deployment's Artifacts bindings, its Workers AI binding, the admin token). With FT_ACCOUNTS off nothing
 * is owned and the accounts object is never asked.
 */

/** The account that owns a colony, or null: an operator colony (always null while accounts are off). */
export async function colonyOwner(env: Partial<AccountsEnv>, colonyId: Id): Promise<AccountId | null> {
  if (!accountsOn(env)) return null;
  const stub = accountsStub(env);
  if (!stub) return null;
  return stub.ownerOf(colonyId);
}

/**
 * After the operator deleted a colony (DELETE /api/colonies/:id): its ownership ends and its scoped tokens are revoked,
 * so a later colony of the same name starts as nobody's. Does nothing while accounts are off; a failure is logged and
 * never fails the delete.
 */
export async function releaseOwnership(env: Partial<AccountsEnv>, colonyId: Id): Promise<void> {
  if (!accountsOn(env)) return;
  const stub = accountsStub(env);
  if (!stub) return;
  try {
    await stub.releaseColony(colonyId, Date.now());
  } catch (e) {
    console.error(`accounts: ownership of ${colonyId} not released: ${messageOf(e)}`);
  }
}
