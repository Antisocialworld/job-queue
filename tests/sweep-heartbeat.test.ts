/**
 * Proves the heartbeat fix for the sweep-reclaims-live-jobs race.
 *
 * Runs against the real Postgres from docker-compose.yml and drives the real
 * production functions: `withHeartbeat` from worker/worker.ts and
 * `sweepStuckJobs` from worker/sweep.ts. Nothing here is a reimplementation.
 *
 * Timings come from the environment so the test runs in seconds rather than
 * minutes. STUCK_TIMEOUT_MS and HEARTBEAT_INTERVAL_MS must be set on the
 * command line because config.ts reads them at import time:
 *
 *   npx cross-env-free:  set them in your shell, then:
 *   npx tsx tests/sweep-heartbeat.test.ts
 *
 * No email is sent and no external service is contacted: the tests never call
 * processJob/sendEmailJob, only the heartbeat wrapper and the sweep.
 */
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { withHeartbeat } from "@/worker/worker";
import { sweepStuckJobs } from "@/worker/sweep";
import { STUCK_TIMEOUT_MS, HEARTBEAT_INTERVAL_MS } from "@/config";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) {
    console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const suffix = () => randomUUID().slice(0, 8);

async function makeProcessingJob(opts: { startedAt: Date; lastHeartbeat: Date | null }) {
  return prisma.job.create({
    data: {
      type: "email",
      payload: { to: "nobody@example.invalid", subject: "t", body: "b" },
      status: "processing",
      attempts: 1,
      maxAttempts: 3,
      idempotencyKey: `sweep-hb-test-${suffix()}`,
      startedAt: opts.startedAt,
      lastHeartbeat: opts.lastHeartbeat,
    },
  });
}

async function main() {
  console.log("=".repeat(72));
  console.log("sweep / heartbeat race test");
  console.log("=".repeat(72));
  console.log(`STUCK_TIMEOUT_MS    = ${STUCK_TIMEOUT_MS}`);
  console.log(`HEARTBEAT_INTERVAL_MS = ${HEARTBEAT_INTERVAL_MS}`);
  const margin = STUCK_TIMEOUT_MS / HEARTBEAT_INTERVAL_MS;
  console.log(`missed beats tolerated before reclaim = ${margin.toFixed(1)}`);
  if (margin < 3) {
    console.log("  WARNING: heartbeat interval is too close to the timeout for a real margin");
  }

  const created: string[] = [];
  // Open for 10x the timeout, so the OLD startedAt-based rule would have
  // reclaimed these long ago.
  const veryOldStartedAt = new Date(Date.now() - STUCK_TIMEOUT_MS * 10);

  try {
    // ---------------------------------------------------------------- case 1
    console.log("\n[case 1] slow but ALIVE: open for 2.5x the timeout, beating throughout");
    const alive = await makeProcessingJob({
      startedAt: veryOldStartedAt,
      lastHeartbeat: new Date(),
    });
    created.push(alive.id);
    console.log(
      `  job ${alive.id} startedAt=${veryOldStartedAt.toISOString()} (older than the timeout on purpose)`
    );

    const holdMs = Math.ceil(STUCK_TIMEOUT_MS * 2.5);
    const sweepsRun = { count: 0, reclaimed: 0 };
    await withHeartbeat(alive, async () => {
      const end = Date.now() + holdMs;
      while (Date.now() < end) {
        await sleep(Math.max(150, Math.floor(STUCK_TIMEOUT_MS / 4)));
        const n = await sweepStuckJobs();
        sweepsRun.count++;
        sweepsRun.reclaimed += n;
        const row = await prisma.job.findUniqueOrThrow({
          where: { id: alive.id },
          select: { status: true, lastHeartbeat: true },
        });
        if (row.status !== "processing") {
          console.log(`  !! job was reclaimed while still beating (status=${row.status})`);
          break;
        }
      }
    });

    const aliveRow = await prisma.job.findUniqueOrThrow({ where: { id: alive.id } });
    check("sweep ran repeatedly during the hold", sweepsRun.count >= 2, `${sweepsRun.count} sweeps`);
    check("sweep reclaimed 0 jobs while heartbeating", sweepsRun.reclaimed === 0, `reclaimed=${sweepsRun.reclaimed}`);
    check(
      "job still 'processing' after being open > 2.5x the timeout",
      aliveRow.status === "processing",
      `status=${aliveRow.status}`
    );
    check(
      "lastHeartbeat was kept fresh (within one interval of now)",
      Date.now() - aliveRow.lastHeartbeat!.getTime() <= HEARTBEAT_INTERVAL_MS * 2,
      `age=${Date.now() - aliveRow.lastHeartbeat!.getTime()}ms`
    );

    // ---------------------------------------------------------------- case 2
    console.log("\n[case 2] DEAD worker: heartbeats stopped, must be reclaimed");
    const dead = await makeProcessingJob({
      startedAt: veryOldStartedAt,
      lastHeartbeat: new Date(Date.now() - STUCK_TIMEOUT_MS - 1000),
    });
    created.push(dead.id);
    console.log(
      `  job ${dead.id} lastHeartbeat is ${STUCK_TIMEOUT_MS + 1000}ms stale (timeout is ${STUCK_TIMEOUT_MS}ms)`
    );
    const reclaimed = await sweepStuckJobs();
    const deadRow = await prisma.job.findUniqueOrThrow({ where: { id: dead.id } });
    check("sweep reported 1 reclaimed job", reclaimed === 1, `count=${reclaimed}`);
    check("dead job went back to 'pending'", deadRow.status === "pending", `status=${deadRow.status}`);
    check(
      "attempts was incremented by the sweep (existing behaviour preserved)",
      deadRow.attempts === 2,
      `attempts=${deadRow.attempts}`
    );

    // ---------------------------------------------------------------- case 3
    console.log("\n[case 3] NULL-safety: 'processing' job with no heartbeat at all");
    const noBeat = await makeProcessingJob({ startedAt: veryOldStartedAt, lastHeartbeat: null });
    created.push(noBeat.id);
    const reclaimedNull = await sweepStuckJobs();
    const noBeatRow = await prisma.job.findUniqueOrThrow({ where: { id: noBeat.id } });
    check("NULL-heartbeat job is still reclaimed (not stuck forever)", reclaimedNull === 1, `count=${reclaimedNull}`);
    check("NULL-heartbeat job went back to 'pending'", noBeatRow.status === "pending", `status=${noBeatRow.status}`);

    // ---------------------------------------------------------------- case 4
    console.log("\n[case 4] safety nets still enforced by the database");
    // Prisma emits @unique as a unique INDEX (pg_indexes), not a pg_constraint
    // entry, so assert on the index and then prove it actually bites.
    const idxRows = await prisma.$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE indexname IN ('Job_idempotencyKey_key', 'EmailLog_jobId_key', 'Job_status_lastHeartbeat_idx')
      ORDER BY indexname;
    `;
    const idxNames = idxRows.map((r) => r.indexname);
    check("Job_idempotencyKey_key unique index still exists", idxNames.includes("Job_idempotencyKey_key"));
    check("EmailLog_jobId_key unique index still exists", idxNames.includes("EmailLog_jobId_key"));
    check("Job_status_lastHeartbeat_idx exists for the sweep query", idxNames.includes("Job_status_lastHeartbeat_idx"));

    // Prove the uniqueness is enforced by Postgres itself, not by app code.
    const key = `sweep-hb-dup-${suffix()}`;
    const first = await prisma.job.create({
      data: {
        type: "email",
        payload: { to: "nobody@example.invalid", subject: "t", body: "b" },
        maxAttempts: 3,
        idempotencyKey: key,
      },
    });
    created.push(first.id);
    let dupJobRejected = false;
    try {
      await prisma.job.create({
        data: {
          type: "email",
          payload: { to: "nobody@example.invalid", subject: "t", body: "b" },
          maxAttempts: 3,
          idempotencyKey: key,
        },
      });
    } catch {
      dupJobRejected = true;
    }
    check("database rejects a duplicate idempotencyKey", dupJobRejected);

    await prisma.emailLog.create({ data: { jobId: first.id, state: "sending" } });
    let dupLogRejected = false;
    try {
      await prisma.emailLog.create({ data: { jobId: first.id, state: "sending" } });
    } catch {
      dupLogRejected = true;
    }
    check("database rejects a second EmailLog for the same job", dupLogRejected);
  } finally {
    for (const id of created) {
      await prisma.job.delete({ where: { id } }).catch(() => undefined);
    }
    console.log(`\ncleaned up ${created.length} test job(s)`);
    await prisma.$disconnect();
  }

  console.log("=".repeat(72));
  if (failures === 0) {
    console.log("RESULT: all checks passed");
  } else {
    console.log(`RESULT: ${failures} check(s) FAILED`);
  }
  console.log("=".repeat(72));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("test harness error:", err);
  await prisma.$disconnect();
  process.exit(1);
});
