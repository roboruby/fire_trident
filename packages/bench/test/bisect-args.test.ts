import { describe, expect, it } from "vitest";
import { USAGE, parseArgs } from "../../../scripts/bisect_args.ts";

/** The command line of scripts/bisect.ts (scripts/bisect_args.ts): the check on two colonies, and the demo on one; both take the history to land. */

const env = { FT_ADMIN_TOKEN: "set-for-the-test" };

describe("bisect.ts arguments: the demo", () => {
  it("runs the demo on one new colony", () => {
    expect(parseArgs(["--url", "https://preview.example", "--demo", "first-red"], env)).toEqual({ mode: "demo", url: "https://preview.example", colony: "first-red", landings: 6, breakAt: 4 });
  });

  it("takes the deployment from FT_URL too, without its trailing slash", () => {
    expect(parseArgs(["--demo", "first-red"], { ...env, FT_URL: "https://preview.example/" })).toEqual({ mode: "demo", url: "https://preview.example", colony: "first-red", landings: 6, breakAt: 4 });
  });

  it("refuses --on or --off beside --demo: the demo has no colony to leave out", () => {
    expect(parseArgs(["--url", "https://preview.example", "--demo", "first-red", "--off", "other"], env)).toEqual({ error: "The demo runs on one colony: leave out --on and --off." });
    expect(parseArgs(["--url", "https://preview.example", "--on", "a", "--demo", "first-red"], env)).toEqual({ error: "The demo runs on one colony: leave out --on and --off." });
  });

  it("needs the colony right after --demo", () => {
    const error = "Name the demo's colony after --demo, a colony that does not exist yet.";
    expect(parseArgs(["--url", "https://preview.example", "--demo"], env)).toEqual({ error });
    expect(parseArgs(["--demo", "--url", "https://preview.example"], env)).toEqual({ error });
  });

  it("refuses what the API would not accept as a colony id", () => {
    for (const bad of ["First-Red", "-first-red", "first red", `${"a".repeat(49)}`]) {
      const out = parseArgs(["--url", "https://preview.example", "--demo", bad], env);
      expect("error" in out && out.error).toContain(`"${bad}" is not a colony id`);
    }
    expect(parseArgs(["--url", "https://preview.example", "--demo", "a".repeat(48)], env)).toMatchObject({ mode: "demo" });
  });
});

describe("bisect.ts arguments: the check", () => {
  it("runs the check on two different colonies, as before the demo existed", () => {
    expect(parseArgs(["--url", "https://preview.example/", "--on", "fr-on", "--off", "fr-off"], env)).toEqual({ mode: "check", url: "https://preview.example", on: "fr-on", off: "fr-off", landings: 6, breakAt: 4 });
  });

  it("asks for both colonies, or the demo, when one is missing", () => {
    const error = "Name two new colonies, --on (one FT_BISECT lists) and --off (one it does not), or run the demo with --demo <colony>.";
    expect(parseArgs(["--url", "https://preview.example", "--on", "fr-on"], env)).toEqual({ error });
    expect(parseArgs(["--url", "https://preview.example", "--on", "--off", "fr-off"], env)).toEqual({ error });
    expect(parseArgs(["--url", "https://preview.example"], env)).toEqual({ error });
  });

  it("refuses one colony for both", () => {
    expect(parseArgs(["--url", "https://preview.example", "--on", "same", "--off", "same"], env)).toEqual({ error: "--on and --off must name two different colonies." });
  });
});

describe("bisect.ts arguments: what both need", () => {
  it("needs the deployment before anything else", () => {
    expect(parseArgs(["--demo", "first-red"], env)).toEqual({ error: "Name the deployment with --url (or FT_URL)." });
  });

  it("needs the admin token set, and never repeats it", () => {
    const out = parseArgs(["--url", "https://preview.example", "--demo", "first-red"], { FT_ADMIN_TOKEN: "" });
    expect(out).toEqual({ error: "Set FT_ADMIN_TOKEN: the script creates colonies and lands changes, which needs the admin token." });
    expect(JSON.stringify(parseArgs(["--url", "https://preview.example", "--demo", "first-red"], { FT_ADMIN_TOKEN: "sekrit-value" }))).not.toContain("sekrit-value");
  });

  it("prints both forms in the usage", () => {
    expect(USAGE).toContain("--on <new colony id FT_BISECT lists> --off <another new colony id>");
    expect(USAGE).toContain("--demo <new colony id>");
  });
});

