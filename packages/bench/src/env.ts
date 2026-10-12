/**
 * Local configuration for live runs: FT_URL and FT_TOKEN from the process
 * environment, falling back to ~/.config/firetrident/env. The token is only
 * ever placed in request headers; nothing here prints it.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Base URL and admin token for the live service. */
export interface LiveConfig {
  url: string;
  token?: string;
}

/** Parse KEY=VALUE lines (blank lines and # comments ignored). */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i <= 0) continue;
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

/** Read FT_URL / FT_TOKEN from env, then from ~/.config/firetrident/env. */
export function liveConfig(env: Record<string, string | undefined> = process.env): LiveConfig {
  let file: Record<string, string> = {};
  try {
    file = parseEnvFile(readFileSync(join(homedir(), ".config", "firetrident", "env"), "utf8"));
  } catch {
    // no local config file
  }
  const url = (env.FT_URL ?? file.FT_URL ?? "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//.test(url)) throw new Error("FT_URL is not set (env or ~/.config/firetrident/env)");
  const token = env.FT_TOKEN ?? env.FT_ADMIN_TOKEN ?? file.FT_TOKEN;
  return token ? { url, token } : { url };
}

/** Redact anything that looks like a bearer or Artifacts token from a message. */
export function redact(message: string): string {
  return message.replace(/art_v\d+_[A-Za-z0-9._~+/=-]+/g, "<redacted>").replace(/Bearer\s+\S+/gi, "Bearer <redacted>");
}
