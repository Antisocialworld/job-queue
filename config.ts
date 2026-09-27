export function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) return fallback;
  return parsed;
}

export const MAX_ATTEMPTS = intFromEnv("MAX_ATTEMPTS", 5);
export const WORKER_CONCURRENCY = intFromEnv("WORKER_CONCURRENCY", 3);
export const POLL_INTERVAL_MS = intFromEnv("POLL_INTERVAL_MS", 1000);
export const BASE_DELAY_MS = intFromEnv("BASE_DELAY_MS", 5000);
export const STUCK_TIMEOUT_MS = intFromEnv("STUCK_TIMEOUT_MS", 60000);

/**
 * How often a worker refreshes `Job.lastHeartbeat` while a job is in flight.
 *
 * Derived from STUCK_TIMEOUT_MS rather than hard-coded so the safety margin
 * is structural: a job survives roughly 6 missed heartbeats before the sweep
 * will call it stuck. With the default 60s timeout that is a 10s heartbeat.
 * Override with HEARTBEAT_INTERVAL_MS only if you keep it well under
 * STUCK_TIMEOUT_MS/3.
 */
export const HEARTBEAT_INTERVAL_MS = intFromEnv(
  "HEARTBEAT_INTERVAL_MS",
  Math.max(250, Math.floor(STUCK_TIMEOUT_MS / 6))
);

/**
 * Hard ceiling on how long one job attempt may run, measured from its real
 * `startedAt`, REGARDLESS of whether its worker is still heartbeating.
 *
 * A heartbeat only proves the process is alive, not that the work is
 * progressing. An infinite loop, or a call that hangs without ever timing
 * out, beats happily forever and would occupy a worker slot permanently.
 * This cap is what catches that.
 *
 * Default 20000 (20s). A real, successful Gmail SMTP send typically completes
 * in well under 5 seconds, so 20s leaves generous, real headroom for network
 * slowness while staying meaningfully tighter than the 60000ms
 * STUCK_TIMEOUT_MS — so a genuinely stuck job is caught well before the
 * dead-worker check would ever need to consider it.
 */
export const MAX_JOB_DURATION_MS = intFromEnv("MAX_JOB_DURATION_MS", 20000);

/**
 * The two timeouts detect different real failures, so the ordering between
 * them is an invariant rather than a preference: the duration cap must fire
 * first, otherwise a hung-but-alive job would sit until the far longer
 * dead-worker timeout. Violating this silently produces a config where the
 * hard ceiling can never beat the heartbeat sweep, so fail loudly instead.
 */
if (MAX_JOB_DURATION_MS > STUCK_TIMEOUT_MS) {
  throw new Error(
    `Invalid job-queue configuration: MAX_JOB_DURATION_MS (${MAX_JOB_DURATION_MS}ms) must be <= ` +
      `STUCK_TIMEOUT_MS (${STUCK_TIMEOUT_MS}ms). The duration cap is the hard ceiling for a ` +
      `hung-but-alive job and must fire before the dead-worker timeout, otherwise a ` +
      `permanently stuck job can never be caught. Lower MAX_JOB_DURATION_MS or raise ` +
      `STUCK_TIMEOUT_MS.`
  );
}

export const BACKOFF_JITTER_FRACTION = 0.3;

/**
 * How long a worker waits for the peer that won an `EmailLog` insert race to
 * record a real send, before concluding the outcome is genuinely uncertain.
 *
 * This exists because losing the insert race and holding the valid lease are
 * two independent facts that can belong to different workers. The lease-holder
 * is the only one authorised to write terminal state, so instead of abandoning
 * the job when it loses the insert race, it waits briefly to see whether the
 * winner actually delivered. If it did, the lease-holder records `succeeded`
 * and the job converges with no second send. If the row is still `sending`
 * after this budget, the winner genuinely never confirmed a send and the
 * outcome really is unknown.
 *
 * Default 2000ms. Long enough to cover the gap between a peer's insert and its
 * `sent` flip, short enough that a worker slot is not held hostage. Kept well
 * under MAX_JOB_DURATION_MS so a slow peer is still caught by the duration cap
 * rather than by this wait.
 */
export const DUPLICATE_SEND_CONFIRM_MS = intFromEnv("DUPLICATE_SEND_CONFIRM_MS", 2000);