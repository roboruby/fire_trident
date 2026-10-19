import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env.ts";
import { connectConfig } from "./config.ts";
import { GrantService } from "./service.ts";
import type { AccountId, CloudflareGrant, ConnectResult, GrantStatus } from "./types.ts";

/**
 * One FireTrident account's Cloudflare connection (binding CF_GRANTS, one object per account by name: the account id).
 * A thin shell over GrantService (cloudflare/service.ts): the object serializes the account's refreshes, so two callers
 * never spend one refresh token, and its storage holds the tokens only sealed with FT_GRANT_KEY.
 */
export class CloudflareGrantDO extends DurableObject<Env> {
  private readonly service: GrantService;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.service = new GrantService({ sql: ctx.storage.sql, config: connectConfig(env), fetch: (input, init) => fetch(input, init) });
    ctx.blockConcurrencyWhile(async () => this.service.migrate());
  }

  /** Remember a started connection (see GrantService.begin). */
  begin(account: AccountId, stateHash: string, verifier: string): Promise<void> {
    return this.service.begin(account, stateHash, verifier);
  }

  /** Finish a started connection (see GrantService.complete). */
  complete(account: AccountId, stateHash: string, code: string): Promise<ConnectResult> {
    return this.service.complete(account, stateHash, code);
  }

  /** The connection as the account page shows it. */
  status(account: AccountId): GrantStatus {
    return this.service.status(account);
  }

  /** Choose the Cloudflare account. */
  choose(account: AccountId, cfAccountId: string): ConnectResult {
    return this.service.choose(account, cfAccountId);
  }

  /** A current access token, renewed near expiry; null when there is none. */
  grant(account: AccountId): Promise<CloudflareGrant | null> {
    return this.service.grant(account);
  }

  /** Revoke at Cloudflare and forget. */
  disconnect(account: AccountId): Promise<{ disconnected: boolean; revoked: boolean }> {
    return this.service.disconnect(account);
  }
}
