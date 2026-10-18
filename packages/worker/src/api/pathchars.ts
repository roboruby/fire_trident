/**
 * Paths with control characters (U+0000 to U+001F, and U+007F: a newline, a tab, NUL, an escape). A file name may hold
 * them in git, but a path with one breaks every line-based reader of a change (a list of paths, a diff header, a
 * terminal), and a newline in a path can pass for two paths. A change naming one is refused where it comes in: the API's
 * path fields (api/schemas.ts), and the colony's intake of every change, whichever way it arrived (ColonyDO.propose).
 * The trunk writer's landing check still refuses NUL.
 */

/** A control character: U+0000 to U+001F, or U+007F. */
const CONTROL = /[\u0000-\u001f\u007f]/;
/** A string with no control character. */
export const NO_CONTROL = /^[^\u0000-\u001f\u007f]*$/;

/** What a request with such a path is told (the API's path fields). */
export const CONTROL_PATH = "a path cannot hold a control character (a newline, a tab, NUL, or another character below U+0020 or U+007F): rename the file without it, then send the request again";

/** Why a change cannot be taken because one of its paths holds a control character (naming the first), or null. */
export function controlPathProblem(paths: Iterable<unknown>): string | null {
  for (const path of paths) {
    if (typeof path === "string" && CONTROL.test(path)) {
      return `the path ${JSON.stringify(path)} holds a control character (a newline, a tab, NUL, or another character below U+0020 or U+007F): rename the file without it, then propose again`;
    }
  }
  return null;
}
