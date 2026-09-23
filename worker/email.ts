import nodemailer from "nodemailer";
import type { Job } from "@prisma/client";
import { prisma } from "@/lib/prisma";

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
): Promise<{ state: "alreadySent" | "sent"; messageId?: string; response?: string }> {
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
    await prisma.emailLog.create({
      data: { jobId: job.id, state: "sending", sentAt: null },
    });
  }

  const info = await sendRealEmail(payload);

  await prisma.emailLog.update({
    where: { jobId: job.id },
    data: { state: "sent", sentAt: new Date() },
  });
  return { state: "sent", messageId: info.messageId, response: info.response };
}