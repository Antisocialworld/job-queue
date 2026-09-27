/**
 * The hard duration ceiling — a mechanism deliberately separate from the
 * heartbeat-based dead-worker sweep in `sweep.ts`.
 *
 * These detect different real failures and must not be folded into one
 * condition:
 *
 *   - `sweep.ts`      : the worker stopped beating  => nobody is working on
 *                       the job any more, so reclaim it. Liveness signal.
 *   - this module     : the job has been running longer than any legitimate
 *                       attempt could take, *even though the worker is still
 *                       beating*. The process is alive but the work is not
 *                       progressing (infinite loop, a call that hangs without
 *                       ever timing out). Progress/ceiling signal.
 *
 * Note this query reads `startedAt` and never consults `lastHeartbeat`. That
 * is the whole point: a fresh heartbeat must not be able to buy a hung job
 * more time. Because it is a plain database predicate, the guarantee holds
 * across separate processes — nothing here depends on in-memory state.
 */
import { prisma } from "@/lib/prisma";
import { MAX_JOB_DURATION_MS } from "@/config";

const REASON = `exceeded MAX_JOB_DURATION_MS (${MAX_JOB_DURATION_MS}ms) while still heartbeating`;

/**
 * Forcibly reclaim jobs that have exceeded MAX_JOB_DURATION_MS.
 *
 * Reclaimed the same way the dead-worker sweep reclaims: back to `pending`
 * with `attempts` incremented once, so the existing backoff-and-dead-letter
 * path bounds how many times a genuinely hung job is retried before it lands
 * in `dead` for a human. That is deliberate — a job that hung once because
 * of a transient network fault should get another attempt, while one that
 * hangs every time exhausts `maxAttempts` and dead-letters instead of
 * looping forever.
 */
export async function reclaimOverlongJobs(): Promise<number> {
  const cutoff = new Date(Date.now() - MAX_JOB_DURATION_MS);
  console.log(
    `[overlong] reclaiming jobs in 'processing' with startedAt < ${cutoff.toISOString()} ` +
      `(MAX_JOB_DURATION_MS=${MAX_JOB_DURATION_MS}ms, ignores heartbeat)`
  );
  const result = await prisma.job.updateMany({
    where: { status: "processing", startedAt: { lt: cutoff } },
    data: {
      status: "pending",
      attempts: { increment: 1 },
      startedAt: null,
      lastHeartbeat: null,
      lastError: REASON,
      // Invalidate the current holder's lease at the moment of the reclaim,
      // not merely when the job is next claimed. Between the reclaim and the
      // re-claim the old worker's leaseVersion would still match, letting a
      // late completion write resurrect a job we have just taken back. Bumping
      // it here means the rejected worker is detected immediately, even if
      // nobody re-claims the job.
      leaseVersion: { increment: 1 },
      workerInstanceId: null,
    },
  });
  console.log(`[overlong] reclaimed ${result.count} overlong job(s) regardless of heartbeat`);
  return result.count;
}
