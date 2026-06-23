import { z } from "zod";

import { resolveAuthContext } from "@/lib/auth";
import { getChatByIdForUser, getConversationForModel, appendMessageToChat } from "@/lib/chat-store";
import { prisma } from "@/lib/prisma";
import { runAgentExecution } from "@/lib/agent/orchestrator";
import type { AgentSseEvent } from "@/lib/agent/types";
import { getAttachmentForUser } from "@/lib/attachments";
import { createHostWorkspace } from "@/lib/agent/workspace";
import { sandboxFileWrite } from "@/lib/agent/sandbox";

const executeSchema = z.object({
  message: z.string().min(1).max(20_000),
  attachments: z.array(z.string().min(16).max(64)).max(40).optional(),
});

const encoder = new TextEncoder();

function sendSseEvent(
  controller: ReadableStreamDefaultController,
  event: string,
  data: unknown
) {
  controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
}

/**
 * POST /api/agent/sessions/:sessionId/execute
 * SSE stream for agent execution.
 *
 * Before the agent runs, any user attachments referenced by ID are:
 *  1. Decrypted from the encrypted host data store
 *  2. Copied into the session's workspace upload/ directory on the host
 *  3. Visible inside the sandbox via the bind-mounted workspace volume
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ sessionId: string }> }
) {
  try {
    const auth = await resolveAuthContext(request);
    if (!auth) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    const { sessionId } = await context.params;

    const session = await prisma.agentSession.findUnique({
      where: { id: sessionId },
    });
    if (!session) {
      return new Response(JSON.stringify({ error: "Session not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (session.userId !== auth.userId) {
      return new Response(JSON.stringify({ error: "Access denied" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (["thinking", "executing"].includes(session.status)) {
      return new Response(JSON.stringify({ error: "Session is already running" }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      });
    }

    const parsed = executeSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return new Response(JSON.stringify({ error: "Invalid request body" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const { message, attachments } = parsed.data;

    const chat = await getChatByIdForUser(auth.userId, session.chatId);
    if (!chat) {
      return new Response(JSON.stringify({ error: "Chat not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    // ── Ensure host workspace exists ────────────────────────────────────────
    await createHostWorkspace(sessionId).catch(() => undefined);

    // ── Copy decrypted attachments into workspace upload/ ───────────────────
    // The session workspace is owned by a per-session uid (mode 0700), so the
    // host process cannot write into it directly. Proxy through the sandbox
    // server, which drops to the session uid.
    if (attachments && attachments.length > 0) {
      for (const attachmentId of attachments) {
        try {
          const { meta, bytes } = await getAttachmentForUser({
            userId: auth.userId,
            userKey: auth.userKey,
            attachmentId,
          });

          await sandboxFileWrite(
            sessionId,
            `upload/${meta.fileName}`,
            bytes.toString("base64"),
            "base64"
          );
        } catch (attachErr) {
          console.error("[Agent Attachment Copy Error]", attachErr);
          // Continue execution — the agent may still work without this file
        }
      }
    }

    // Persist user message
    await appendMessageToChat({
      chatId: chat.id,
      role: "user",
      content: message,
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
        let completionResult: { content: string; reasoning?: string; toolCallsCount: number } | null = null;

        try {
          completionResult = await runAgentExecution({
            sessionId,
            userMessage: message,
            priorConversation,
            model: chat.model,
            sendEvent: (event: AgentSseEvent) => {
              sendSseEvent(controller, event.type, event.data);
            },
          });
        } catch (error) {
          console.error("[Agent Execution Error]", error);
          const errMsg = error instanceof Error ? error.message : "Agent execution failed";
          sendSseEvent(controller, "error", { message: errMsg });
          sendSseEvent(controller, "done", {
            session: { ...session, status: "error" },
            artifacts: [],
            meta: { totalToolCalls: 0, totalDurationMs: 0 },
          });
          controller.close();
          return;
        }

        // Persist assistant message
        let assistantMessage;
        try {
          assistantMessage = await appendMessageToChat({
            chatId: chat.id,
            role: "assistant",
            content: completionResult.content,
            reasoning: completionResult.reasoning,
            userKey: auth.userKey,
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
            totalDurationMs: 0,
          },
          assistantMessage: assistantMessage ?? undefined,
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
    console.error("[Agent Execute Route Error]", error);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
