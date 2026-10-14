import type { ColonySpend, Id, IntentSpend, IntentSpendBrief, ModelSpend, SpendLayer } from "./types.ts";

/**
 * Model prices. A colony counts the tokens of the model calls it makes (its in-platform agents, review, contest judging,
 * the conflict resolver, antibody minting); this module prices them, so a run shows what its model calls cost while it
 * runs, and anyone can check the number against the tokens per model the colony reports beside it. Prices are Workers AI
 * list prices in USD per million tokens on PRICE_DATE. A model missing from the list is never guessed: its tokens are
 * reported as unpriced and count in no dollar sum. Pure.
 */

/** The day MODEL_PRICES were read from the Workers AI price list (YYYY-MM-DD). */
export const PRICE_DATE = "2026-10-12";

/** A model's price in USD per million input and output tokens. */
export interface ModelPrice {
  input: number;
  output: number;
}

/** Workers AI list prices on PRICE_DATE, by model id. */
export const MODEL_PRICES: Readonly<Record<string, Readonly<ModelPrice>>> = {
  "@cf/moonshotai/kimi-k2.7-code": { input: 0.95, output: 4.0 },
  "@cf/zai-org/glm-5.3-flash": { input: 0.15, output: 0.5 },
  "@cf/openai/gpt-oss-120b": { input: 0.35, output: 0.75 },
  "@cf/openai/gpt-oss-20b": { input: 0.2, output: 0.3 },
  "@cf/google/gemma-4-26b-a4b-it": { input: 0.1, output: 0.3 },
  "@cf/qwen/qwen3.8-27b": { input: 0.45, output: 3.2 },
  "@cf/zai-org/glm-4.7-flash": { input: 0.0605, output: 0.4 },
  // The reflex model answers typed questions and is billed for input tokens only (its usage reports no output).
  "@cf/cloudflare/clef": { input: 0.24, output: 0 },
};

/** The layers in the order every report lists them. */
export const SPEND_LAYERS: readonly SpendLayer[] = ["agents", "review", "judge", "resolver", "other"];

/** How each layer reads in a sentence. */
const LAYER_TEXT: Readonly<Record<SpendLayer, string>> = {
  agents: "agents",
  review: "review",
  judge: "contest judge",
  resolver: "conflict resolver",
  other: "other",
};

