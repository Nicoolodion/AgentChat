import { NextResponse } from "next/server";

import { resolveMobileAuth } from "@/lib/mobile-auth";
import { decryptString } from "@/lib/crypto";
import { prisma } from "@/lib/prisma";

/**
 * GET /api/mobile/tasks/:id  — status + a short decrypted preview.
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
      chat: { select: { encryptedTitle: true, model: true } },
      agentSession: {
        select: {
          id: true,
          status: true,
          artifacts: { select: { id: true, fileName: true, mimeType: true, size: true, kind: true, storagePath: true, description: true, createdAt: true } },
        },
      },
    },
  });
  if (!task) return NextResponse.json({ error: "Task not found" }, { status: 404 });

  let title = "Task";
  try {
    if (task.chat?.encryptedTitle) title = decryptString(task.chat.encryptedTitle, auth.userKey);
  } catch { /* fall back */ }

  let preview = "";
  try {
    preview = decryptString(task.prompt, auth.userKey).slice(0, 200);
  } catch { /* fall back */ }

  return NextResponse.json({
    id: task.id,
    chatId: task.chatId,
    agentSessionId: task.agentSessionId,
    status: task.status,
    source: task.source,
    model: task.chat?.model ?? task.model,
    title,
    promptPreview: preview,
    answeredFromDesktop: task.answeredFromDesktop,
    emailAddress: task.emailAddress,
    createdAt: task.createdAt.toISOString(),
    startedAt: task.startedAt?.toISOString() ?? null,
    completedAt: task.completedAt?.toISOString() ?? null,
    errorMessage: task.errorMessage,
    artifacts: task.agentSession?.artifacts ?? [],
  });
}
