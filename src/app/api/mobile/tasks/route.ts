import { NextResponse } from "next/server";
import { z } from "zod";

import { resolveMobileAuth } from "@/lib/mobile-auth";
import { enforceRateLimit } from "@/lib/rate-limit";
import { decryptString } from "@/lib/crypto";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { createTask, enqueueTask, isTaskActive } from "@/lib/tasks";
import { attachmentLimits, saveAttachmentForUser } from "@/lib/attachments";

const createSchema = z.object({
  prompt: z.string().min(1).max(20_000),
  model: z.string().max(128).optional(),
  attachmentIds: z.array(z.string().min(16).max(64)).max(40).optional(),
});


/**
 * GET /api/mobile/tasks?status=active|recent
 * List the user's tasks. Titles are NOT decrypted here (the MobileTask row
 * carries the encrypted prompt; the chat title is decrypted separately via
 * the existing chat-list decrypt path — kept simple here).
 */
export async function GET(request: Request) {
  const auth = await resolveMobileAuth(request);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(request.url);
  const status = url.searchParams.get("status") ?? "recent";
  const limit = Math.min(Number(url.searchParams.get("limit") ?? "30"), 100);

  const where = status === "active"
    ? { userId: auth.userId, status: { in: ["queued", "running"] } }
    : { userId: auth.userId };

  const tasks = await prisma.mobileTask.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: limit,
    include: {
      chat: { select: { encryptedTitle: true, model: true, updatedAt: true } },
      agentSession: { select: { id: true, status: true } },
    },
  });

  const out = tasks.map((t) => {
    let title = "Task";
    try {
      if (t.chat?.encryptedTitle) title = decryptString(t.chat.encryptedTitle, auth.userKey);
    } catch { /* fall back */ }
    return {
      id: t.id,
      chatId: t.chatId,
      agentSessionId: t.agentSessionId,
      status: t.status,
      source: t.source,
      model: t.chat?.model ?? t.model,
      title,
      active: isTaskActive(t.status),
      createdAt: t.createdAt.toISOString(),
      startedAt: t.startedAt?.toISOString() ?? null,
      completedAt: t.completedAt?.toISOString() ?? null,
      errorMessage: t.errorMessage,
    };
  });

  return NextResponse.json({ tasks: out });
}

/**
 * POST /api/mobile/tasks
 * Create + enqueue a task. Supports two intake shapes:
 *   - JSON { prompt, model?, attachmentIds? } when files were uploaded first
 *   - multipart/form-data with prompt + files[] for a one-step upload-and-start
 */
export async function POST(request: Request) {
  const auth = await resolveMobileAuth(request);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const rateKey = `mobile-task:${auth.userId}`;
  const rate = await enforceRateLimit(rateKey, env.RATE_LIMIT_MAX_REQUESTS, env.RATE_LIMIT_WINDOW_SECONDS);
  if (!rate.ok) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429, headers: { "Retry-After": String(rate.retryAfterSeconds) } });
  }

  const contentType = request.headers.get("content-type") ?? "";
  let prompt: string | undefined;
  let model: string | undefined;
  let attachmentIds: string[] | undefined;

  if (contentType.includes("multipart/form-data")) {
    const formData = await request.formData();
    prompt = (formData.get("prompt") as string | null) ?? undefined;
    model = (formData.get("model") as string | null) ?? undefined;
    const files = formData.getAll("files").filter((e): e is File => e instanceof File);
    if (files.length > attachmentLimits.maxAttachmentsPerMessage) {
      return NextResponse.json({ error: `Upload up to ${attachmentLimits.maxAttachmentsPerMessage} files.` }, { status: 400 });
    }
    const uploaded: string[] = [];
    for (const file of files) {
      const bytes = Buffer.from(await file.arrayBuffer());
      if (bytes.length > attachmentLimits.maxFileSizeBytes) {
        return NextResponse.json({ error: `File ${file.name} too large.` }, { status: 413 });
      }
      const saved = await saveAttachmentForUser({
        userId: auth.userId,
        userKey: auth.userKey,
        fileName: file.name,
        mimeType: file.type || "application/octet-stream",
        bytes,
      });
      uploaded.push(saved.id);
    }
    attachmentIds = uploaded.length ? uploaded : undefined;
  } else {
    const parsed = createSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
    prompt = parsed.data.prompt;
    model = parsed.data.model;
    attachmentIds = parsed.data.attachmentIds;
  }

  if (!prompt || !prompt.trim()) {
    return NextResponse.json({ error: "prompt is required" }, { status: 400 });
  }

  // Resolve verified email + locale (Phase B adds the email row; Phase A leaves null).
  const verifiedEmail = await prisma.userEmail.findFirst({
    where: { userId: auth.userId, verifiedAt: { not: null } },
    select: { address: true },
  });

  const created = await createTask({
    userId: auth.userId,
    userKey: auth.userKey,
    username: auth.username,
    prompt,
    model: model ?? null,
    source: "mobile",
    emailAddress: verifiedEmail?.address ?? null,
    attachmentIds,
  });

  enqueueTask(created.taskId);

  return NextResponse.json({ taskId: created.taskId, chatId: created.chatId, status: created.status }, { status: 201 });
}
