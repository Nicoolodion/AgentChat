import { NextResponse } from "next/server";
import { z } from "zod";

import {
  deleteChatForUser,
  getChatDetailForUser,
  updateChatSettingsForUser,
} from "@/lib/chat-store";
import { resolveAuthContext } from "@/lib/auth";
import { requireCsrfHeader } from "@/lib/csrf";

const updateSchema = z.object({
  model: z.string().min(1).max(150).optional(),
  webSearchEnabled: z.boolean().optional(),
  title: z.string().max(120).optional(),
});

export async function GET(
  request: Request,
  context: { params: Promise<{ chatId: string }> },
) {
  const auth = await resolveAuthContext(request);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { chatId } = await context.params;
  const chat = await getChatDetailForUser(auth.userId, chatId, auth.userKey);
  if (!chat) {
    return NextResponse.json({ error: "Chat not found" }, { status: 404 });
  }

  return NextResponse.json({ chat });
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ chatId: string }> },
) {
  const csrfError = requireCsrfHeader(request);
  if (csrfError) return csrfError;

  const auth = await resolveAuthContext(request);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = updateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid update payload." }, { status: 400 });
  }

  const { chatId } = await context.params;
  const updated = await updateChatSettingsForUser({
    userId: auth.userId,
    chatId,
    userKey: auth.userKey,
    model: parsed.data.model,
    webSearchEnabled: parsed.data.webSearchEnabled,
    title: parsed.data.title,
  });

  if (!updated) {
    return NextResponse.json({ error: "Chat not found" }, { status: 404 });
  }

  return NextResponse.json({ chat: updated });
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ chatId: string }> },
) {
  const csrfError = requireCsrfHeader(request);
  if (csrfError) return csrfError;

  const auth = await resolveAuthContext(request);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { chatId } = await context.params;
  const deleted = await deleteChatForUser(auth.userId, chatId);
  if (!deleted) {
    return NextResponse.json({ error: "Chat not found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
