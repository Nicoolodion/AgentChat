import { NextResponse } from "next/server";

import { resolveMobileAuth } from "@/lib/mobile-auth";
import { prisma } from "@/lib/prisma";
import { agentSignals } from "@/lib/agent/runner-store";

/**
 * POST /api/mobile/tasks/:id/cancel
 * Abort the running agent via the shared agentSignals registry. This is the
 * exact same registry the desktop Stop button uses, so cancel works
 * identically from either surface.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await resolveMobileAuth(request);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await context.params;
  const task = await prisma.mobileTask.findFirst({
    where: { id, userId: auth.userId },
    select: { agentSessionId: true, status: true },
  });
  if (!task) return NextResponse.json({ error: "Task not found" }, { status: 404 });

  if (!task.agentSessionId) {
    return NextResponse.json({ ok: false, message: "No active session" }, { status: 409 });
  }

  const ac = agentSignals.get(task.agentSessionId);
  if (ac) {
    ac.abort();
    return NextResponse.json({ ok: true, status: "cancel_requested" });
  }

  // Not currently running — mark as cancelled so no completion email fires.
  try {
    await prisma.mobileTask.update({
      where: { id },
      data: { status: "cancelled", completedAt: new Date() },
    });
  } catch (err) {
    console.error("[Task Cancel Error]", err);
    return NextResponse.json({ ok: false, message: "Failed to cancel task" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, status: "cancelled" });
}
