const intFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/** Integer with thousands separators. */
export function fmtInt(n: number): string {
  return intFormat.format(Math.round(n));
}

/** A rate or ratio with fixed decimals. */
export function fmtFixed(n: number, digits = 2): string {
  return Number.isFinite(n) ? n.toFixed(digits) : "0";
}

/** First `n` characters of a SHA, or a placeholder. */
export function shortSha(sha: string | undefined | null, n = 7): string {
  return sha ? sha.slice(0, n) : "·······";
}

/** A compact form of an opaque id: readable ids stay, long random ones keep their tail. */
export function shortId(id: string): string {
  if (id.length <= 14) return id;
  const cut = id.indexOf("_");
  const prefix = cut > 0 && cut < 6 ? id.slice(0, cut + 1) : "";
  return prefix + id.slice(-6);
}

/** Human time distance from `at` to `now`. */
export function timeAgo(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** Wall-clock HH:MM:SS for an epoch time. */
export function clock(at: number): string {
  const d = new Date(at);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Last path segment. */
export function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? path : path.slice(i + 1);
}

/** Everything before the last path segment, with a trailing slash ("" for root files). */
export function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i + 1);
}

/** First `depth` directory segments of a path ("." for root files). */
export function regionOf(path: string, depth = 1): string {
  const parts = path.split("/");
  if (parts.length <= 1) return ".";
  return parts.slice(0, Math.min(depth, parts.length - 1)).join("/");
}

/** Byte count as B / KB / MB. */
export function fmtBytes(n: number): string {
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Probability as a percentage string. */
export function fmtPct(p: number, digits = 0): string {
  return `${(p * 100).toFixed(digits)}%`;
}

/** Escape text for safe insertion into HTML built by hand (tooltips). */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;"));
}
