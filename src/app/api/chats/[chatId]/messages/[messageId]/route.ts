import { NextResponse } from "next/server";

import { deleteMessageForUser, getChatByIdForUser } from "@/lib/chat-store";
import { resolveAuthContext } from "@/lib/auth";

export async function DELETE(
  request: Request,
  context: { params: Promise<{ chatId: string; messageId: string }> },
) {
  try {
    const auth = await resolveAuthContext(request);
    if (!auth) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { chatId, messageId } = await context.params;
    const chat = await getChatByIdForUser(auth.userId, chatId);
    if (!chat) {
      return NextResponse.json({ error: "Chat not found" }, { status: 404 });
    }

    const deleted = await deleteMessageForUser(auth.userId, chatId, messageId);
    if (!deleted) {
      return NextResponse.json({ error: "Message not found" }, { status: 404 });
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[Delete Message Error]", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}