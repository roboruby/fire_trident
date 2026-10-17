import { useEffect, useState } from "react";
import { fetchRoot, rootTitle, type ColonyRoot } from "../root.ts";
import type { ColonyStore } from "../store.ts";

/**
 * The colony's root commit under its name in the top bar (root.ts): one muted line, the full commit so it can be copied,
 * with how to pin a clone to it on hover. Nothing for the simulator, whose colony is in no repository, and until the
 * server answers with one.
 */

/** The line itself: nothing without a root. */
export function RootCommitTag({ root }: { root: ColonyRoot | null }) {
  if (!root) return null;
  return (
    <span className="signed-by root-commit mono" title={rootTitle(root)} data-root={root.sha}>
      root {root.sha}
    </span>
  );
}

/** The top bar's root line for this colony (see the module comment). */
export function RootCommit({ store, mock }: { store: ColonyStore; mock: boolean }) {
  const [root, setRoot] = useState<ColonyRoot | null>(null);
  useEffect(() => {
    setRoot(null);
    if (mock) return;
    let live = true;
    void fetchRoot(store.colonyId).then((r) => {
      if (live) setRoot(r);
    });
    return () => {
      live = false;
    };
  }, [store.colonyId, mock]);
  return <RootCommitTag root={root} />;
}
