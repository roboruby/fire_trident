import { useEffect, useState } from "react";
import { fmtInt, shortSha } from "../format.ts";
import { PICTURE_FILE, fetchPicture, hasPicture, pictureLanding, type Picture as Grid } from "../picture.ts";
import type { ColonyStore } from "../store.ts";
import { useThrottledVersion } from "../useStore.ts";
import "./picture.css";

/**
 * The picture panel over a replay's map (picture.ts): for a colony whose trunk has mosaic.json at its root, the grid as
 * that file held it at the replay's newest landing of it, so the picture fills in tile by tile as the changes land. It
 * keeps the last picture drawn while the next one is read, and renders nothing for a colony without the file.
 */
export function Picture({ store }: { store: ColonyStore }) {
  useThrottledVersion(store, 250);
  const at = store.loaded ? pictureLanding(store.landings) : null;
  const state = usePicture(store.colonyId, at?.trunkSha ?? null);
  if (!store.loaded || !hasPicture(store.files, store.landings)) return null;
  return <PictureView picture={state.picture} commit={state.commit} error={at && state.error && state.errorAt === at.trunkSha ? state.error : null} waiting={at === null} />;
}

/** What the panel shows: the last picture drawn and its commit, and the error of the newest read when it failed. */
interface Shown {
  picture: Grid | null;
  commit: string | null;
  error: string | null;
  errorAt: string | null;
}

/** The picture at `trunkSha`, read once per commit; the last one drawn stays while the next is read or when it fails. */
function usePicture(colonyId: string, trunkSha: string | null): Shown {
  const [shown, setShown] = useState<Shown>({ picture: null, commit: null, error: null, errorAt: null });
  useEffect(() => {
    if (!trunkSha) {
      setShown({ picture: null, commit: null, error: null, errorAt: null });
      return;
    }
    let live = true;
    fetchPicture(colonyId, trunkSha).then(
      (picture) => {
        if (live) setShown({ picture, commit: trunkSha, error: null, errorAt: null });
      },
      (e: unknown) => {
        if (live) setShown((cur) => ({ ...cur, error: e instanceof Error ? e.message : "The picture could not be read.", errorAt: trunkSha }));
      },
    );
    return () => {
      live = false;
    };
  }, [colonyId, trunkSha]);
  return shown;
}

/** The panel itself: the grid, how many tiles are filled, and the commit it was read at (or why there is nothing yet). */
export function PictureView({ picture, commit, error = null, waiting = false }: { picture: Grid | null; commit: string | null; error?: string | null; waiting?: boolean }) {
  const total = picture ? picture.rows * picture.cols : 0;
  return (
    <section className="picture" aria-label={`The picture in ${PICTURE_FILE}`}>
      <div className="picture-head">
        <span className="picture-k">Picture</span>
        {picture ? <span className="picture-count">{`${fmtInt(picture.filled)} of ${fmtInt(total)} tiles`}</span> : null}
      </div>
      {picture ? (
        <div className="picture-grid" role="img" aria-label={`${fmtInt(picture.filled)} of ${fmtInt(total)} tiles filled`} style={{ gridTemplateColumns: `repeat(${picture.cols}, 1fr)` }}>
          {picture.tiles.map((t) => (
            <i key={`${t.r}:${t.c}`} className={t.color ? "picture-tile is-filled" : "picture-tile"} style={t.color ? { backgroundColor: t.color } : undefined} title={`tile (${t.r}, ${t.c})${t.color ? ` ${t.color}` : ", empty"}`} />
          ))}
        </div>
      ) : null}
      <div className="picture-foot">
        {picture && commit ? (
          <>
            <span className="mono">{PICTURE_FILE}</span> at <span className="mono">{shortSha(commit)}</span>
          </>
        ) : waiting ? (
          `The picture appears when ${PICTURE_FILE} lands.`
        ) : error ? null : (
          `Reading ${PICTURE_FILE}…`
        )}
      </div>
      {error ? <div className="picture-error">{`The picture could not be read: ${error}`}</div> : null}
    </section>
  );
}
