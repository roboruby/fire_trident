import { buildLabel, buildTitle, commitHref, type About } from "../about.ts";

/**
 * "build <commit>" in muted text, linking to the commit, with the Worker version, deploy time and flags on hover; the
 * Worker version when the deployment names no commit, and nothing when the server says neither.
 */
export function BuildTag({ about, className }: { about: About | null; className?: string }) {
  const label = buildLabel(about);
  if (!about || !label) return null;
  const cls = className ? `build-tag mono ${className}` : "build-tag mono";
  const href = commitHref(about);
  const title = buildTitle(about);
  return href ? (
    <a className={cls} href={href} target="_blank" rel="noreferrer" title={title}>
      {label}
    </a>
  ) : (
    <span className={cls} title={title}>
      {label}
    </span>
  );
}
