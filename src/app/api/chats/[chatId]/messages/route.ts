import { NextResponse } from "next/server";
import { z } from "zod";

import {
  appendAttachmentSummaryToMessage,
  AttachmentError,
  prepareAttachmentsForModel,
} from "@/lib/attachments";
import { resolveAuthContext } from "@/lib/auth";
import { requireCsrfHeader } from "@/lib/csrf";
import { log } from "@/lib/logger";
import {
  type ChatToolCall,
  type MessageAttachmentRef,
  encodeUserAttachmentsPayload,
} from "@/lib/chat-types";
import {
  appendMessageToChat,
  getChatByIdForUser,
  getConversationForModel,
  updateChatSettingsForUser,
} from "@/lib/chat-store";
import { streamCompletionWithCallbacks, generateChatTitle, resolveModelContextLength } from "@/lib/nanogpt";
import { prisma } from "@/lib/prisma";
import { runAgentExecution } from "@/lib/agent/orchestrator";
import type { AgentSseEvent } from "@/lib/agent/types";
import { sandboxCreateWorkspace, sandboxFileWrite } from "@/lib/agent/sandbox";
import { getAttachmentForUser } from "@/lib/attachments";
import { activeAgents, agentSignals } from "@/lib/agent/runner-store";

const schema = z.object({
  content: z.string().min(1).max(20_000),
  attachments: z.array(z.string().min(16).max(64)).max(40).optional(),
  agentEnabled: z.boolean().optional(),
  reasoningEffort: z.enum(["low", "medium", "high", "max"]).optional(),
});

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

