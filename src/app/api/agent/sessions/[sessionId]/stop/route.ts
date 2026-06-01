import { NextResponse } from "next/server";
import { ZodError, z } from "zod";

import { resolveAuthContext } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { activeAgents, agentSignals } from "@/lib/agent/runner-store";

/**
 * POST /api/agent/sessions/:sessionId/stop
 * Request the agent to stop gracefully (sets status to idle and aborts in-flight LLM calls).
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ sessionId: string }> }
) {
  try {
    const auth = await resolveAuthContext(request);
    if (!auth) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { sessionId } = await context.params;

    const session = await prisma.agentSession.findUnique({ where: { id: sessionId } });
    if (!session) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    if (session.userId !== auth.userId) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    // Abort the in-flight LLM stream if any
    const ac = agentSignals.get(sessionId);
    if (ac) {
      ac.abort();
      agentSignals.delete(sessionId);
    }

    // Mark session as idle so clients know it stopped
    await prisma.agentSession.update({
      where: { id: sessionId },
      data: { status: "idle", errorMessage: "Stopped by user", completedAt: new Date() },
    });

    activeAgents.delete(sessionId);

    return NextResponse.json({ stopped: true });
  } catch (error) {
    console.error("[Agent Stop Error]", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
