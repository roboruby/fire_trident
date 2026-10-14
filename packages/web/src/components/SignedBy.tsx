import { useEffect, useState } from "react";
import type { About } from "../about.ts";
import { KEYS_PATH, signedKeyOf } from "../signed.ts";
import type { ColonyStore } from "../store.ts";
import { fetchNoteCheck } from "../verified.ts";

/**
 * "notes signed by <key id>" under the colony's name in the top bar: shown when GET /api/about names the key that signs
 * lineage notes and this colony's newest landing's note checks intact and signed (GET /notes/verify?landing=, the same
 * read as the badge in the Why tab). Nothing for the simulator, for a deployment that does not sign, and until the check
 * answers; a note whose push is due is asked again a few times, and a landing that arrives meanwhile is checked in turn.
 */

/** A note whose push is due is checked again this many times, this far apart. */
const PENDING_RETRIES = 3;
const PENDING_RETRY_MS = 5_000;

/** The key the colony's newest note is signed by, once its check answers; null until then, when it is not signed, and when `noteKey` is null. */
export function useNewestSigned(store: ColonyStore, noteKey: string | null, enabled: boolean): string | null {
  const newest = store.landings[store.landings.length - 1]?.id ?? null;
  const [keyId, setKeyId] = useState<string | null>(null);
  const [retry, setRetry] = useState<{ id: string | null; n: number }>({ id: null, n: 0 });
  useEffect(() => {
    if (!enabled || !noteKey || !newest) return;
    let live = true;
    let timer = 0;
    const n = retry.id === newest ? retry.n : 0;
    fetchNoteCheck(store.colonyId, newest).then(
      (check) => {
        if (!live) return;
        const signed = signedKeyOf(check);
        if (signed) setKeyId(signed);
        else if (check?.status === "pending" && n < PENDING_RETRIES) timer = window.setTimeout(() => setRetry({ id: newest, n: n + 1 }), PENDING_RETRY_MS);
        else if (check && check.status !== "pending") setKeyId(null);
      },
      () => {
        // The check could not be read: the indicator keeps what it last knew.
      },
    );
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [enabled, noteKey, newest, store.colonyId, retry]);
  return enabled && noteKey ? keyId : null;
}

/** The indicator: one muted line linking to the published keys, with what it means on hover; nothing without a key. */
export function SignedByTag({ keyId }: { keyId: string | null }) {
  if (!keyId) return null;
  const title = `The trunk writer signs each landing's commit with Ed25519 key ${keyId}, published at ${KEYS_PATH}, and this colony's newest note checks intact and signed by it. Any git client can check a clone of the colony with scripts/verify_note.mjs --keys.`;
  return (
    <a className="signed-by mono" href={KEYS_PATH} target="_blank" rel="noreferrer" title={title}>
      notes signed by {keyId}
    </a>
  );
}

/** The top bar's indicator for this colony (see the module comment): off for the simulator, whose notes are in no repository. */
export function SignedBy({ store, about, mock }: { store: ColonyStore; about: About | null; mock: boolean }) {
  const keyId = useNewestSigned(store, about?.noteKey ?? null, !mock);
  return <SignedByTag keyId={keyId} />;
}
