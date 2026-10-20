import { useEffect, useState } from "react";
import { useAbout, type About } from "../about.ts";
import { send } from "./account.ts";

/** Whether a deployment has accounts on (FT_ACCOUNTS among the flags GET /api/about lists); unknown reads as off. */
export function accountsOn(about: About | null): boolean {
  return about?.flags.includes("FT_ACCOUNTS") ?? false;
}

type Who = "unknown" | "out" | "in";

/**
 * The account buttons in a page's navigation, only where the deployment has accounts on (FT_ACCOUNTS, from GET
 * /api/about): Sign in and Request invite for a visitor, Account once signed in (GET /api/me says).
 */
export function AccountLink() {
  const about = useAbout();
  const on = accountsOn(about);
  const [who, setWho] = useState<Who>("unknown");
  useEffect(() => {
    if (!on) return;
    let live = true;
    send("GET", "/api/me")
      .then(async (res) => {
        if (!live) return;
        const b = res.ok ? ((await res.json().catch(() => null)) as { signedIn?: unknown } | null) : null;
        setWho(b?.signedIn === true ? "in" : "out");
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
