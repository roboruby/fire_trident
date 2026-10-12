import { describe, expect, it } from "vitest";
import { modelClient } from "../../src/agents/llm.ts";

/** The AI binding as the client uses it: records which model ran. */
function fakeAi() {
  const ran: string[] = [];
  return {
    ran,
    run: async (model: string) => {
      ran.push(model);
      return { response: "<file>\nx\n</file>", usage: { prompt_tokens: 10, completion_tokens: 2 } };
    },
  };
}

describe("modelClient", () => {
  it("resolves the default and bulk classes to the server's models and says which answered", async () => {
    const ai = fakeAi();
    const client = modelClient({ AI: ai as unknown as Ai, FT_DEFAULT_MODEL: "@cf/vendor/strong", FT_BULK_MODEL: "@cf/vendor/cheap" });
    const reply = await client.complete({ model: "default", messages: [{ role: "user", content: "hi" }], maxTokens: 10 });
    expect(reply.model).toBe("@cf/vendor/strong");
    expect((await client.complete({ model: "bulk", messages: [], maxTokens: 10 })).model).toBe("@cf/vendor/cheap");
    expect((await client.complete({ model: "@cf/vendor/other", messages: [], maxTokens: 10 })).model).toBe("@cf/vendor/other");
    expect(ai.ran).toEqual(["@cf/vendor/strong", "@cf/vendor/cheap", "@cf/vendor/other"]);
    expect(reply.usage).toMatchObject({ input: 10, output: 2 });
  });
});
