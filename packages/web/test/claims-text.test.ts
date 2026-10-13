import { describe, expect, it } from "vitest";
import script from "../src/director/script.json";
import { GUIDE_STEPS } from "../src/guide.ts";

/** What the guide and the director captions claim about the platform stays true to what it does. */

const step = (target: string): string => GUIDE_STEPS.find((s) => s.target === target)?.text ?? "";

describe("claims on screen", () => {
  it("says what certified means instead of claiming every test passed", () => {
    expect(step("trunk")).toContain("`certified` is the newest commit on which every test file that could run passed and no test that passed before was lost.");
    expect(step("trunk")).not.toMatch(/all passed/);
  });

  it("says the trunk writer commits each batch, not one commit for every lane", () => {
    expect(step("lanes")).toContain("one trunk writer commits each batch and pushes them together.");
    expect(step("lanes")).not.toMatch(/single commit/);
  });

  it("says a change of direction stops uncommitted work, not that old work never lands", () => {
    const scene = script.scenes.find((s) => s.id === "direction");
    expect(scene?.sub).toBe("{direction}. Needs move, agents re-orient, and uncommitted work for the old direction is stopped.");
    for (const s of script.scenes) expect(`${s.caption} ${s.sub ?? ""}`).not.toMatch(/never lands/);
  });
});
