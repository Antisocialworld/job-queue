import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { MAX_ATTEMPTS } from "@/config";

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const { idempotencyKey, type, payload, userId } = (body ?? {}) as {
    idempotencyKey?: unknown;
    type?: unknown;
    payload?: unknown;
    userId?: unknown;
  };

  if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0) {
    return NextResponse.json({ error: "idempotencyKey (string) is required" }, { status: 400 });
  }
  if (typeof payload !== "object" || payload === null) {
    return NextResponse.json({ error: "payload (object) is required" }, { status: 400 });
  }

  const p = payload as { to?: unknown; subject?: unknown; body?: unknown };
  if (typeof p.to !== "string" || p.to.length === 0) {
    return NextResponse.json({ error: "payload.to (string, recipient email) is required" }, { status: 400 });
  }
  if (typeof p.subject !== "string") {
    return NextResponse.json({ error: "payload.subject (string) is required" }, { status: 400 });
  }
  if (typeof p.body !== "string") {
    return NextResponse.json({ error: "payload.body (string) is required" }, { status: 400 });
  }

  const jobType = typeof type === "string" && type.length > 0 ? type : "email";

  const workPayload: Prisma.InputJsonValue = {
    ...(payload as Record<string, unknown>),
    ...(typeof userId === "string" ? { userId } : {}),
  };

  const jobData: Prisma.JobUncheckedCreateInput = {
    type: jobType,
    payload: workPayload,
    maxAttempts: MAX_ATTEMPTS,
    idempotencyKey,
    runAt: new Date(),
  };

  const existing = await prisma.job.findUnique({ where: { idempotencyKey } });
  if (existing) {
    return NextResponse.json({ jobId: existing.id, created: false }, { status: 202 });
  }

  try {
    const job = await prisma.job.create({ data: jobData });
    return NextResponse.json({ jobId: job.id, created: true }, { status: 202 });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const race = await prisma.job.findUnique({ where: { idempotencyKey } });
      if (race) {
        return NextResponse.json({ jobId: race.id, created: false }, { status: 202 });
      }
    }
    throw err;
  }
}