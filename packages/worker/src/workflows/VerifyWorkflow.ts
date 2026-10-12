import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Env } from "../env.ts";

/** Stub: verification pipeline (innate checks, @cloudflare/ci runners). */
export class VerifyWorkflow extends WorkflowEntrypoint<Env, Record<string, unknown>> {
  async run(_event: WorkflowEvent<Record<string, unknown>>, _step: WorkflowStep): Promise<void> {}
}
