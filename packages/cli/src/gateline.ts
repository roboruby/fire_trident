import { decidesOf, landingConfirmed, presetLabel, splitText, valueNumber } from "./decides.ts";
import type { DecidesReport } from "./decides.ts";
import type { LineageNote } from "@fire_trident/core";
import type { ApiRequest } from "./api.ts";
import { colonyPath } from "./api.ts";
import type { Colors } from "./format.ts";

/**
 * How a colony decides, in the CLI (core/decides.ts words it): `ft status` prints the preset the colony's decide policy
 * equals (or custom and how it differs from the nearest preset) with the last 30 days of landed changes by what
 * confirmed them (GET /api/colonies/:id/decides, a public read), and `ft why` prints under each landing the rule that
 * confirmed it with the values it used, from its lineage note.
 */

/** The request for the colony's report. */
export function decidesRequest(colony: string): ApiRequest {
  return { method: "GET", path: colonyPath(colony, "/decides") };
}

const LABEL = 11;

/** A setting's value as the line writes it. */
function setting(v: number | boolean): string {
  return typeof v === "boolean" ? (v ? "on" : "off") : valueNumber(v);
}

/** The preset in a few words: its label, or custom with the nearest preset and what differs (three fields, then a count). */
export function presetWords(r: DecidesReport): string {
  if (r.preset !== "custom") return presetLabel(r, r.preset);
  const shown = r.differs.slice(0, 3).map((d) => `${d.label} ${setting(d.value)} (preset ${setting(d.preset)})`);
  const more = r.differs.length > 3 ? ` and ${r.differs.length - 3} more` : "";
  return `custom, nearest ${presetLabel(r, r.nearest)}: ${shown.join(", ")}${more}`;
}

/**
 * The rows `ft status` prints for the report: the preset and the 30-day split, then what the policy lets land without a
 * person (dim), and a warning when models are not reviewing changes. None for a server that predates the report.
 */
export function decidesLines(raw: unknown, c: Colors): string[] {
  const r = decidesOf(raw);
  if (!r) return [];
  const pad = " ".repeat(LABEL);
  const out = [`${c.dim("decides".padEnd(LABEL))}${r.preset === "custom" ? c.yellow(presetWords(r)) : c.bold(presetWords(r))} · ${splitText(r.split)}`];
  if (r.lets) out.push(`${pad}${c.dim(r.lets)}`);
  if (!r.reviewing) out.push(`${pad}${c.yellow("Review is off now: changes go to their lanes without the gate, except those a protected path or tests before landing hold.")}`);
  return out;
}

/** The line `ft why` prints under a landing: the rule that confirmed it with its values, and the colony's preset then. */
export function confirmedLine(note: LineageNote | null | undefined, c: Colors): string {
  const l = landingConfirmed(note);
  const presets = [...new Set(l.changes.map((x) => x.preset).filter((p): p is string => typeof p === "string" && p !== ""))];
  const preset = presets.length === 1 ? c.dim(` · preset ${presets[0]!.replace(/-/g, " ")}`) : "";
  const text = l.kind === "unreviewed" || l.kind === "unknown" ? c.yellow(l.text) : l.text;
  return `${text}${preset}`;
}
