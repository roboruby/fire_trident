/**
 * The agent's watchdog alarm (AgentDO.alarm). Every tick first sets the alarm WATCHDOG_MS ahead, so a tick that dies
 * with its isolate resumes within a minute, and at its end sets the alarm for its next step.
 *
 * An alarm that finds a tick still running. The runtime runs one alarm handler at a time per object, so in the normal
 * case the watchdog cannot fire during the tick that set it: the next alarm is delivered after the handler returns, and
 * the tick's own last setAlarm stands. The flag outlives its handler only when the runtime gave up on that handler (the
 * 15-minute wall limit for an alarm, which a long produce step of many files and slow model calls can pass, or a failed
 * invocation it retries) while the tick's promise still runs in the same isolate. Then every retry used to re-arm one
 * second ahead: an alarm a second for as long as the leftover tick ran. Now it re-arms WATCHDOG_MS ahead while the
 * leftover tick's step runs, and once that tick has chosen its next alarm (it is finishing), no later than that and at
 * least BUSY_MIN_MS ahead, so a tick that ends just then is not held back a minute.
 */

/** Re-arm time set at the start of every tick, so a killed tick resumes within a minute. */
export const WATCHDOG_MS = 60_000;
/** The soonest an alarm that finds a tick running comes back. */
export const BUSY_MIN_MS = 1_000;

/**
 * When an alarm that finds a tick still running should fire again: WATCHDOG_MS ahead while the tick's step runs
 * (`chosenAt` null), else the time the tick chose for its next alarm, held to [BUSY_MIN_MS, WATCHDOG_MS] ahead.
 */
export function busyAlarmAt(now: number, chosenAt: number | null): number {
  if (chosenAt === null || !Number.isFinite(chosenAt)) return now + WATCHDOG_MS;
  return Math.max(now + BUSY_MIN_MS, Math.min(chosenAt, now + WATCHDOG_MS));
}
