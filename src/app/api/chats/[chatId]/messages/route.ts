import { NextResponse } from "next/server";
import { z } from "zod";

import {
  appendAttachmentSummaryToMessage,
  AttachmentError,
  prepareAttachmentsForModel,
} from "@/lib/attachments";
import { resolveAuthContext } from "@/lib/auth";
import {
  type MessageAttachmentRef,
  encodeUserAttachmentsPayload,
} from "@/lib/chat-types";
import {
  appendMessageToChat,
  getChatByIdForUser,
  getConversationForModel,
  updateChatSettingsForUser,
} from "@/lib/chat-store";
import { streamCompletionWithCallbacks, generateChatTitle } from "@/lib/nanogpt";

const schema = z.object({
  content: z.string().min(1).max(20_000),
  attachments: z.array(z.string().min(16).max(64)).max(8).optional(),
});

const encoder = new TextEncoder();

function sendSseEvent(controller: ReadableStreamDefaultController, event: string, data: unknown) {
  controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
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

    let preparedAttachments = [];
    try {
      preparedAttachments = await prepareAttachmentsForModel({
        userId: auth.userId,
        userKey: auth.userKey,
        attachmentIds: parsed.data.attachments ?? [],
      });
    } catch (error) {
      if (error instanceof AttachmentError) {
        return NextResponse.json({ error: error.message }, { status: error.statusCode });
      }
      throw error;
    }

    const persistedUserContent = appendAttachmentSummaryToMessage(
      parsed.data.content,
      preparedAttachments,
    );

    const attachmentRefs: MessageAttachmentRef[] = preparedAttachments.map((attachment) => ({
      id: attachment.id,
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
      size: attachment.size,
      kind: attachment.kind,
    }));

    const userMessage = await appendMessageToChat({
      chatId: chat.id,
      role: "user",
      content: persistedUserContent,
      toolPayload: attachmentRefs.length ? encodeUserAttachmentsPayload(attachmentRefs) : undefined,
      userKey: auth.userKey,
    });

    const priorConversation = await getConversationForModel({
      userId: auth.userId,
      chatId: chat.id,
      userKey: auth.userKey,
      maxMessages: 30,
    });

    const stream = new ReadableStream({
      async start(controller) {
        let completion;
        try {
          completion = await streamCompletionWithCallbacks(
            {
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
              attachments: preparedAttachments,
              latestUserPrompt: parsed.data.content,
            },
            {
              onTTFT: (ttftMs: number) => sendSseEvent(controller, "ttft", { ttftMs }),
              onContent: (text: string) => sendSseEvent(controller, "content", { text }),
              onReasoning: (text: string) => sendSseEvent(controller, "reasoning", { text }),
              onToolStart: (name: string) => sendSseEvent(controller, "tool_start", { name }),
              onToolDone: (name: string, ok: boolean) => sendSseEvent(controller, "tool_done", { name, ok }),
            },
          );
        } catch (error) {
          const err = error as Error & { status?: number; response?: { status?: number }; code?: string; error?: unknown };
          console.error("[NanoGPT Completion Error]", {
            message: err?.message,
            status: err?.status ?? err?.response?.status,
            code: err?.code,
            error: err?.error,
            name: err?.name,
          });

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
          
          sendSseEvent(controller, "error", { message });
          controller.close();
          return;
        }

        const streamEndTime = Date.now();
        const elapsedSec = (streamEndTime - (completion.ttftMs ?? streamEndTime)) / 1000;
        const avgTokensPerSecond = 
          elapsedSec > 0 && completion.usageCompletionTokens 
            ? completion.usageCompletionTokens / elapsedSec 
            : undefined;

        let assistantMessage;
        try {
          assistantMessage = await appendMessageToChat({
            chatId: chat.id,
            role: "assistant",
            content: completion.content,
            reasoning: completion.reasoning,
            toolPayload: completion.toolPayload,
            userKey: auth.userKey,
            usagePromptTokens: completion.usagePromptTokens,
            usageCompletionTokens: completion.usageCompletionTokens,
            providerModel: completion.providerModel,
            ttftMs: completion.ttftMs,
            avgTokensPerSecond,
          });
        } catch (dbError) {
          console.error("[DB Write Error]", dbError);
          sendSseEvent(controller, "error", { message: "Failed to save response." });
          controller.close();
          return;
        }

        const shouldSetTitle = priorConversation.length <= 1;
        let generatedTitle: string | undefined;

        if (shouldSetTitle) {
          generatedTitle = await generateChatTitle({
            userMessage: parsed.data.content,
            assistantMessage: completion.content,
          }).catch(() => undefined);

          void updateChatSettingsForUser({
            userId: auth.userId,
            chatId: chat.id,
            userKey: auth.userKey,
            title: generatedTitle ?? "New chat",
          }).catch(() => {});
        }

        sendSseEvent(controller, "done", {
          userMessage,
          assistantMessage,
          title: generatedTitle,
          meta: {
            selectedModel: chat.model,
            webSearchEnabled: chat.webSearchEnabled,
            providerModel: completion.providerModel,
            usagePromptTokens: completion.usagePromptTokens,
            usageCompletionTokens: completion.usageCompletionTokens,
            ttftMs: completion.ttftMs,
            avgTokensPerSecond,
          },
        });

        controller.close();
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    console.error("[Messages Route Error]", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
