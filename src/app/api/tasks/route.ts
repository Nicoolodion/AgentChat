import { NextResponse } from "next/server";
import { z } from "zod";

import { resolveAuthContext } from "@/lib/auth";
import { requireCsrfHeader } from "@/lib/csrf";
import { prisma } from "@/lib/prisma";
import { createTask, enqueueTask, isTaskActive } from "@/lib/tasks";

const createSchema = z.object({
  prompt: z.string().min(1).max(20_000),
  model: z.string().max(128).optional(),
  attachmentIds: z.array(z.string().min(16).max(64)).max(40).optional(),
});

/**
 * GET /api/tasks?status=active|recent
 * Cookie-authed task list for the /m web route (desktop sidebar already lists
 * chats natively; this endpoint powers the mobile PWA's task list).
 */
export async function GET(request: Request) {
  const auth = await resolveAuthContext(request);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(request.url);
  const status = url.searchParams.get("status") ?? "recent";
  const limit = Math.min(Number(url.searchParams.get("limit") ?? "30"), 100);

  const tasks = await prisma.mobileTask.findMany({
    where:
      status === "active"
        ? { userId: auth.userId, status: { in: ["queued", "running"] } }
        : { userId: auth.userId },
    orderBy: { createdAt: "desc" },
    take: limit,
    include: { chat: { select: { id: true, model: true, updatedAt: true } } },
  });

  return NextResponse.json({
    tasks: tasks.map((t) => ({
      id: t.id,
      chatId: t.chatId,
      status: t.status,
      source: t.source,
      model: t.chat?.model ?? t.model,
      active: isTaskActive(t.status),
      createdAt: t.createdAt.toISOString(),
      completedAt: t.completedAt?.toISOString() ?? null,
    })),
  });
}

/**
 * POST /api/tasks
 * Cookie-authed + CSRF-protected task creation for the /m web route. Mirrors
 * POST /api/mobile/tasks but uses the session cookie instead of a bearer token.
 */
export async function POST(request: Request) {
  const csrfError = requireCsrfHeader(request);
  if (csrfError) return csrfError;

  const auth = await resolveAuthContext(request);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request body" }, { status: 400 });

  // /m is always a desktop (cookie) surface.
  const verifiedEmail = await prisma.userEmail.findFirst({
    where: { userId: auth.userId, verifiedAt: { not: null } },
    select: { address: true },
  });

  const created = await createTask({
    userId: auth.userId,
    userKey: auth.userKey,
    username: auth.username,
    prompt: parsed.data.prompt,
    model: parsed.data.model ?? null,
    source: "desktop",
    emailAddress: verifiedEmail?.address ?? null,
    attachmentIds: parsed.data.attachmentIds,
  });

  enqueueTask(created.taskId);

  return NextResponse.json({ taskId: created.taskId, chatId: created.chatId }, { status: 201 });
}
