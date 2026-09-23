import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(_request: Request, ctx: RouteContext<"/api/jobs/[id]">) {
  const { id } = await ctx.params;
  const job = await prisma.job.findUnique({
    where: { id },
    select: {
      id: true,
      type: true,
      status: true,
      attempts: true,
      maxAttempts: true,
      lastError: true,
      runAt: true,
      startedAt: true,
      finishedAt: true,
      idempotencyKey: true,
      createdAt: true,
      emailLog: { select: { state: true, sentAt: true } },
    },
  });

  if (!job) {
    return NextResponse.json({ error: "job not found" }, { status: 404 });
  }

  return NextResponse.json(job);
}