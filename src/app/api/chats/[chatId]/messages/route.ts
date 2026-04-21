import { NextResponse } from "next/server";
import { z } from "zod";

import { resolveAuthContext } from "@/lib/auth";
import {
  appendMessageToChat,
  getChatByIdForUser,
  getConversationForModel,
  updateChatSettingsForUser,
} from "@/lib/chat-store";
import { runNanoGPTCompletion } from "@/lib/nanogpt";

const schema = z.object({
  content: z.string().min(1).max(20_000),
});

function makeTitleFromPrompt(content: string): string {
  return content.replace(/\s+/g, " ").trim().slice(0, 48) || "New chat";
}

export async function POST(
  request: Request,
  context: { params: Promise<{ chatId: string }> },
) {
  const auth = await resolveAuthContext(request);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid message payload." }, { status: 400 });
  }

  const { chatId } = await context.params;
  const chat = await getChatByIdForUser(auth.userId, chatId);
  if (!chat) {
    return NextResponse.json({ error: "Chat not found" }, { status: 404 });
  }

  const userMessage = await appendMessageToChat({
    chatId: chat.id,
    role: "user",
    content: parsed.data.content,
    userKey: auth.userKey,
  });

  const priorConversation = await getConversationForModel({
    userId: auth.userId,
    chatId: chat.id,
    userKey: auth.userKey,
    maxMessages: 30,
  });

  let completion;
  try {
    completion = await runNanoGPTCompletion({
      model: chat.model,
      webSearchEnabled: chat.webSearchEnabled,
      messages: [
        {
          role: "system",
          content:
            "You are a secure assistant in Chatinterface. Use tools when useful and return concise, accurate answers.",
        },
        ...priorConversation,
      ],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Model call failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }

  const assistantMessage = await appendMessageToChat({
    chatId: chat.id,
    role: "assistant",
    content: completion.content,
    reasoning: completion.reasoning,
    toolPayload: completion.toolPayload,
    userKey: auth.userKey,
    usagePromptTokens: completion.usagePromptTokens,
    usageCompletionTokens: completion.usageCompletionTokens,
    providerModel: completion.providerModel,
  });

  const shouldSetTitle = priorConversation.length <= 1;
  if (shouldSetTitle) {
    await updateChatSettingsForUser({
      userId: auth.userId,
      chatId: chat.id,
      userKey: auth.userKey,
      title: makeTitleFromPrompt(parsed.data.content),
    });
  }

  return NextResponse.json({
    userMessage,
    assistantMessage,
    meta: {
      selectedModel: chat.model,
      webSearchEnabled: chat.webSearchEnabled,
      providerModel: completion.providerModel,
      usagePromptTokens: completion.usagePromptTokens,
      usageCompletionTokens: completion.usageCompletionTokens,
    },
  });
}
