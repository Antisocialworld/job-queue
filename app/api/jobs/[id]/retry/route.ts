import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function POST(_request: Request, ctx: RouteContext<"/api/jobs/[id]/retry">) {
  const { id } = await ctx.params;

  const updated = await prisma.job.updateMany({
    where: { id, status: "dead" },
    data: { status: "pending", runAt: new Date(), finishedAt: null },
  });

  if (updated.count === 0) {
    return NextResponse.json({ error: "no dead job found with this id" }, { status: 404 });
  }

  return NextResponse.json({ retried: true });
}