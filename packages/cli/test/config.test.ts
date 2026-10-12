import { describe, expect, it } from "vitest";
import { DEFAULT_URL } from "../src/api.ts";
import { configPath, parseEnvFile, withConfig } from "../src/config.ts";

describe("configPath", () => {
  it("prefers XDG_CONFIG_HOME, then HOME", () => {
    expect(configPath({ XDG_CONFIG_HOME: "/x/cfg/", HOME: "/home/a" })).toBe("/x/cfg/firetrident/env");
    expect(configPath({ HOME: "/home/a/" })).toBe("/home/a/.config/firetrident/env");
    expect(configPath({})).toBeNull();
  });
});

describe("parseEnvFile", () => {
  it("reads KEY=value lines with comments, export and quotes", () => {
    const text = [
      "# FireTrident",
      "FT_URL=https://ft.example.com",
      "export FT_TOKEN='s3cret'",
      'FT_USER="Ana Lima"',
      "FT_EMPTY=",
      "  FT_SPACED = padded  # trailing comment",
      "not a line",
      "",
    ].join("\n");
    expect(parseEnvFile(text)).toEqual({ FT_URL: "https://ft.example.com", FT_TOKEN: "s3cret", FT_USER: "Ana Lima", FT_EMPTY: "", FT_SPACED: "padded" });
    expect(parseEnvFile("A=1\r\nB=2\r\n")).toEqual({ A: "1", B: "2" });
  });
});

describe("withConfig", () => {
  const file = { FT_URL: "https://ft.example.com", FT_TOKEN: "filetok", FT_USER: "ana" };

  it("fills FT_URL, FT_TOKEN and FT_USER when unset", () => {
    expect(withConfig({ HOME: "/h" }, file)).toEqual({ HOME: "/h", FT_URL: "https://ft.example.com", FT_TOKEN: "filetok", FT_USER: "ana" });
  });

  it("never overrides the environment", () => {
    expect(withConfig({ FT_URL: "https://ft.example.com/", FT_TOKEN: "envtok", FT_USER: "bo" }, file)).toEqual({ FT_URL: "https://ft.example.com/", FT_TOKEN: "envtok", FT_USER: "bo" });
  });

  it("uses the file's token with the file's server only", () => {
    expect(withConfig({ FT_URL: "https://ft.example.com/api" }, file).FT_TOKEN).toBe("filetok");
    expect(withConfig({ FT_URL: "http://localhost:8787" }, file).FT_TOKEN).toBeUndefined();
    expect(withConfig({}, file, "http://localhost:8787").FT_TOKEN).toBeUndefined();
    expect(withConfig({}, file, "https://ft.example.com").FT_TOKEN).toBe("filetok");
  });

  it("pairs a token without a URL with the default server", () => {
    expect(withConfig({}, { FT_TOKEN: "t" }).FT_TOKEN).toBe("t");
    expect(withConfig({ FT_URL: DEFAULT_URL }, { FT_TOKEN: "t" }).FT_TOKEN).toBe("t");
    expect(withConfig({ FT_URL: "https://elsewhere.example" }, { FT_TOKEN: "t" }).FT_TOKEN).toBeUndefined();
    expect(withConfig({}, { FT_URL: "not a url", FT_TOKEN: "t" }).FT_TOKEN).toBeUndefined();
  });
});
