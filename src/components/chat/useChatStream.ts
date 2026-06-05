/**
 * useChatStream
 *
 * Owns the SSE stream for a single chat completion (non-agent or agent).
 *
 * Exposes:
 *  - start(userMessage, options) → fires the request, returns when stream ends
 *  - cancel() → aborts the in-flight request
 *  - restore() → if the chat has a still-running agent session, attach to it
 *
 * The hook updates a `messages` array exactly the way the network stream
 * emits events, so after a page refresh + restore() the timeline continues
 * to populate live.
 *
 * Events understood (server side already uses these names):
 *   ttft, content, reasoning, tool_start, tool_output, tool_done,
 *   error, done, session, replay_tool_start, replay_tool_output,
 *   replay_tool_done, status
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type {
  ChatDetail,
  ChatMessage,
  ChatToolCall,
  MessageAttachmentRef,
  UploadedAttachment,
} from "@/lib/chat-types";
import { encodeUserAttachmentsPayload } from "@/lib/chat-types";

export type ToolOutputEntry = {
  toolCallId: string;
  output: string;
  timestamp?: number;
};

export type UseChatStreamOptions = {
  chat: ChatDetail;
  agentEnabled: boolean;
  onTitleUpdate?: (title: string) => void;
  onChatsRefresh?: () => Promise<void>;
  /**
   * Called for every SSE event the hook receives (both fresh sends and
   * the re-attach / restore stream). Useful for forwarding to other
   * surfaces — e.g. the agent sidebar's terminal.
   */
  onSseEvent?: (event: string, data: Record<string, unknown>) => void;
};

export type UseChatStream = {
  messages: ChatMessage[];
  toolOutputs: Record<string, ToolOutputEntry[]>;
  toolArguments: Record<string, Record<string, unknown>>;
  sending: boolean;
  error: string | null;
  send: (input: { text: string; attachments: UploadedAttachment[] }) => Promise<void>;
  cancel: () => void;
  restore: () => void;
  applyAssistantMessage: (msg: ChatMessage) => void;
  reset: (newMessages: ChatMessage[]) => void;
};

