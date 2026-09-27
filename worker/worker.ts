import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { WORKER_CONCURRENCY, POLL_INTERVAL_MS, HEARTBEAT_INTERVAL_MS } from "@/config";
import { nextRunAt } from "./backoff";
import { sendEmailJob } from "./email";
import { WORKER_INSTANCE_ID, reportLeaseRejection } from "./lease";

type ClaimedJob = {
  id: string;
  type: string;
  payload: unknown;
  status: string;
  attempts: number;
  maxAttempts: number;
  runAt: Date;
  leaseVersion: number;
  workerInstanceId: string | null;
};

/**
 * Atomic claim. Still a single UPDATE ... FOR UPDATE SKIP LOCKED, now also
 * incrementing `leaseVersion` and stamping `workerInstanceId` in that same
 * statement, so ownership transfer and claim are one indivisible operation.
 * RETURNING hands the worker the exact leaseVersion it now owns.
 */
async function claimOneJob(): Promise<ClaimedJob | null> {
  const rows = await prisma.$queryRaw<ClaimedJob[]>`
    UPDATE "Job"
    SET status = 'processing',
        "startedAt" = NOW(),
        "lastHeartbeat" = NOW(),
        "leaseVersion" = "leaseVersion" + 1,
        "workerInstanceId" = ${WORKER_INSTANCE_ID},
        attempts = attempts + 1
    WHERE id = (
      SELECT id FROM "Job"
      WHERE status = 'pending' AND "runAt" <= NOW()
      ORDER BY "runAt" ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *;
  `;
  return rows[0] ?? null;
}

/**
 * Completion write guarded on the worker's own lease.
 *
 * If the job was reclaimed and re-claimed while this worker was busy, the
 * leaseVersion no longer matches and 0 rows change. That is not a silent
 * no-op: it is recorded as a possible duplicate send and logged loudly.
 */
async function completeAsLeaseHolder(
  job: ClaimedJob,
  data: Prisma.JobUpdateManyMutationInput,
  what: string
): Promise<boolean> {
  const res = await prisma.job.updateMany({
    where: { id: job.id, leaseVersion: job.leaseVersion },
    data,
  });
  if (res.count === 0) {
    await reportLeaseRejection({
      job,
      workerInstanceId: WORKER_INSTANCE_ID,
      what,
      reason: `expected leaseVersion ${job.leaseVersion}, row no longer at that version`,
    });
    return false;
  }
  return true;
}

/**
 * Refresh `Job.lastHeartbeat` for as long as `fn` is still running.
 *
 * This is the liveness signal the sweep trusts. A worker that is alive but
 * slow (a slow SMTP server, a large payload) keeps beating, so the sweep
 * leaves its job alone. A worker that dies stops beating, its heartbeat goes
 * stale, and only then does the sweep reclaim the job.
 *
 * The beat is guarded on the caller's own `leaseVersion` as well as
 * `status = 'processing'`. Both guards are load-bearing. Without the status
 * guard, a late beat from a worker whose job was already reclaimed would
 * resurrect the heartbeat of a job that is back in the queue. Without the
 * lease guard, a worker that lost its lease to the duration cap keeps beating
 * on the *new* holder's job — its beats match because the new holder set the
 * row back to 'processing' — which would mask a job nobody is working on from
 * the liveness sweep indefinitely. A stale worker must be able to neither
 * heartbeat nor write once it has lost the job.
 */
export async function withHeartbeat<T>(
  job: Pick<ClaimedJob, "id" | "leaseVersion">,
  fn: () => Promise<T>
): Promise<T> {
  const beat = async () => {
    try {
      await prisma.job.updateMany({
        where: { id: job.id, status: "processing", leaseVersion: job.leaseVersion },
        data: { lastHeartbeat: new Date() },
      });
    } catch (err) {
      // A failed beat must never fail the job; the sweep will reclaim it if
      // beats genuinely stop for long enough.
      console.error(`[worker] heartbeat failed for job ${job.id}:`, err);
    }
  };

  await beat();
  const timer = setInterval(beat, HEARTBEAT_INTERVAL_MS);
  // Do not hold the process open just for heartbeats.
  timer.unref?.();
  try {
    return await fn();
  } finally {
    clearInterval(timer);
  }
}

