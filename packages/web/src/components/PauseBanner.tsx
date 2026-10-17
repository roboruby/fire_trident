import { pauseBanner, type PauseBanner as Banner } from "../pause.ts";
import type { ColonyStore } from "../store.ts";
import { useThrottledVersion } from "../useStore.ts";

/**
 * The pause banner over the colony map (pause.ts): while a person has paused the colony's agents (or the
 * deployment's), it says who paused and why, what holds and what still works, and the command that resumes. It
 * renders nothing while agents may work.
 */
export function PauseBanner({ store }: { store: ColonyStore }) {
  useThrottledVersion(store, 500);
  if (!store.loaded) return null;
  return <PauseBannerView banner={pauseBanner(store.pauses, store.colony?.id ?? store.colonyId)} replay={store.replay !== null} />;
}

/** The banner itself, from what pauseBanner says (a replay shows the pause as it stood, with no command). */
export function PauseBannerView({ banner, replay = false }: { banner: Banner | null; replay?: boolean }) {
  if (!banner) return null;
  return (
    <section className="pause-banner" role="status" aria-label="Agents are paused">
      <span className="pause-k">Paused</span>
      <span className="pause-headline">{banner.headline}</span>
      <span className="pause-detail">{banner.detail}</span>
      {replay ? null : (
        <span className="pause-command">
          Resume: <code className="mono">{banner.command}</code>
        </span>
      )}
    </section>
  );
}
