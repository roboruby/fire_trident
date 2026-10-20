import { useEffect, useState } from "react";
import { useAbout, type About } from "../about.ts";
import { send } from "./account.ts";

/** Whether a deployment has accounts on (FT_ACCOUNTS among the flags GET /api/about lists); unknown reads as off. */
export function accountsOn(about: About | null): boolean {
  return about?.flags.includes("FT_ACCOUNTS") ?? false;
}

type Who = "unknown" | "out" | "in";

/**
 * What this browser last learned, so the first paint is right: whether this deployment has accounts ("on" or "off")
 * and whether its person was signed in ("1"). Conveniences only; the server's answers replace them on every load.
 */
const ACCOUNTS_HINT = "ft.accounts";
const SIGNED_IN_HINT = "ft.signedIn";

function hint(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function remember(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Storage may be off or full; the hint is a convenience.
  }
}

/**
 * The account buttons in a page's navigation: Sign in and Request invite for a visitor, Account once signed in. They
 * show at once and go only when GET /api/about says the deployment has accounts off, so the nav does not fill in a
 * moment after the page; GET /api/me then tells Sign in from Account, and the browser remembers its answer for next time.
 */
export function AccountLink() {
  const about = useAbout();
  const on = about ? accountsOn(about) : hint(ACCOUNTS_HINT) !== "off";
  const [who, setWho] = useState<Who>(() => (hint(SIGNED_IN_HINT) === "1" ? "in" : "unknown"));
  useEffect(() => {
    if (about) remember(ACCOUNTS_HINT, accountsOn(about) ? "on" : "off");
  }, [about]);
  useEffect(() => {
    if (!on) return;
    let live = true;
    send("GET", "/api/me")
      .then(async (res) => {
        if (!live) return;
        const b = res.ok ? ((await res.json().catch(() => null)) as { signedIn?: unknown } | null) : null;
        const signedIn = b?.signedIn === true;
        setWho(signedIn ? "in" : "out");
        remember(SIGNED_IN_HINT, signedIn ? "1" : null);
      })
      .catch(() => {
        if (live) setWho("out");
      });
    return () => {
      live = false;
    };
  }, [on]);
  if (!on) return null;
  if (who === "in") {
    return (
      <a className="l-btn l-btn-nav" href="/account">
        Account
      </a>
    );
  }
  return (
    <>
      <a className="l-btn l-btn-nav l-btn-primary" href="/auth/github/start">
        Sign in
      </a>
      <a className="l-btn l-btn-nav" href="/account?request=1">
        Request invite
      </a>
    </>
  );
}
