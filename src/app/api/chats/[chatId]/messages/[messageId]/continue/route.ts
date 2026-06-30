import { NextResponse } from "next/server";

import { resolveAuthContext } from "@/lib/auth";
import { requireCsrfHeader } from "@/lib/csrf";
import { log } from "@/lib/logger";
import { resolveModelContextLength, streamCompletionWithCallbacks } from "@/lib/nanogpt";
import {
  appendContentToMessageForUser,
  appendTailSegmentToMessageForUser,
  getChatByIdForUser,
  getConversationForModel,
} from "@/lib/chat-store";
import { prisma } from "@/lib/prisma";

const encoder = new TextEncoder();

function sendSseEvent(controller: ReadableStreamDefaultController, event: string, data: unknown) {
  const encoded = encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  if (controller.desiredSize !== null && controller.desiredSize <= 0) {
    void Promise.resolve().then(() => {
      try { controller.enqueue(encoded); } catch { /* stream closed */ }
    });
  } else {
    try { controller.enqueue(encoded); } catch { /* controller closed — ignore */ }
  }
}

/**
 * POST /api/chats/:chatId/messages/:messageId/continue
 *
 * Continues a truncated assistant message (finish_reason === "length"). The
 * conversation up to and including that assistant message is re-sent to the
 * model, which resumes generating; the new output is appended to the same
 * persisted message (raw content for normal chats, a tail content segment for
 * agent chats so tool-call ordering is preserved).
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ chatId: string; messageId: string }> },
) {
  try {
    const csrfError = requireCsrfHeader(request);
    if (csrfError) return csrfError;

    const auth = await resolveAuthContext(request);
    if (!auth) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { chatId, messageId } = await context.params;
    const chat = await getChatByIdForUser(auth.userId, chatId);
    if (!chat) {
      return NextResponse.json({ error: "Chat not found" }, { status: 404 });
    }

    // The target message must exist and be an assistant turn.
    const target = await prisma.message.findFirst({
      where: { id: messageId, chatId, chat: { userId: auth.userId } },
    });
    if (!target) {
      return NextResponse.json({ error: "Message not found" }, { status: 404 });
    }
    if (target.role !== "assistant") {
      return NextResponse.json({ error: "Only assistant messages can be continued." }, { status: 400 });
    }

    const modelContextLength = await resolveModelContextLength(chat.model).catch(() => undefined);

    const stream = new ReadableStream({
      async start(controller) {
        let completion;
        try {
          // Re-send the full conversation (which ends with the truncated
          // assistant message) — the provider resumes generating from there.
          // We deliberately do NOT call the agent orchestrator here: a
          // truncation continue is a pure text continuation and should not
          // trigger a new tool-calling loop.
          const priorConversation = await getConversationForModel({
            userId: auth.userId,
            chatId: chat.id,
            userKey: auth.userKey,
            maxMessages: 30,
          });

          completion = await streamCompletionWithCallbacks(
            {
              model: chat.model,
              webSearchEnabled: chat.webSearchEnabled,
              messages: [
                {
                  role: "system",
                  content:
                    "You are a secure assistant in Chatinterface. Return concise, accurate answers.",
                },
                ...priorConversation,
              ],
              reasoningEffort: undefined,
            },
            {
              onTTFT: (ttftMs: number) => sendSseEvent(controller, "ttft", { ttftMs }),
              onContent: (text: string) => sendSseEvent(controller, "content", { text }),
              onReasoning: () => {},
            },
          );
        } catch (error) {
          const err = error as Error & { status?: number; response?: { status?: number }; code?: string };
          log.error("Continue completion error", {
            message: err?.message,
            status: err?.status ?? err?.response?.status,
            code: err?.code,
            name: err?.name,
          });
          sendSseEvent(controller, "error", {
            message: `Continue failed: ${err?.message ?? "Unknown error"}`,
          });
          controller.close();
          return;
        }

        // Persist the continuation. Agent chats keep their ordered segment
        // structure so the timeline renders the appended text after any tool
        // calls; normal chats just append raw content.
        let updatedMessage;
        try {
          if (chat.agentModeLocked === true) {
            // Position the tail segment after the last tool call on the
            // message by counting the stored (decrypted) tool calls.
            let beforeToolIndex = 0;
            try {
              const row = await prisma.message.findUnique({ where: { id: messageId } });
              const encrypted = (row as unknown as { encryptedToolCalls?: string | null } | null)?.encryptedToolCalls;
              if (encrypted) {
                const { decryptString } = await import("@/lib/crypto");
                const parsed = JSON.parse(decryptString(encrypted, auth.userKey));
                beforeToolIndex = Array.isArray(parsed) ? parsed.length : 0;
              }
            } catch (err) {
              log.warn("continue: failed to derive tool-call index", { error: String(err) });
            }
            updatedMessage = await appendTailSegmentToMessageForUser({
              userId: auth.userId,
              chatId: chat.id,
              messageId,
              userKey: auth.userKey,
              segmentText: completion.content,
              beforeToolIndex,
            });
          } else {
            updatedMessage = await appendContentToMessageForUser({
              userId: auth.userId,
              chatId: chat.id,
              messageId,
              userKey: auth.userKey,
              appendContent: completion.content,
            });
          }
        } catch (dbError) {
          log.error("Continue DB write error", { error: String(dbError) });
          sendSseEvent(controller, "error", { message: "Failed to save continuation." });
          controller.close();
          return;
        }

        sendSseEvent(controller, "done", {
          assistantMessage: updatedMessage ?? undefined,
          meta: {
            selectedModel: chat.model,
            webSearchEnabled: chat.webSearchEnabled,
            providerModel: completion.providerModel,
            usagePromptTokens: completion.usagePromptTokens,
            usageCompletionTokens: completion.usageCompletionTokens,
            usageTotalTokens: completion.usageTotalTokens,
            usageCachedTokens: completion.usageCachedTokens,
            energyJoules: completion.energyJoules,
            energyKwh: completion.energyKwh,
            energyDurationSeconds: completion.energyDurationSeconds,
            ttftMs: completion.ttftMs,
            finishReason: completion.finishReason,
            modelContextLength,
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
    log.error("Continue route error", { error: String(error) });
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
