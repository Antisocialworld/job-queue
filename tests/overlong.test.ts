/**
 * Proves the MAX_JOB_DURATION_MS hard ceiling, as a mechanism separate from
 * the heartbeat-based dead-worker sweep.
 *
 * The scenario under test is the one heartbeat CANNOT catch: a worker that
 * keeps beating correctly for the whole run, but whose job is over the
 * duration ceiling. The job must still be reclaimed.
 *
 * Runs against the real Postgres and drives the real production functions:
 * `withHeartbeat` (worker/worker.ts), `sweepStuckJobs` (worker/sweep.ts) and
 * `reclaimOverlongJobs` (worker/overlong.ts). Nothing is reimplemented.
 *
 * Timings come from the environment because config.ts reads them at import:
 *
 *   STUCK_TIMEOUT_MS=2000 MAX_JOB_DURATION_MS=800 HEARTBEAT_INTERVAL_MS=400 \
 *     npx tsx tests/overlong.test.ts
 *
 * No email is sent and no external service is contacted.
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { withHeartbeat } from "@/worker/worker";
import { sweepStuckJobs } from "@/worker/sweep";
import { reclaimOverlongJobs } from "@/worker/overlong";
import { MAX_JOB_DURATION_MS, STUCK_TIMEOUT_MS, HEARTBEAT_INTERVAL_MS } from "@/config";

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
      idempotencyKey: `overlong-test-${suffix()}`,
      startedAt: opts.startedAt,
      lastHeartbeat: opts.lastHeartbeat,
    },
  });
}

async function main() {
  console.log("=".repeat(72));
  console.log("MAX_JOB_DURATION_MS hard-ceiling test (separate from heartbeat sweep)");
  console.log("=".repeat(72));
  console.log(`MAX_JOB_DURATION_MS   = ${MAX_JOB_DURATION_MS}`);
  console.log(`STUCK_TIMEOUT_MS     = ${STUCK_TIMEOUT_MS}`);
  console.log(`HEARTBEAT_INTERVAL_MS = ${HEARTBEAT_INTERVAL_MS}`);
  check(
    "config invariant holds: MAX_JOB_DURATION_MS <= STUCK_TIMEOUT_MS",
    MAX_JOB_DURATION_MS <= STUCK_TIMEOUT_MS,
    `${MAX_JOB_DURATION_MS} <= ${STUCK_TIMEOUT_MS}`
  );

  const created: string[] = [];
  try {
    // ---------------------------------------------------------------- case 1
    console.log("\n[case 1] HUNG BUT ALIVE: beats correctly, yet over the duration ceiling");
    const alive = await makeProcessingJob({
      startedAt: new Date(Date.now() - 1),
      lastHeartbeat: new Date(),
    });
    created.push(alive.id);
    console.log(`  job ${alive.id} starts UNDER the ceiling, then runs past it while beating`);

    // Hold the job open well past MAX_JOB_DURATION_MS with a live heartbeat
    // for the whole time. This is the case the heartbeat sweep must NOT touch.
    const holdMs = Math.ceil(MAX_JOB_DURATION_MS * 1.6);
    const sweptDuringHold = { runs: 0, reclaimed: 0 };
    await withHeartbeat(alive, async () => {
      const end = Date.now() + holdMs;
      while (Date.now() < end) {
        await sleep(Math.max(100, Math.floor(MAX_JOB_DURATION_MS / 5)));
        const n = await sweepStuckJobs();
        sweptDuringHold.runs++;
        sweptDuringHold.reclaimed += n;
      }
    });

    const beforeRow = await prisma.job.findUniqueOrThrow({ where: { id: alive.id } });
    const ageMs = Date.now() - beforeRow.startedAt!.getTime();
    console.log(
      `  after ${ageMs}ms open (ceiling ${MAX_JOB_DURATION_MS}ms), heartbeat age ` +
        `${Date.now() - beforeRow.lastHeartbeat!.getTime()}ms`
    );
    check("job really did exceed the duration ceiling", ageMs > MAX_JOB_DURATION_MS, `age=${ageMs}ms`);
    check(
      "heartbeat really was still fresh at the moment of the check",
      Date.now() - beforeRow.lastHeartbeat!.getTime() <= HEARTBEAT_INTERVAL_MS * 2,
      `heartbeat age=${Date.now() - beforeRow.lastHeartbeat!.getTime()}ms`
    );
    check("job was still 'processing' before the ceiling check", beforeRow.status === "processing");
    check(
      "heartbeat sweep ran during the hold and reclaimed nothing (proves the two are distinct)",
      sweptDuringHold.reclaimed === 0,
      `${sweptDuringHold.runs} sweeps, reclaimed=${sweptDuringHold.reclaimed}`
    );

    // Now the separate mechanism acts.
    const reclaimed = await reclaimOverlongJobs();
    const afterRow = await prisma.job.findUniqueOrThrow({ where: { id: alive.id } });
    check("duration cap reclaimed the job despite a live heartbeat", reclaimed === 1, `count=${reclaimed}`);
    check("overlong job went back to 'pending'", afterRow.status === "pending", `status=${afterRow.status}`);
    check(
      "attempts was incremented once (existing reclaim behaviour preserved)",
      afterRow.attempts === 2,
      `attempts=${afterRow.attempts}`
    );
    check(
      "lastError records the real reason",
      typeof afterRow.lastError === "string" && afterRow.lastError.includes("MAX_JOB_DURATION_MS"),
      `lastError="${afterRow.lastError}"`
    );

    // ---------------------------------------------------------------- case 2
    console.log("\n[case 2] control: fresh job under the ceiling is left alone");
    const young = await makeProcessingJob({ startedAt: new Date(), lastHeartbeat: new Date() });
    created.push(young.id);
    const reclaimedYoung = await reclaimOverlongJobs();
    const youngRow = await prisma.job.findUniqueOrThrow({ where: { id: young.id } });
    check("duration cap reclaimed 0 jobs", reclaimedYoung === 0, `count=${reclaimedYoung}`);
    check("young job untouched", youngRow.status === "processing", `status=${youngRow.status}`);

    // ---------------------------------------------------------------- case 3
    console.log("\n[case 3] startup guard: MAX_JOB_DURATION_MS > STUCK_TIMEOUT_MS must fail loudly");
    // shell:true so Windows resolves npx.cmd; without it spawnSync returns
    // status=null (ENOENT) and the assertion below is meaningless.
    const child = spawnSync("npx tsx -e \"import './config'\"", {
      encoding: "utf8",
      shell: true,
      timeout: 120000,
      env: {
        ...process.env,
        STUCK_TIMEOUT_MS: "1000",
        MAX_JOB_DURATION_MS: "999999",
        HEARTBEAT_INTERVAL_MS: "400",
      },
    });
    const combined = `${child.stdout ?? ""}${child.stderr ?? ""}`;
    check("bad config exits non-zero", child.status === 1, `exit=${child.status}`);
    check(
      "error names both variables and the required ordering",
      combined.includes("MAX_JOB_DURATION_MS") &&
        combined.includes("STUCK_TIMEOUT_MS") &&
        combined.includes("must be <="),
      combined.includes("must be <=") ? "message explains the invariant" : "message missing the invariant"
    );
  } finally {
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
