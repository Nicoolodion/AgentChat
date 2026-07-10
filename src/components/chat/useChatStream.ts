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
  MessageAttachmentRef,
  ReasoningEffort,
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
  send: (input: {
    text: string;
    attachments: UploadedAttachment[];
    reasoningEffort?: ReasoningEffort;
    /**
     * Override the chat id used for the message POST. This is used when a
     * message is sent from a still-unpersistised "new chat": the caller first
     * creates the chat, then streams against the fresh id while keeping the
     * in-memory chat identity stable until the stream finishes.
     */
    chatIdOverride?: string;
  }) => Promise<void>;
  cancel: () => void;
  restore: () => void;
  applyAssistantMessage: (msg: ChatMessage) => void;
  reset: (newMessages: ChatMessage[]) => void;
  /**
   * Continue generating a truncated assistant message. Appends the model's
   * continuation to the given message id (both client-side and server-side).
   */
  continueGeneration: (input: { chatIdOverride?: string; messageId: string }) => Promise<void>;
  /**
   * Mark `chatId` as already-synced so the next time the parent swaps the
   * active chat to this id the resync effect does NOT wipe the in-flight /
   * freshly-streamed message list. Used right after a transient→real chat is
   * created so the persisted messages we just received aren't thrown away.
   */
  adoptChatId: (chatId: string) => void;
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
  // The chat id an in-flight send is streaming against. Lets the resync
  // effect abort only sends that belong to a *different* chat than the one we
  // are switching to (so flipping chats cancels the old stream instead of
  // letting its events mutate the newly-selected chat's message list).
  const sendTargetChatIdRef = useRef<string | null>(null);
  // True while re-attaching to a session that is still running on the server.
  // On `done` we then pull the freshly-persisted chat detail so the timeline
  // reflects the canonical assistant message (tool calls + segments).
  const liveRestoreRef = useRef(false);

  // Re-sync state when the parent switches to a different chat. We only
  // depend on chat.id — chat.messages gets a fresh array reference on every
  // parent render, so including it in the dep list would cause an infinite
  // re-render loop. The ref guards against running the sync more than once
  // per chatId even if React fires the effect twice in StrictMode.
  useEffect(() => {
    if (lastSyncedChatIdRef.current === chat.id) return;
    // Abort any in-flight send that belongs to the chat we are leaving. A
    // send for the *new* chat is never in-flight yet at this point (it is
    // only ever triggered by a user action after this render commits).
    if (sendAbortRef.current && sendTargetChatIdRef.current && sendTargetChatIdRef.current !== chat.id) {
      sendAbortRef.current.abort();
      sendAbortRef.current = null;
      setSending(false);
    }
    lastSyncedChatIdRef.current = chat.id;
    setMessages(chat.messages);
    setToolOutputs({});
    setToolArguments({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.id]);

  // Abort any orphaned streams when the hook unmounts (e.g. navigating to a
  // different route). The server-side agent keeps running independently; the
  // client simply stops consuming the SSE feed.
  useEffect(() => {
    return () => {
      sendAbortRef.current?.abort();
      restoreAbortRef.current?.abort();
    };
  }, []);

  const adoptChatId = useCallback((chatId: string) => {
    lastSyncedChatIdRef.current = chatId;
  }, []);

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
    async ({ text, attachments, reasoningEffort, chatIdOverride }: { text: string; attachments: UploadedAttachment[]; reasoningEffort?: ReasoningEffort; chatIdOverride?: string }) => {
      if (sending) return;
      const targetChatId = chatIdOverride ?? chat.id;
      const content = text.trim() || "Please analyze the attached files.";
      const atts = [...attachments];

      setError(null);
      setSending(true);
      setToolOutputs({});
      setToolArguments({});

      if (sendAbortRef.current) sendAbortRef.current.abort();
      sendAbortRef.current = new AbortController();
      sendTargetChatIdRef.current = targetChatId;

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
      let currentContentSegment = "";
      let currentToolCallIdx = 0;

      const pushReasoningSegment = () => {
        if (currentReasoningSegment.length > 0) {
          const segText = currentReasoningSegment;
          const segIdx = currentToolCallIdx;
          setMessages((current) => {
            const copy = current.slice();
            const idx = copy.length - 1;
            if (idx < 0) return current;
            const last = copy[idx]!;
            const segs = last.reasoningSegments ?? [];
            copy[idx] = { ...last, reasoningSegments: [...segs, { text: segText, beforeToolIndex: segIdx }] };
            return copy;
          });
          currentReasoningSegment = "";
        }
      };

      const pushContentSegment = () => {
        if (currentContentSegment.trim().length > 0) {
          const segText = currentContentSegment;
          const segIdx = currentToolCallIdx;
          setMessages((current) => {
            const copy = current.slice();
            const idx = copy.length - 1;
            if (idx < 0) return current;
            const last = copy[idx]!;
            const segs = last.contentSegments ?? [];
            copy[idx] = { ...last, contentSegments: [...segs, { text: segText, beforeToolIndex: segIdx }] };
            return copy;
          });
        }
        currentContentSegment = "";
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
        const res = await fetch(`/api/chats/${targetChatId}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Requested-With": "ChatInterface" },
          body: JSON.stringify({
            content,
            attachments: atts.map((a) => a.id),
            agentEnabled,
            reasoningEffort,
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
            currentContentSegment += data.text;
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
            pushContentSegment();
            const tcId = (data.toolCallId as string) ?? `tc-${Date.now()}`;
            const args = (data.arguments as Record<string, unknown> | undefined) ?? undefined;
            if (args) {
              setToolArguments((prev) => ({ ...prev, [tcId]: args }));
            }
            currentToolCallIdx++;
            applyContent((m) => applyToolEventToMessage(m, "tool_start", data) ?? m);
            return;
          }
          if (event === "tool_output") {
            // Streamed output lives in toolOutputs (live display) + the
            // persisted toolCall.output (server-side). No per-chunk message
            // mutation here — avoids N×M re-renders for chunked output.
            appendOutput({
              toolCallId: (data.toolCallId as string) ?? "",
              output: (data.output as string) ?? "",
            });
            return;
          }
          if (event === "tool_done") {
            applyContent((m) => applyToolEventToMessage(m, "tool_done", data) ?? m);
            return;
          }
          if (event === "error") {
            setError((data.message as string) ?? "Stream error");
            return;
          }
          if (event === "done") {
            pushReasoningSegment();
            pushContentSegment();
            const asst = data.assistantMessage as ChatMessage | undefined;
            const usr = data.userMessage as ChatMessage | undefined;
            // Replace the optimistic user message id with the persisted one so
            // later edits/deletes resolve to the real DB row.
            if (usr) {
              setMessages((current) => {
                const copy = current.slice();
                const userIdx = copy.length - 2;
                if (
                  userIdx >= 0 &&
                  copy[userIdx]?.role === "user" &&
                  copy[userIdx]!.id.startsWith("user-temp-")
                ) {
                  copy[userIdx] = { ...copy[userIdx]!, id: usr.id };
                }
                return copy;
              });
            }
            if (asst) {
              const meta = data.meta as { finishReason?: string } | undefined;
              const truncated = meta?.finishReason === "length";
              applyContent((m) => ({
                ...asst,
                _isStreaming: false,
                ttftMs: asst.ttftMs ?? m.ttftMs,
                // Prefer the server-persisted tool calls/segments (they carry
                // arguments + output and survive refresh); fall back to the
                // live in-memory copies when the server omitted them.
                toolCalls: asst.toolCalls ?? m.toolCalls,
                reasoning: asst.reasoning ?? m.reasoning,
                reasoningSegments: asst.reasoningSegments ?? m.reasoningSegments,
                contentSegments: asst.contentSegments ?? m.contentSegments,
                avgTokensPerSecond: asst.avgTokensPerSecond ?? m.avgTokensPerSecond,
                _truncated: truncated,
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
        sendTargetChatIdRef.current = null;
      }
    },
    [chat.id, agentEnabled, sending, onTitleUpdate, onChatsRefresh],
  );

  // ── Continue generating (truncated response) ──────────────────────────────
  // Re-streams a completion against the existing conversation (which ends with
  // the truncated assistant message) and appends the new output to that same
  // message, both in-memory and server-side. Works for normal and agent-locked
  // chats — the server decide whether to extend raw content (normal) or append
  // a tail content segment (agent, to preserve tool-call ordering).
  const continueGeneration = useCallback(
    async ({ chatIdOverride, messageId }: { chatIdOverride?: string; messageId: string }) => {
      if (sending) return;
      const targetChatId = chatIdOverride ?? chat.id;
      setError(null);
      setSending(true);

      if (sendAbortRef.current) sendAbortRef.current.abort();
      sendAbortRef.current = new AbortController();
      sendTargetChatIdRef.current = targetChatId;

      // Mark the target message as streaming again so the UI shows the active
      // indicator and disables controls while the continuation streams.
      setMessages((current) =>
        current.map((m) => (m.id === messageId ? { ...m, _isStreaming: true, _truncated: false } : m)),
      );

      const applyContent = (updater: (msg: ChatMessage) => ChatMessage) => {
        setMessages((current) => {
          const idx = current.findIndex((m) => m.id === messageId);
          if (idx === -1) return current;
          const copy = current.slice();
          copy[idx] = updater(copy[idx]!);
          return copy;
        });
      };

      try {
        const res = await fetch(`/api/chats/${targetChatId}/messages/${messageId}/continue`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Requested-With": "ChatInterface" },
          signal: sendAbortRef.current.signal,
        });

        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(j.error ?? "Continue request failed");
        }
        if (!res.body) throw new Error("No response body");

        await consumeSse(res.body, (event, data) => {
          onSseEvent?.(event, data);
          if (event === "ttft") {
            applyContent((m) => ({ ...m, ttftMs: data.ttftMs as number }));
            return;
          }
          if (event === "content" && typeof data.text === "string") {
            applyContent((m) => ({ ...m, content: m.content + data.text, _isStreaming: true }));
            return;
          }
          if (event === "error") {
            setError((data.message as string) ?? "Continue stream error");
            return;
          }
          if (event === "done") {
            const asst = data.assistantMessage as ChatMessage | undefined;
            const meta = data.meta as { finishReason?: string } | undefined;
            const truncated = meta?.finishReason === "length";
            if (asst) {
              applyContent((m) => ({
                ...asst,
                _isStreaming: false,
                ttftMs: asst.ttftMs ?? m.ttftMs,
                content: asst.content,
                contentSegments: asst.contentSegments ?? m.contentSegments,
                toolCalls: asst.toolCalls ?? m.toolCalls,
                _truncated: truncated,
              }));
            } else {
              applyContent((m) => ({ ...m, _isStreaming: false, _truncated: truncated }));
            }
            if (onChatsRefresh) void onChatsRefresh();
          }
        });
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        setError(err instanceof Error ? err.message : "Continue failed");
      } finally {
        setSending(false);
        sendTargetChatIdRef.current = null;
        // If we never got a done event, flip the streaming flag off so the
        // message isn't stuck showing the active state.
        setMessages((current) =>
          current.map((m) => (m.id === messageId ? { ...m, _isStreaming: false } : m)),
        );
      }
    },
    [chat.id, sending, onSseEvent, onChatsRefresh],
  );

  // ── Restore live state after refresh ─────────────────────────────────────
  const restore = useCallback(() => {
    if (restoreAbortRef.current) restoreAbortRef.current.abort();
    const ac = new AbortController();
    restoreAbortRef.current = ac;
    liveRestoreRef.current = false;

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
              liveRestoreRef.current = true;
              // If the in-flight assistant message isn't persisted yet (the last
              // row is the user message), create a streaming placeholder so the
              // replayed tool calls have somewhere to attach on the timeline.
              setMessages((current) => {
                const copy = current.slice();
                const idx = copy.length - 1;
                if (idx < 0) return current;
                const last = copy[idx]!;
                if (last.role === "assistant") {
                  copy[idx] = { ...last, _isStreaming: true };
                  return copy;
                }
                copy.push({
                  id: `temp-restore-${agentSessionId}`,
                  role: "assistant",
                  content: "",
                  createdAt: new Date().toISOString(),
                  _isStreaming: true,
                });
                return copy;
              });
            }
            return;
          }
          if (event === "replay_tool_start") {
            const id = (data.toolCallId as string) ?? "";
            const args = (data.arguments as Record<string, unknown> | undefined) ?? undefined;
            if (args && id) {
              setToolArguments((prev) => ({ ...prev, [id]: args }));
            }
            setMessages((current) => {
              const copy = current.slice();
              const idx = copy.length - 1;
              if (idx < 0) return current;
              const last = copy[idx]!;
              if (last.role !== "assistant") return current;
              const updated = applyToolEventToMessage(last, "replay_tool_start", data);
              if (!updated) return current;
              copy[idx] = updated;
              return copy;
            });
            return;
          }
          if (event === "replay_tool_output") {
            // Live output is displayed via toolOutputs; persisted call.output is
            // loaded from chat detail after the session finishes (see `done`).
            appendOutput({
              toolCallId: data.toolCallId as string,
              output: data.output as string,
            });
            return;
          }
          if (event === "replay_tool_done") {
            applyContent((m) => applyToolEventToMessage(m, "replay_tool_done", data) ?? m);
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
            // If we re-attached to a live session that has now finished, pull
            // the freshly-persisted chat detail so the timeline shows the
            // canonical assistant message (tool calls w/ arguments + output and
            // ordered content/reasoning segments) instead of the placeholder.
            if (liveRestoreRef.current) {
              liveRestoreRef.current = false;
              void (async () => {
                // The orchestrator flips session status to "completed" before
                // the messages route persists the assistant row, so the stream's
                // `done` can arrive a moment too early. Retry until the last
                // message is a real persisted assistant row (not our
                // `temp-restore-*` placeholder).
                const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
                for (let attempt = 0; attempt < 8; attempt++) {
                  if (ac.signal.aborted) return;
                  try {
                    const res = await fetch(`/api/chats/${chat.id}`, {
                      headers: { "X-Requested-With": "ChatInterface" },
                      signal: ac.signal,
                    });
                    if (res.ok) {
                      const detail = (await res.json().catch(() => null)) as { chat?: ChatDetail } | null;
                      const msgs = detail?.chat?.messages;
                      if (msgs && msgs.length) {
                        const last = msgs[msgs.length - 1]!;
                        if (last.role === "assistant" && !last.id.startsWith("temp-restore-")) {
                          setMessages(msgs);
                          setToolOutputs({});
                          setToolArguments({});
                          return;
                        }
                      }
                    }
                  } catch {
                    // keep retrying
                  }
                  await sleep(450);
                }
              })();
            }
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
  }, [chat.id, chat.agentSession?.id, onChatsRefresh, onSseEvent]);

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
    adoptChatId,
    continueGeneration,
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

// ── Shared tool-event reducer ────────────────────────────────────────────────
// Both the fresh `send` stream and the `restore` replay stream mutate the
// assistant message's `toolCalls` array the same way. Centralizing it prevents
// drift between the two code paths. `tool_output` events are intentionally NOT
// handled here — streamed output lives in the `toolOutputs` state during a live
// session and on the persisted tool call after refresh; stashing it per-chunk
// onto the message would double state updates for every output chunk.
export function applyToolEventToMessage(
  msg: ChatMessage,
  event:
    | "tool_start"
    | "replay_tool_start"
    | "tool_done"
    | "replay_tool_done",
  data: Record<string, unknown>,
): ChatMessage | null {
  if (event === "tool_start" || event === "replay_tool_start") {
    const tcId = (data.toolCallId as string) ?? `tc-${Date.now()}`;
    const existing = msg.toolCalls ?? [];
    // Avoid duplicates when the server replays the same call twice.
    if (existing.some((tc) => tc.toolCallId === tcId)) return null;
    return {
      ...msg,
      toolCalls: [
        ...existing,
        {
          toolCallId: tcId,
          toolName: (data.toolName as string) ?? "unknown",
          status: "running",
          arguments: (data.arguments as Record<string, unknown> | undefined) ?? undefined,
        },
      ],
      _isStreaming: true,
    };
  }
  // tool_done / replay_tool_done — match by id only (avoids matching the
  // wrong call when two calls share a tool name).
  const id = (data.toolCallId as string) ?? "";
  const tcs = (msg.toolCalls ?? []).map((tc) =>
    tc.toolCallId === id
      ? {
          ...tc,
          status: data.ok ? ("success" as const) : ("error" as const),
          durationMs: data.durationMs as number,
          error: (data.error as string) ?? tc.error,
        }
      : tc,
  );
  return { ...msg, toolCalls: tcs };
}
