import { NextResponse } from "next/server";
import { z } from "zod";

import { resolveAuthContext } from "@/lib/auth";
import { getChatByIdForUser } from "@/lib/chat-store";
import { prisma } from "@/lib/prisma";
import { sandboxCreateWorkspace, sandboxHealthCheck } from "@/lib/agent/sandbox";
import { createHostWorkspace } from "@/lib/agent/workspace";

const createSchema = z.object({
  chatId: z.string().min(1),
});

/**
 * POST /api/agent/sessions
 * Creates a new agent session for a chat.
 *
 * Workspace layout on the host (mirrored inside the sandbox):
 *   data/agent-workspaces/{sessionId}/
 *     upload/    ← user files copied here
 *     output/    ← agent artifacts
 *     temp/      ← scratch space
 */
export async function POST(request: Request) {
  try {
    const auth = await resolveAuthContext(request);
    if (!auth) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const parsed = createSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
    }

    const { chatId } = parsed.data;

    const chat = await getChatByIdForUser(auth.userId, chatId);
    if (!chat) {
      return NextResponse.json({ error: "Chat not found" }, { status: 404 });
    }

    // If chat mode is locked to agent, reactivate an existing session instead of deleting it
    const existing = await prisma.agentSession.findUnique({
      where: { chatId },
    });

    if (existing && chat.agentModeLocked === true) {
      // Reactivate — preserves tool calls and artifacts history
      const reactivated = await prisma.agentSession.update({
        where: { id: existing.id },
        data: {
          status: "idle",
          errorMessage: null,
          completedAt: null,
        },
      });
      return NextResponse.json({ session: reactivated }, { status: 200 });
    }

    if (existing && !["completed", "error"].includes(existing.status)) {
      return NextResponse.json({ session: existing }, { status: 200 });
    }

    if (existing) {
      await prisma.agentSession.delete({ where: { id: existing.id } });
    }

    // Create the workspace on the host filesystem first.
    // The docker-compose binds ../data/agent-workspaces:/workspace,
    // so the sandbox sees the exact same files.
    const workspacePath = await createHostWorkspace(chatId);

    // Also tell the sandbox to create its dirs (idempotent if already present)
    const sandboxHealthy = await sandboxHealthCheck().catch(() => false);
    if (sandboxHealthy) {
      await sandboxCreateWorkspace(chatId).catch(() => {
        // Non-critical for creation — will retry later
      });
    }

    const session = await prisma.agentSession.create({
      data: {
        chatId,
        userId: auth.userId,
        status: "idle",
        workspacePath,
      },
    });

    return NextResponse.json({ session }, { status: 201 });
  } catch (error) {
    console.error("[Agent Session Create Error]", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
