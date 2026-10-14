import { describe, expect, it } from "vitest";
import { USAGE, parseArgs } from "../../../scripts/bisect_args.ts";

/** The command line of scripts/bisect.ts (scripts/bisect_args.ts): the check on two colonies, and the demo on one. */

const env = { FT_ADMIN_TOKEN: "set-for-the-test" };

describe("bisect.ts arguments: the demo", () => {
  it("runs the demo on one new colony", () => {
    expect(parseArgs(["--url", "https://preview.example", "--demo", "first-red"], env)).toEqual({ mode: "demo", url: "https://preview.example", colony: "first-red" });
  });

  it("takes the deployment from FT_URL too, without its trailing slash", () => {
    expect(parseArgs(["--demo", "first-red"], { ...env, FT_URL: "https://preview.example/" })).toEqual({ mode: "demo", url: "https://preview.example", colony: "first-red" });
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
    expect(parseArgs(["--url", "https://preview.example/", "--on", "fr-on", "--off", "fr-off"], env)).toEqual({ mode: "check", url: "https://preview.example", on: "fr-on", off: "fr-off" });
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