/**
 * The concrete shape of a send attempt, derived from `sendEmailJob` itself so
 * the two can never drift apart. This must be a real return type: `runJob`
 * branches on `result.state`, and when this was `Promise<void>` the caller
 * received `undefined` and every attempt — including the ordinary
 * already-sent retry — died on `Cannot read properties of undefined`.
 */
type SendResult = Awaited<ReturnType<typeof sendEmailJob>>;

async function processJob(job: ClaimedJob): Promise<SendResult> {
  if (job.type !== "email") {
    throw new Error(`unknown job type: ${job.type}`);
  }
  // Returned, not logged-and-dropped: the caller owns the decision about
  // what the result means, and needs the real value to make it.
  return sendEmailJob(job as never);
}

async function runJob(job: ClaimedJob): Promise<void> {
  try {
    const result = await withHeartbeat(job, () => processJob(job));

    if (result.state === "deferred") {
      // Another worker won the EmailLog race and never confirmed a send, so
      // the outcome really is unknown. Deliberately write NO completion status
      // here: a retry from this side is exactly what could place a second real
      // send.
      console.warn(
        `[worker] job ${job.id} deferred to the worker that owns the send ` +
          `(workerInstanceId=${WORKER_INSTANCE_ID}); no completion write, no retry`
      );
      return;
    }

    if (result.state === "alreadySent") {
      console.log(`[worker] job ${job.id} attempt #${job.attempts} already sent previously — marking succeeded`);
    } else {
      console.log(
        `[worker] job ${job.id} attempt #${job.attempts} email sent messageId=${result.messageId} smtp="${result.response}"`
      );
    }

    const wrote = await completeAsLeaseHolder(
      job,
      { status: "succeeded", finishedAt: new Date() },
      "succeeded-completion"
    );
    if (wrote) console.log(`[worker] job ${job.id} succeeded`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const gotDead = job.attempts >= job.maxAttempts;
    console.log(`[worker] job ${job.id} attempt #${job.attempts} failed: ${message}`);
    if (gotDead) {
      await completeAsLeaseHolder(
        job,
        { status: "dead", lastError: message, finishedAt: new Date() },
        "dead-completion"
      );
      console.log(`[worker] job ${job.id} attempts ${job.attempts} exhausted max ${job.maxAttempts} — DEAD`);
    } else {
      const wrote = await completeAsLeaseHolder(
        job,
        {
          status: "pending",
          lastError: message,
          runAt: nextRunAt(job.attempts),
          startedAt: null,
          lastHeartbeat: null,
        },
        "retry-completion"
      );
      if (wrote) console.log(`[worker] job ${job.id} scheduled for retry at ${new Date().toISOString()}`);
    }
  }
}

async function main(): Promise<void> {
  console.log(
    `[worker] starting pid=${process.pid} workerInstanceId=${WORKER_INSTANCE_ID} concurrency=${WORKER_CONCURRENCY} poll=${POLL_INTERVAL_MS}ms`
  );
  const inFlight = new Map<string, Promise<void>>();

  const tick = async () => {
    while (inFlight.size < WORKER_CONCURRENCY) {
      const claimed = await claimOneJob();
      if (!claimed) break;
      console.log(
        `[worker] claimed job ${claimed.id} attempts=${claimed.attempts} inFlight=${inFlight.size + 1}/${WORKER_CONCURRENCY}`
      );
      const p = runJob(claimed).finally(() => {
        inFlight.delete(claimed.id);
        console.log(`[worker] released job ${claimed.id} inFlight=${inFlight.size}/${WORKER_CONCURRENCY}`);
      });
      inFlight.set(claimed.id, p);
    }
  };

  await tick();
  setInterval(tick, POLL_INTERVAL_MS);
}

// Only start the poll loop when this file is run as a program. Tests import
// `withHeartbeat` from here and must not kick off a competing worker.
const isDirectRun = process.argv[1]
  ? realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  : false;

if (isDirectRun) {
  main().catch((err) => {
    console.error("[worker] fatal:", err);
    process.exit(1);
  });
}