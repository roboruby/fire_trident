import { describe, expect, it } from "vitest";
import { landingMessage, type LineageNote, type Proposal } from "@fire_trident/core";
import { sealNote, trailerDigest, withNoteDigest } from "../../src/trunk/digest.ts";
import { COAUTHOR_DOMAIN, agentAddress, creditLines, creditsEnabled, withCredits } from "../../src/trunk/credits.ts";
import { checkSignature, noteSigner, withSignature } from "../../src/trunk/signature.ts";

/** Credit trailers on landing commits (trunk/credits.ts): who co-authored a landing and who approved it, above the FT trailers. */

type Entry = LineageNote["proposals"][number];
const entry = (id: string, agentId: string, decisions: Entry["decisions"] = []): Entry =>
  ({ id, agentId, agentKind: "external", intent: { id: `int_${id}`, title: id, why: "" }, writeSet: [], readSet: [], decisions, evidence: { checks: [] } }) as Entry;
const approve = (by: string): Entry["decisions"][number] => ({ kind: "triage", layer: "human", p: 1, action: "approve", by });

describe("credit lines", () => {
  it("name each agent once as a co-author with a no-reply address, then each person who approved a change", () => {
    const note = {
      colonyId: "hono",
      proposals: [entry("prp_1", "agt_a", [approve("Dana Reviewer")]), entry("prp_2", "agt_b"), entry("prp_3", "agt_a", [approve("Dana Reviewer")]), entry("prp_4", "agt_c", [approve("api")])],
    };
    const names: Record<string, string> = { agt_a: "scout", agt_b: "builder <b@example.com>\nFT-Note: sha256:00" };
    expect(creditLines(note, (id) => names[id])).toEqual([
      "Co-authored-by: scout <agt_a@hono.noreply.firetrident.dev>",
      // A name is one line with no angle brackets: it cannot add a trailer or an address of its own.
      "Co-authored-by: builder b@example.com FT-Note: sha256:00 <agt_b@hono.noreply.firetrident.dev>",
      // No name: the agent's id stands for it.
      "Co-authored-by: agt_c <agt_c@hono.noreply.firetrident.dev>",
      // A person approved prp_1 and prp_3; prp_4's approver is an API default that names nobody, so it adds no line.
      "Approved-by: Dana Reviewer",
    ]);
    expect(COAUTHOR_DOMAIN).toBe("noreply.firetrident.dev");
  });

  it("make an address from the agent id and the colony that is a valid address whatever they hold", () => {
    expect(agentAddress("agt_0abc12", "order-backend")).toBe("agt_0abc12@order-backend.noreply.firetrident.dev");
    expect(agentAddress("agt x/y", "Weird_Colony!")).toBe("agt-x-y@weird-colony.noreply.firetrident.dev");
    expect(agentAddress("", "")).toBe("agent@colony.noreply.firetrident.dev");
    const long = agentAddress("a".repeat(100), "b".repeat(100));
    expect(long.split("@")[0]).toHaveLength(64);
    expect(long.split("@")[1]!.split(".")[0]).toHaveLength(63);
  });

  it("mask a name that looks like a secret, and say nothing for a note with no agents", () => {
    const lines = creditLines({ colonyId: "c", proposals: [entry("prp_1", "agt_a")] }, () => "ghp_0123456789abcdefghijklmnopqrstuvwxyzAB");
    expect(lines[0]).not.toContain("ghp_0123456789");
    expect(lines[0]).toContain("[masked]");
    expect(creditLines({ colonyId: "c", proposals: [] }, () => undefined)).toEqual([]);
  });

  it("follow FT_CREDIT_TRAILERS like the other colony flags", () => {
    expect(creditsEnabled(undefined, "hono")).toBe(false);
    expect(creditsEnabled("off", "hono")).toBe(false);
    expect(creditsEnabled("on", "hono")).toBe(true);
    expect(creditsEnabled("scale, hono", "hono")).toBe(true);
    expect(creditsEnabled("scale", "hono")).toBe(false);
  });
});

describe("a landing message with credits", () => {
  const proposal = { id: "prp_1", intentId: "int_1", agentId: "agt_a" } as Proposal;
  const base = landingMessage({ id: "lnd_1", intentIds: ["int_1"] }, [proposal], { int_1: "Add a thing" });
  const lines = ["Co-authored-by: scout <agt_a@c.noreply.firetrident.dev>", "Approved-by: Dana Reviewer"];

  it("puts them at the top of the trailer paragraph, above the FT trailers, and FT-Note-Signature and FT-Note stay last", async () => {
    const credited = withCredits(base, lines);
    expect(credited).toBe(base.replace("\n\nFT-Landing: lnd_1", `\n\n${lines.join("\n")}\nFT-Landing: lnd_1`));
    const secret = await (async () => {
      const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
      const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
      return JSON.stringify({ kty: jwk.kty, crv: jwk.crv, d: jwk.d, x: jwk.x });
    })();
    const signer = (await noteSigner(secret))!;
    const note: LineageNote = { schema: "firetrident.lineage/v1", landingId: "lnd_1", colonyId: "c", proposals: [] };
    const { digest } = await sealNote(note);
    const tree = "1".repeat(40);
    const parents = ["2".repeat(40)];
    const message = withNoteDigest(await withSignature(credited, signer, { digest, tree, parents }), digest);
    const paragraphs = message.split("\n\n");
    expect(paragraphs.at(-1)!.split("\n")).toEqual([...lines, "FT-Landing: lnd_1", "FT-Intent: int_1", "FT-Proposal: prp_1", "FT-Agent: agt_a", expect.stringMatching(/^FT-Note-Signature: ed25519 /), `FT-Note: sha256:${digest}`]);
    expect(trailerDigest(message)).toBe(digest);
    expect(await checkSignature({ tree, parents, message }, [signer.key])).toEqual({ status: "signed", keyId: signer.key.id });
  });

  it("is the message as before with no lines, and gets its own paragraph when it has no FT trailers", () => {
    expect(withCredits(base, [])).toBe(base);
    expect(withCredits("Fix a thing\n\nSome body.\n", lines)).toBe(`Fix a thing\n\nSome body.\n\n${lines.join("\n")}`);
  });
});
