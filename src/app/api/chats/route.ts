import { NextResponse } from "next/server";
import { z } from "zod";

import { createChatForUser, listChatsForUser } from "@/lib/chat-store";
import { resolveAuthContext } from "@/lib/auth";
import { env } from "@/lib/env";

const createSchema = z.object({
  model: z.string().min(1).max(150).optional(),
  webSearchEnabled: z.boolean().optional(),
  title: z.string().max(120).optional(),
});

export async function GET(request: Request) {
  const auth = await resolveAuthContext(request);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const chats = await listChatsForUser(auth.userId, auth.userKey);
  return NextResponse.json({ chats });
}

export async function POST(request: Request) {
  const auth = await resolveAuthContext(request);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid chat payload." }, { status: 400 });
  }

  const chat = await createChatForUser({
    userId: auth.userId,
    userKey: auth.userKey,
    model: parsed.data.model ?? env.DEFAULT_MODEL,
    webSearchEnabled: parsed.data.webSearchEnabled ?? false,
    title: parsed.data.title,
  });

  return NextResponse.json({ chat }, { status: 201 });
}
