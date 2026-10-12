import { useCallback, useRef, useSyncExternalStore } from "react";
import type { ColonyStore } from "./store.ts";

/**
 * Re-render a component when the store changes, at most once every `ms`.
 * Returns the store version the component last rendered with.
 */
export function useThrottledVersion(store: ColonyStore, ms = 250): number {
  const published = useRef(store.version);
  const subscribe = useCallback(
    (notify: () => void) => {
      let timer = 0;
      let last = 0;
      const flush = () => {
        timer = 0;
        last = performance.now();
        if (published.current !== store.version) {
          published.current = store.version;
          notify();
        }
      };
      const unsubscribe = store.subscribe(() => {
        if (timer) return;
        timer = window.setTimeout(flush, Math.max(0, ms - (performance.now() - last)));
      });
      // Pick up anything that changed between render and subscribe.
      timer = window.setTimeout(flush, 0);
      return () => {
        unsubscribe();
        if (timer) window.clearTimeout(timer);
      };
    },
    [store, ms],
  );
  return useSyncExternalStore(subscribe, () => published.current);
}
