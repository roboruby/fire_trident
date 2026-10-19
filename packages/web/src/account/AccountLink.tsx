import { useAbout, type About } from "../about.ts";

/** Whether a deployment has accounts on (FT_ACCOUNTS among the flags GET /api/about lists); unknown reads as off. */
export function accountsOn(about: About | null): boolean {
  return about?.flags.includes("FT_ACCOUNTS") ?? false;
}

/** The account page's link in a page's navigation, only where the deployment has accounts on (FT_ACCOUNTS, from GET /api/about). */
export function AccountLink() {
  const about = useAbout();
  if (!accountsOn(about)) return null;
  return <a href="/account">Account</a>;
}
