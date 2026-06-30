import { NextResponse } from "next/server";
import { z } from "zod";

import { resolveAuthContext } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { deleteHostWorkspace } from "@/lib/agent/workspace";
import { activeAgents, agentSignals } from "@/lib/agent/runner-store";

const patchSchema = z.object({
  status: z.enum(["idle", "thinking", "executing", "completed", "error"]).optional(),
});

function notFound() {
  return NextResponse.json({ error: "Session not found" }, { status: 404 });
}

function forbidden() {
  return NextResponse.json({ error: "Access denied" }, { status: 403 });
}

/**
 * GET /api/agent/sessions/:sessionId
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ sessionId: string }> }
) {
  try {
    const auth = await resolveAuthContext(request);
    if (!auth) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { sessionId } = await context.params;

    const session = await prisma.agentSession.findUnique({
      where: { id: sessionId },
    });
    if (!session) return notFound();
    if (session.userId !== auth.userId) return forbidden();

    const toolCalls = await prisma.agentToolCall.findMany({
      where: { sessionId },
      orderBy: { createdAt: "asc" },
    });

    const artifacts = await prisma.agentArtifact.findMany({
      where: { sessionId },
      orderBy: { createdAt: "asc" },
    });

    return NextResponse.json({ session, toolCalls, artifacts });
  } catch (error) {
    console.error("[Agent Session GET Error]", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

/**
 * DELETE /api/agent/sessions/:sessionId
 */
export async function DELETE(
  request: Request,
  context: { params: Promise<{ sessionId: string }> }
) {
  try {
    const auth = await resolveAuthContext(request);
    if (!auth) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { sessionId } = await context.params;

    const session = await prisma.agentSession.findUnique({
      where: { id: sessionId },
    });
    if (!session) return notFound();
    if (session.userId !== auth.userId) return forbidden();

    // Abort any in-flight orchestrator before tearing down resources, so the
    // run cannot keep writing to the workspace/DB we are about to delete.
    const ac = agentSignals.get(sessionId);
    if (ac) {
      ac.abort();
      agentSignals.delete(sessionId);
      activeAgents.delete(sessionId);
    }

    // Clean up the host workspace directory. Workspaces may be keyed by either
    // the chatId or the session id depending on the creation path; remove both
    // candidates idempotently so neither orphans.
    try {
      await deleteHostWorkspace(session.chatId);
      await deleteHostWorkspace(session.id);
    } catch (cleanupErr) {
      console.error("[Agent Workspace Cleanup Error]", cleanupErr);
      // Continue even if cleanup fails — DB record is more important
    }

    await prisma.agentSession.update({
      where: { id: sessionId },
      data: {
        status: "completed",
        completedAt: new Date(),
      },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[Agent Session DELETE Error]", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

/**
 * PATCH /api/agent/sessions/:sessionId
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ sessionId: string }> }
) {
  try {
    const auth = await resolveAuthContext(request);
    if (!auth) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { sessionId } = await context.params;

    const session = await prisma.agentSession.findUnique({
      where: { id: sessionId },
    });
    if (!session) return notFound();
    if (session.userId !== auth.userId) return forbidden();

    // Guard against racing an active run: if the orchestrator is currently
    // executing for this session, a client PATCH could corrupt its status.
    if (activeAgents.has(sessionId)) {
      return NextResponse.json(
        { error: "Agent is currently running for this session." },
        { status: 409 }
      );
    }

    const parsed = patchSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
    }

    const updateData: Partial<{ status: string; completedAt: Date | null }> = {};
    if (parsed.data.status) {
      updateData.status = parsed.data.status;
      if (parsed.data.status === "completed" || parsed.data.status === "error") {
        updateData.completedAt = new Date();
      } else if (parsed.data.status === "thinking" || parsed.data.status === "executing") {
        // Moving back into a running state must clear any prior completion time.
        updateData.completedAt = null;
      }
    }

    const updated = await prisma.agentSession.update({
      where: { id: sessionId },
      data: updateData,
    });

    return NextResponse.json({ session: updated });
  } catch (error) {
    console.error("[Agent Session PATCH Error]", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
