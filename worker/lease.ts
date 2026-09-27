/**
 * Lease ownership and duplicate-send auditing.
 *
 * A job can be legitimately reclaimed out from under a worker that is still
 * running (the duration cap or the dead-worker sweep will do it). Without a
 * lease, that worker's eventual completion write lands unconditionally and
 * silently overwrites the new lease-holder's result. Worse, the original
 * worker may already have placed a real, irreversible email send.
 *
 * The lease makes that loss *detectable*, and the audit event makes the
 * duplicate-send risk visible to a human instead of leaving it to be inferred.
 *
 * Scope note, deliberately: this records the risk, it does not compensate for
 * it. No retraction email, no undo, no attempt to un-send anything. A real
 * duplicate may genuinely have been delivered and the honest thing is to say
 * so plainly on the job row.
 */
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";

/** Identifies this worker process for the lifetime of the process. */
export const WORKER_INSTANCE_ID = `worker-${randomUUID()}`;

export type LeaseHolder = {
  id: string;
  leaseVersion: number;
};

/** True for a Postgres unique-constraint violation surfaced by Prisma (P2002). */
export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string } | null;
  return !!e && typeof e === "object" && e.code === "P2002";
}

/**
 * Record that a possible duplicate real send may have occurred.
 *
 * This is forensic annotation, NOT a state transition, so it is written
 * unconditionally — including by a worker that has just lost its lease and no
 * longer owns the row. That is the whole point: the worker that lost the race
 * is precisely the one that has the evidence, so it must still be able to
 * write it down.
 *
 * `lastError` is intentionally left alone. It belongs to whoever currently
 * owns the job, and the losing worker must not clobber the winner's real
 * error state. The boolean plus the log line are the durable record.
 */
export async function flagPossibleDuplicateSend(params: {
  jobId: string;
  workerInstanceId: string;
  expectedLeaseVersion: number | null;
  actualLeaseVersion: number | null;
  observedStatus: string | null;
  reason: string;
}): Promise<void> {
  const {
    jobId,
    workerInstanceId,
    expectedLeaseVersion,
    actualLeaseVersion,
    observedStatus,
    reason,
  } = params;

  // Loud, greppable, and names every fact a human needs to judge the risk.
  console.warn(
    `[lease] POSSIBLE DUPLICATE SEND jobId=${jobId} ` +
      `rejectedWorkerInstanceId=${workerInstanceId} ` +
      `leaseVersionMismatch expected=${expectedLeaseVersion} actual=${actualLeaseVersion} ` +
      `observedStatus=${observedStatus} ` +
      `reason="${reason}" ` +
      `-> flagged Job.possibleDuplicateSend=true; NOT compensating for the send`
  );

  await prisma.job.update({
    where: { id: jobId },
    data: { possibleDuplicateSend: true },
  });
}

/**
 * Handle a completion write that matched 0 rows because the lease was lost.
 *
 * Returns the current row state so the caller can log precisely what happened.
 * Never throws: a rejected completion write must not take the worker down.
 */
export async function reportLeaseRejection(params: {
  job: LeaseHolder;
  workerInstanceId: string;
  what: string;
  reason: string;
}): Promise<void> {
  const { job, workerInstanceId, what, reason } = params;
  try {
    const current = await prisma.job.findUnique({
      where: { id: job.id },
      select: { leaseVersion: true, status: true, attempts: true, workerInstanceId: true },
    });
    await flagPossibleDuplicateSend({
      jobId: job.id,
      workerInstanceId,
      expectedLeaseVersion: job.leaseVersion,
      actualLeaseVersion: current?.leaseVersion ?? null,
      observedStatus: current?.status ?? null,
      reason: `${what} rejected: ${reason}`,
    });
    console.warn(
      `[lease] jobId=${job.id} ${what} DISCARDED (lease lost) ` +
        `heldByNow=${current?.workerInstanceId ?? "none"} attempts=${current?.attempts ?? "?"}`
    );
  } catch (err) {
    console.error(`[lease] failed to record lease rejection for job ${job.id}:`, err);
  }
}