describe("bisect.ts arguments: the history (--landings, --break-at)", () => {
  const check = ["--url", "https://preview.example", "--on", "fr-on", "--off", "fr-off"];
  const demo = ["--url", "https://preview.example", "--demo", "first-red"];

  it("lands six with the break at the fourth when both are absent, in both forms", () => {
    expect(parseArgs(check, env)).toMatchObject({ mode: "check", landings: 6, breakAt: 4 });
    expect(parseArgs(demo, env)).toMatchObject({ mode: "demo", landings: 6, breakAt: 4 });
  });

  it("puts the break in the middle of --landings when --break-at is absent", () => {
    expect(parseArgs([...check, "--landings", "40"], env)).toMatchObject({ mode: "check", landings: 40, breakAt: 21 });
    expect(parseArgs([...demo, "--landings", "100"], env)).toMatchObject({ mode: "demo", landings: 100, breakAt: 51 });
    expect(parseArgs([...demo, "--landings", "1"], env)).toMatchObject({ landings: 1, breakAt: 1 });
  });

  it("takes --break-at with or without --landings", () => {
    expect(parseArgs([...check, "--landings", "100", "--break-at", "7"], env)).toMatchObject({ landings: 100, breakAt: 7 });
    expect(parseArgs([...demo, "--break-at", "2"], env)).toMatchObject({ landings: 6, breakAt: 2 });
    expect(parseArgs([...demo, "--break-at", "6"], env)).toMatchObject({ landings: 6, breakAt: 6 });
  });

  it("refuses what is not a whole number of landings from 1 to 512", () => {
    for (const bad of ["abc", "4.5", "-3", "+4", "0", "513", "1e2"]) {
      const out = parseArgs([...check, "--landings", bad], env);
      expect("error" in out && out.error).toBe(`--landings takes a whole number from 1 to 512 (how many landings since green the search covers; its landing log holds at most 512), not "${bad}".`);
    }
  });

  it("needs a number right after --landings", () => {
    const error = "--landings needs a whole number after it, from 1 to 512: how many landings since green the search covers; its landing log holds at most 512.";
    expect(parseArgs([...check, "--landings"], env)).toEqual({ error });
    expect(parseArgs([...check, "--landings", "--break-at", "3"], env)).toEqual({ error });
  });

  it("keeps --break-at within the landings", () => {
    for (const bad of ["0", "7", "x", "-1", "2.5"]) {
      const out = parseArgs([...demo, "--break-at", bad], env);
      expect("error" in out && out.error).toBe(`--break-at takes a whole number from 1 to 6 (which of the 6 landings since green breaks the test, counted from the first), not "${bad}".`);
    }
    expect(parseArgs([...demo, "--landings", "40", "--break-at", "41"], env)).toMatchObject({ error: expect.stringContaining("from 1 to 40") });
    expect(parseArgs([...demo, "--break-at"], env)).toEqual({ error: "--break-at needs a whole number after it, from 1 to 6: which of the 6 landings since green breaks the test, counted from the first." });
  });

  it("refuses a history the search's 8 runs do not settle, and says how far they would get", () => {
    const out = parseArgs([...check, "--landings", "129", "--break-at", "129"], env);
    expect("error" in out && out.error).toBe(
      "The search's 8 test runs do not settle 129 landings with the break at position 129: it would stop with the first failing commit narrowed to 2 landings. Use at most 128 landings (the runs settle every position of those), or a position they settle.",
    );
    expect(parseArgs([...check, "--landings", "512"], env)).toMatchObject({ error: expect.stringContaining("do not settle 512 landings with the break at position 257") });
    // Every position of 128 landings settles; past that, some still do.
    expect(parseArgs([...check, "--landings", "128", "--break-at", "128"], env)).toMatchObject({ landings: 128, breakAt: 128 });
    expect(parseArgs([...check, "--landings", "129", "--break-at", "1"], env)).toMatchObject({ landings: 129, breakAt: 1 });
  });

  it("checks the history after the form's own arguments", () => {
    expect(parseArgs(["--url", "https://preview.example", "--on", "a", "--demo", "first-red", "--landings", "abc"], env)).toEqual({ error: "The demo runs on one colony: leave out --on and --off." });
    expect(parseArgs(["--url", "https://preview.example", "--on", "a", "--landings", "abc"], env)).toMatchObject({ error: expect.stringContaining("Name two new colonies") });
  });

  it("names both options in the usage", () => {
    expect(USAGE).toContain("[--landings <n>] [--break-at <k>]");
    expect(USAGE).toContain("up to 128 landings in its 8 test runs");
  });
});
