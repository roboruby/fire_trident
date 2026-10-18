import { MODEL_PRICES } from "@fire_trident/core";
import type { IntentSource } from "@fire_trident/core";

/**
 * Who may choose the model an in-platform agent writes with. A spec intent's why can carry a `Model:` line
 * (agents/create.ts parseIntentSpec), and the agent writes that intent's files with the model it names. The why is
 * whoever declared the intent's text, and an MCP declare or an Agent2Agent request passes an agent's why through as it
 * is, so the line is honored only where a person or a rule wrote it: source `human` (a person, or a spec, which
 * `ft new` declares as one) or `rule`. Trunk certification writes `Model: default` into every repair intent
 * (certify/repair.ts) and nothing else, so on its intents the default class alone is honored. And the model must be one
 * this deployment knows: the classes `default` and `bulk`, FT_DEFAULT_MODEL, FT_BULK_MODEL, the agent's own model, or a
 * model with a list price (core/pricing.ts); the step-up asks for the `default` class. Anything else is ignored: the
 * agent writes with its own model, and the reason goes into the take's journal line and the change's evidence.
 */

/** Sources whose why may choose the model: a person (a spec is declared as one) and a colony rule. */
const CHOOSING_SOURCES: ReadonlySet<string> = new Set<IntentSource>(["human", "rule"]);
/** The one model line trunk certification writes (certify/repair.ts). */
const CERTIFY_MODEL = "default";
/** Longest model name a reason quotes. */
const NAME_CHARS = 80;
/** Who declared an intent that may not choose the model, in a sentence. */
const DECLARED: Readonly<Record<string, string>> = {
  agent: "an agent declared it",
  system: "the platform declared it",
  external: "it was imported from a public GitHub issue",
};
/** The evidence check that says a Model line was ignored. */
export const MODEL_LINE_CHECK = "model line";

/** The models a deployment knows beyond the classes and the price list: its default and bulk models, the agent's own. */
export interface KnownModels {
  default?: string | undefined;
  bulk?: string | undefined;
  own?: string | undefined;
}

/** What an intent's Model line comes to: the model to write with (null: the agent's own) and why a line was ignored. */
export interface ModelChoice {
  model: string | null;
  /** Set when the intent had a Model line and it was not honored: one sentence saying why and what was used instead. */
  ignored?: string;
}

/** Is `model` one this deployment knows (see the module comment)? */
export function knownModel(model: string, known: KnownModels): boolean {
  if (model === "default" || model === "bulk") return true;
  if (model === known.default || model === known.bulk || model === known.own) return true;
  return Object.hasOwn(MODEL_PRICES, model);
}

/** A model name quoted in a sentence: one line, cut. */
function quoted(model: string): string {
  const one = model.replace(/[\s\u0000-\u001f\u007f-\u009f]+/g, " ").trim();
  return one.length > NAME_CHARS ? `${one.slice(0, NAME_CHARS - 1)}…` : one;
}

/**
 * The model an intent's Model line (`asked`, as parseIntentSpec read it, or null) lets its agent write with, given who
 * declared the intent (`source`; absent reads as an agent) and the models the deployment knows. No line: the agent's own.
 */
export function modelLineChoice(asked: string | null | undefined, source: IntentSource | string | null | undefined, known: KnownModels): ModelChoice {
  const model = typeof asked === "string" ? asked.trim() : "";
  if (model === "") return { model: null };
  const own = known.own ? `its own model, ${quoted(known.own)}` : "its own model";
  const line = `The intent's "Model: ${quoted(model)}" line was ignored`;
  const src = typeof source === "string" ? source : "";
  if (src === "certify") {
    if (model === CERTIFY_MODEL) return { model };
    return { model: null, ignored: `${line}: trunk certification only asks for the ${CERTIFY_MODEL} model class, so the agent wrote with ${own}.` };
  }
  if (!CHOOSING_SOURCES.has(src)) {
    const who = Object.hasOwn(DECLARED, src) ? DECLARED[src] : "nothing says a person or a rule declared it";
    return { model: null, ignored: `${line}: ${who}, and only a person, a spec or a colony rule chooses the model, so the agent wrote with ${own}.` };
  }
  if (!knownModel(model, known)) {
    return { model: null, ignored: `${line}: it names no model this deployment knows (default, bulk, its configured models or a listed one), so the agent wrote with ${own}.` };
  }
  return { model };
}
