import { z } from "zod";
import { GUIDE_LIMITS, INLINE_LIMITS } from "@fire_trident/core";

/** A git object id (SHA-1, or SHA-256 for repos that use it), lowercase hex. */
const Sha = z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/, "expected a lowercase hex commit id");
const PathString = z.string().trim().min(1).max(1024);
const Name = z.string().trim().min(1).max(200);

/** POST /api/colonies */
export const CreateColonyBody = z.object({
  name: Name,
  source: z
    .object({
      url: z.string().trim().url().max(2048),
      branch: z.string().trim().min(1).max(255).optional(),
    })
    .optional(),
  regionDepth: z.number().int().min(1).max(8).optional(),
  poolTarget: z.number().int().min(0).max(10_000).optional(),
  /** Alias of poolTarget (the CLI sends `pool`). */
  pool: z.number().int().min(0).max(10_000).optional(),
});

/** POST /api/colonies/:id/intents */
export const IntentBody = z.object({
  title: z.string().trim().min(1).max(500),
  why: z.string().max(20_000).default(""),
  footprint: z.array(PathString).min(1).max(1_000),
  priority: z.number().finite().min(0).max(1_000).default(1),
  source: z.enum(["human", "agent", "rule"]).default("human"),
  acceptance: z.array(z.string().max(2_000)).max(100).optional(),
  parentId: z.string().min(1).max(100).optional(),
  ruleId: z.string().min(1).max(100).optional(),
  assignedTo: z.string().min(1).max(100).optional(),
  createdBy: z.string().trim().min(1).max(200).optional(),
  /** Contest mode: 2 to 4 agents each build the intent and the colony lands one change (1: one holder, as usual). */
  contest: z.number().int().min(1).max(4).optional(),
  /** Twin intents (FT_TWINS): declare it even when it matches an intent the colony has (colony/twins.ts). */
  force: z.boolean().optional(),
});

/** POST /api/colonies/:id/rules */
export const RuleBody = z.object({
  kind: z.enum(["forbid-pattern", "forbid-import"]),
  spec: z.record(z.string(), z.unknown()),
  description: z.string().trim().min(1).max(500),
  approvedBy: z.string().trim().min(1).max(200).optional(),
});

/** POST /api/colonies/:id/agents */
export const AgentBody = z.object({
  name: Name,
  kind: z.enum(["internal", "external", "synthetic"]).default("external"),
  model: z.string().trim().min(1).max(200).optional(),
});

const FileVersionBody = z.object({ path: PathString, blob: Sha.nullable() });

/** POST /api/colonies/:id/proposals */
export const ProposalBody = z.object({
  intentId: z.string().min(1).max(100),
  agentId: z.string().min(1).max(100),
  workspace: z.object({ namespace: z.string().min(1).max(200), name: z.string().min(1).max(200), remote: z.string().min(1).max(2048) }),
  baseSha: Sha,
  headSha: Sha,
  writeSet: z.array(FileVersionBody).min(1).max(5_000),
  readSet: z.array(FileVersionBody).max(50_000).default([]),
  declared: z.object({ footprint: z.array(PathString).max(1_000).default([]), summary: z.string().max(20_000).default("") }).default({ footprint: [], summary: "" }),
  /** The intent revision the change was built on (from the assignment); see Proposal.intentRevision. */
  intentRevision: z.number().int().min(1).max(1_000_000).optional(),
  /**
   * An inline change (colony/inline.ts; on where FT_INLINE allows it): the text of every file the write set writes,
   * keyed by its git blob id, and headSha is the changeset id of baseSha and the write set. The colony checks it all.
   */
  contents: z
    .record(Sha, z.string().max(INLINE_LIMITS.fileBytes))
    .refine((c) => Object.keys(c).length <= INLINE_LIMITS.files, { message: `an inline change writes at most ${INLINE_LIMITS.files} files` })
    .optional(),
  evidence: z
    .object({
      checks: z.array(z.object({ name: z.string().max(200), ok: z.boolean(), ms: z.number().finite().min(0), detail: z.string().max(20_000).optional() })).max(200).optional(),
      notVerified: z.string().max(5_000).optional(),
      previewUrl: z.string().url().max(2048).optional(),
    })
    .optional(),
  /** One surprising fact the agent learned, for the colony's field guide (FT_FIELD_GUIDE; ignored where it is off). */
  lesson: z.string().max(GUIDE_LIMITS.lessonChars).optional(),
});