/** A count (tokens, intents, agents) as a whole number: negative or non-finite counts read as 0, fractions round down. */
function wholeCount(n: unknown): number {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** Dollars kept to 1e-8 (sums of many small prices otherwise carry float noise into the API). */
function roundUsd(usd: number): number {
  return Math.round(usd * 1e8) / 1e8;
}

/** The list price of a model, or null when it has none. */
export function modelPrice(model: string): ModelPrice | null {
  const id = typeof model === "string" ? model.trim() : "";
  return Object.hasOwn(MODEL_PRICES, id) ? (MODEL_PRICES[id] ?? null) : null;
}

/** USD for `input` and `output` tokens of `model`, or null when the model has no listed price. */
export function priceTokens(model: string, input: number, output: number): number | null {
  const p = modelPrice(model);
  if (!p) return null;
  return (wholeCount(input) * p.input + wholeCount(output) * p.output) / 1_000_000;
}

/** Tokens one layer spent on one model, as the colony counted them. */
export interface LayerUsage {
  layer: SpendLayer;
  model: string;
  input: number;
  output: number;
}

/**
 * A colony's spend from the tokens it counted: each layer's tokens priced by model and summed by layer, and the total
 * over the intents landed (null when none landed). Tokens of a model with no listed price go to `unpriced` only.
 */
export function colonySpend(usage: readonly LayerUsage[], landedIntents: number, opts: { agentsUnread?: number } = {}): ColonySpend {
  const byLayer: Record<SpendLayer, number> = { agents: 0, review: 0, judge: 0, resolver: 0, other: 0 };
  const byModel = new Map<string, ModelSpend>();
  const unpriced = new Map<string, { input: number; output: number }>();
  let input = 0;
  let output = 0;
  let usd = 0;
  for (const u of usage) {
    const i = wholeCount(u?.input);
    const o = wholeCount(u?.output);
    if (i === 0 && o === 0) continue;
    const model = (typeof u.model === "string" ? u.model.trim() : "") || "unknown";
    const layer: SpendLayer = SPEND_LAYERS.includes(u.layer) ? u.layer : "other";
    input += i;
    output += o;
    const price = priceTokens(model, i, o);
    const m = byModel.get(model) ?? { input: 0, output: 0, usd: price === null ? null : 0 };
    m.input += i;
    m.output += o;
    byModel.set(model, m);
    if (price === null) {
      const x = unpriced.get(model) ?? { input: 0, output: 0 };
      x.input += i;
      x.output += o;
      unpriced.set(model, x);
      continue;
    }
    m.usd = (m.usd ?? 0) + price;
    byLayer[layer] += price;
    usd += price;
  }
  for (const l of SPEND_LAYERS) byLayer[l] = roundUsd(byLayer[l]);
  for (const m of byModel.values()) if (m.usd !== null) m.usd = roundUsd(m.usd);
  const landed = wholeCount(landedIntents);
  const unread = wholeCount(opts.agentsUnread);
  return {
    usd: roundUsd(usd),
    byLayer,
    perLandedIntent: landed > 0 ? roundUsd(usd / landed) : null,
    landedIntents: landed,
    tokens: { input, output },
    // Object.fromEntries defines own properties, so no model id can reach a prototype.
    byModel: Object.fromEntries(byModel),
    unpriced: Object.fromEntries(unpriced),
    priceDate: PRICE_DATE,
    ...(unread > 0 ? { agentsUnread: unread } : {}),
  };
}

/** Dollars as FireTrident shows them: four decimals below one cent, three below a dollar, else two ("$0.0002", "$0.042", "$1.25"). */
export function usdText(usd: number): string {
  const v = typeof usd === "number" && Number.isFinite(usd) && usd > 0 ? usd : 0;
  return `$${v.toFixed(v < 0.01 ? 4 : v < 1 ? 3 : 2)}`;
}

/** True when a spend report counted any model call (a report from an older server, or none at all, did not). */
export function spentAny(spend: ColonySpend | null | undefined): spend is ColonySpend {
  return !!spend && typeof spend.usd === "number" && !!spend.tokens && wholeCount(spend.tokens.input) + wholeCount(spend.tokens.output) > 0;
}

/**
 * The spend line's two halves: what the colony's model calls cost ("$0.042 of model calls") and that over each landed
 * intent ("$0.0001 a landed intent", null when none landed). Null when the colony made no model calls.
 */
export function spendParts(spend: ColonySpend | null | undefined): { total: string; perIntent: string | null } | null {
  if (!spentAny(spend)) return null;
  const some = Object.keys(spend.unpriced ?? {}).length > 0 ? " (some unpriced)" : "";
  const per = typeof spend.perLandedIntent === "number" && Number.isFinite(spend.perLandedIntent) ? `${usdText(spend.perLandedIntent)} a landed intent` : null;
  return { total: `${usdText(spend.usd)} of model calls${some}`, perIntent: per };
}

/** "$0.042 of model calls · $0.0001 a landed intent" (without the second half when no intent landed), or null when the colony made no model calls. */
export function spendLine(spend: ColonySpend | null | undefined): string | null {
  const parts = spendParts(spend);
  if (!parts) return null;
  return parts.perIntent ? `${parts.total} · ${parts.perIntent}` : parts.total;
}

/**
 * The spend by layer, the models with no listed price, and where the prices come from, one sentence a line (a tooltip,
 * or the detail under a summary). Empty when the colony made no model calls.
 */
export function spendDetail(spend: ColonySpend | null | undefined): string {
  if (!spentAny(spend)) return "";
  const n = (x: number): string => wholeCount(x).toLocaleString("en-US");
  const layers = SPEND_LAYERS.map((l) => `${LAYER_TEXT[l]} ${usdText(spend.byLayer?.[l] ?? 0)}`).join(", ");
  const lines = [`Model spend by layer: ${layers}.`];
  const unpriced = Object.entries(spend.unpriced ?? {});
  if (unpriced.length > 0) {
    lines.push(`Not priced (no list price): ${unpriced.map(([m, t]) => `${m} ${n(t.input)} input / ${n(t.output)} output tokens`).join("; ")}.`);
  }
  if (wholeCount(spend.agentsUnread) > 0) lines.push(`${n(spend.agentsUnread ?? 0)} in-platform agents not read yet: their calls are not in this sum.`);
  lines.push(`Priced at Workers AI list prices on ${spend.priceDate || PRICE_DATE}, from the ${n(spend.tokens.input)} input and ${n(spend.tokens.output)} output tokens the colony counted.`);
  return lines.join("\n");
}

/** Tokens and calls one layer spent on one model for one intent, as the colony counted them. */
export interface IntentUsage extends LayerUsage {
  calls: number;
}

/** Every layer at zero. */
function zeroLayers(): Record<SpendLayer, number> {
  return { agents: 0, review: 0, judge: 0, resolver: 0, other: 0 };
}

/**
 * One intent's spend from the tokens and calls counted for it: each layer's tokens priced by model (as colonySpend does)
 * and its calls summed by layer. A call that reported no tokens counts as a call and prices at nothing.
 */
export function intentSpend(intentId: Id, usage: readonly IntentUsage[]): IntentSpend {
  const s = colonySpend(usage, 0);
  const calls = zeroLayers();
  for (const u of usage) {
    const layer: SpendLayer = SPEND_LAYERS.includes(u?.layer) ? u.layer : "other";
    calls[layer] += wholeCount(u?.calls);
  }
  return { intentId, usd: s.usd, byLayer: s.byLayer, calls, tokens: s.tokens, byModel: s.byModel, unpriced: s.unpriced, priceDate: s.priceDate };
}

/** True when any token was counted for the intent (nothing counted reads as no spend, never as a spend of zero). */
export function spentOnIntent(spend: IntentSpend | IntentSpendBrief | null | undefined): spend is IntentSpend | IntentSpendBrief {
  return !!spend && typeof spend.usd === "number" && !!spend.tokens && wholeCount(spend.tokens.input) + wholeCount(spend.tokens.output) > 0;
}

/** The short form of an intent's spend for a listing, or null when nothing was counted for it. */
export function intentSpendBrief(spend: IntentSpend | null | undefined): IntentSpendBrief | null {
  if (!spentOnIntent(spend) || !("calls" in spend)) return null;
  const byLayer: IntentSpendBrief["byLayer"] = {};
  for (const l of SPEND_LAYERS) {
    const calls = wholeCount(spend.calls?.[l]);
    const usd = typeof spend.byLayer?.[l] === "number" && spend.byLayer[l] > 0 ? spend.byLayer[l] : 0;
    if (calls > 0 || usd > 0) byLayer[l] = { usd, calls };
  }
  const brief: IntentSpendBrief = { usd: spend.usd, byLayer, tokens: { input: wholeCount(spend.tokens.input), output: wholeCount(spend.tokens.output) } };
  if (Object.keys(spend.unpriced ?? {}).length > 0) brief.unpriced = true;
  return brief;
}

/** Whether some of the intent's tokens had no list price, from either form. */
function intentUnpriced(spend: IntentSpend | IntentSpendBrief): boolean {
  return "calls" in spend ? Object.keys(spend.unpriced ?? {}).length > 0 : spend.unpriced === true;
}

/** "$0.0004 of model calls" (with " (some unpriced)" when a model had no list price), or null when nothing was counted for the intent. */
export function intentSpendLine(spend: IntentSpend | IntentSpendBrief | null | undefined): string | null {
  if (!spentOnIntent(spend)) return null;
  return `${usdText(spend.usd)} of model calls${intentUnpriced(spend) ? " (some unpriced)" : ""}`;
}

/** Each layer that called, with its calls: "agents $0.0003 in 2 calls, review $0.0001 in 1 call". */
function layerCalls(spend: IntentSpend | IntentSpendBrief): string {
  const parts: string[] = [];
  for (const l of SPEND_LAYERS) {
    const usd = "calls" in spend ? (spend.byLayer?.[l] ?? 0) : (spend.byLayer?.[l]?.usd ?? 0);
    const calls = "calls" in spend ? wholeCount(spend.calls?.[l]) : wholeCount(spend.byLayer?.[l]?.calls);
    if (calls === 0 && !(usd > 0)) continue;
    parts.push(`${LAYER_TEXT[l]} ${usdText(usd)} in ${calls.toLocaleString("en-US")} call${calls === 1 ? "" : "s"}`);
  }
  return parts.join(", ");
}

/**
 * The intent's spend by layer with each layer's calls, its tokens and where the prices come from, in one sentence
 * (a tooltip, or the detail beside a line). Empty when nothing was counted for the intent.
 */
export function intentSpendDetail(spend: IntentSpend | IntentSpendBrief | null | undefined, priceDate = PRICE_DATE): string {
  if (!spentOnIntent(spend)) return "";
  const n = (x: number): string => wholeCount(x).toLocaleString("en-US");
  const date = "calls" in spend && spend.priceDate ? spend.priceDate : priceDate;
  const layers = layerCalls(spend);
  const unpriced = intentUnpriced(spend) ? "; some tokens had no list price and count in no dollar sum" : "";
  return `${layers ? `${layers}; ` : ""}${n(spend.tokens.input)} input and ${n(spend.tokens.output)} output tokens at Workers AI list prices on ${date}${unpriced}.`;
}
