import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Env } from "../env.ts";

/** Stub: import pipeline (history mining, regions, seeding checks). */
export class IngestWorkflow extends WorkflowEntrypoint<Env, Record<string, unknown>> {
  async run(_event: WorkflowEvent<Record<string, unknown>>, _step: WorkflowStep): Promise<void> {}
}
