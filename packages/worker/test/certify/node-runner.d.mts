import type { TestCounts } from "@fire_trident/core";
import type { Plan } from "../../src/certify/plan.ts";
import type { RunReport } from "../../src/certify/report.ts";

/** Run a plan's harness in a fresh Node process and return its report. */
export declare function runPlanInNode(plan: Plan): RunReport;
/** Run `node --test` on `paths` of a project written from `files`, and parse its summary counts. */
export declare function nodeTestCounts(files: Record<string, string>, paths: string[]): TestCounts & { output: string };
/** Does this Node run TypeScript files by stripping types? */
export declare function nodeStripsTypes(): boolean;
