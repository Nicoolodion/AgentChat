"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentArtifact, AgentSession, AgentSseEvent, AgentToolCall } from "@/lib/agent/types";

export type TerminalEntry =
  | { type: "status"; message: string; timestamp: number }
  | { type: "tool_start"; toolName: string; arguments: Record<string, unknown>; timestamp: number }
  | { type: "tool_output"; toolCallId: string; output: string; timestamp: number }
  | { type: "tool_done"; toolCallId: string; toolName: string; ok: boolean; durationMs: number; timestamp: number }
  | { type: "error"; message: string; timestamp: number }
  | { type: "step"; text: string; timestamp: number };

export type AgentUIState = {
  agentSession: AgentSession | null;
  isAgentMode: boolean;
  modeLocked: boolean;
  isInitializing: boolean;
  sidebarOpen: boolean;
  activeTab: "terminal" | "files" | "artifacts";
  terminalEntries: TerminalEntry[];
  artifacts: AgentArtifact[];
  isExecuting: boolean;
  currentStep: { number: number; total: number; description: string } | null;
  error: string | null;
};

export function useAgent(chatId: string | undefined) {
  const [state, setState] = useState<AgentUIState>({
    agentSession: null,
    isAgentMode: false,
    modeLocked: false,
    isInitializing: false,
    sidebarOpen: false, // default minimized
    activeTab: "terminal",
    terminalEntries: [],
    artifacts: [],
    isExecuting: false,
    currentStep: null,
    error: null,
  });

  const abortRef = useRef<AbortController | null>(null);
  const restoringRef = useRef(false);

  const toggleAgentMode = useCallback(async () => {
    if (!chatId) return;

    // Don't allow toggling if mode is already locked
    if (state.modeLocked) return;

    const next = !state.isAgentMode;

    if (next) {
      setState((s) => ({ ...s, isInitializing: true, isAgentMode: true, sidebarOpen: true, error: null }));
      try {
        const res = await fetch("/api/agent/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chatId }),
        });
        const data = (await res.json().catch(() => ({}))) as { session?: AgentSession; error?: string };
        if (!res.ok) {
          throw new Error(data.error ?? "Failed to initialize agent");
        }
        setState((s) => ({
          ...s,
          agentSession: data.session ?? null,
          isInitializing: false,
          sidebarOpen: true,
        }));
      } catch (err) {
        setState((s) => ({
          ...s,
          isInitializing: false,
          isAgentMode: false,
          sidebarOpen: false,
          error: err instanceof Error ? err.message : "Agent initialization failed",
        }));
      }
    } else {
      setState((s) => ({ ...s, isAgentMode: false, sidebarOpen: false }));
    }
  }, [chatId, state.isAgentMode, state.modeLocked]);

  const setActiveTab = useCallback((tab: AgentUIState["activeTab"]) => {
    setState((s) => ({ ...s, activeTab: tab }));
  }, []);

  const openSidebar = useCallback(() => setState((s) => ({ ...s, sidebarOpen: true })), []);
  const closeSidebar = useCallback(() => setState((s) => ({ ...s, sidebarOpen: false })), []);

  const addTerminalEntry = useCallback((entry: TerminalEntry) => {
    setState((s) => ({ ...s, terminalEntries: [...s.terminalEntries, entry] }));
  }, []);

  const clearTerminal = useCallback(() => {
    setState((s) => ({ ...s, terminalEntries: [] }));
  }, []);

  const setArtifacts = useCallback((artifacts: AgentArtifact[]) => {
    setState((s) => ({ ...s, artifacts }));
  }, []);

  const addArtifact = useCallback((artifact: AgentArtifact) => {
    setState((s) => ({ ...s, artifacts: [...s.artifacts, artifact] }));
  }, []);

  const loadSession = useCallback(async (sessionId: string) => {
    try {
      const res = await fetch(`/api/agent/sessions/${sessionId}`);
      if (!res.ok) return;
      const data = (await res.json()) as {
        session: AgentSession;
        toolCalls: AgentToolCall[];
        artifacts: AgentArtifact[];
      };

      const entries: TerminalEntry[] = [];
      for (const tc of data.toolCalls) {
        const ts = new Date(tc.createdAt).getTime();
        entries.push({
          type: "tool_start",
          toolName: tc.toolName,
          arguments: safeParseArgs(tc.arguments),
          timestamp: ts,
        });

        // Inject stored result as tool_output so users can inspect it on refresh
        if (tc.result) {
          entries.push({
            type: "tool_output",
            toolCallId: tc.id,
            output: tc.result.slice(0, 4000),
            timestamp: ts + 1,
          });
        }
        if (tc.error && tc.status !== "error") {
          entries.push({
            type: "tool_output",
            toolCallId: tc.id,
            output: tc.error.slice(0, 4000),
            timestamp: ts + 1,
          });
        }

        if (tc.status === "success") {
          entries.push({
            type: "tool_done",
            toolCallId: tc.id,
            toolName: tc.toolName,
            ok: true,
            durationMs: tc.durationMs ?? 0,
            timestamp: new Date(tc.completedAt ?? tc.createdAt).getTime(),
          });
        } else if (tc.status === "error") {
          entries.push({
            type: "error",
            message: tc.error ?? `${tc.toolName} failed`,
            timestamp: new Date(tc.completedAt ?? tc.createdAt).getTime(),
          });
        }
      }

      setState((s) => ({
        ...s,
        agentSession: data.session,
        artifacts: data.artifacts,
        terminalEntries: entries,
      }));
    } catch {
      // ignore
    }
  }, []);

  const syncChatMode = useCallback(
    async (chat: {
      id: string;
      agentModeLocked: boolean | null;
      agentSession: { id: string; status: string } | null;
      messages: Array<unknown>;
    }) => {
      if (!chatId) return;

      const hasMessages = chat.messages.length > 0;
      const isLocked = chat.agentModeLocked !== null;
      const lockedToAgent = chat.agentModeLocked === true;

      if (isLocked) {
        // Mode is locked — force to correct mode
        if (lockedToAgent) {
          // Agent mode locked in — restore session
          if (chat.agentSession) {
            setState((s) => ({
              ...s,
              isAgentMode: true,
              modeLocked: true,
              agentSession: chat.agentSession as AgentSession,
            }));
            void loadSession(chat.agentSession!.id);
          } else {
            // No session yet but locked to agent — initialize
            setState((s) => ({ ...s, isAgentMode: true, modeLocked: true, isInitializing: true }));
            try {
              const res = await fetch("/api/agent/sessions", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ chatId }),
              });
              const data = (await res.json().catch(() => ({}))) as { session?: AgentSession; error?: string };
              setState((s) => ({
                ...s,
                agentSession: data.session ?? null,
                isInitializing: false,
              }));
              if (data.session) {
                void loadSession(data.session.id);
              }
            } catch {
              setState((s) => ({ ...s, isInitializing: false }));
            }
          }
        } else {
          // Locked to normal mode
          setState((s) => ({
            ...s,
            isAgentMode: false,
            modeLocked: true,
            sidebarOpen: false,
            agentSession: null,
            terminalEntries: [],
            artifacts: [],
          }));
        }
      } else if (hasMessages) {
        // Has messages but mode is NOT locked (backward compat / unexpected)
        // Determine from whether there is an agentSession
        if (chat.agentSession) {
          setState((s) => ({
            ...s,
            isAgentMode: true,
            modeLocked: true,
            sidebarOpen: true,
            agentSession: chat.agentSession as AgentSession,
          }));
          void loadSession(chat.agentSession!.id);
        } else {
          setState((s) => ({
            ...s,
            isAgentMode: false,
            modeLocked: true,
            sidebarOpen: false,
            agentSession: null,
            terminalEntries: [],
            artifacts: [],
          }));
        }
      } else {
        // Empty chat — mode is free to choose
        setState((s) => ({
          ...s,
          isAgentMode: false,
          modeLocked: false,
          sidebarOpen: false,
          agentSession: null,
          terminalEntries: [],
          artifacts: [],
        }));
      }
    },
    [chatId, loadSession]
  );

  const executeAgent = useCallback(
    async (message: string, attachments?: string[]) => {
      if (!state.agentSession) return;
      const sessionId = state.agentSession.id;

      if (abortRef.current) {
        abortRef.current.abort();
      }
      abortRef.current = new AbortController();

      setState((s) => ({
        ...s,
        isExecuting: true,
        error: null,
        currentStep: { number: 1, total: 1, description: "Starting..." },
      }));

      try {
        const response = await fetch(`/api/agent/sessions/${sessionId}/execute`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message, attachments }),
          signal: abortRef.current.signal,
        });

        if (!response.ok) {
          const err = (await response.json().catch(() => ({}))) as { error?: string };
          throw new Error(err.error ?? "Agent execution failed");
        }

        const reader = response.body!.getReader();
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
              if (line.startsWith("event: ")) {
                eventType = line.slice(7).trim();
              } else if (line.startsWith("data: ")) {
                dataStr += line.slice(6) + "\n";
              }
            }

            if (!dataStr.trim()) continue;

            try {
              const data = JSON.parse(dataStr.trim());
              handleSseEvent(eventType, data, setState);
            } catch {
              // ignore parse errors
            }
          }
        }
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        setState((s) => ({
          ...s,
          isExecuting: false,
          error: err instanceof Error ? err.message : "Agent execution failed",
        }));
      } finally {
        setState((s) => ({ ...s, isExecuting: false, currentStep: null }));
      }
    },
    [state.agentSession]
  );

  // Auto-restore agent mode on mount / chatId change
  useEffect(() => {
    if (!chatId || restoringRef.current) return;
    restoringRef.current = true;

    fetch(`/api/chats/${chatId}`)
      .then((r) => r.json().catch(() => null))
      .then((data) => {
        const chat = (data as { chat?: { agentModeLocked?: boolean | null; agentSession?: { id: string; status: string } | null; messages?: unknown[] } } | null)?.chat;
        if (!chat) {
          restoringRef.current = false;
          return;
        }

        const hasMessages = (chat.messages?.length ?? 0) > 0;
        const isLocked = chat.agentModeLocked !== null && chat.agentModeLocked !== undefined;
        const lockedToAgent = chat.agentModeLocked === true;

      if (isLocked) {
        if (lockedToAgent) {
          if (chat.agentSession) {
            setState((s) => ({
              ...s,
              isAgentMode: true,
              modeLocked: true,
              sidebarOpen: true,
              agentSession: chat.agentSession as AgentSession,
            }));
            void loadSession(chat.agentSession!.id);
          } else {
              setState((s) => ({ ...s, isAgentMode: true, modeLocked: true, sidebarOpen: true, isInitializing: true }));
              fetch("/api/agent/sessions", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ chatId }),
              })
                .then((r) => r.json().catch(() => ({})))
                .then((d: { session?: AgentSession }) => {
                  setState((s) => ({
                    ...s,
                    agentSession: d.session ?? null,
                    isInitializing: false,
                  }));
                  if (d.session) void loadSession(d.session.id);
                })
                .catch(() => setState((s) => ({ ...s, isInitializing: false })))
                .finally(() => {
                  restoringRef.current = false;
                });
              return;
            }
          } else {
            setState((s) => ({
              ...s,
              isAgentMode: false,
              modeLocked: true,
              sidebarOpen: false,
              agentSession: null,
              terminalEntries: [],
              artifacts: [],
            }));
          }
        } else if (hasMessages) {
          if (chat.agentSession) {
            setState((s) => ({
              ...s,
              isAgentMode: true,
              modeLocked: true,
              sidebarOpen: true,
              agentSession: chat.agentSession as AgentSession,
            }));
            void loadSession(chat.agentSession.id);
          } else {
            setState((s) => ({
              ...s,
              isAgentMode: false,
              modeLocked: true,
              sidebarOpen: false,
              agentSession: null,
              terminalEntries: [],
              artifacts: [],
            }));
          }
        } else {
          setState((s) => ({
            ...s,
            isAgentMode: false,
            modeLocked: false,
            sidebarOpen: false,
            agentSession: null,
            terminalEntries: [],
            artifacts: [],
          }));
        }
        restoringRef.current = false;
      })
      .catch(() => {
        restoringRef.current = false;
      });
  }, [chatId, loadSession]);

  return {
    ...state,
    toggleAgentMode,
    setActiveTab,
    openSidebar,
    closeSidebar,
    addTerminalEntry,
    clearTerminal,
    setArtifacts,
    addArtifact,
    loadSession,
    syncChatMode,
    executeAgent,
  };
}

