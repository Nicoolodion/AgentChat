"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Bot,
  Globe,
  KeyRound,
  Loader2,
  LogOut,
  MessageSquarePlus,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  Trash2,
} from "lucide-react";
import { useRouter } from "next/navigation";

import type { ChatDetail, ChatListItem, ModelInfo } from "@/lib/chat-types";
import { cn } from "@/lib/ui";

type MePayload = {
  authenticated: boolean;
  authRequired: boolean;
  registrationEnabled: boolean;
  user: {
    id: string;
    username: string;
    isGuest: boolean;
  } | null;
};

async function apiFetch<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  const json = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    throw new Error((json as { error?: string }).error ?? "Request failed");
  }

  return json;
}

function prettyDate(iso: string): string {
  const date = new Date(iso);
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function ChatApp() {
  const router = useRouter();
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const [me, setMe] = useState<MePayload | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [chats, setChats] = useState<ChatListItem[]>([]);
  const [activeChat, setActiveChat] = useState<ChatDetail | null>(null);
  const [messageInput, setMessageInput] = useState("");
  const [chatTitle, setChatTitle] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (activeChat?.messages.length) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [activeChat?.messages.length]);

  useEffect(() => {
    const boot = async () => {
      try {
        setLoading(true);
        const meResult = await apiFetch<MePayload>("/api/auth/me");
        setMe(meResult);

        if (meResult.authRequired && !meResult.authenticated) {
          router.replace("/login");
          return;
        }

        const [{ models: modelRows }, { chats: chatRows }] = await Promise.all([
          apiFetch<{ models: ModelInfo[] }>("/api/models"),
          apiFetch<{ chats: ChatListItem[] }>("/api/chats"),
        ]);

        setModels(modelRows);
        setChats(chatRows);

        if (chatRows.length > 0) {
          await openChat(chatRows[0].id);
        } else {
          await createChat(modelRows[0]?.id ?? "gpt-4o-mini");
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to initialize app.");
      } finally {
        setLoading(false);
      }
    };

    void boot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activeModelInfo = useMemo(() => {
    if (!activeChat) return null;
    return models.find((model) => model.id === activeChat.model) ?? null;
  }, [activeChat, models]);

  async function reloadChatsAndKeepSelection(chatId?: string) {
    const chatRows = await apiFetch<{ chats: ChatListItem[] }>("/api/chats");
    setChats(chatRows.chats);

    const targetId = chatId ?? activeChat?.id ?? chatRows.chats[0]?.id;
    if (targetId) {
      await openChat(targetId);
    }
  }

  async function openChat(chatId: string) {
    const detail = await apiFetch<{ chat: ChatDetail }>(`/api/chats/${chatId}`);
    setActiveChat(detail.chat);
    setChatTitle(detail.chat.title);
  }

  async function createChat(modelId?: string) {
    const created = await apiFetch<{ chat: ChatListItem }>("/api/chats", {
      method: "POST",
      body: JSON.stringify({
        model: modelId,
        webSearchEnabled: false,
      }),
    });

    await reloadChatsAndKeepSelection(created.chat.id);
  }

  async function updateChat(payload: Partial<Pick<ChatDetail, "title" | "model" | "webSearchEnabled">>) {
    if (!activeChat) return;
    const updated = await apiFetch<{ chat: ChatDetail }>(`/api/chats/${activeChat.id}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    });

    setActiveChat(updated.chat);
    setChatTitle(updated.chat.title);
    await reloadChatsAndKeepSelection(updated.chat.id);
  }

  async function deleteChat(chatId: string) {
    await apiFetch(`/api/chats/${chatId}`, { method: "DELETE" });
    const remaining = chats.filter((chat) => chat.id !== chatId);
    setChats(remaining);

    if (remaining.length) {
      await openChat(remaining[0].id);
    } else {
      await createChat(models[0]?.id ?? "gpt-4o-mini");
    }
  }

  async function sendMessage() {
    if (!activeChat || !messageInput.trim() || sending) return;

    setSending(true);
    setError(null);

    const content = messageInput.trim();
    setMessageInput("");

    try {
      const response = await apiFetch<{
        userMessage: ChatDetail["messages"][number];
        assistantMessage: ChatDetail["messages"][number];
      }>(`/api/chats/${activeChat.id}/messages`, {
        method: "POST",
        body: JSON.stringify({ content }),
      });

      setActiveChat((current) => {
        if (!current) return current;
        return {
          ...current,
          messages: [...current.messages, response.userMessage, response.assistantMessage],
        };
      });

      await reloadChatsAndKeepSelection(activeChat.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Message failed.");
    } finally {
      setSending(false);
    }
  }

  async function logout() {
    await apiFetch("/api/auth/logout", { method: "POST" });
    router.replace("/login");
  }

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="flex items-center gap-3 rounded-full border border-white/20 bg-slate-900/70 px-5 py-3 text-slate-100 shadow-2xl">
          <Loader2 className="h-4 w-4 animate-spin" />
          Booting your encrypted workspace...
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-[radial-gradient(circle_at_20%_20%,rgba(13,148,136,0.18),transparent_35%),radial-gradient(circle_at_85%_5%,rgba(251,146,60,0.2),transparent_30%),linear-gradient(135deg,#0f172a,#111827_45%,#020617)] p-3 md:p-5">
      <div className="grid h-full w-full grid-cols-1 overflow-hidden rounded-3xl border border-white/10 bg-slate-950/60 shadow-[0_30px_80px_rgba(2,6,23,.5)] backdrop-blur xl:grid-cols-[320px_1fr]">
        <aside className="border-b border-white/10 p-4 xl:border-b-0 xl:border-r">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <div className="text-xs uppercase tracking-[0.2em] text-teal-300">Chatinterface</div>
              <div className="text-lg font-semibold text-white">NanoGPT Agent Desk</div>
            </div>
            <button
              onClick={() => createChat(activeChat?.model ?? models[0]?.id)}
              className="inline-flex items-center gap-2 rounded-full bg-teal-400 px-3 py-2 text-xs font-semibold text-slate-900 transition hover:bg-teal-300"
            >
              <MessageSquarePlus className="h-4 w-4" />
              New
            </button>
          </div>

          <div className="mb-4 rounded-2xl border border-white/10 bg-white/5 p-3 text-xs text-slate-300">
            <div className="flex items-center gap-2 text-teal-200">
              <ShieldCheck className="h-4 w-4" />
              End-to-end app-layer encryption at rest
            </div>
            <div className="mt-2 flex items-center gap-2 text-slate-400">
              <KeyRound className="h-4 w-4" />
              Signed in as {me?.user?.username ?? "anonymous"}
            </div>
          </div>

          <div className="max-h-[calc(100vh-260px)] space-y-2 overflow-y-auto pr-1">
            {chats.map((chat) => (
              <button
                key={chat.id}
                onClick={() => openChat(chat.id)}
                className={cn(
                  "group w-full rounded-2xl border px-3 py-2 text-left transition",
                  activeChat?.id === chat.id
                    ? "border-teal-300/60 bg-teal-400/20"
                    : "border-white/10 bg-white/5 hover:bg-white/10",
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="line-clamp-1 text-sm font-medium text-white">{chat.title}</div>
                  <button
                    onClick={(event) => {
                      event.stopPropagation();
                      void deleteChat(chat.id);
                    }}
                    className="opacity-0 transition group-hover:opacity-100"
                    aria-label="Delete chat"
                  >
                    <Trash2 className="h-4 w-4 text-rose-300" />
                  </button>
                </div>
                <div className="mt-1 line-clamp-2 text-xs text-slate-300">{chat.lastMessagePreview}</div>
                <div className="mt-1 text-[11px] text-slate-400">{prettyDate(chat.updatedAt)}</div>
              </button>
            ))}
          </div>
        </aside>

        <main className="flex min-h-0 flex-col">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={activeChat?.model ?? models[0]?.id ?? ""}
                onChange={(event) => {
                  void updateChat({ model: event.target.value });
                }}
                className="rounded-xl border border-white/15 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none ring-teal-300/40 focus:ring"
              >
                {models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.displayName}
                  </option>
                ))}
              </select>

              <button
                onClick={() =>
                  void updateChat({ webSearchEnabled: !(activeChat?.webSearchEnabled ?? false) })
                }
                className={cn(
                  "inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-sm",
                  activeChat?.webSearchEnabled
                    ? "border-emerald-300/70 bg-emerald-400/20 text-emerald-100"
                    : "border-white/15 bg-slate-900 text-slate-300",
                )}
              >
                {activeChat?.webSearchEnabled ? <Globe className="h-4 w-4" /> : <Search className="h-4 w-4" />}
                Web Search
              </button>
            </div>

            <div className="flex items-center gap-2">
              <div className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-slate-300">
                Context: {activeModelInfo?.contextLength?.toLocaleString() ?? "unknown"}
              </div>
              <button
                onClick={() => void logout()}
                className="inline-flex items-center gap-2 rounded-xl border border-white/15 bg-slate-900 px-3 py-2 text-sm text-slate-200 hover:bg-slate-800"
              >
                <LogOut className="h-4 w-4" />
                Logout
              </button>
            </div>
          </div>

          <div className="border-b border-white/10 px-4 py-3">
            <input
              value={chatTitle}
              onChange={(event) => setChatTitle(event.target.value)}
              onBlur={() => {
                if (!activeChat) return;
                if (chatTitle.trim() && chatTitle.trim() !== activeChat.title) {
                  void updateChat({ title: chatTitle.trim() });
                }
              }}
              className="w-full rounded-xl border border-white/15 bg-slate-900/70 px-3 py-2 text-sm text-white outline-none ring-teal-300/30 focus:ring"
              placeholder="Chat title"
            />
          </div>

          <div className="flex min-h-0 flex-1 flex-col px-4 py-3">
            <div className="flex-1 space-y-3 overflow-y-auto">
              {activeChat?.messages.map((message) => (
                <div
                  key={message.id}
                  className={cn(
                    "rounded-2xl border px-4 py-3",
                    message.role === "user"
                      ? "ml-auto max-w-[85%] border-teal-300/40 bg-teal-400/15"
                      : "max-w-[90%] border-white/15 bg-white/5",
                  )}
                >
                  <div className="mb-1 flex items-center gap-2 text-xs uppercase tracking-wide text-slate-300">
                    {message.role === "assistant" ? <Bot className="h-3.5 w-3.5" /> : <Sparkles className="h-3.5 w-3.5" />}
                    {message.role}
                    <span className="text-slate-500">{prettyDate(message.createdAt)}</span>
                  </div>
                  <div className="whitespace-pre-wrap text-sm text-slate-100">{message.content}</div>
                  {message.reasoning ? (
                    <details className="mt-2 rounded-xl border border-white/10 bg-slate-950/40 p-2 text-xs text-slate-300">
                      <summary className="cursor-pointer text-teal-200">Reasoning trace</summary>
                      <pre className="mt-2 whitespace-pre-wrap font-mono text-[11px] leading-relaxed">
                        {message.reasoning}
                      </pre>
                    </details>
                  ) : null}
                  {message.toolPayload ? (
                    <details className="mt-2 rounded-xl border border-white/10 bg-slate-950/40 p-2 text-xs text-slate-300">
                      <summary className="cursor-pointer text-amber-200">Tool payload</summary>
                      <pre className="mt-2 whitespace-pre-wrap font-mono text-[11px] leading-relaxed">
                        {message.toolPayload}
                      </pre>
                    </details>
                  ) : null}
                  {(message.usagePromptTokens || message.usageCompletionTokens) && (
                    <div className="mt-2 text-[11px] text-slate-400">
                      usage: prompt {message.usagePromptTokens ?? 0} / completion {message.usageCompletionTokens ?? 0}
                    </div>
                  )}
                </div>
              ))}
              <div ref={bottomRef} />
            </div>

            <div className="mt-3 rounded-2xl border border-white/15 bg-slate-900/70 p-2">
              <textarea
                value={messageInput}
                onChange={(event) => setMessageInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void sendMessage();
                  }
                }}
                rows={3}
                placeholder="Ask anything. Press Enter to send, Shift+Enter for newline."
                className="w-full resize-none bg-transparent px-2 py-1 text-sm text-slate-100 outline-none"
              />
              <div className="flex items-center justify-between px-2 pb-1 pt-2">
                <div className="text-xs text-slate-400">
                  Tools enabled • Secure storage • {activeChat?.webSearchEnabled ? "Web search on" : "Web search off"}
                </div>
                <button
                  onClick={() => void sendMessage()}
                  disabled={sending || !messageInput.trim()}
                  className="inline-flex items-center gap-2 rounded-xl bg-teal-400 px-3 py-2 text-sm font-semibold text-slate-900 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                  Send
                </button>
              </div>
            </div>

            {error ? (
              <div className="mt-2 rounded-xl border border-rose-400/40 bg-rose-500/15 px-3 py-2 text-sm text-rose-200">
                {error}
              </div>
            ) : null}
          </div>
        </main>
      </div>
    </div>
  );
}