/** POST /api/colonies/:id/review/:pid */
export const DecisionBody = z.object({
  decision: z.enum(["approve", "reject", "return"]),
  reason: z.string().max(5_000).default(""),
  by: z.string().trim().min(1).max(200).optional(),
});

/** POST /api/colonies/:id/landings/:ref/revert: a person undoes a landing (`ref`: landing id or trunk commit). */
export const RevertBody = z.object({
  reason: z.string().trim().min(1).max(5_000),
  by: z.string().trim().min(1).max(200).optional(),
  /** Declare the intents it completed again (default true). */
  redo: z.boolean().default(true),
  /** One proposal that landed in that landing: only the files it wrote go back and only its intent is declared again. */
  proposal: z.string().trim().min(1).max(100).optional(),
});

/** POST /api/colonies/:id/swarm (the CLI sends `agents` for the count). */
export const SwarmBody = z
  .object({
    count: z.number().int().min(1).max(1_000).optional(),
    agents: z.number().int().min(1).max(1_000).optional(),
    kind: z.enum(["internal", "synthetic"]).optional(),
    model: z.string().trim().min(1).max(200).optional(),
  })
  .refine((b) => b.count !== undefined || b.agents !== undefined, { message: "count is required (1..1000)", path: ["count"] });

/** POST /api/colonies/:id/agents/:aid/stop (the body is optional). */
export const StopBody = z.object({
  reason: z.string().trim().min(1).max(500).optional(),
});

/** POST /api/colonies/:id/swarm/stop (the body is optional). `all` also re-stops agents already stopped. */
export const SwarmStopBody = z.object({
  reason: z.string().trim().min(1).max(500).optional(),
  all: z.boolean().optional(),
});

/** GET /api/colonies/:id/why */
export const WhyQuery = z.object({
  path: PathString,
  line: z.coerce.number().int().min(1).optional(),
});

/** Why a direction changes: recorded with the change and sent to the agents it affects. */
const Reason = z.string().trim().min(1, "a reason is required").max(500);

/** PATCH /api/colonies/:id/intents/:iid: amend an intent (at least one field, and a reason). */
export const AmendIntentBody = z
  .object({
    title: z.string().trim().min(1).max(500).optional(),
    why: z.string().max(20_000).optional(),
    footprint: z.array(PathString).min(1).max(1_000).optional(),
    priority: z.number().finite().min(0).max(1_000).optional(),
    reason: Reason,
    by: z.string().trim().min(1).max(200).optional(),
  })
  .refine((b) => b.title !== undefined || b.why !== undefined || b.footprint !== undefined || b.priority !== undefined, {
    message: "give at least one of title, why, footprint or priority",
    path: ["title"],
  });

/** POST /api/colonies/:id/intents/:iid/withdraw and DELETE /api/colonies/:id/rules/:rid. */
export const WithdrawBody = z.object({
  reason: Reason,
  by: z.string().trim().min(1).max(200).optional(),
});

/** POST /api/colonies/:id/agents/:aid/directive: free-text guidance for one agent. */
export const DirectiveBody = z.object({
  message: z.string().trim().min(1, "a directive needs a message").max(2_000),
  intentId: z.string().trim().min(1).max(100).optional(),
  by: z.string().trim().min(1).max(200).optional(),
});

/** POST /api/colonies/:id/agents/:aid/status: the agent's one-line "what I am doing now" (kept to 280 characters). */
export const StatusBody = z.object({
  note: z.string().trim().min(1, "a status note cannot be empty").max(2_000),
});

/**
 * POST /api/colonies/:id/intents/:iid/escalation: a person answers an agent's report that the intent
 * cannot be done as written. `amend` changes the intent (at least one of amend.title, amend.why,
 * amend.footprint) and reopens it; `withdraw` withdraws it; `dismiss` reopens it unchanged. The note
 * is the answer: the amendment's or withdrawal's reason, or guidance for whoever takes it next.
 */
export const EscalationBody = z
  .object({
    decision: z.enum(["amend", "withdraw", "dismiss"]),
    note: z.string().trim().min(1, "a note is required").max(2_000),
    by: z.string().trim().min(1).max(200).optional(),
    amend: z
      .object({
        title: z.string().trim().min(1).max(500).optional(),
        why: z.string().max(20_000).optional(),
        footprint: z.array(PathString).min(1).max(1_000).optional(),
      })
      .optional(),
  })
  .refine((b) => b.decision !== "amend" || (b.amend !== undefined && (b.amend.title !== undefined || b.amend.why !== undefined || b.amend.footprint !== undefined)), {
    message: "amend needs amend.title, amend.why or amend.footprint",
    path: ["amend"],
  });
