import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ColonyFooter } from "../src/components/ColonyFooter.tsx";
import { AXES, NOTES_COMMAND, PITCH, PITCH_MORE, TAKE_BACK_COMMANDS, axesMarkdown } from "../src/landing/axes.ts";
import { Axes } from "../src/landing/Axes.tsx";
import { QUESTIONS } from "../src/landing/questions.ts";
import { TakeBack } from "../src/landing/TakeBack.tsx";
import { ARTIFACTS_LESSONS, GROUPS, LIMITS, STATUS_LABEL } from "../src/limits/limits.ts";
import { Limits } from "../src/limits/Limits.tsx";
import { parseRoute } from "../src/route.ts";

/**
 * A judge's first five minutes outside the colony page: the limits page (Why / Instead / Status, the rows where a team's
 * forge is ahead first, what Artifacts taught us), the judging-axes table, the take-back commands and the pitch line.
 */

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
/** Text as React writes it into HTML. */
const html = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#x27;");
/** Sentences in a text: a period, question or exclamation mark followed by a space or the end. */
const sentences = (s: string) => s.match(/[.!?](?=\s|$)/g)?.length ?? 0;

describe("the limits page", () => {
  it("is /limits", () => {
    expect(parseRoute("/limits", "")).toEqual({ kind: "limits" });
    expect(parseRoute("/limits/", "")).toEqual({ kind: "limits" });
    expect(parseRoute("/", "")).toEqual({ kind: "landing" });
  });

  it("puts the rows where a team's forge is ahead first: no teams, no pull requests, no issues", () => {
    expect(GROUPS.map((g) => g.id)).toEqual(["forge", "colony"]);
    expect(LIMITS.slice(0, 3).map((l) => l.id)).toEqual(["accounts", "pull-requests", "issues"]);
    const lastForge = LIMITS.map((l) => l.group).lastIndexOf("forge");
    const firstColony = LIMITS.findIndex((l) => l.group === "colony");
    expect(lastForge).toBeLessThan(firstColony);
    expect(new Set(LIMITS.map((l) => l.id)).size).toBe(LIMITS.length);
  });

  it("gives every row what you cannot do, why, what to do instead, a status and a page or command that shows it", () => {
    for (const l of LIMITS) {
      for (const field of [l.cannot, l.why, l.instead]) expect(field.trim(), l.id).not.toBe("");
      expect(Object.keys(STATUS_LABEL), l.id).toContain(l.status);
      if ("href" in l.check) expect(l.check.href, l.id).toMatch(/^\/[a-z#]/);
      else expect(l.check.command.trim(), l.id).not.toBe("");
    }
    expect(new Set(LIMITS.map((l) => l.status))).toEqual(new Set(["planned", "cloudflare", "unscheduled"]));
  });

  it("renders its rows in the stated order, in Why / Instead / Status form", () => {
    const out = renderToStaticMarkup(createElement(Limits));
    let at = 0;
    for (const l of LIMITS) {
      const i = out.indexOf(`id="lm-${l.id}"`);
      expect(i, l.id).toBeGreaterThan(at);
      at = i;
      expect(out).toContain(html(l.cannot));
      expect(out).toContain(`<dt>Why</dt><dd>${html(l.why)}</dd><dt>Instead</dt><dd>${html(l.instead)}</dd><dt>Status</dt>`);
      expect(out).toContain(`<span class="lm-status lm-status-${l.status}">${STATUS_LABEL[l.status]}</span>`);
    }
    expect(out.indexOf("Where your forge is ahead")).toBeLessThan(out.indexOf("Where a colony stops"));
    expect(out.match(/<article class="lm-row"/g)).toHaveLength(LIMITS.length);
  });

  it("ends with what Artifacts taught us, each finding with its workaround", () => {
    expect(ARTIFACTS_LESSONS.map((x) => x.id)).toEqual(["fork-after-push", "compare-and-swap", "no-hooks", "per-namespace"]);
    const out = renderToStaticMarkup(createElement(Limits));
    expect(out).toContain("What Artifacts taught us.");
    for (const x of ARTIFACTS_LESSONS) {
      expect(out).toContain(html(x.finding));
      expect(out).toContain(`<b>Workaround.</b> ${html(x.workaround)}`);
    }
    // The spike measured what each finding says.
    const spike = read("../../../spike/RESULTS.md");
    expect(spike).toContain("2/10");
    expect(spike).toContain("stale ref");
    expect(spike).toContain("no `atomic`, no `push-options`");
  });

  it("is linked from the landing page and the colony page's footer", () => {
    expect(read("../src/components/SiteNav.tsx")).toContain('<a href="/limits">Limits</a>');
    expect(read("../src/landing/Landing.tsx")).toContain('<a href="/limits">Limits</a>');
    expect(renderToStaticMarkup(createElement(ColonyFooter))).toContain('<a href="/limits">');
  });
});

describe("how FireTrident answers the judging axes", () => {
  it("has the five axes in order, each one sentence naming its mechanism, with a replay, a scene or a command", () => {
    expect(AXES.map((a) => a.id)).toEqual(["concurrency", "coordination", "context", "review", "conflicts"]);
    for (const a of AXES) {
      expect(sentences(a.mechanism), a.id).toBe(1);
      if ("href" in a.check) expect(a.check.href, a.id).toMatch(/^\/(c\/|#try-)/);
      else expect(a.check.command, a.id).toContain("git ");
    }
    expect(AXES.find((a) => a.id === "concurrency")?.mechanism).toMatch(/^Read-set validation: /);
    expect(AXES.find((a) => a.id === "coordination")?.mechanism).toMatch(/^Decaying claims: /);
    expect(AXES.find((a) => a.id === "context")?.mechanism).toMatch(/^Lineage notes: /);
    expect(AXES.find((a) => a.id === "review")?.mechanism).toMatch(/^Deterministic proof first, then .* a person/);
    expect(AXES.find((a) => a.id === "conflicts")?.mechanism).toMatch(/^Text merge .* naming the landing that beat it .* quoting that landing's diff/);
  });

  it("renders the table on the landing page", () => {
    const out = renderToStaticMarkup(createElement(Axes));
    expect(out).toContain('<section class="l-section" id="axes">');
    expect(out).toContain("How FireTrident answers the judging axes.");
    for (const a of AXES) {
      expect(out).toContain(`id="ax-${a.id}"`);
      expect(out).toContain(html(a.mechanism));
      if ("href" in a.check) expect(out).toContain(`href="${html(a.check.href)}"`);
    }
    expect(out).toContain(html(NOTES_COMMAND));
  });

  it("writes the docs' version with full links, which docs/mechanisms.md carries word for word", () => {
    expect(read("../../../docs/mechanisms.md")).toContain(axesMarkdown());
    const md = axesMarkdown().split("\n");
    expect(md[0]).toBe("| Axis | How FireTrident answers it | Check it |");
    expect(md).toHaveLength(2 + AXES.length);
    expect(md[2]).toBe(`| Concurrency | ${AXES[0]?.mechanism} | [Replay 2,000 agents landing 6,606 changes](https://firetrident.com/c/scale?replay=1&t=32&speed=4) |`);
    expect(md[6]).toContain("(https://firetrident.com/#try-merge) |");
    for (const row of md.slice(2)) expect(row.split(" | ")).toHaveLength(3);
  });
});

describe("take the work back, and the pitch", () => {
  it("gives the stock-git commands: clone certified, fetch the notes, push both as a branch, open a pull request", () => {
    const lines = TAKE_BACK_COMMANDS.split("\n").filter((l) => !l.startsWith("#"));
    expect(lines).toEqual([
      "git clone -b certified https://firetrident.com/git/shortlinks.git && cd shortlinks",
      "git fetch origin refs/notes/firetrident:refs/notes/firetrident",
      "git push <your-origin> certified:refs/heads/firetrident/certified",
      "git push <your-origin> refs/notes/firetrident",
    ]);
    expect(TAKE_BACK_COMMANDS).toContain("open a pull request from firetrident/certified");
  });

  it("says only what exists today: no credential for your origin, no sync", () => {
    const out = renderToStaticMarkup(createElement(TakeBack));
    expect(out).toContain('id="take-back"');
    expect(out).toContain(html("git push <your-origin> certified:refs/heads/firetrident/certified"));
    expect(out).toContain("FireTrident holds no credential for your origin.");
    expect(out).toContain("Nothing syncs on its own in either direction");
    expect(out).not.toMatch(/two-way sync|syncs automatically|keeps .* in sync/i);
  });

  it("shows the pitch line in the hero, the take-back section under Try it, and the axes' checks inside the answers", () => {
    // The landing page draws a live colony in its hero, so it is read as source here; its sections render above.
    const landing = read("../src/landing/Landing.tsx");
    expect(PITCH).toBe("A colony sits beside your forge.");
    const h1 = landing.indexOf('<h1 className="l-h1">A colony, not a queue.</h1>');
    const pitch = landing.indexOf('<p className="l-pitch">\n            <b>{PITCH}</b> {PITCH_MORE}\n          </p>');
    expect(h1).toBeGreaterThan(0);
    expect(pitch).toBeGreaterThan(h1);
    expect(pitch).toBeLessThan(landing.indexOf('<div className="l-ctas">'));
    const tryIt = landing.indexOf("<TryIt />");
    const back = landing.indexOf("<TakeBack />");
    expect(landing.slice(tryIt + "<TryIt />".length, back).trim()).toBe("");
    expect(landing.indexOf("<Questions />")).toBeLessThan(back);
    expect(landing).not.toContain("<Axes />");
    const more = QUESTIONS.flatMap((q) => (q.more ?? []).map((m) => m.href));
    for (const a of AXES) if ("href" in a.check) expect([...more, ...QUESTIONS.map((q) => q.link.href.replace(/^https:\/\/firetrident\.com/, ""))]).toContain(a.check.href);
    expect(PITCH_MORE).toContain("you give it a target, and it converges, certifies and tells you why");
  });
});
