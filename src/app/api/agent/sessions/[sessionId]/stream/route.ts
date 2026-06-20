/**
 * Stream an existing agent session in real-time.
 *
 * Used after a page refresh: the client calls this endpoint to re-attach
 * to a session that is still running on the server. The server replays the
 * already-persisted tool calls (from the database) as a `restore` event
 * and then live-streams any new SSE events until the session finishes.
 *
 * This is what enables "refresh the page and everything keeps streaming".
 */
import { z } from "zod";

import { resolveAuthContext } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { safeParseArgs } from "@/lib/agent/parse-args";

const querySchema = z.object({
  fromCreatedAt: z.string().datetime().optional(),
});

const encoder = new TextEncoder();

function sse(controller: ReadableStreamDefaultController, event: string, data: unknown) {
  const encoded = encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  if (controller.desiredSize !== null && controller.desiredSize <= 0) {
    void Promise.resolve().then(() => {
      try { controller.enqueue(encoded); } catch { /* stream closed */ }
    });
  } else {
    controller.enqueue(encoded);
  }
}

export async function GET(
  request: Request,
  context: { params: Promise<{ sessionId: string }> },
) {
  const auth = await resolveAuthContext(request);
  if (!auth) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { sessionId } = await context.params;
  const session = await prisma.agentSession.findUnique({ where: { id: sessionId } });
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

  const url = new URL(request.url);
  const parsed = querySchema.safeParse({ fromCreatedAt: url.searchParams.get("fromCreatedAt") ?? undefined });
  const fromTs = parsed.success && parsed.data.fromCreatedAt ? new Date(parsed.data.fromCreatedAt).getTime() : 0;

  // Replay persisted tool calls so the UI can rebuild its timeline on refresh.
  const toolCalls = await prisma.agentToolCall.findMany({
    where: {
      sessionId,
      ...(fromTs > 0 ? { createdAt: { gt: new Date(fromTs) } } : {}),
    },
    orderBy: { createdAt: "asc" },
  });

  const isLive = session.status === "thinking" || session.status === "executing";

  const stream = new ReadableStream({
    async start(controller) {
      try {
        // 1. Hand the client back the current session state.
        sse(controller, "session", { session });

        // Only replay persisted tool calls when the session is still running.
        // For completed/error/idle sessions the assistant message already
        // carries its tool calls (incl. arguments + output) — they are loaded
        // from the chat detail endpoint, so replaying here would only
        // duplicate them on the wrong message.
        if (isLive) {
          for (const tc of toolCalls) {
            sse(controller, "replay_tool_start", {
              toolCallId: tc.id,
              toolName: tc.toolName,
              arguments: safeParseArgs(tc.arguments),
              timestamp: tc.createdAt.getTime(),
            });
            if (tc.result) {
              sse(controller, "replay_tool_output", {
                toolCallId: tc.id,
                output: tc.result.slice(0, 4000),
                timestamp: tc.createdAt.getTime() + 1,
              });
            }
            if (tc.status === "success") {
              sse(controller, "replay_tool_done", {
                toolCallId: tc.id,
                toolName: tc.toolName,
                ok: true,
                durationMs: tc.durationMs ?? 0,
                timestamp: (tc.completedAt ?? tc.createdAt).getTime(),
              });
            } else if (tc.status === "error") {
              sse(controller, "replay_tool_done", {
                toolCallId: tc.id,
                toolName: tc.toolName,
                ok: false,
                durationMs: tc.durationMs ?? 0,
                error: tc.error ?? undefined,
                timestamp: (tc.completedAt ?? tc.createdAt).getTime(),
              });
            }
          }
        }

        // 2. If the session is no longer running, we're done.
        if (!isLive) {
          const artifacts = await prisma.agentArtifact.findMany({
            where: { sessionId },
            orderBy: { createdAt: "asc" },
          });
          sse(controller, "done", { session, artifacts: artifacts.map(toClientArtifact) });
          controller.close();
          return;
        }

        // 3. Otherwise, poll for new tool calls + status changes every 1.5s.
        // while the session is running. The orchestrator continues to write
        // to the database, so this gives us a real-time tail.
        const seenIds = new Set(toolCalls.map((tc) => tc.id));
        const start = Date.now();
        let closed = false;

        const safeClose = () => {
          if (closed) return;
          closed = true;
          try { controller.close(); } catch {}
        };

        const interval = setInterval(async () => {
          if (closed) {
            clearInterval(interval);
            return;
          }
          try {
            const fresh = await prisma.agentToolCall.findMany({
              where: { sessionId, id: { notIn: Array.from(seenIds) } },
              orderBy: { createdAt: "asc" },
              take: 20,
            });
            for (const tc of fresh) {
              seenIds.add(tc.id);
              sse(controller, "replay_tool_start", {
                toolCallId: tc.id,
                toolName: tc.toolName,
                arguments: safeParseArgs(tc.arguments),
                timestamp: tc.createdAt.getTime(),
              });
              if (tc.status === "success") {
                if (tc.result) {
                  sse(controller, "replay_tool_output", {
                    toolCallId: tc.id,
                    output: tc.result.slice(0, 4000),
                    timestamp: tc.createdAt.getTime() + 1,
                  });
                }
                sse(controller, "replay_tool_done", {
                  toolCallId: tc.id,
                  toolName: tc.toolName,
                  ok: true,
                  durationMs: tc.durationMs ?? 0,
                  timestamp: (tc.completedAt ?? tc.createdAt).getTime(),
                });
              } else if (tc.status === "error") {
                sse(controller, "replay_tool_done", {
                  toolCallId: tc.id,
                  toolName: tc.toolName,
                  ok: false,
                  durationMs: tc.durationMs ?? 0,
                  error: tc.error ?? undefined,
                  timestamp: (tc.completedAt ?? tc.createdAt).getTime(),
                });
              }
            }

            const cur = await prisma.agentSession.findUnique({ where: { id: sessionId } });
            if (!cur) return;
            if (cur.status !== session.status) {
              sse(controller, "status", { status: cur.status, step: cur.errorMessage ?? undefined });
            }
            if (cur.status !== "thinking" && cur.status !== "executing") {
              const artifacts = await prisma.agentArtifact.findMany({
                where: { sessionId },
                orderBy: { createdAt: "asc" },
              });
              sse(controller, "done", { session: cur, artifacts: artifacts.map(toClientArtifact) });
              clearInterval(interval);
              safeClose();
            }
          } catch (err) {
            // ignore — keep polling
            console.warn("[Agent Stream] poll error", err);
          }
        }, 1500);

        // Safety: cap connection at 30 minutes
        setTimeout(() => {
          clearInterval(interval);
          safeClose();
        }, 30 * 60 * 1000);

        // Close on client disconnect
        request.signal.addEventListener("abort", () => {
          clearInterval(interval);
          safeClose();
        });

        // Touch start to satisfy linter
        void start;
      } catch (err) {
        console.error("[Agent Stream Error]", err);
        try {
          sse(controller, "error", { message: err instanceof Error ? err.message : "Stream failed" });
          controller.close();
        } catch {}
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

function toClientArtifact(a: {
  id: string;
  sessionId: string;
  fileName: string;
  mimeType: string;
  size: number;
  kind: string;
  storagePath: string;
  description: string | null;
  createdAt: Date;
}) {
  return {
    id: a.id,
    sessionId: a.sessionId,
    fileName: a.fileName,
    mimeType: a.mimeType,
    size: a.size,
    kind: a.kind,
    storagePath: a.storagePath,
    description: a.description ?? undefined,
    createdAt: a.createdAt.toISOString(),
  };
}
