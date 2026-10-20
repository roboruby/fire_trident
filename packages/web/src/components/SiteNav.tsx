import type { ReactNode } from "react";
import { AccountLink } from "../account/AccountLink.tsx";
import { TridentMark } from "./TopBar.tsx";

/** The source repository. */
export const REPO = "https://github.com/roboruby/fire_trident";
/** The architecture document, the site's "Docs" link. */
export const DOCS = `${REPO}/blob/main/docs/ARCHITECTURE.md`;

/** GitHub's mark, for the link to the source. */
export function GithubMark() {
  return (
    <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true">
      <path
        fill="currentColor"
        d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"
      />
    </svg>
  );
}

/**
 * The site's navigation, the same on every page: the sections of the front page, Limits, Connect, Docs, the GitHub
 * mark that links to the source, then the account buttons (Sign in and Request invite, or Account). A page adds its
 * own links with `extra`, and the account page, which is where those buttons lead, leaves them out.
 */
export function SiteNav({ extra, account = true }: { extra?: ReactNode; account?: boolean }) {
  return (
    <header className="l-nav">
      <a className="l-brand" href="/">
        <TridentMark size={28} />
        <span>FireTrident</span>
      </a>
      <nav className="l-links">
        <a href="/#questions">Answers</a>
        <a href="/#results">Results</a>
        <a href="/#how">How it works</a>
        <a href="/#try">Try it</a>
        <a href="/#run">Run it</a>
        <a href="/limits">Limits</a>
        <a href="/connect">Connect</a>
        <a href={DOCS} target="_blank" rel="noreferrer">
          Docs
        </a>
        {extra}
        <a className="l-gh" href={REPO} target="_blank" rel="noreferrer" aria-label="Source on GitHub" title="Source on GitHub">
          <GithubMark />
        </a>
        {account ? <AccountLink /> : null}
      </nav>
    </header>
  );
}