export function useChatStream(options: UseChatStreamOptions): UseChatStream {
  const { chat, agentEnabled, onTitleUpdate, onChatsRefresh, onSseEvent } = options;

  const [messages, setMessages] = useState<ChatMessage[]>(chat.messages);
  const [toolOutputs, setToolOutputs] = useState<Record<string, ToolOutputEntry[]>>({});
  const [toolArguments, setToolArguments] = useState<Record<string, Record<string, unknown>>>({});
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sendAbortRef = useRef<AbortController | null>(null);
  const restoreAbortRef = useRef<AbortController | null>(null);
  const lastSyncedChatIdRef = useRef<string | null>(null);

  // Re-sync state when the parent switches to a different chat. We only
  // depend on chat.id — chat.messages gets a fresh array reference on every
  // parent render, so including it in the dep list would cause an infinite
  // re-render loop. The ref guards against running the sync more than once
  // per chatId even if React fires the effect twice in StrictMode.
  useEffect(() => {
    if (lastSyncedChatIdRef.current === chat.id) return;
    lastSyncedChatIdRef.current = chat.id;
    setMessages(chat.messages);
    setToolOutputs({});
    setToolArguments({});
  }, [chat.id, chat.messages]);

  const cancel = useCallback(() => {
    sendAbortRef.current?.abort();
    sendAbortRef.current = null;
    restoreAbortRef.current?.abort();
    restoreAbortRef.current = null;
  }, []);

  const reset = useCallback((newMessages: ChatMessage[]) => {
    setMessages(newMessages);
    setToolOutputs({});
    setToolArguments({});
  }, []);

  const applyAssistantMessage = useCallback((msg: ChatMessage) => {
    setMessages((current) => {
      if (current.length === 0) return [...current, msg];
      const copy = current.slice();
      // Replace a temp streaming message, or append
      const last = copy[copy.length - 1]!;
      if (last._isStreaming) {
        copy[copy.length - 1] = msg;
      } else {
        copy.push(msg);
      }
      return copy;
    });
  }, []);

  // ── Send a new message ────────────────────────────────────────────────────
  const send = useCallback(
    async ({ text, attachments }: { text: string; attachments: UploadedAttachment[] }) => {
      if (sending) return;
      const content = text.trim() || "Please analyze the attached files.";
      const atts = [...attachments];

      setError(null);
      setSending(true);
      setToolOutputs({});
      setToolArguments({});

      if (sendAbortRef.current) sendAbortRef.current.abort();
      sendAbortRef.current = new AbortController();

      const tempId = `temp-${Date.now()}`;
      const optimisticRefs: MessageAttachmentRef[] = atts.map((a) => ({
        id: a.id,
        fileName: a.fileName,
        mimeType: a.mimeType,
        size: a.size,
        kind: a.kind,
      }));

      const userMsg: ChatMessage = {
        id: `user-${tempId}`,
        role: "user",
        content,
        toolPayload: optimisticRefs.length ? encodeUserAttachmentsPayload(optimisticRefs) : undefined,
        createdAt: new Date().toISOString(),
      };
      const tempAsst: ChatMessage = {
        id: tempId,
        role: "assistant",
        content: "",
        createdAt: new Date().toISOString(),
        _isStreaming: true,
      };
      setMessages((m) => [...m, userMsg, tempAsst]);

      let totalTokens = 0;
      let streamStart = Date.now();
      let liveTps: number | undefined;
      let currentReasoningSegment = "";

      const pushReasoningSegment = () => {
        if (currentReasoningSegment.length > 0) {
          setMessages((current) => {
            const copy = current.slice();
            const idx = copy.length - 1;
            if (idx < 0) return current;
            const last = copy[idx]!;
            const segs = last.reasoningSegments ?? [];
            copy[idx] = { ...last, reasoningSegments: [...segs, currentReasoningSegment] };
            return copy;
          });
          currentReasoningSegment = "";
        }
      };

      const applyContent = (updater: (msg: ChatMessage) => ChatMessage) => {
        setMessages((current) => {
          const copy = current.slice();
          const idx = copy.length - 1;
          if (idx < 0) return current;
          copy[idx] = updater(copy[idx]!);
          return copy;
        });
      };

      const appendOutput = (entry: ToolOutputEntry) => {
        setToolOutputs((prev) => {
          const list = prev[entry.toolCallId] ?? [];
          return { ...prev, [entry.toolCallId]: [...list, entry] };
        });
      };

      try {
        const res = await fetch(`/api/chats/${chat.id}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content,
            attachments: atts.map((a) => a.id),
            agentEnabled,
          }),
          signal: sendAbortRef.current.signal,
        });

        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(j.error ?? "Request failed");
        }
        if (!res.body) throw new Error("No response body");

        await consumeSse(res.body, (event, data) => {
          onSseEvent?.(event, data);
          if (event === "ttft") {
            applyContent((m) => ({ ...m, ttftMs: data.ttftMs as number, _isStreaming: true }));
            streamStart = Date.now();
            totalTokens = 0;
            return;
          }
          if (event === "content" && typeof data.text === "string") {
            totalTokens += data.text.length;
            const elapsed = Math.max((Date.now() - streamStart) / 1000, 0.1);
            liveTps = totalTokens / elapsed;
            applyContent((m) => ({
              ...m,
              content: m.content + data.text,
              avgTokensPerSecond: liveTps,
              _isStreaming: true,
            }));
            return;
          }
          if (event === "reasoning" && typeof data.text === "string") {
            currentReasoningSegment += data.text;
            applyContent((m) => ({
              ...m,
              reasoning: (m.reasoning ?? "") + data.text,
              _isStreaming: true,
            }));
            return;
          }
          if (event === "tool_start") {
            pushReasoningSegment();
            const tcId = (data.toolCallId as string) ?? `tc-${Date.now()}`;
            const args = (data.arguments as Record<string, unknown> | undefined) ?? undefined;
            if (args) {
              setToolArguments((prev) => ({ ...prev, [tcId]: args }));
            }
            applyContent((m) => {
              const existing = m.toolCalls ?? [];
              return {
                ...m,
                toolCalls: [
                  ...existing,
                  {
                    toolCallId: tcId,
                    toolName: (data.toolName as string) ?? "unknown",
                    status: "running",
                  },
                ],
                _isStreaming: true,
              };
            });
            return;
          }
          if (event === "tool_output") {
            appendOutput({
              toolCallId: (data.toolCallId as string) ?? "",
              output: (data.output as string) ?? "",
            });
            return;
          }
          if (event === "tool_done") {
            const id = (data.toolCallId as string) ?? "";
            applyContent((m) => {
              const tcs = (m.toolCalls ?? []).map((tc) =>
                tc.toolCallId === id || tc.toolName === data.toolName
                  ? { ...tc, status: data.ok ? ("success" as const) : ("error" as const), durationMs: data.durationMs as number }
                  : tc,
              );
              return { ...m, toolCalls: tcs, _isStreaming: true };
            });
            return;
          }
          if (event === "error") {
            setError((data.message as string) ?? "Stream error");
            return;
          }
          if (event === "done") {
            pushReasoningSegment();
            const asst = data.assistantMessage as ChatMessage | undefined;
            if (asst) {
              applyContent((m) => ({
                ...asst,
                _isStreaming: false,
                ttftMs: asst.ttftMs ?? m.ttftMs,
                toolCalls: asst.toolCalls ?? m.toolCalls,
                reasoning: asst.reasoning ?? m.reasoning,
                avgTokensPerSecond: asst.avgTokensPerSecond ?? m.avgTokensPerSecond,
              }));
            } else {
              applyContent((m) => ({ ...m, _isStreaming: false }));
            }
            if (data.title) onTitleUpdate?.(data.title as string);
            if (onChatsRefresh) void onChatsRefresh();
          }
        });
      } catch (err) {
        if ((err as Error).name === "AbortError") {
          // User cancelled
          return;
        }
        setError(err instanceof Error ? err.message : "Stream failed");
        setMessages((current) => current.filter((m) => !m.id.startsWith("temp-")));
      } finally {
        setSending(false);
      }
    },
    [chat.id, agentEnabled, sending, onTitleUpdate, onChatsRefresh],
  );

  // ── Restore live state after refresh ─────────────────────────────────────
  const restore = useCallback(() => {
    if (restoreAbortRef.current) restoreAbortRef.current.abort();
    const ac = new AbortController();
    restoreAbortRef.current = ac;

    const agentSessionId = chat.agentSession?.id;
    if (!agentSessionId) return;

    const applyContent = (updater: (msg: ChatMessage) => ChatMessage) => {
      setMessages((current) => {
        const copy = current.slice();
        const idx = copy.length - 1;
        if (idx < 0) return current;
        copy[idx] = updater(copy[idx]!);
        return copy;
      });
    };

    const appendOutput = (entry: ToolOutputEntry) => {
      setToolOutputs((prev) => {
        const list = prev[entry.toolCallId] ?? [];
        return { ...prev, [entry.toolCallId]: [...list, entry] };
      });
    };

    void (async () => {
      try {
        const res = await fetch(`/api/agent/sessions/${agentSessionId}/stream`, {
          signal: ac.signal,
        });
        if (!res.ok || !res.body) return;

        await consumeSse(res.body, (event, data) => {
          onSseEvent?.(event, data);
          if (event === "session") {
            // Server confirmed the session. If a tool call is still running
            // we want to show it as live.
            const sess = data.session as { status?: string };
            if (sess?.status === "thinking" || sess?.status === "executing") {
              setSending(true);
              // Mark the last assistant message (if any) as streaming so the
              // live cursor stays on while we replay tool calls.
              applyContent((m) =>
                m.role === "assistant" ? { ...m, _isStreaming: true } : m,
              );
            }
            return;
          }
          if (event === "replay_tool_start") {
            const id = data.toolCallId as string;
            const call: ChatToolCall = {
              toolCallId: id,
              toolName: data.toolName as string,
              status: "running",
            };
            const args = (data.arguments as Record<string, unknown> | undefined) ?? undefined;
            if (args) {
              setToolArguments((prev) => ({ ...prev, [id]: args }));
            }
            // If the message we care about is the last assistant one, push the call
            setMessages((current) => {
              const copy = current.slice();
              const idx = copy.length - 1;
              if (idx < 0) return current;
              const last = copy[idx]!;
              if (last.role !== "assistant") return current;
              const tcs = last.toolCalls ?? [];
              copy[idx] = { ...last, toolCalls: [...tcs, call] };
              return copy;
            });
            return;
          }
          if (event === "replay_tool_output") {
            appendOutput({
              toolCallId: data.toolCallId as string,
              output: data.output as string,
            });
            return;
          }
          if (event === "replay_tool_done") {
            const id = data.toolCallId as string;
            applyContent((m) => {
              const tcs = (m.toolCalls ?? []).map((tc) =>
                tc.toolCallId === id
                  ? {
                      ...tc,
                      status: data.ok ? ("success" as const) : ("error" as const),
                      durationMs: data.durationMs as number,
                    }
                  : tc,
              );
              return { ...m, toolCalls: tcs };
            });
            return;
          }
          if (event === "status") {
            // Phase change
            const st = data.status as string;
            if (st === "thinking" || st === "executing") setSending(true);
            return;
          }
          if (event === "done") {
            setSending(false);
            applyContent((m) => (m._isStreaming ? { ...m, _isStreaming: false } : m));
            if (onChatsRefresh) void onChatsRefresh();
          }
          if (event === "error") {
            setError(data.message as string);
          }
        });
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        // ignore network errors during restore
      }
    })();
  }, [chat.agentSession?.id, onChatsRefresh]);

  // Trigger restore on chat change
  useEffect(() => {
    if (chat.agentSession?.id) {
      restore();
    }
    return () => {
      restoreAbortRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.id, chat.agentSession?.id]);

  return {
    messages,
    toolOutputs,
    toolArguments,
    sending,
    error,
    send,
    cancel,
    restore,
    applyAssistantMessage,
    reset,
  };
}

// ── Shared SSE parser ───────────────────────────────────────────────────────

export async function consumeSse(
  body: ReadableStream<Uint8Array>,
  handler: (event: string, data: Record<string, unknown>) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      const lines = part.split("\n");
      let eventType = "data";
      let dataStr = "";
      for (const line of lines) {
        if (line.startsWith("event: ")) eventType = line.slice(7).trim();
        else if (line.startsWith("data: ")) dataStr += line.slice(6) + "\n";
      }
      if (!dataStr.trim()) continue;
      try {
        const data = JSON.parse(dataStr.trim()) as Record<string, unknown>;
        handler(eventType, data);
      } catch {
        // ignore
      }
    }
  }
}