export async function POST(
  request: Request,
  context: { params: Promise<{ chatId: string }> },
) {
  try {
    const csrfError = requireCsrfHeader(request);
    if (csrfError) return csrfError;

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

    // ── Mode Locking ────────────────────────────────────────────────────────
    // If the chat has messages, the mode is already locked. Respect it.
    // If this is the first message, lock the mode to whatever the client sent.
    const messageCount = await prisma.message.count({
      where: { chatId: chat.id },
    });

    let agentEnabled = parsed.data.agentEnabled ?? false;

    if (chat.agentModeLocked !== null) {
      // Chat is already locked — respect the stored mode
      agentEnabled = chat.agentModeLocked;
    } else {
      // No mode locked yet — lock it now before proceeding
      await prisma.chat.update({
        where: { id: chat.id },
        data: { agentModeLocked: agentEnabled },
      });
    }

    // ── Agent Mode Routing ─────────────────────────────────────────────────
    if (agentEnabled) {
      return handleAgentMessage({
        request,
        auth,
        chat,
        chatId,
        content: parsed.data.content,
        attachments: parsed.data.attachments ?? [],
        reasoningEffort: parsed.data.reasoningEffort,
      });
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
                    "You are a secure assistant in Chatinterface. Return concise, accurate answers.",
                },
                ...priorConversation,
              ],
              attachments: preparedAttachments,
              latestUserPrompt: parsed.data.content,
              reasoningEffort: parsed.data.reasoningEffort,
            },
            {
              onTTFT: (ttftMs: number) => sendSseEvent(controller, "ttft", { ttftMs }),
              onContent: (text: string) => sendSseEvent(controller, "content", { text }),
              onReasoning: (text: string) => sendSseEvent(controller, "reasoning", { text }),
            },
          );
        } catch (error) {
          const err = error as Error & { status?: number; response?: { status?: number }; code?: string; error?: unknown };
          log.error("NanoGPT completion error", {
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
            userKey: auth.userKey,
            usagePromptTokens: completion.usagePromptTokens,
            usageCompletionTokens: completion.usageCompletionTokens,
            usageTotalTokens: completion.usageTotalTokens,
            usageCachedTokens: completion.usageCachedTokens,
            energyJoules: completion.energyJoules,
            energyKwh: completion.energyKwh,
            energyDurationSeconds: completion.energyDurationSeconds,
            providerModel: completion.providerModel,
            ttftMs: completion.ttftMs,
            avgTokensPerSecond,
          });
        } catch (dbError) {
          log.error("DB write error", { error: String(dbError) });
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
            usageTotalTokens: completion.usageTotalTokens,
            usageCachedTokens: completion.usageCachedTokens,
            energyJoules: completion.energyJoules,
            energyKwh: completion.energyKwh,
            energyDurationSeconds: completion.energyDurationSeconds,
            ttftMs: completion.ttftMs,
            avgTokensPerSecond,
            finishReason: completion.finishReason,
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
    log.error("Messages route error", { error: String(error) });
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

// ── Agent Mode Handler ───────────────────────────────────────────────────────

async function handleAgentMessage(input: {
  request: Request;
  auth: { userId: string; userKey: Buffer };
  chat: { id: string; userId: string; model: string; webSearchEnabled: boolean };
  chatId: string;
  content: string;
  attachments: string[];
  reasoningEffort?: "low" | "medium" | "high" | "max";
}) {
  const { auth, chat, chatId, content, attachments, reasoningEffort } = input;

  // Prevent concurrent agent execution on the same session
  const existingSession = await prisma.agentSession.findUnique({ where: { chatId } });
  if (existingSession && activeAgents.has(existingSession.id)) {
    return NextResponse.json({ error: "Agent is already running for this chat." }, { status: 409 });
  }

  // Find or create/reset agent session (upsert avoids unique constraint violation on chatId)
  const agentSession = await prisma.agentSession.upsert({
    where: { chatId },
    create: {
      chatId,
      userId: auth.userId,
      status: "idle",
      workspacePath: `/workspace/${chatId}`,
    },
    update: {
      status: "idle",
      errorMessage: null,
      completedAt: null,
    },
  });

  const sessionId = agentSession.id;

  // Ensure workspace directories exist in sandbox
  try {
    await sandboxCreateWorkspace(sessionId);
  } catch (err) {
    console.error("[Agent] Failed to create workspace:", err);
  }

  // ── Copy user attachments into agent workspace upload/ ──────────────────
  const attachmentRefs: MessageAttachmentRef[] = [];
  for (const attachmentId of attachments) {
    try {
      const { meta, bytes } = await getAttachmentForUser({
        userId: auth.userId,
        userKey: auth.userKey,
        attachmentId,
      });
      const destPath = `upload/${meta.fileName}`;
      // Write to sandbox
      await sandboxFileWrite(sessionId, destPath, bytes.toString("base64"), "base64");

      attachmentRefs.push({
        id: meta.id,
        fileName: meta.fileName,
        mimeType: meta.mimeType,
        size: meta.size,
        kind: meta.kind,
      });
    } catch (err) {
      console.warn("[Agent] Failed to copy attachment to workspace:", attachmentId, err);
    }
  }

  // Fetch the conversation history BEFORE persisting the new user message.
  // Otherwise getConversationForModel would include the just-appended message
  // and the orchestrator would append it again (duplication the model saw as a
  // repeated user turn).
  const priorConversation = await getConversationForModel({
    userId: auth.userId,
    chatId: chat.id,
    userKey: auth.userKey,
    maxMessages: 30,
  });

  // Persist user message (with attachment refs so the UI can render them)
  const userMessage = await appendMessageToChat({
    chatId: chat.id,
    role: "user",
    content,
    toolPayload: attachmentRefs.length
      ? encodeUserAttachmentsPayload(attachmentRefs)
      : undefined,
    userKey: auth.userKey,
  });

  const stream = new ReadableStream({
    async start(controller) {
      const ac = new AbortController();
      activeAgents.set(sessionId, ac);
      agentSignals.set(sessionId, ac);
      const onClientAbort = () => ac.abort();
      input.request.signal.addEventListener("abort", onClientAbort, { once: true });

      const toolCallMap = new Map<string, ChatToolCall>();
      // Tool outputs are captured per toolCallId from the `tool_output` event so
      // they can be persisted onto the assistant message (and therefore survive
      // a page refresh / be included in exports).
      const toolOutputMap = new Map<string, string>();
      let completionResult: {
        content: string;
        reasoning?: string;
        reasoningSegments?: { text: string; beforeToolIndex: number }[];
        contentSegments?: { text: string; beforeToolIndex: number }[];
        toolCallsCount: number;
        runDurationMs?: number;
        finishReason?: string;
        usagePromptTokens?: number;
        usageCompletionTokens?: number;
        usageTotalTokens?: number;
        usageCachedTokens?: number;
        energyJoules?: number;
        energyKwh?: number;
        energyDurationSeconds?: number;
        providerModel?: string;
        ttftMs?: number;
        avgTokensPerSecond?: number;
      } | null = null;

      // wrap sendEvent to intercept tool_start / tool_output / tool_done and
      // build ChatToolCalls that carry their arguments + output + error so they
      // can be persisted on the final assistant message. Persisted tool calls
      // are the source of truth after a refresh (the in-memory map is only used
      // to assemble the persisted row).
      const wrappedSendEvent = (event: AgentSseEvent) => {
        if (event.type === "tool_start") {
          const d = event.data as { toolCallId?: string; toolName?: string; arguments?: Record<string, unknown> };
          const toolCallId = d.toolCallId ?? `tc-${Date.now()}`;
          toolCallMap.set(toolCallId, {
            toolCallId,
            toolName: d.toolName ?? "unknown",
            status: "running",
            arguments: d.arguments,
          });
        }
        if (event.type === "tool_output") {
          const d = event.data as { toolCallId?: string; output?: string };
          const toolCallId = d.toolCallId ?? "";
          if (toolCallId) {
            const prev = toolOutputMap.get(toolCallId) ?? "";
            toolOutputMap.set(toolCallId, prev + (d.output ?? ""));
          }
        }
        if (event.type === "tool_done") {
          const d = event.data as {
            toolCallId?: string;
            toolName?: string;
            ok?: boolean;
            durationMs?: number;
            error?: string;
          };
          const toolCallId = d.toolCallId ?? "";
          const existing = toolCallMap.get(toolCallId);
          const output = toolOutputMap.get(toolCallId);
          if (existing) {
            existing.status = d.ok ? "success" : "error";
            existing.durationMs = d.durationMs;
            if (output) existing.output = output;
            if (d.error) existing.error = d.error;
          } else if (d.toolName) {
            toolCallMap.set(toolCallId, {
              toolCallId,
              toolName: d.toolName,
              status: d.ok ? "success" : "error",
              durationMs: d.durationMs,
              output,
              error: d.error,
            } as ChatToolCall);
          }
        }
        sendSseEvent(controller, event.type, event.data);
      };

      try {
        const modelContextLength = await resolveModelContextLength(chat.model).catch(() => undefined);
        completionResult = await runAgentExecution({
          sessionId,
          userMessage: content,
          priorConversation,
          model: chat.model,
          sendEvent: wrappedSendEvent,
          signal: ac.signal,
          reasoningEffort,
          modelContextLength,
        });

        // Persist assistant message with toolCalls (incl. arguments + output) and
        // ordered content/reasoning segments so the timeline survives refresh.
        let assistantMessage;
        const finalToolCalls = Array.from(toolCallMap.values());
        try {
          assistantMessage = await appendMessageToChat({
            chatId: chat.id,
            role: "assistant",
            content: completionResult.content,
            reasoning: completionResult.reasoning,
            reasoningSegments: completionResult.reasoningSegments,
            contentSegments: completionResult.contentSegments,
            toolCalls: finalToolCalls.length ? finalToolCalls : undefined,
            userKey: auth.userKey,
            usagePromptTokens: completionResult.usagePromptTokens,
            usageCompletionTokens: completionResult.usageCompletionTokens,
            usageTotalTokens: completionResult.usageTotalTokens,
            usageCachedTokens: completionResult.usageCachedTokens,
            energyJoules: completionResult.energyJoules,
            energyKwh: completionResult.energyKwh,
            energyDurationSeconds: completionResult.energyDurationSeconds,
            providerModel: completionResult.providerModel,
            ttftMs: completionResult.ttftMs,
            avgTokensPerSecond: completionResult.avgTokensPerSecond,
          });
        } catch (dbError) {
          console.error("[DB Write Error]", dbError);
          sendSseEvent(controller, "error", { message: "Failed to save response." });
        }

        const artifacts = await prisma.agentArtifact.findMany({
          where: { sessionId },
        });

        const updatedSession = await prisma.agentSession.findUnique({
          where: { id: sessionId },
        });

        sendSseEvent(controller, "done", {
          session: updatedSession,
          artifacts: artifacts.map((a) => ({
            id: a.id,
            sessionId: a.sessionId,
            fileName: a.fileName,
            mimeType: a.mimeType,
            size: a.size,
            kind: a.kind,
            storagePath: a.storagePath,
            description: a.description ?? undefined,
            createdAt: a.createdAt.toISOString(),
          })),
          meta: {
            totalToolCalls: completionResult.toolCallsCount,
            totalDurationMs: completionResult.runDurationMs ?? 0,
            finishReason: completionResult.finishReason,
            providerModel: completionResult.providerModel,
            usagePromptTokens: completionResult.usagePromptTokens,
            usageCompletionTokens: completionResult.usageCompletionTokens,
            usageTotalTokens: completionResult.usageTotalTokens,
            usageCachedTokens: completionResult.usageCachedTokens,
            energyJoules: completionResult.energyJoules,
            energyKwh: completionResult.energyKwh,
            energyDurationSeconds: completionResult.energyDurationSeconds,
            ttftMs: completionResult.ttftMs,
            avgTokensPerSecond: completionResult.avgTokensPerSecond,
          },
          assistantMessage: assistantMessage ?? undefined,
          userMessage,
        });

        controller.close();
      } catch (error) {
        if ((error as Error).name === "AbortError") {
          await prisma.agentSession.update({
            where: { id: sessionId },
            data: { status: "idle", errorMessage: "Stopped by user", completedAt: new Date() },
          });
          sendSseEvent(controller, "error", { message: "Stopped by user" });
          sendSseEvent(controller, "done", {
            session: { ...agentSession!, status: "idle" },
            artifacts: [],
            meta: { totalToolCalls: 0, totalDurationMs: 0 },
          });
        } else {
          console.error("[Agent Execution Error]", error);
          const errMsg = error instanceof Error ? error.message : "Agent execution failed";
          await prisma.agentSession.update({
            where: { id: sessionId },
            data: { status: "error", errorMessage: errMsg, completedAt: new Date() },
          });
          sendSseEvent(controller, "error", { message: errMsg });
          sendSseEvent(controller, "done", {
            session: { ...agentSession!, status: "error" },
            artifacts: [],
            meta: { totalToolCalls: 0, totalDurationMs: 0 },
          });
        }
        controller.close();
      } finally {
        input.request.signal.removeEventListener("abort", onClientAbort);
        activeAgents.delete(sessionId);
        agentSignals.delete(sessionId);
      }
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
}
