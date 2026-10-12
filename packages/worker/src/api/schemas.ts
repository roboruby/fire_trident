import { z } from "zod";

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
  evidence: z
    .object({
      checks: z.array(z.object({ name: z.string().max(200), ok: z.boolean(), ms: z.number().finite().min(0), detail: z.string().max(20_000).optional() })).max(200).optional(),
      notVerified: z.string().max(5_000).optional(),
      previewUrl: z.string().url().max(2048).optional(),
    })
    .optional(),
});

/** POST /api/colonies/:id/review/:pid */
export const DecisionBody = z.object({
  decision: z.enum(["approve", "reject", "return"]),
  reason: z.string().max(5_000).default(""),
  by: z.string().trim().min(1).max(200).optional(),
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

/** GET /api/colonies/:id/why */
export const WhyQuery = z.object({
  path: PathString,
  line: z.coerce.number().int().min(1).optional(),
});
