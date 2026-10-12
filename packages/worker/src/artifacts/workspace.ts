import { Workspace } from "@cloudflare/computer";
import type { PromiseFsClient } from "isomorphic-git";
import { glueFs, type ProviderLike } from "./git.ts";

/** Persistent isomorphic-git fs for a Durable Object: a @cloudflare/computer Workspace on its SQLite storage. */
export function durableFs(storage: DurableObjectStorage): PromiseFsClient {
  const ws = new Workspace({ storage: storage as never });
  return glueFs(ws.provider() as unknown as ProviderLike);
}
