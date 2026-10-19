import { useAbout } from "../about.ts";

/** The account page's link in a page's navigation, only where the deployment has accounts on (FT_ACCOUNTS, from GET /api/about). */
export function AccountLink() {
  const about = useAbout();
  if (!about?.flags.includes("FT_ACCOUNTS")) return null;
  return <a href="/account">Account</a>;
}
