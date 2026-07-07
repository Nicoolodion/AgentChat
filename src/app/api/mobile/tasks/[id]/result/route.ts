import { NextResponse } from "next/server";

import { resolveMobileAuth } from "@/lib/mobile-auth";
import { decryptString } from "@/lib/crypto";
import { prisma } from "@/lib/prisma";

/**
 * GET /api/mobile/tasks/:id/result — final assistant message text + artifacts.
 * Reads the chat's last assistant message (decrypted with userKey) so the
 * phone renders the same answer shown in the desktop UI.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await resolveMobileAuth(request);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await context.params;
  const task = await prisma.mobileTask.findFirst({
    where: { id, userId: auth.userId },
    include: {
      agentSession: {
        select: {
          id: true,
          status: true,
          artifacts: true,
        },
      },
      chat: { select: { id: true, model: true, encryptedTitle: true } },
    },
  });
  if (!task) return NextResponse.json({ error: "Task not found" }, { status: 404 });

  if (!task.chat) {
    return NextResponse.json({ error: "No chat linked" }, { status: 404 });
  }

  const messages = await prisma.message.findMany({
    where: { chatId: task.chat.id, role: "assistant" },
    orderBy: { createdAt: "desc" },
    take: 1,
  });

  let result = "";
  let reasoning: string | undefined;
  if (messages.length > 0) {
    try {
      result = decryptString(messages[0].encryptedContent, auth.userKey);
      if (messages[0].encryptedReasoning) {
        reasoning = decryptString(messages[0].encryptedReasoning, auth.userKey);
      }
    } catch { /* fall back to empty */ }
  }

  let title = "Task";
  try {
    if (task.chat.encryptedTitle) title = decryptString(task.chat.encryptedTitle, auth.userKey);
  } catch { /* fall back */ }

  return NextResponse.json({
    id: task.id,
    status: task.status,
    title,
    model: task.chat.model,
    result,
    reasoning,
    artifacts: (task.agentSession?.artifacts ?? []).map((a) => ({
      id: a.id,
      fileName: a.fileName,
      mimeType: a.mimeType,
      size: a.size,
      kind: a.kind,
      storagePath: a.storagePath,
      description: a.description ?? undefined,
      createdAt: a.createdAt.toISOString(),
    })),
    completedAt: task.completedAt?.toISOString() ?? null,
    errorMessage: task.errorMessage,
  });
}
