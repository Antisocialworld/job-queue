import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { RetryButton } from "./retry-button";

export const dynamic = "force-dynamic";

export default async function DeadLetterPage() {
  const deadJobs = await prisma.job.findMany({
    where: { status: "dead" },
    orderBy: { finishedAt: "desc" },
    take: 100,
  });

  return (
    <main style={{ padding: 24, fontFamily: "system-ui, sans-serif" }}>
      <h1>Dead-letter view</h1>
      <p>
        Jobs with exhausted retries. A human has to look at <code>lastError</code> and decide
        whether to retry.
      </p>
      <Link href="/">← back to trigger</Link>

      {deadJobs.length === 0 ? (
        <p>
          <strong>No dead jobs.</strong>
        </p>
      ) : (
        <table border={1} cellPadding={8} style={{ borderCollapse: "collapse", marginTop: 16 }}>
          <thead>
            <tr>
              <th>id</th>
              <th>attempts / max</th>
              <th>payload</th>
              <th>lastError</th>
              <th>finishedAt</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {deadJobs.map((job) => (
              <tr key={job.id}>
                <td>
                  <code>{job.id}</code>
                </td>
                <td>
                  {job.attempts} / {job.maxAttempts}
                </td>
                <td>
                  <pre style={{ margin: 0 }}>{JSON.stringify(job.payload)}</pre>
                </td>
                <td>
                  <code>{job.lastError}</code>
                </td>
                <td>{job.finishedAt?.toISOString()}</td>
                <td>
                  <RetryButton jobId={job.id} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}