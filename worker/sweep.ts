import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { prisma } from "@/lib/prisma";
import { STUCK_TIMEOUT_MS } from "@/config";
import { reclaimOverlongJobs } from "./overlong";

/**
 * Reclaim jobs whose worker has stopped beating.
 *
 * Liveness is measured from `lastHeartbeat`, NOT from `startedAt`. A worker
 * that is alive but slow (SMTP taking longer than usual) keeps refreshing its
 * heartbeat, so its job is left alone no matter how long it has been open.
 * Only a genuinely dead worker — one whose beats have stopped — lets its
 * heartbeat go stale and gets reclaimed here.
 *
 * The `lastHeartbeat: null` branch keeps this NULL-safe. In SQL, comparing
 * NULL with `<` yields NULL, never true, so a plain `lastHeartbeat < cutoff`
 * filter would silently skip any job with no heartbeat row and leave it stuck
 * in 'processing' forever. Jobs with no heartbeat can only predate this
 * column, so they fall back to the old `startedAt` rule.
 */
export async function sweepStuckJobs(): Promise<number> {
  const cutoff = new Date(Date.now() - STUCK_TIMEOUT_MS);
  console.log(
    `[sweep] resetting jobs in 'processing' whose lastHeartbeat < ${cutoff.toISOString()} (timeout ${STUCK_TIMEOUT_MS}ms)`
  );
  const result = await prisma.job.updateMany({
    where: {
      status: "processing",
      OR: [{ lastHeartbeat: { lt: cutoff } }, { lastHeartbeat: null, startedAt: { lt: cutoff } }],
    },
    data: {
      status: "pending",
      attempts: { increment: 1 },
      // Invalidate the dead worker's lease as part of the reclaim, so its late
      // completion write is rejected on leaseVersion rather than quietly
      // resurrecting a job we have just taken back. See the same note in
      // overlong.ts.
      leaseVersion: { increment: 1 },
      workerInstanceId: null,
    },
  });
  console.log(`[sweep] reset ${result.count} stuck job(s) to pending`);
  return result.count;
}

async function main(): Promise<void> {
  // Two independent mechanisms, run in order. The duration cap is tighter, so
  // it runs first and gets first refusal on a job that is both hung and
  // stale. Each keeps its own query and its own log line.
  await reclaimOverlongJobs();
  await sweepStuckJobs();
}

const isDirectRun = process.argv[1]
  ? realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  : false;

if (isDirectRun) {
  main()
    .then(async () => {
      await prisma.$disconnect();
    })
    .catch(async (err) => {
      console.error("[sweep] fatal:", err);
      await prisma.$disconnect();
      process.exit(1);
    });
}
