import nodemailer from "nodemailer";
import type { Job } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { DUPLICATE_SEND_CONFIRM_MS } from "@/config";
import { WORKER_INSTANCE_ID, flagPossibleDuplicateSend, isUniqueViolation } from "./lease";

export interface EmailPayload {
  to: string;
  subject: string;
  body: string;
  userId: string;
}

export async function sendRealEmail(payload: EmailPayload): Promise<{ messageId?: string; response?: string }> {
  if (process.env.WORKER_TEST_DISABLE_SEND === "1") {
    const sleepMs = Number.parseInt(process.env.WORKER_TEST_SLEEP_MS ?? "300", 10);
    console.log(
      `[email][TEST] WORKER_TEST_DISABLE_SEND=1 — real Gmail call skipped; sleeping ${sleepMs}ms to hold the claim open`
    );
    await new Promise((r) => setTimeout(r, sleepMs));
    return {
      messageId: `test-${Date.now()}@noop.invalid`,
      response: "250 TEST OK (real send disabled by WORKER_TEST_DISABLE_SEND)",
    };
  }

  const user = process.env.GMAIL_USER;
  const appPassword = process.env.GMAIL_APP_PASSWORD;
  if (!user || !appPassword) {
    throw new Error("GMAIL_USER / GMAIL_APP_PASSWORD not set — cannot send real email");
  }
  const transport = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user, pass: appPassword },
  });
  const info = await transport.sendMail({
    from: user,
    to: payload.to,
    subject: payload.subject,
    text: payload.body,
  });
  return { messageId: info.messageId, response: info.response };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait, briefly, for the peer that won an insert race to record a real send.
 *
 * Returns true as soon as the row reaches `sent`. Returns false only if the
 * budget expires with the row still `sending` — which is genuine uncertainty:
 * the peer inserted but never confirmed a delivery, so the job may or may not
 * have been sent and nobody can honestly say which.
 */
async function waitForPeerSend(jobId: string, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const row = await prisma.emailLog.findUnique({
      where: { jobId },
      select: { state: true },
    });
    if (row?.state === "sent") return true;
    if (Date.now() >= deadline) return false;
    await sleep(Math.min(100, Math.max(10, budgetMs / 10)));
  }
}

/**
 * Idempotent email work, per Part 3 of JOB-QUEUE-COMBINED.md, using the
 * stronger "sending" state fix:
 *
 *  1. The EmailLog row is written in state `sending` BEFORE the provider is
 *     ever called.
 *  2. After `sendRealEmail` genuinely succeeds the row is flipped to `sent`
 *     with a real `sentAt`.
 *
 * A resumed job that finds a `sending` row knows a send attempt was started
 * and never confirmed — honest uncertainty, surfaced rather than silently
 * guessed. A resumed job that finds a `sent` row is a safe, proven no-op.
 *
 * Residual race (documented honestly): a crash between a successful SMTP
 * send and the `sent` update leaves the row at `sending`, so a retry sends
 * one duplicate real email. This window is genuinely narrower than the
 * check-then-act pattern (which had the same window PLUS double-send on two
 * concurrent claims), and the `sending` state at least records the
 * uncertainty. Covered in DOCUMENTATION.md.
 */
export async function sendEmailJob(
  job: Job
): Promise<{ state: "alreadySent" | "sent" | "deferred"; messageId?: string; response?: string }> {
  const payload = job.payload as unknown as EmailPayload;

  const existing = await prisma.emailLog.findUnique({ where: { jobId: job.id } });

  if (existing) {
    if (existing.state === "sent") {
      return { state: "alreadySent" };
    }
    if (existing.state === "sending") {
      console.log(`[email] job ${job.id} has a 'sending' row (unconfirmed prior attempt) — attempting send`);
    }
  } else {
    try {
      await prisma.emailLog.create({
        data: { jobId: job.id, state: "sending", sentAt: null },
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;

      // We lost the insert race. The `EmailLog_jobId_key` unique index is the
      // real, database-level guarantee that the peer owns this send, and we
      // provably never reached `sendRealEmail` — the insert threw above — so
      // THIS worker cannot have caused a duplicate and must not set the
      // duplicate-send flag.
      //
      // But losing the insert and holding the valid lease are two independent
      // facts that can belong to different workers. We are the lease-holder,
      // so we are the only worker authorised to write terminal state. Rather
      // than abandoning the job, wait briefly to see whether the peer actually
      // delivered: if it did, report `alreadySent` and let the caller's
      // lease-guarded completion write record `succeeded`.
      const confirmed = await waitForPeerSend(job.id, DUPLICATE_SEND_CONFIRM_MS);
      if (confirmed) {
        console.log(
          `[email] job ${job.id} lost the insert race to a peer, but the peer recorded a real ` +
            `send within ${DUPLICATE_SEND_CONFIRM_MS}ms — reporting alreadySent so the ` +
            `lease-holder (this worker) can mark it succeeded without a second send`
        );
        return { state: "alreadySent" };
      }

      // Genuine uncertainty: the peer inserted a row but never confirmed a
      // delivery. Nothing is known, so write no status and schedule no retry —
      // a retry from here is exactly what could place a second real send. The
      // reclaim mechanisms will re-offer the job, and whoever claims it next
      // sees the same `sending` uncertainty this worker saw.
      console.warn(
        `[email] job ${job.id} lost the insert race and the peer's row is still 'sending' ` +
          `after ${DUPLICATE_SEND_CONFIRM_MS}ms — outcome genuinely unknown, deferring ` +
          `(workerInstanceId=${WORKER_INSTANCE_ID} holds leaseVersion=${job.leaseVersion}); ` +
          `no completion write, no retry, and no duplicate-send flag because this ` +
          `worker never reached sendRealEmail`
      );
      return { state: "deferred" };
    }
  }

  const info = await sendRealEmail(payload);

  // Record the send, and deliberately do this WITHOUT a lease guard.
  //
  // A delivery that actually happened is a fact about the world, not a
  // scheduling decision. The lease says who is responsible for the job right
  // now; it says nothing about whether the email was sent. Guarding this flip
  // on the lease is what made a real, irreversible send vanish: the row stayed
  // at `sending`, the next claimer read that as an unconfirmed attempt, and
  // sent a duplicate. The unique index on `EmailLog.jobId` already guarantees
  // exactly one worker owns this row, so the lease adds nothing here.
  //
  // If our lease has since been lost, the send may duplicate whatever the new
  // lease-holder does — that is a real, recorded risk, not a reason to discard
  // the truth. So flag it, then record it.
  const currentLease = await prisma.$transaction(async (tx) => {
    const job_ = await tx.job.findUnique({
      where: { id: job.id },
      select: { leaseVersion: true, workerInstanceId: true },
    });
    await tx.emailLog.updateMany({
      where: { jobId: job.id, state: "sending" },
      data: { state: "sent", sentAt: new Date() },
    });
    return job_;
  });

  if (currentLease && currentLease.leaseVersion !== job.leaseVersion) {
    await flagPossibleDuplicateSend({
      jobId: job.id,
      workerInstanceId: WORKER_INSTANCE_ID,
      expectedLeaseVersion: job.leaseVersion,
      actualLeaseVersion: currentLease.leaseVersion,
      observedStatus: null,
      reason:
        "this worker placed a real send while its lease had already been reclaimed " +
        `(lease now held by ${currentLease.workerInstanceId ?? "none"}); the send was still ` +
        "recorded, and it may duplicate the new lease-holder's",
    });
  }

  return { state: "sent", messageId: info.messageId, response: info.response };
}