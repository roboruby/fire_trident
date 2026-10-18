import { speaker } from "@fire_trident/core";
import { SaidBy } from "./SaidBy.tsx";

/** Characters of a preview address that is shown as text (not linked) at most. */
const TEXT_CHARS = 120;

/**
 * The preview address an agent gave, when it may be a link: an https:// URL with a host, written without spaces or
 * control characters. Null for anything else, such as a javascript: or data: address stored before the API refused them.
 */
export function previewHref(url: unknown): string | null {
  if (typeof url !== "string" || !/^https:\/\//i.test(url) || /[\s\u0000-\u001f\u007f]/.test(url)) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname !== "" ? url : null;
  } catch {
    return null;
  }
}

/** A preview address as plain text: one line, cut to TEXT_CHARS. */
function asText(url: string): string {
  const t = url.replace(/[\s\u0000-\u001f\u007f]+/g, " ").trim();
  return t.length > TEXT_CHARS ? `${t.slice(0, TEXT_CHARS - 1)}…` : t;
}

/**
 * The agent's preview on the Why tab: a link for an https address, and the address as plain text, never a link, for
 * anything else (old data from before the API took only https), so no other scheme can run from the page.
 */
export function PreviewLine({ url }: { url: string | undefined }) {
  if (!url) return null;
  const href = previewHref(url);
  return (
    <span className="lin-preview-row">
      {href ? (
        <a className="link lin-preview" href={href} target="_blank" rel="noreferrer">
          Preview
        </a>
      ) : (
        <span className="lin-preview lin-muted" style={{ overflowWrap: "anywhere" }} title="Not an https address, so it is shown as text and not linked.">
          Preview (not linked, not an https address): {asText(url)}
        </span>
      )}{" "}
      <SaidBy s={speaker("agent")} />
    </span>
  );
}
