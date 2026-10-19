/**
 * The deployment a contention-scale run talks to, read the way the stage scripts read it (scripts/stage.rb): the base URL
 * from --base, the admin token from FT_TOKEN (or FT_ADMIN_TOKEN) in the environment, else from the ft config file when
 * that file's FT_URL is this deployment (a token is never sent to a deployment it was not issued for), and Cloudflare
 * Access's service-token headers from CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET (both or neither). Nothing here
 * prints a secret.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnvFile, type LiveConfig } from "../env.ts";

/** The server a config file without FT_URL is for (the ft CLI's default). */
export const DEFAULT_URL = "https://firetrident.com";

/** Scheme, host and port of a URL, or null when it does not parse as http(s). */
export function origin(url: string): string | null {
  try {
    const u = new URL(url.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return `${u.protocol}//${u.hostname.toLowerCase()}:${u.port || (u.protocol === "https:" ? "443" : "80")}`;
  } catch {
    return null;
  }
}

/** The ft config file: $XDG_CONFIG_HOME/firetrident/env, else ~/.config/firetrident/env. */
export function configPath(env: Record<string, string | undefined>): string | null {
  const xdg = (env.XDG_CONFIG_HOME ?? "").trim();
  if (xdg) return join(xdg.replace(/\/+$/, ""), "firetrident", "env");
  const home = (env.HOME ?? "").trim();
  return home ? join(home, ".config", "firetrident", "env") : null;
}

/** The secrets a config carries (for redacting logs). */
export function secretsOf(cfg: LiveConfig): string[] {
  return [cfg.token ?? "", ...Object.values(cfg.headers ?? {})].filter((s) => s.length >= 4);
}

/**
 * The config for `base`: its URL, the admin token for it (none when neither the environment nor a matching config
 * file has one) and the Access headers. Throws a sentence when --base is not an http(s) URL or only one Access variable is set.
 */
export function deploymentConfig(base: string, env: Record<string, string | undefined> = process.env, read: (path: string) => string | null = readOrNull): LiveConfig {
  const url = base.trim().replace(/\/+$/, "");
  if (!origin(url)) throw new Error(`--base must be an http(s) URL, for example --base https://staging.firetrident.com (got "${base}")`);
  let token = (env.FT_TOKEN ?? env.FT_ADMIN_TOKEN ?? "").trim();
  if (!token) {
    const path = configPath(env);
    const text = path ? read(path) : null;
    if (text !== null) {
      const file = parseEnvFile(text);
      const issuedFor = (file.FT_URL ?? "").trim() || DEFAULT_URL;
      if ((file.FT_TOKEN ?? "").trim() && origin(issuedFor) === origin(url)) token = file.FT_TOKEN!.trim();
    }
  }
  const id = (env.CF_ACCESS_CLIENT_ID ?? "").trim();
  const secret = (env.CF_ACCESS_CLIENT_SECRET ?? "").trim();
  if (!!id !== !!secret) throw new Error("set both CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET to reach a deployment behind Cloudflare Access, or neither");
  const headers = id ? { "CF-Access-Client-Id": id, "CF-Access-Client-Secret": secret } : undefined;
  return { url, ...(token ? { token } : {}), ...(headers ? { headers } : {}) };
}

function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}
