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
};

async function claimOneJob(): Promise<ClaimedJob | null> {
  const rows = await prisma.$queryRaw<ClaimedJob[]>`
    UPDATE "Job"
    SET status = 'processing', "startedAt" = NOW(), attempts = attempts + 1
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

async function processJob(job: ClaimedJob): Promise<void> {
  const started = Date.now();
  if (job.type !== "email") {
    throw new Error(`unknown job type: ${job.type}`);
  }

  const result = await sendEmailJob(job as never);

  if (result.state === "alreadySent") {
    console.log(`[worker] job ${job.id} attempt #${job.attempts} already sent previously — marking succeeded`);
  } else {
    console.log(
      `[worker] job ${job.id} attempt #${job.attempts} email sent in ${Date.now() - started}ms messageId=${result.messageId} smtp="${result.response}"`
    );
  }
}

async function runJob(job: ClaimedJob): Promise<void> {
  try {
    await processJob(job);
    await prisma.job.update({
      where: { id: job.id },
      data: { status: "succeeded", finishedAt: new Date() },
    });
    console.log(`[worker] job ${job.id} succeeded`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const gotDead = job.attempts >= job.maxAttempts;
    console.log(`[worker] job ${job.id} attempt #${job.attempts} failed: ${message}`);
    if (gotDead) {
      await prisma.job.update({
        where: { id: job.id },
        data: { status: "dead", lastError: message, finishedAt: new Date() },
      });
      console.log(`[worker] job ${job.id} attempts ${job.attempts} exhausted max ${job.maxAttempts} — DEAD`);
    } else {
      await prisma.job.update({
        where: { id: job.id },
        data: { status: "pending", lastError: message, runAt: nextRunAt(job.attempts), startedAt: null },
      });
      console.log(`[worker] job ${job.id} scheduled for retry at ${new Date().toISOString()}`);
    }
  }
}

async function main(): Promise<void> {
  console.log(
    `[worker] starting pid=${process.pid} concurrency=${WORKER_CONCURRENCY} poll=${POLL_INTERVAL_MS}ms`
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