import { issueLabel, issueOf, issueTitle } from "../issues.ts";

/**
 * The public GitHub issue an imported intent came from (worker colony/issues.ts), as a link: a badge on the intent's
 * row in the Intents tab, and a line under the intent of a landing card in the Why tab. Nothing when the intent names
 * no issue. The link opens GitHub in a new tab and never sends this page as the referrer.
 */

/** The badge on an intent's row; a click opens the issue without picking the row's file. */
export function IssueBadge({ external }: { external: unknown }) {
  const e = issueOf(external);
  if (!e) return null;
  return (
    <a className="ibadge ibadge-closure" href={e.url} target="_blank" rel="noopener noreferrer nofollow" title={issueTitle(e)} onClick={(ev) => ev.stopPropagation()} onKeyDown={(ev) => ev.stopPropagation()}>
      issue {issueLabel(e)}
    </a>
  );
}

/** The line under a landing card's intent: the issue it came from, and who opened it. */
export function IssueLine({ external }: { external: unknown }) {
  const e = issueOf(external);
  if (!e) return null;
  return (
    <div className="lin-why" title={issueTitle(e)}>
      From the public issue{" "}
      <a href={e.url} target="_blank" rel="noopener noreferrer nofollow">
        {issueLabel(e)}
      </a>
      {e.author ? ` opened by @${e.author}` : ""}: imported text, reviewed as untrusted.
    </div>
  );
}
