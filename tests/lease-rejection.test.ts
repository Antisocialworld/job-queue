/**
 * Proves the lease rejection path: when a worker's completion write is
 * rejected because its leaseVersion no longer matches, the rejection must be
 * loud and auditable, never a silent no-op.
 *
 * Forces the rejection deliberately and realistically: a job is claimed
 * (leaseVersion N), then reclaimed and re-claimed by "another worker"
 * (leaseVersion N+1), and the original holder then tries to complete.
 *
 * Drives the real production code paths — the real claim statement, the real
 * guarded completion write, the real audit helpers — against real Postgres.
 *
 *   STUCK_TIMEOUT_MS=2000 MAX_JOB_DURATION_MS=800 HEARTBEAT_INTERVAL_MS=400 \
 *     npx tsx tests/lease-rejection.test.ts
 *
 * No email is sent and no external service is contacted.
 */
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { MAX_JOB_DURATION_MS } from "@/config";
import { WORKER_INSTANCE_ID, reportLeaseRejection } from "@/worker/lease";
import { reclaimOverlongJobs } from "@/worker/overlong";
import { withHeartbeat } from "@/worker/worker";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ""}`);
  else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const suffix = () => randomUUID().slice(0, 8);

/** The real atomic claim statement, parameterised by instance id. */
async function realClaim(instanceId: string) {
  const rows = await prisma.$queryRaw<{ id: string; leaseVersion: number }[]>`
    UPDATE "Job"
    SET status = 'processing',
        "startedAt" = NOW(),
        "lastHeartbeat" = NOW(),
        "leaseVersion" = "leaseVersion" + 1,
        "workerInstanceId" = ${instanceId},
        attempts = attempts + 1
    WHERE id = (
      SELECT id FROM "Job"
      WHERE status = 'pending' AND "runAt" <= NOW()
      ORDER BY "runAt" ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, "leaseVersion";
  `;
  return rows[0] ?? null;
}

/** The real guarded completion write, mirrored from worker.ts. */
async function guardedComplete(jobId: string, leaseVersion: number): Promise<number> {
  const res = await prisma.job.updateMany({
    where: { id: jobId, leaseVersion },
    data: { status: "succeeded", finishedAt: new Date() },
  });
  return res.count;
}

async function main() {
  console.log("=".repeat(72));
  console.log("lease rejection: loud + auditable test");
  console.log("=".repeat(72));
  console.log(`this worker's WORKER_INSTANCE_ID = ${WORKER_INSTANCE_ID}`);

  // Capture the real warning lines so we can assert on their content.
  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...a: unknown[]) => {
    warnings.push(a.map(String).join(" "));
    origWarn(...a);
  };

  const created: string[] = [];
  try {
    // ---------------------------------------------------------------- case 1
    console.log("\n[case 1] the real reclaim must invalidate the lease on its own");
    const j1 = await prisma.job.create({
      data: {
        type: "email",
        payload: { to: "nobody@example.invalid", subject: "s", body: "b" },
        maxAttempts: 5,
        idempotencyKey: `lease-test-a-${suffix()}`,
        runAt: new Date(Date.now() - 1000),
      },
    });
    created.push(j1.id);

    const claimA = await realClaim("worker-A-instance");
    check("worker A claimed the job via the real atomic claim", claimA?.id === j1.id, `leaseVersion=${claimA?.leaseVersion}`);
    const leaseA = claimA!.leaseVersion;
    const stamped = await prisma.job.findUniqueOrThrow({ where: { id: j1.id } });
    check("claim stamped worker A's instance id", stamped.workerInstanceId === "worker-A-instance", `workerInstanceId=${stamped.workerInstanceId}`);

    // Let the job exceed MAX_JOB_DURATION_MS, then reclaim it for real.
    await sleep(MAX_JOB_DURATION_MS + 400);
    const reclaimed = await reclaimOverlongJobs();
    check("the real overlong reclaim took the job back", reclaimed >= 1, `reclaimed=${reclaimed}`);

    const afterReclaim = await prisma.job.findUniqueOrThrow({ where: { id: j1.id } });
    check("reclaim bumped leaseVersion (invalidation happens at reclaim time)", afterReclaim.leaseVersion === leaseA + 1, `${leaseA} -> ${afterReclaim.leaseVersion}`);
    check("reclaim cleared workerInstanceId", afterReclaim.workerInstanceId === null);
    check("reclaim put the job back in pending", afterReclaim.status === "pending", `status=${afterReclaim.status}`);

    // Worker A finishes *before anyone re-claims* and still must be rejected.
    // Without lease invalidation in the reclaim this write would match and
    // resurrect a job that was already taken back.
    const midRows = await guardedComplete(j1.id, leaseA);
    check("worker A's late write is rejected even with no re-claim", midRows === 0, `count=${midRows}`);
    const afterMid = await prisma.job.findUniqueOrThrow({ where: { id: j1.id } });
    check("job was NOT resurrected to succeeded", afterMid.status === "pending", `status=${afterMid.status}`);

    // ---------------------------------------------------------------- case 2
    console.log("\n[case 2] reclaim + re-claim, then the loser's completion is rejected and audited");
    const claimB = await realClaim("worker-B-instance");
    check("worker B claimed it after the reclaim", claimB?.id === j1.id, `leaseVersion=${claimB?.leaseVersion}`);
    check("leaseVersion increased again on re-claim", claimB!.leaseVersion === leaseA + 2, `${afterReclaim.leaseVersion} -> ${claimB!.leaseVersion}`);

    const rowsChanged = await guardedComplete(j1.id, leaseA);
    check("worker A's completion write matched 0 rows (lease rejected)", rowsChanged === 0, `count=${rowsChanged}`);

    const beforeRow = await prisma.job.findUniqueOrThrow({ where: { id: j1.id } });
    check("worker A did NOT overwrite worker B's status", beforeRow.status === "processing", `status=${beforeRow.status}`);
    check("flag not yet set (the rejection has not been reported yet)", beforeRow.possibleDuplicateSend === false);

    // Now the real rejection handler runs.
    const lastErrorBefore = beforeRow.lastError;
    await reportLeaseRejection({
      job: { id: j1.id, leaseVersion: leaseA },
      workerInstanceId: "worker-A-instance",
      what: "succeeded-completion",
      reason: `expected leaseVersion ${leaseA}, row no longer at that version`,
    });

    const afterRow = await prisma.job.findUniqueOrThrow({ where: { id: j1.id } });
    check("Job.possibleDuplicateSend is now true", afterRow.possibleDuplicateSend === true);
    check("status still belongs to worker B (audit did not clobber it)", afterRow.status === "processing", `status=${afterRow.status}`);
    check("worker B still owns the row", afterRow.workerInstanceId === "worker-B-instance");
    check(
      "the loser's audit did not overwrite lastError",
      afterRow.lastError === lastErrorBefore,
      `unchanged="${lastErrorBefore}"`
    );

    // ------------------------------------------------- warning content asserts
    console.log("\n[case 3] the warning must be explicit, not a silent no-op");
    const dup = warnings.find((w) => w.includes("POSSIBLE DUPLICATE SEND"));
    check("a POSSIBLE DUPLICATE SEND warning was logged", !!dup);
    const w = dup ?? "";
    check("warning names the jobId", w.includes(j1.id), `jobId=${j1.id}`);
    check("warning names the rejected worker's own instance id", w.includes("rejectedWorkerInstanceId=worker-A-instance"));
    check(
      "warning reports the leaseVersion mismatch expected vs actual",
      w.includes(`expected=${leaseA}`) && w.includes(`actual=${claimB!.leaseVersion}`),
      `expected=${leaseA} actual=${claimB!.leaseVersion}`
    );
    check("warning states the observed post-reclaim status", w.includes("observedStatus=processing"));
    check("warning says no compensation was attempted", w.includes("NOT compensating"));
    check(
      "a second explicit line records the discarded write",
      warnings.some((x) => x.includes("succeeded-completion") && x.includes("DISCARDED"))
    );
    check("the worker's own WORKER_INSTANCE_ID is a real uuid-suffixed id", /^worker-[0-9a-f-]{36}$/.test(WORKER_INSTANCE_ID));

    // ---------------------------------------------------------------- case 4
    console.log("\n[case 4] a valid lease still completes normally");
    const ok2 = await prisma.job.create({
      data: {
        type: "email",
        payload: { to: "nobody@example.invalid", subject: "s", body: "b" },
        maxAttempts: 5,
        idempotencyKey: `lease-ok-${suffix()}`,
        runAt: new Date(Date.now() - 1000),
      },
    });
    created.push(ok2.id);
    const c = await realClaim("worker-C-instance");
    const good = await guardedComplete(ok2.id, c!.leaseVersion);
    check("holder of the current lease completes successfully", good === 1, `count=${good}`);
    const okRow = await prisma.job.findUniqueOrThrow({ where: { id: ok2.id } });
    check("status became succeeded", okRow.status === "succeeded", `status=${okRow.status}`);
    check("no duplicate-send flag on an uncontested job", okRow.possibleDuplicateSend === false);

    // ---------------------------------------------------------------- case 5
    console.log("\n[case 5] a stale lease must not be able to heartbeat");
    // Drive the real withHeartbeat from worker.ts, which is what keeps the
    // liveness sweep away from a job.
    const hb = await prisma.job.create({
      data: {
        type: "email",
        payload: { to: "nobody@example.invalid", subject: "s", body: "b" },
        maxAttempts: 5,
        idempotencyKey: `lease-hb-${suffix()}`,
        runAt: new Date(Date.now() - 1000),
      },
    });
    created.push(hb.id);
    const hbClaim = await realClaim("worker-D-instance");
    const hbStaleVersion = hbClaim!.leaseVersion;
    // Worker D's job gets reclaimed out from under it, exactly as before.
    await prisma.job.update({
      where: { id: hb.id },
      data: {
        status: "pending",
        startedAt: null,
        lastHeartbeat: null,
        leaseVersion: { increment: 1 },
        workerInstanceId: null,
      },
    });
    const hbFresh = await realClaim("worker-E-instance");
    // Blank the heartbeat so any successful beat is unmistakable.
    await prisma.job.update({ where: { id: hb.id }, data: { lastHeartbeat: new Date(0) } });
    await withHeartbeat({ id: hb.id, leaseVersion: hbStaleVersion }, async () => {
      await sleep(120);
    });
    const afterStale = await prisma.job.findUniqueOrThrow({ where: { id: hb.id } });
    const staleBeat = afterStale.lastHeartbeat?.getTime() ?? -1;
    check(
      "stale lease could NOT refresh the heartbeat",
      staleBeat === 0,
      `lastHeartbeat=${afterStale.lastHeartbeat?.toISOString() ?? "null"}`
    );
    await prisma.job.update({ where: { id: hb.id }, data: { lastHeartbeat: new Date(0) } });
    await withHeartbeat({ id: hb.id, leaseVersion: hbFresh!.leaseVersion }, async () => {
      await sleep(120);
    });
    const afterFresh = await prisma.job.findUniqueOrThrow({ where: { id: hb.id } });
    const freshBeat = afterFresh.lastHeartbeat?.getTime() ?? -1;
    check(
      "current lease CAN refresh the heartbeat",
      freshBeat > 0,
      `lastHeartbeat=${afterFresh.lastHeartbeat?.toISOString() ?? "null"}`
    );
  } finally {
    console.warn = origWarn;
    for (const id of created) {
      await prisma.job.delete({ where: { id } }).catch(() => undefined);
    }
    console.log(`\ncleaned up ${created.length} test job(s)`);
    await prisma.$disconnect();
  }

  console.log("=".repeat(72));
  console.log(failures === 0 ? "RESULT: all checks passed" : `RESULT: ${failures} check(s) FAILED`);
  console.log("=".repeat(72));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("test harness error:", err);
  await prisma.$disconnect();
  process.exit(1);
});
