import { DEFAULT_URL } from "./api.ts";

/**
 * The config file `ft` falls back to when FT_URL or FT_TOKEN is not set:
 * `$XDG_CONFIG_HOME/firetrident/env`, else `~/.config/firetrident/env`, with
 * KEY=value lines (FT_URL, FT_TOKEN, FT_USER, ...). The environment always wins.
 */

/** Path of the config file, or null when neither XDG_CONFIG_HOME nor HOME is known. */
export function configPath(env: Record<string, string | undefined>): string | null {
  const xdg = env.XDG_CONFIG_HOME?.trim();
  if (xdg) return `${xdg.replace(/\/+$/, "")}/firetrident/env`;
  const home = env.HOME?.trim() || env.USERPROFILE?.trim();
  return home ? `${home.replace(/[\\/]+$/, "")}/.config/firetrident/env` : null;
}

/** Parse KEY=value lines. Blank lines and `#` comments are skipped; `export ` and matching quotes are allowed. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m || !m[1]) continue;
    let value = (m[2] ?? "").trim();
    const q = value[0];
    if ((q === '"' || q === "'") && value.length >= 2 && value.endsWith(q)) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, "");
    out[m[1]] = value;
  }
  return out;
}

/** Origin (scheme, host, port) of a URL, or null when it does not parse. */
function origin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * The environment `ft` runs with: `env` plus, from the config file, FT_URL and FT_USER when
 * unset, and FT_TOKEN when unset and the server in use (`--url`, FT_URL, or the default) is the
 * file's server. A token is never sent to a server it was not issued for.
 */
export function withConfig(env: Record<string, string | undefined>, file: Record<string, string>, flagUrl?: string): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...env };
  const fileUrl = file.FT_URL?.trim() ?? "";
  if (!env.FT_URL?.trim() && fileUrl) out.FT_URL = fileUrl;
  if (!env.FT_USER?.trim() && file.FT_USER?.trim()) out.FT_USER = file.FT_USER.trim();
  const fileToken = file.FT_TOKEN?.trim() ?? "";
  if (!env.FT_TOKEN?.trim() && fileToken) {
    const used = origin((flagUrl ?? out.FT_URL ?? "").trim() || DEFAULT_URL);
    const issuedFor = origin(fileUrl || DEFAULT_URL);
    if (used !== null && used === issuedFor) out.FT_TOKEN = fileToken;
  }
  return out;
}
