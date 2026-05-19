import { NextResponse } from "next/server";
import { z } from "zod";

import { resolveAuthContext } from "@/lib/auth";
import { getChatByIdForUser } from "@/lib/chat-store";
import { prisma } from "@/lib/prisma";
import { sandboxCreateWorkspace, sandboxHealthCheck } from "@/lib/agent/sandbox";

const createSchema = z.object({
  chatId: z.string().min(1),
});

/**
 * POST /api/agent/sessions
 * Creates a new agent session for a chat.
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

    // Check if chat already has an active agent session
    const existing = await prisma.agentSession.findUnique({
      where: { chatId },
    });
    if (existing && !["completed", "error"].includes(existing.status)) {
      return NextResponse.json({ session: existing }, { status: 200 });
    }

    if (existing) {
      await prisma.agentSession.delete({ where: { id: existing.id } });
    }

    // Health check sandbox before creating
    const sandboxHealthy = await sandboxHealthCheck().catch(() => false);

    const workspacePath = `/workspace/${chatId}`;

    // Create workspace directories in sandbox
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
