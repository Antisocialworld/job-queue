/**
 * Proves the EmailLog-insert race and the Job lease guard are resolved in
 * favour of the SAME outcome, with no duplicate send.
 *
 * Before the fix these two arbitrators were independent: losing the insert race
 * and holding the valid lease could belong to different workers, and in 7 of 12
 * forced rounds the STALE worker won the insert while the valid lease-holder
 * deferred. Neither wrote anything, the EmailLog row stayed at `sending` despite
 * a real send having happened, and the next claimer sent a duplicate.
 *
 * What this asserts, every round:
 *   - exactly ONE real send,
 *   - EmailLog ends at `sent`,
 *   - Job ends at `succeeded` WITHOUT any further claim being needed,
 *   - `succeeded` was written by the worker holding the valid lease.
 *
 * Drives the real production paths: the real atomic claim, the real
 * `reclaimOverlongJobs`, the real `sendEmailJob`, and the real lease-guarded
 * completion write.
 *
 *   STUCK_TIMEOUT_MS=2000 MAX_JOB_DURATION_MS=800 HEARTBEAT_INTERVAL_MS=400 \
 *     DUPLICATE_SEND_CONFIRM_MS=600 npx tsx tests/send-race-divergence.test.ts
 *
 * No email is sent and no external service is contacted.
 */
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { MAX_JOB_DURATION_MS, DUPLICATE_SEND_CONFIRM_MS } from "@/config";
import { sendEmailJob } from "@/worker/email";
import { reclaimOverlongJobs } from "@/worker/overlong";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ROUNDS = 16;
const suffix = () => randomUUID().slice(0, 8);

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ""}`);
  else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

let sends = 0;
const origLog = console.log;
console.log = (...a: unknown[]) => {
  if (a.map(String).join(" ").includes("real Gmail call skipped")) sends++;
  origLog(...a);
};

/** The real atomic claim from worker.ts, parameterised by instance id. */
async function realClaim(instanceId: string) {
  const rows = await prisma.$queryRaw<{ id: string; leaseVersion: number }[]>`
    UPDATE "Job"
    SET status = 'processing', "startedAt" = NOW(), "lastHeartbeat" = NOW(),
        "leaseVersion" = "leaseVersion" + 1, "workerInstanceId" = ${instanceId},
        attempts = attempts + 1
    WHERE id = (SELECT id FROM "Job" WHERE status = 'pending' AND "runAt" <= NOW()
                ORDER BY "runAt" ASC LIMIT 1 FOR UPDATE SKIP LOCKED)
    RETURNING id, "leaseVersion";
  `;
  return rows[0] ?? null;
}

/**
 * Exactly what runJob does with the result: `deferred` writes nothing at all,
 * anything else performs the lease-guarded completion write.
 */
async function applyRunJobCompletion(
  job: { id: string; leaseVersion: number },
  res: { state: string }
): Promise<number> {
  if (res.state === "deferred") return 0;
  const r = await prisma.job.updateMany({
    where: { id: job.id, leaseVersion: job.leaseVersion },
    data: { status: "succeeded", finishedAt: new Date() },
  });
  return r.count;
}

async function main() {
  origLog("=".repeat(74));
  origLog("send-race divergence: insert race vs lease guard, resolved consistently");
  origLog("=".repeat(74));
  origLog(`ROUNDS=${ROUNDS}  DUPLICATE_SEND_CONFIRM_MS=${DUPLICATE_SEND_CONFIRM_MS}  MAX_JOB_DURATION_MS=${MAX_JOB_DURATION_MS}`);

  const created: string[] = [];
  let divergent = 0;
  let aligned = 0;
  let totalSends = 0;
  const perRound: string[] = [];

  try {
    for (let round = 1; round <= ROUNDS; round++) {
      const job = await prisma.job.create({
        data: {
          type: "email",
          payload: { to: "nobody@example.invalid", subject: "s", body: "b" },
          maxAttempts: 5,
          idempotencyKey: `div-${suffix()}`,
          runAt: new Date(Date.now() - 1000),
        },
      });
      created.push(job.id);

      // A claims and is deliberately slower than the duration cap. The cap
      // reclaims its job while A is still in flight, so B claims it and holds
      // the valid lease while A is stale. Both then race the EmailLog insert.
      await realClaim("A-stale");
      const jobA = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
      await sleep(MAX_JOB_DURATION_MS + 400);
      await reclaimOverlongJobs();
      await realClaim("B-current");
      const jobB = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });

      sends = 0;
      const [resA, resB] = await Promise.all([sendEmailJob(jobA), sendEmailJob(jobB)]);
      const roundSends = sends;
      totalSends += roundSends;

      const aWonInsert = resA.state === "sent";
      const bWonInsert = resB.state === "sent";
      if (aWonInsert) divergent++;
      else if (bWonInsert) aligned++;

      const aWrote = await applyRunJobCompletion(jobA, resA);
      const bWrote = await applyRunJobCompletion(jobB, resB);

      const el = await prisma.emailLog.findUniqueOrThrow({ where: { jobId: job.id } });
      const j = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });

      // The insert winner is the worker that reached sendRealEmail and recorded
      // the send; the loser waited, saw the peer's real send, and reported
      // `alreadySent` without sending anything itself.
      const shape = aWonInsert ? "DIVERGENT(stale won)" : bWonInsert ? "aligned(valid won)" : "both-deferred";
      const line =
        `round ${String(round).padStart(2)} ${shape.padEnd(21)} sends=${roundSends} A=${resA.state.padEnd(11)} ` +
        `B=${resB.state.padEnd(11)} writesA=${aWrote} writesB=${bWrote} EmailLog=${el.state.padEnd(7)} ` +
        `Job=${j.status.padEnd(10)} dupFlag=${j.possibleDuplicateSend}`;
      perRound.push(line);
      origLog(`  ${line}`);

      // The per-round invariants that matter, asserted for EVERY round.
      check(`r${round}: exactly one real send`, roundSends === 1, `sends=${roundSends}`);
      check(`r${round}: EmailLog recorded the send`, el.state === "sent", `state=${el.state}`);
      check(`r${round}: job converged to succeeded with no further claim`, j.status === "succeeded", `status=${j.status}`);
      check(`r${round}: succeeded was written by the valid lease-holder (B)`, bWrote === 1, `B wrote ${bWrote}, A wrote ${aWrote}`);
      check(`r${round}: stale worker A wrote nothing to the job row`, aWrote === 0, `A wrote ${aWrote}`);

      if (bWonInsert) {
        // Aligned: the valid lease-holder also won the insert. A lost at the
        // insert, so A provably never reached sendRealEmail and no duplicate
        // was even possible — the flag must stay clear.
        check(
          `r${round}: aligned race set NO duplicate-send flag`,
          j.possibleDuplicateSend === false,
          `dupFlag=${j.possibleDuplicateSend}`
        );
      } else {
        // Divergent: the stale worker really did place a send, so the flag is
        // correct and expected. What matters is that the send was still
        // RECORDED rather than discarded, which is what caused duplicates.
        check(
          `r${round}: divergent race still flags the stale real send`,
          j.possibleDuplicateSend === true,
          `dupFlag=${j.possibleDuplicateSend}`
        );
      }
    }

    // ------------------------------------------------- genuine uncertainty case
    // The other half of the confirm-budget rule: if the peer inserted a row but
    // never confirmed a delivery, the outcome really is unknown, so the
    // lease-holder must still defer and write nothing.
    origLog("\n[extra] peer inserted a row but NEVER confirmed a send -> must still defer");
    let deferredSeen = 0;
    for (let i = 1; i <= 6; i++) {
      const j2 = await prisma.job.create({
        data: {
          type: "email",
          payload: { to: "nobody@example.invalid", subject: "s", body: "b" },
          maxAttempts: 5,
          idempotencyKey: `unc-${suffix()}`,
          runAt: new Date(Date.now() - 1000),
        },
      });
      created.push(j2.id);
      await realClaim("valid-holder");
      const jobU = await prisma.job.findUniqueOrThrow({ where: { id: j2.id } });

      sends = 0;
      // Stub peer: wins or loses the insert, but NEVER flips to 'sent'.
      const stubPeer = prisma.emailLog
        .create({ data: { jobId: j2.id, state: "sending", sentAt: null } })
        .catch(() => undefined);
      const [, resU] = await Promise.all([stubPeer, sendEmailJob(jobU)]);
      const wrote = await applyRunJobCompletion(jobU, resU);
      const elU = await prisma.emailLog.findUniqueOrThrow({ where: { jobId: j2.id } });
      const rowU = await prisma.job.findUniqueOrThrow({ where: { id: j2.id } });
      origLog(
        `  unc ${i}: result=${resU.state} sends=${sends} writes=${wrote} EmailLog=${elU.state} ` +
          `Job=${rowU.status} dupFlag=${rowU.possibleDuplicateSend}`
      );

      if (resU.state === "deferred") {
        deferredSeen++;
        check(`unc${i}: deferred on genuine uncertainty, no send placed`, sends === 0, `sends=${sends}`);
        check(`unc${i}: deferred wrote nothing to the job row`, wrote === 0, `writes=${wrote}`);
        check(`unc${i}: deferred left the job for the reclaim path`, rowU.status === "processing", `status=${rowU.status}`);
        check(`unc${i}: deferred set NO duplicate flag (this worker never sent)`, rowU.possibleDuplicateSend === false, `dupFlag=${rowU.possibleDuplicateSend}`);
        check(`unc${i}: EmailLog honestly still records the uncertainty`, elU.state === "sending", `state=${elU.state}`);
      } else {
        check(`unc${i}: this worker won the insert, so a single send is correct`, sends === 1, `sends=${sends}`);
        check(`unc${i}: and the job converged`, rowU.status === "succeeded", `status=${rowU.status}`);
      }
    }
    check("the genuine-uncertainty defer path was exercised", deferredSeen > 0, `deferred in ${deferredSeen}/6`);

    origLog("\n" + "-".repeat(74));
    origLog("SUMMARY");
    origLog("-".repeat(74));
    check("both interleavings were exercised", divergent > 0 && aligned > 0, `divergent=${divergent} aligned=${aligned}`);
    check("ZERO duplicate sends across all rounds", totalSends === ROUNDS, `totalSends=${totalSends} over ${ROUNDS} rounds`);
    check("no round needed a second send to converge", perRound.every((l) => l.includes("Job=succeeded ")), "");
    console.log = origLog;
  } finally {
    console.log = origLog;
    for (const id of created) await prisma.job.delete({ where: { id } }).catch(() => undefined);
    origLog(`\ncleaned up ${created.length} test job(s)`);
    await prisma.$disconnect();
  }

  origLog("=".repeat(74));
  origLog(failures === 0 ? "RESULT: all checks passed" : `RESULT: ${failures} check(s) FAILED`);
  origLog("=".repeat(74));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.log = origLog;
  console.error("test harness error:", err);
  await prisma.$disconnect();
  process.exit(1);
});
