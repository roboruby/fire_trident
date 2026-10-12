// The narration script: `## <m:ss> <Title> (<visual note>)` headings, then paragraphs.
// {braced} values are placeholders to verify before recording; the braces are dropped when
// spoken. pronounce.json respells words for the synthesizer only (the script is unchanged).
import { readFileSync } from "node:fs";

/** "Bring your own agent" -> "bring-your-own-agent". */
export const slug = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/** Text as the synthesizer should read it. */
export function spoken(text, pronounce = {}) {
  let out = text.replace(/\{([^}]*)\}/g, "$1").replace(/`/g, "");
  for (const [word, say] of Object.entries(pronounce)) {
    if (word.startsWith("$")) continue;
    out = out.replace(new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g"), say);
  }
  return out;
}

/** Scenes with their paragraphs, in script order. */
export function parseNarration(md, pronounce = {}) {
  const scenes = [];
  let cur = null;
  let gap = true;
  for (const raw of md.split("\n")) {
    const h = raw.match(/^##\s+(\d+:\d{2})\s+(.+?)(?:\s+\((.+)\))?\s*$/);
    if (h) {
      cur = { time: h[1], title: h[2].trim(), note: h[3] ?? "", id: slug(h[2]), paragraphs: [] };
      scenes.push(cur);
      gap = true;
      continue;
    }
    if (!cur || raw.startsWith("#")) continue;
    const line = raw.trim();
    if (!line) {
      gap = true;
      continue;
    }
    if (gap || !cur.paragraphs.length) cur.paragraphs.push(line);
    else cur.paragraphs[cur.paragraphs.length - 1] += ` ${line}`;
    gap = false;
  }
  return scenes.map((s) => ({ ...s, paragraphs: s.paragraphs.map((text, index) => ({ index, text, spoken: spoken(text, pronounce) })) }));
}

/** Read and parse a narration file. */
export function loadNarration(path, pronounce = {}) {
  return parseNarration(readFileSync(path, "utf8"), pronounce);
}

/** Every {placeholder} in the script, with its scene, for the pre-recording number check. */
export function placeholders(scenes) {
  const out = [];
  for (const s of scenes) for (const p of s.paragraphs) for (const m of p.text.matchAll(/\{([^}]*)\}/g)) out.push({ scene: s.id, value: m[1] });
  return out;
}