function safeParseArgs(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function handleSseEvent(
  eventType: string,
  data: Record<string, unknown>,
  setState: React.Dispatch<React.SetStateAction<AgentUIState>>
) {
  const now = Date.now();

  switch (eventType) {
    case "status": {
      const status = String((data as { status?: string }).status ?? "");
      const step = String((data as { step?: string }).step ?? "");
      setState((s) => ({
        ...s,
        isExecuting: ["thinking", "executing"].includes(status),
        terminalEntries: [
          ...s.terminalEntries,
          { type: "status", message: step || status, timestamp: now },
        ],
      }));
      break;
    }
    case "tool_start": {
      const typed = data as { toolCallId?: string; toolName?: string; arguments?: Record<string, unknown> };
      setState((s) => ({
        ...s,
        terminalEntries: [
          ...s.terminalEntries,
          {
            type: "tool_start",
            toolName: typed.toolName ?? "unknown",
            arguments: typed.arguments ?? {},
            timestamp: now,
          },
        ],
      }));
      break;
    }
    case "tool_output": {
      const typed = data as { toolCallId?: string; output?: string };
      setState((s) => ({
        ...s,
        terminalEntries: [
          ...s.terminalEntries,
          {
            type: "tool_output",
            toolCallId: typed.toolCallId ?? "",
            output: typed.output ?? "",
            timestamp: now,
          },
        ],
      }));
      break;
    }
    case "tool_done": {
      const typed = data as {
        toolCallId?: string;
        toolName?: string;
        ok?: boolean;
        durationMs?: number;
        error?: string;
      };
      if (!typed.ok && typed.error) {
        setState((s) => ({
          ...s,
          terminalEntries: [
            ...s.terminalEntries,
            {
              type: "error",
              message: `${typed.toolName} failed: ${typed.error}`,
              timestamp: now,
            },
          ],
        }));
      } else {
        setState((s) => ({
          ...s,
          terminalEntries: [
            ...s.terminalEntries,
            {
              type: "tool_done",
              toolCallId: typed.toolCallId ?? "",
              toolName: typed.toolName ?? "",
              ok: typed.ok ?? false,
              durationMs: typed.durationMs ?? 0,
              timestamp: now,
            },
          ],
        }));
      }
      break;
    }
    case "artifact": {
      const typed = data as { artifact?: AgentArtifact };
      if (typed.artifact) {
        setState((s) => ({
          ...s,
          artifacts: [...s.artifacts, typed.artifact!],
        }));
      }
      break;
    }
    case "error": {
      setState((s) => ({
        ...s,
        isExecuting: false,
        error: String((data as { message?: string }).message ?? "Unknown error"),
      }));
      break;
    }
    case "done": {
      setState((s) => ({
        ...s,
        isExecuting: false,
        currentStep: null,
      }));
      break;
    }
  }
}
