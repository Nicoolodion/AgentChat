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
  try {
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
      const err = error as Error & { status?: number; response?: { status?: number }; code?: string; error?: unknown };
      console.error("[NanoGPT Completion Error]", {
        message: err?.message,
        status: err?.status ?? err?.response?.status,
        code: err?.code,
        error: err?.error,
        name: err?.name,
      });
      console.error("Stack:", error);
      
      const statusCode = err?.status ?? err?.response?.status ?? 500;
      const isAuthError = statusCode === 401 || statusCode === 403 || 
                          err?.message?.toLowerCase().includes("auth") ||
                          err?.message?.toLowerCase().includes("api key");
      const isRateLimit = statusCode === 429;
      const isNotFound = statusCode === 404;
      
      let message: string;
      if (isNotFound) {
        message = "Model not found - check if the model ID and API base URL are correct";
      } else if (isAuthError) {
        message = "AI authentication failed - verify your API key is correct";
      } else if (isRateLimit) {
        message = "AI service rate limit reached, please try again in a moment";
      } else {
        message = `AI service error: ${err?.message ?? "Unknown error"}`;
      }
      return NextResponse.json({ error: message }, { status: isAuthError ? 503 : isNotFound ? 404 : 500 });
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
  } catch (error) {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
