import { useEffect, useState } from "react";
import { REPO } from "./landing/questions.ts";

/**
 * Which build is serving this page, from GET /api/about (packages/worker/src/front/about.ts): every page shows
 * "build <commit>" in its footer or top bar.
 */

/** What GET /api/about says, read defensively. */
export interface About {
  /** The short git commit the deployment was built from (FT_BUILD). */
  commit: string | null;
  /** The Worker version serving the request, and its tag. */
  versionId: string | null;
  versionTag: string | null;
  /** When that version was deployed, ISO 8601. */
  deployedAt: string | null;
  /** The flags that are on, by name. */
  flags: string[];
  /** The id of the key that signs lineage notes (16 hex digits), published at /.well-known/firetrident-keys.json; null when landings are not signed. */
  noteKey: string | null;
}

/** A short single-line string, or null. */
function text(x: unknown, max: number): string | null {
  if (typeof x !== "string") return null;
  const s = x.trim();
  return s && s.length <= max && !/[\u0000-\u001f\u007f]/.test(s) ? s : null;
}

/** Read /api/about's answer: a field of the wrong type is null (flags: dropped); anything but an object is null. */
export function parseAbout(x: unknown): About | null {
  if (typeof x !== "object" || x === null || Array.isArray(x)) return null;
  const o = x as Record<string, unknown>;
  const at = typeof o.deployedAt === "string" ? Date.parse(o.deployedAt) : Number.NaN;
  return {
    commit: text(o.commit, 40),
    versionId: text(o.versionId, 64),
    versionTag: text(o.versionTag, 100),
    deployedAt: Number.isFinite(at) ? new Date(at).toISOString() : null,
    flags: Array.isArray(o.flags) ? o.flags.filter((f): f is string => typeof f === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(f)) : [],
    noteKey: typeof o.noteKey === "string" && /^[0-9a-f]{16}$/.test(o.noteKey) ? o.noteKey : null,
  };
}

/** "build f9c7aad"; without a commit, "version 3f2a1b9c" (the Worker version); null when the server says neither. */
export function buildLabel(a: About | null): string | null {
  if (a?.commit) return `build ${a.commit}`;
  if (a?.versionId) return `version ${a.versionId.slice(0, 8)}`;
  return null;
}

/** The whole answer behind the label, for a tooltip: commit, Worker version and tag, deploy time in UTC, flags on. */
export function buildTitle(a: About): string {
  const parts: string[] = [];
  if (a.commit) parts.push(`Commit ${a.commit}`);
  if (a.versionId) parts.push(`Worker version ${a.versionId}${a.versionTag ? ` (tag ${a.versionTag})` : ""}`);
  if (a.deployedAt) parts.push(`deployed ${a.deployedAt.slice(0, 16).replace("T", " ")} UTC`);
  parts.push(a.flags.length > 0 ? `flags on: ${a.flags.join(", ")}` : "no flags on");
  return parts.join(" · ");
}

/** The commit in the source repository, when the server names one that looks like a git commit ("f9c7aad-dirty" links to f9c7aad). */
export function commitHref(a: About | null): string | null {
  const m = a?.commit ? /^[0-9a-f]{7,40}(?![0-9a-z])/i.exec(a.commit) : null;
  return m ? `${REPO}/commit/${m[0]}` : null;
}

/** GET /api/about with `fetcher`: null when the server does not answer it (an older deployment answers 404). */
export async function fetchAbout(fetcher: typeof fetch): Promise<About | null> {
  try {
    const res = await fetcher("/api/about", { headers: { accept: "application/json" } });
    return res.ok ? parseAbout(await res.json()) : null;
  } catch {
    return null;
  }
}

let shared: Promise<About | null> | null = null;

/** GET /api/about once per page load: the top bar and the footer share one request. */
export function loadAbout(): Promise<About | null> {
  shared ??= fetchAbout((input, init) => fetch(input, init));
  return shared;
}

/** The build serving this page, once /api/about answers; null until then, and when it never does. */
export function useAbout(): About | null {
  const [about, setAbout] = useState<About | null>(null);
  useEffect(() => {
    let live = true;
    void loadAbout().then((a) => {
      if (live) setAbout(a);
    });
    return () => {
      live = false;
    };
  }, []);
  return about;
}
