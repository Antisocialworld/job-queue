import { prisma } from "@/lib/prisma";
import { STUCK_TIMEOUT_MS } from "@/config";

async function main(): Promise<void> {
  const cutoff = new Date(Date.now() - STUCK_TIMEOUT_MS);
  console.log(
    `[sweep] resetting jobs in 'processing' with startedAt < ${cutoff.toISOString()} (timeout ${STUCK_TIMEOUT_MS}ms)`
  );
  const result = await prisma.job.updateMany({
    where: { status: "processing", startedAt: { lt: cutoff } },
    data: { status: "pending", attempts: { increment: 1 } },
  });
  console.log(`[sweep] reset ${result.count} stuck job(s) to pending`);
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (err) => {
    console.error("[sweep] fatal:", err);
    await prisma.$disconnect();
    process.exit(1);
  });