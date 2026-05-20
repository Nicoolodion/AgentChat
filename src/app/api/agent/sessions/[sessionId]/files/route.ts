import { NextResponse } from "next/server";
import { z } from "zod";

import { resolveAuthContext } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { listHostWorkspaceFiles, createHostWorkspace } from "@/lib/agent/workspace";

function notFound() {
  return NextResponse.json({ error: "Session not found" }, { status: 404 });
}

function forbidden() {
  return NextResponse.json({ error: "Access denied" }, { status: 403 });
}

/**
 * GET /api/agent/sessions/:sessionId/files?path=/
 * List files in the workspace.
 *
 * Reads directly from the host filesystem so the file explorer
 * works even when the sandbox container is offline.
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
    const session = await prisma.agentSession.findUnique({ where: { id: sessionId } });
    if (!session) return notFound();
    if (session.userId !== auth.userId) return forbidden();

    const { searchParams } = new URL(request.url);
    const path = searchParams.get("path") ?? "/";

    // Security: validate path is within workspace
    if (path.includes("..")) {
      return NextResponse.json({ error: "Invalid path" }, { status: 400 });
    }

    // Ensure workspace exists
    await createHostWorkspace(session.chatId).catch(() => undefined);

    const files = await listHostWorkspaceFiles(sessionId, path);
    return NextResponse.json({ files });
  } catch (error) {
    console.error("[Agent Files GET Error]", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
