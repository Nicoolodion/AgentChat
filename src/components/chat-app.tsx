"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Bot,
  CornerDownLeft,
  File,
  FileImage,
  FileText,
  Globe,
  KeyRound,
  Loader2,
  LogOut,
  MessageSquarePlus,
  Paperclip,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
  Upload,
  X,
  ChevronRight,
  Zap,
  Activity,
  Menu,
} from "lucide-react";
import { useRouter } from "next/navigation";

import {
  AgentModeToggle,
  AgentProgressBar,
  AgentMessageBadge,
  AgentSidebar,
  useAgent,
} from "@/components/agent";

import type {
  ChatDetail,
  ChatListItem,
  ChatMessage,
  MessageAttachmentRef,
  ModelInfo,
  UploadedAttachment,
} from "@/lib/chat-types";
import { decodeUserAttachmentsPayload, encodeUserAttachmentsPayload } from "@/lib/chat-types";
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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function MessageBubble({
  message,
  prettyDate,
  onAttachmentPreview,
  isNewest,
  activeModelContextLength,
  onReroll,
}: {
  message: ChatMessage;
  prettyDate: (iso: string) => string;
  onAttachmentPreview: (attachment: MessageAttachmentRef) => void;
  isNewest: boolean;
  activeModelContextLength?: number;
  onReroll?: () => void;
}) {
  const isAssistant = message.role === "assistant";
  const isStreaming = "_isStreaming" in message;
  const userAttachments = message.role === "user" ? decodeUserAttachmentsPayload(message.toolPayload) : [];
  const displayContent =
    message.role === "user" && userAttachments.length > 0
      ? message.content.replace(/\n\nAttached files:[\s\S]*$/, "").trimEnd()
      : message.content;
  const isEmpty = !displayContent && !message.reasoning;
  const showToolPayload = Boolean(message.toolPayload) && !(message.role === "user" && userAttachments.length > 0);

  function renderAttachmentCard(attachment: MessageAttachmentRef) {
    const isImage = attachment.kind === "image";
    const Icon =
      attachment.kind === "image"
        ? FileImage
        : attachment.kind === "pdf" || attachment.kind === "document" || attachment.kind === "text"
          ? FileText
          : File;

    return (
      <button
        key={attachment.id}
        type="button"
        onClick={() => onAttachmentPreview(attachment)}
        className="group overflow-hidden rounded-xl border border-white/15 bg-white/5 text-left transition hover:border-teal-300/50 hover:bg-white/10"
      >
        {isImage ? (
          <div className="h-24 w-24 overflow-hidden bg-slate-900/80">
            <img
              src={`/api/uploads/${encodeURIComponent(attachment.id)}`}
              alt={attachment.fileName}
              className="h-full w-full object-cover transition group-hover:scale-105"
            />
          </div>
        ) : (
          <div className="flex h-24 w-44 items-center gap-2 px-3">
            <Icon className="h-5 w-5 shrink-0 text-teal-200" />
            <div className="min-w-0">
              <div className="truncate text-xs font-medium text-slate-100" title={attachment.fileName}>
                {attachment.fileName}
              </div>
              <div className="text-[10px] uppercase tracking-wide text-slate-400">{attachment.kind}</div>
              <div className="text-[10px] text-slate-500">{formatBytes(attachment.size)}</div>
            </div>
          </div>
        )}
      </button>
    );
  }

  return (
    <div
      className={cn(
        "rounded-2xl border px-4 py-3",
        message.role === "user"
          ? "ml-auto max-w-[85%] border-teal-300/40 bg-teal-400/15"
          : "max-w-[90%] border-white/15 bg-white/5",
      )}
    >
      <div className="mb-1 flex items-center gap-2 text-xs uppercase tracking-wide text-slate-300">
        {isAssistant ? <Bot className="h-3.5 w-3.5" /> : <Sparkles className="h-3.5 w-3.5" />}
        {message.role}
        <span className="text-slate-500">{prettyDate(message.createdAt)}</span>
        {message.ttftMs && (
          <span className="flex items-center gap-1 text-[10px] font-medium text-emerald-300">
            <Zap className="h-3 w-3" />
            {message.ttftMs}ms TTFT
          </span>
        )}
        {message.avgTokensPerSecond && (
          <span className="flex items-center gap-1 text-[10px] font-medium text-amber-300">
            <Activity className="h-3 w-3" />
            {message.avgTokensPerSecond.toFixed(1)} t/s
          </span>
        )}
      </div>

      {message.reasoning && (
        <details className="group/details mb-2 overflow-hidden rounded-xl border border-white/10 bg-slate-950/40">
          <summary className="flex cursor-pointer items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-teal-200 transition group-open/details:bg-white/5">
            <ChevronRight className="h-3 w-3 transition-transform group-open/details:rotate-90" />
            Reasoning ({message.reasoning.length} chars)
          </summary>
          <div className="border-t border-white/5 px-3 py-2">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                pre: ({ children }) => (
                  <pre className="overflow-x-auto rounded-lg bg-slate-900 p-3 text-[11px] leading-relaxed text-slate-200">
                    {children}
                  </pre>
                ),
                code: ({ className, children }) => {
                  const isBlock = className?.includes("language-");
                  if (isBlock) {
                    return <>{children}</>;
                  }
                  return (
                    <code className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-[11px] text-slate-100">
                      {children}
                    </code>
                  );
                },
              }}
            >
              {message.reasoning}
            </ReactMarkdown>
          </div>
        </details>
      )}

      {isStreaming && isEmpty ? (
        <div className="flex items-center gap-1.5 py-2">
          <div className="h-1.5 w-1.5 animate-bounce rounded-full bg-teal-300" style={{ animationDelay: "0ms" }} />
          <div className="h-1.5 w-1.5 animate-bounce rounded-full bg-teal-300" style={{ animationDelay: "150ms" }} />
          <div className="h-1.5 w-1.5 animate-bounce rounded-full bg-teal-300" style={{ animationDelay: "300ms" }} />
          <span className="ml-2 text-xs text-slate-400">Thinking{message.ttftMs ? "..." : ""}</span>
        </div>
      ) : null}

      {userAttachments.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">{userAttachments.map((attachment) => renderAttachmentCard(attachment))}</div>
      )}

      {displayContent && (
        <div className="mt-1">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              h1: ({ children }) => <h1 className="mb-2 mt-3 text-lg font-semibold text-white">{children}</h1>,
              h2: ({ children }) => <h2 className="mb-2 mt-3 text-base font-semibold text-white">{children}</h2>,
              h3: ({ children }) => <h3 className="mb-1 mt-2 text-sm font-semibold text-white">{children}</h3>,
              p: ({ children }) => <p className="mb-2 text-sm text-slate-100 leading-relaxed">{children}</p>,
              ul: ({ children }) => <ul className="mb-2 ml-4 list-disc text-sm text-slate-100">{children}</ul>,
              ol: ({ children }) => <ol className="mb-2 ml-4 list-decimal text-sm text-slate-100">{children}</ol>,
              li: ({ children }) => <li className="mb-1 leading-relaxed">{children}</li>,
              a: ({ href, children }) => (
                <a href={href} target="_blank" rel="noopener noreferrer" className="text-teal-300 underline underline-offset-2 hover:text-teal-200">
                  {children}
                </a>
              ),
              blockquote: ({ children }) => (
                <blockquote className="mb-2 border-l-3 border-teal-300/40 pl-3 italic text-slate-300">
                  {children}
                </blockquote>
              ),
              hr: () => <hr className="my-3 border-white/10" />,
              table: ({ children }) => (
                <div className="my-3 overflow-x-auto">
                  <table className="min-w-full border-collapse border border-white/10 text-sm text-slate-100">
                    {children}
                  </table>
                </div>
              ),
              th: ({ children }) => (
                <th className="border border-white/10 bg-white/5 px-3 py-1.5 font-semibold">{children}</th>
              ),
              td: ({ children }) => <td className="border border-white/10 px-3 py-1.5">{children}</td>,
              pre: ({ children }) => (
                <pre className="my-2 overflow-x-auto rounded-xl border border-white/10 bg-slate-900/80 p-3 text-[12px] leading-relaxed text-slate-200">
                  {children}
                </pre>
              ),
              code: ({ className, children }) => {
                const isBlock = className?.includes("language-");
                if (isBlock) {
                  return <>{children}</>;
                }
                return (
                  <code className="rounded-lg bg-white/10 px-1.5 py-0.5 font-mono text-[12px] text-slate-100">
                    {children}
                  </code>
                );
              },
            }}
          >
            {displayContent}
          </ReactMarkdown>
        </div>
      )}

      {showToolPayload && (
        <details className="group/details mt-2 overflow-hidden rounded-xl border border-white/10 bg-slate-950/40">
          <summary className="flex cursor-pointer items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-amber-200 transition group-open/details:bg-white/5">
            <ChevronRight className="h-3 w-3 transition-transform group-open/details:rotate-90" />
            Tool use
          </summary>
          <div className="border-t border-white/5 px-3 py-2">
            <pre className="overflow-x-auto font-mono text-[11px] leading-relaxed text-slate-300">
              {message.toolPayload}
            </pre>
          </div>
        </details>
      )}

      {(message.usagePromptTokens || message.usageCompletionTokens) && (
        <div className="mt-2 flex items-center justify-between text-[10px] text-slate-500">
          <span>
            prompt {message.usagePromptTokens ?? 0} / completion {message.usageCompletionTokens ?? 0}
          </span>
          {message.providerModel && (
            <span className="font-mono">{message.providerModel}</span>
          )}
        </div>
      )}

      {isNewest && message.role === "assistant" && !isStreaming && activeModelContextLength && (
        <div className="mt-2 flex items-center gap-2 border-t border-white/5 pt-2 text-[10px] text-slate-500">
          <span className="font-mono">
            {(message.usagePromptTokens ?? 0) + (message.usageCompletionTokens ?? 0)}k / {Math.round(activeModelContextLength / 1000)}k
          </span>
          <span className="text-slate-600">context used</span>
        </div>
      )}

      {!isStreaming && message.role === "assistant" && onReroll && (
        <div className="mt-2 flex items-center justify-end">
          <button
            type="button"
            onClick={onReroll}
            className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] text-slate-300 transition hover:bg-white/10 hover:text-white"
            title="Regenerate response"
          >
            <RefreshCw className="h-3 w-3" />
            Reroll
          </button>
        </div>
      )}

      {isStreaming && !isEmpty && (
        <div className="flex items-center gap-1.5 pt-1">
          <div className="h-1.5 w-1.5 animate-pulse rounded-full bg-teal-300" />
          <span className="text-[10px] text-slate-400">Streaming...</span>
        </div>
      )}
    </div>
  );
}

export function ChatApp() {
  const router = useRouter();
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const dragCounterRef = useRef(0);

  const [me, setMe] = useState<MePayload | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [chats, setChats] = useState<ChatListItem[]>([]);
  const [activeChat, setActiveChat] = useState<ChatDetail | null>(null);
  const [messageInput, setMessageInput] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modelSearch, setModelSearch] = useState("");
  const [pendingAttachments, setPendingAttachments] = useState<UploadedAttachment[]>([]);
  const [uploadingAttachments, setUploadingAttachments] = useState(false);
  const [dropOverlayActive, setDropOverlayActive] = useState(false);
  const [previewAttachment, setPreviewAttachment] = useState<MessageAttachmentRef | null>(null);
  const modelDropdownRef = useRef<HTMLDivElement | null>(null);

  const agent = useAgent(activeChat?.id);

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

  const activeModelDisplay = activeModelInfo?.name ?? activeModelInfo?.displayName ?? activeChat?.model;

  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const modelSearchRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (modelDropdownOpen && modelSearchRef.current) {
      modelSearchRef.current.focus();
    }
  }, [modelDropdownOpen]);

  useEffect(() => {
    function handleClick(event: MouseEvent) {
      if (
        modelDropdownOpen &&
        modelDropdownRef.current &&
        !modelDropdownRef.current.contains(event.target as Node)
      ) {
        setModelDropdownOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [modelDropdownOpen]);

  const displayModels = useMemo(() => {
    const search = modelSearch.trim().toLowerCase();
    if (!search) return models;

    return models.filter(
      (model) =>
        model.id.toLowerCase().includes(search) ||
        model.displayName.toLowerCase().includes(search),
    );
  }, [modelSearch, models]);

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

  const uploadFiles = useCallback(async (files: File[]): Promise<void> => {
    if (files.length === 0 || uploadingAttachments) return;

    setError(null);
    setUploadingAttachments(true);

    try {
      const formData = new FormData();
      for (const file of files) {
        formData.append("files", file, file.name);
      }

      const response = await fetch("/api/uploads", {
        method: "POST",
        body: formData,
      });

      const json = (await response.json().catch(() => ({}))) as {
        attachments?: UploadedAttachment[];
        error?: string;
      };

      if (!response.ok) {
        throw new Error(json.error ?? "Upload failed.");
      }

      const newItems = json.attachments ?? [];
      setPendingAttachments((current) => {
        const merged = [...current, ...newItems];
        return merged.slice(0, 8);
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setUploadingAttachments(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  }, [uploadingAttachments]);

  function removeAttachment(attachmentId: string) {
    setPendingAttachments((current) => current.filter((item) => item.id !== attachmentId));
  }

  function openAttachmentPreview(attachment: MessageAttachmentRef) {
    setPreviewAttachment(attachment);
  }

  function closeAttachmentPreview() {
    setPreviewAttachment(null);
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setPreviewAttachment(null);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    function hasFiles(event: DragEvent): boolean {
      const types = event.dataTransfer?.types;
      return Boolean(types && Array.from(types).includes("Files"));
    }

    function onDragEnter(event: DragEvent) {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragCounterRef.current += 1;
      setDropOverlayActive(true);
    }

    function onDragLeave(event: DragEvent) {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
      if (dragCounterRef.current === 0) {
        setDropOverlayActive(false);
      }
    }

    function onDragOver(event: DragEvent) {
      if (!hasFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = "copy";
      }
    }

    function onDrop(event: DragEvent) {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragCounterRef.current = 0;
      setDropOverlayActive(false);

      const droppedFiles = Array.from(event.dataTransfer?.files ?? []);
      if (droppedFiles.length > 0) {
        void uploadFiles(droppedFiles);
      }
    }

    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);

    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
    };
  }, [uploadFiles]);

  async function sendMessage() {
    if (!activeChat || sending) return;

    const text = messageInput.trim();
    if (!text && pendingAttachments.length === 0) return;

    setSending(true);
    setError(null);

    const content = text || "Please analyze the attached files.";
    const attachmentsForSend = [...pendingAttachments];
    const optimisticAttachmentRefs: MessageAttachmentRef[] = attachmentsForSend.map((item) => ({
      id: item.id,
      fileName: item.fileName,
      mimeType: item.mimeType,
      size: item.size,
      kind: item.kind,
    }));
    setMessageInput("");
    // NOTE: We do NOT clear pendingAttachments here to keep files in context for the next message

    const tempId = `temp-${Date.now()}`;

    const userMsg: ChatMessage = {
      id: `user-${tempId}`,
      role: "user",
      content,
      toolPayload: optimisticAttachmentRefs.length
        ? encodeUserAttachmentsPayload(optimisticAttachmentRefs)
        : undefined,
      createdAt: new Date().toISOString(),
    };

    const tempAsstMsg: ChatMessage & { _isStreaming: true } = {
      id: tempId,
      role: "assistant",
      content: "",
      createdAt: new Date().toISOString(),
      _isStreaming: true,
    };

    setActiveChat((current) => {
      if (!current) return current;
      return {
        ...current,
        messages: [...current.messages, userMsg, tempAsstMsg],
      };
    });

    let ttftMsVal: number | undefined;
    let liveTokensPerSec: number | undefined;
    let totalTokens = 0;
    let streamingStarted = false;
    let streamStartTime = Date.now();

    try {
      const response = await fetch(`/api/chats/${activeChat.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content,
          attachments: attachmentsForSend.map((item) => item.id),
          agentEnabled: agent.isAgentMode,
        }),
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error((errData as { error?: string }).error ?? "Request failed");
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

            if (eventType === "ttft" && !streamingStarted) {
              ttftMsVal = data.ttftMs;
              streamingStarted = true;

              setActiveChat((current) => {
                if (!current) return current;
                const msgs = [...current.messages];
                const lastIdx = msgs.length - 1;
                msgs[lastIdx] = {
                  ...msgs[lastIdx]!,
                  content: "",
                  ttftMs: data.ttftMs,
                  _isStreaming: true,
                };
                return { ...current, messages: msgs };
              });
              continue;
            }

            if (eventType === "content" && data.text) {
              totalTokens += data.text.length;
              if (!streamingStarted) {
                streamingStarted = true;
                streamStartTime = Date.now();
                if (ttftMsVal) {
                  totalTokens = 1;
                }
              }

              const elapsedSec = (Date.now() - streamStartTime) / 1000;
              liveTokensPerSec = totalTokens / Math.max(elapsedSec, 0.1);

              setActiveChat((current) => {
                if (!current) return current;
                const msgs = [...current.messages];
                const lastIdx = msgs.length - 1;
                if (msgs[lastIdx]) {
                  msgs[lastIdx] = {
                    ...msgs[lastIdx]!,
                    content: (msgs[lastIdx] as ChatMessage).content + data.text,
                    avgTokensPerSecond: liveTokensPerSec,
                    _isStreaming: true,
                  };
                }
                return { ...current, messages: msgs };
              });
            }

            if (eventType === "reasoning" && data.text) {
              setActiveChat((current) => {
                if (!current) return current;
                const msgs = [...current.messages];
                const lastIdx = msgs.length - 1;
                if (msgs[lastIdx]) {
                  const existingReasoning = (msgs[lastIdx] as ChatMessage).reasoning ?? "";
                  msgs[lastIdx] = {
                    ...msgs[lastIdx]!,
                    reasoning: existingReasoning + data.text,
                    _isStreaming: true,
                  };
                }
                return { ...current, messages: msgs };
              });
            }

            if (eventType === "done") {
              const assistantMsg = (data.assistantMessage ?? data.assistantMessage) as ChatMessage | undefined;
              const finalAvgTokensPerSecond = (assistantMsg?.usageCompletionTokens && data.meta?.ttftMs)
                ? assistantMsg.usageCompletionTokens / Math.max((Date.now() - streamStartTime) / 1000, 0.1)
                : data.meta?.avgTokensPerSecond;

              if (assistantMsg) {
                setActiveChat((current) => {
                  if (!current) return current;
                  const msgs = [...current.messages];
                  const storedMsg = {
                    ...assistantMsg,
                    ttftMs: data.meta?.ttftMs ?? assistantMsg.ttftMs,
                    avgTokensPerSecond: data.meta?.avgTokensPerSecond ?? finalAvgTokensPerSecond,
                  };
                  msgs[msgs.length - 1] = storedMsg;
                  return { ...current, messages: msgs };
                });
              } else {
                // Agent mode: finalize the streaming message without server-returned assistantMessage
                setActiveChat((current) => {
                  if (!current) return current;
                  const msgs = [...current.messages];
                  const last = msgs[msgs.length - 1];
                  if (last && last._isStreaming) {
                    msgs[msgs.length - 1] = { ...last, _isStreaming: false };
                  }
                  return { ...current, messages: msgs };
                });
              }

              if (data.title) {
                setChats((prev) =>
                  prev.map((chat) =>
                    chat.id === activeChat.id
                      ? { ...chat, title: data.title, updatedAt: new Date().toISOString() }
                      : chat,
                  ),
                );
                setActiveChat((current) => {
                  if (!current) return current;
                  return { ...current, title: data.title };
                });
              }

              await reloadChatsAndKeepSelection(activeChat.id);
            }

            if (eventType === "error") {
              setError(data.message ?? "Streaming error occurred.");
            }
          } catch (parseErr) {
            console.warn("Failed to parse SSE data:", dataStr, parseErr);
          }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Message failed.");
      if (attachmentsForSend.length > 0) {
        setPendingAttachments((current) => [...attachmentsForSend, ...current]);
      }
      setActiveChat((current) => {
        if (!current) return current;
        return {
          ...current,
          messages: current.messages.filter((m) => !m.id.startsWith("temp-")),
        };
      });
    } finally {
      setSending(false);
    }
  }

  async function logout() {
    await apiFetch("/api/auth/logout", { method: "POST" });
    router.replace("/login");
  }

  async function handleReroll(assistantMessageIndex: number) {
    if (!activeChat || sending) return;

    const messages = activeChat.messages;
    const assistantMsg = messages[assistantMessageIndex];
    if (!assistantMsg || assistantMsg.role !== "assistant") return;

    // Find the preceding user message
    let userMsgIndex = -1;
    for (let i = assistantMessageIndex - 1; i >= 0; i--) {
      if (messages[i].role === "user") {
        userMsgIndex = i;
        break;
      }
    }
    if (userMsgIndex === -1) return;

    const userMsg = messages[userMsgIndex];

    // Extract attachment refs from user's toolPayload if any
    const userAttachments = decodeUserAttachmentsPayload(userMsg.toolPayload);
    const attachmentIds = userAttachments.map((a) => a.id);

    // Remove the assistant message optimistically
    setActiveChat((current) => {
      if (!current) return current;
      const newMessages = current.messages.filter((_, idx) => idx !== assistantMessageIndex);
      return { ...current, messages: newMessages };
    });

    // Delete the assistant message from server
    try {
      await apiFetch(`/api/chats/${activeChat.id}/messages/${assistantMsg.id}`, {
        method: "DELETE",
      });
    } catch {
      // Continue even if delete fails
    }

    setSending(true);
    setError(null);

    const tempId = `temp-${Date.now()}`;
    const tempAsstMsg: ChatMessage & { _isStreaming: true } = {
      id: tempId,
      role: "assistant",
      content: "",
      createdAt: new Date().toISOString(),
      _isStreaming: true,
    };

    setActiveChat((current) => {
      if (!current) return current;
      return {
        ...current,
        messages: [...current.messages, tempAsstMsg],
      };
    });

    let ttftMsVal: number | undefined;
    let liveTokensPerSec: number | undefined;
    let totalTokens = 0;
    let streamingStarted = false;
    let streamStartTime = Date.now();

    try {
      const response = await fetch(`/api/chats/${activeChat.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: userMsg.content.replace(/\n\nAttached files:[\s\S]*$/, "").trimEnd(),
          attachments: attachmentIds,
        }),
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error((errData as { error?: string }).error ?? "Request failed");
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

            if (eventType === "ttft" && !streamingStarted) {
              ttftMsVal = data.ttftMs;
              streamingStarted = true;

              setActiveChat((current) => {
                if (!current) return current;
                const msgs = [...current.messages];
                const lastIdx = msgs.length - 1;
                msgs[lastIdx] = {
                  ...msgs[lastIdx]!,
                  content: "",
                  ttftMs: data.ttftMs,
                  _isStreaming: true,
                };
                return { ...current, messages: msgs };
              });
              continue;
            }

            if (eventType === "content" && data.text) {
              totalTokens += data.text.length;
              if (!streamingStarted) {
                streamingStarted = true;
                streamStartTime = Date.now();
                if (ttftMsVal) {
                  totalTokens = 1;
                }
              }

              const elapsedSec = (Date.now() - streamStartTime) / 1000;
              liveTokensPerSec = totalTokens / Math.max(elapsedSec, 0.1);

              setActiveChat((current) => {
                if (!current) return current;
                const msgs = [...current.messages];
                const lastIdx = msgs.length - 1;
                if (msgs[lastIdx]) {
                  msgs[lastIdx] = {
                    ...msgs[lastIdx]!,
                    content: (msgs[lastIdx] as ChatMessage).content + data.text,
                    avgTokensPerSecond: liveTokensPerSec,
                    _isStreaming: true,
                  };
                }
                return { ...current, messages: msgs };
              });
            }

            if (eventType === "reasoning" && data.text) {
              setActiveChat((current) => {
                if (!current) return current;
                const msgs = [...current.messages];
                const lastIdx = msgs.length - 1;
                if (msgs[lastIdx]) {
                  const existingReasoning = (msgs[lastIdx] as ChatMessage).reasoning ?? "";
                  msgs[lastIdx] = {
                    ...msgs[lastIdx]!,
                    reasoning: existingReasoning + data.text,
                    _isStreaming: true,
                  };
                }
                return { ...current, messages: msgs };
              });
            }

            if (eventType === "done") {
              const assistantMsg = data.assistantMessage as ChatMessage;
              const finalAvgTokensPerSecond = (assistantMsg.usageCompletionTokens && data.meta?.ttftMs)
                ? assistantMsg.usageCompletionTokens / Math.max((Date.now() - streamStartTime) / 1000, 0.1)
                : data.meta?.avgTokensPerSecond;

              setActiveChat((current) => {
                if (!current) return current;
                const msgs = [...current.messages];
                const storedMsg = {
                  ...assistantMsg,
                  ttftMs: data.meta?.ttftMs ?? assistantMsg.ttftMs,
                  avgTokensPerSecond: data.meta?.avgTokensPerSecond ?? finalAvgTokensPerSecond,
                };
                msgs[msgs.length - 1] = storedMsg;
                return { ...current, messages: msgs };
              });

              await reloadChatsAndKeepSelection(activeChat.id);
            }

            if (eventType === "error") {
              setError(data.message ?? "Streaming error occurred.");
            }
          } catch (parseErr) {
            console.warn("Failed to parse SSE data:", dataStr, parseErr);
          }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Reroll failed.");
      setActiveChat((current) => {
        if (!current) return current;
        return {
          ...current,
          messages: current.messages.filter((m) => !m.id.startsWith("temp-")),
        };
      });
    } finally {
      setSending(false);
    }
  }

  const previewUrl = previewAttachment
    ? `/api/uploads/${encodeURIComponent(previewAttachment.id)}`
    : null;

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
    <div className="relative flex h-screen bg-[radial-gradient(circle_at_20%_20%,rgba(13,148,136,0.18),transparent_35%),radial-gradient(circle_at_85%_5%,rgba(251,146,60,0.2),transparent_30%),linear-gradient(135deg,#0f172a,#111827_45%,#020617)] p-3 md:p-5">
      {dropOverlayActive && (
        <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center bg-slate-950/60 backdrop-blur-sm">
          <div className="flex items-center gap-2 rounded-full border border-teal-300/80 bg-teal-300/10 px-5 py-3 text-sm font-medium text-teal-100 animate-drop-glow">
            <Upload className="h-4 w-4" />
            Drop files anywhere to attach
          </div>
        </div>
      )}

      <div className={cn(
        "grid h-full w-full grid-cols-1 overflow-hidden rounded-3xl border border-white/10 bg-slate-950/60 shadow-[0_30px_80px_rgba(2,6,23,.5)] backdrop-blur",
        agent.isAgentMode && agent.sidebarOpen ? "xl:grid-cols-[320px_1fr_360px]" : "xl:grid-cols-[320px_1fr]"
      )}>
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
              <div
                key={chat.id}
                role="button"
                tabIndex={0}
                onClick={() => openChat(chat.id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    openChat(chat.id);
                  }
                }}
                className={cn(
                  "group w-full rounded-2xl border px-3 py-2 text-left transition cursor-pointer",
                  activeChat?.id === chat.id
                    ? "border-teal-300/60 bg-teal-400/20"
                    : "border-white/10 bg-white/5 hover:bg-white/10",
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <div key={`${chat.id}-${chat.title}`} className="line-clamp-1 text-sm font-medium text-white animated-title">{chat.title}</div>
                  <button
                    type="button"
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
              </div>
            ))}
          </div>
        </aside>

        <main className="flex min-h-0 flex-col">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative">
                <button
                  type="button"
                  onClick={() => {
                    setModelDropdownOpen((prev) => !prev);
                    if (!modelDropdownOpen) {
                      setModelSearch("");
                      setTimeout(() => modelSearchRef.current?.focus(), 0);
                    }
                  }}
                  className="min-w-[240px] rounded-xl border border-white/15 bg-slate-900 px-3 py-2 text-sm text-left text-slate-100 outline-none ring-teal-300/40 focus:ring truncate"
                >
                  <span className="font-mono text-xs">{activeModelDisplay ?? "Select model"}</span>
                </button>

                {modelDropdownOpen && (
                  <div className="absolute z-50 mt-1 w-[calc(100%+2px)] rounded-xl border border-white/10 bg-slate-900 shadow-2xl">
                    <input
                      ref={modelSearchRef}
                      type="text"
                      value={modelSearch}
                      onChange={(event) => setModelSearch(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") {
                          setModelDropdownOpen(false);
                        }
                      }}
                      className="w-full border-b border-white/10 bg-transparent px-3 py-2 text-sm text-white outline-none placeholder:text-slate-500"
                      placeholder="Search models..."
                    />
                    <div className="max-h-[280px] overflow-y-auto p-1">
                      {displayModels.map((model) => (
                        <button
                          key={model.id}
                          type="button"
                          onClick={() => {
                            void updateChat({ model: model.id });
                            setModelDropdownOpen(false);
                            setModelSearch("");
                          }}
                          className={cn(
                            "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left transition",
                            activeChat?.model === model.id
                              ? "bg-teal-400/20 text-teal-100"
                              : "text-slate-300 hover:bg-white/10",
                          )}
                        >
                          <div className="min-w-0 flex-1">
                            <div className="truncate font-mono text-xs text-white">
                              {model.name || model.id}
                            </div>
                            <div className="truncate text-[11px] text-slate-400">
                              {model.displayName}
                            </div>
                          </div>
                          {activeChat?.model === model.id && (
                            <span className="text-[10px] font-semibold text-teal-300">ACTIVE</span>
                          )}
                        </button>
                      ))}
                      {displayModels.length === 0 && (
                        <div className="px-3 py-4 text-center text-xs text-slate-500">
                          No models found
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>

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

              <AgentModeToggle
                isOn={agent.isAgentMode}
                isInitializing={agent.isInitializing}
                onToggle={() => void agent.toggleAgentMode()}
              />
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

          <AgentProgressBar visible={agent.isAgentMode && agent.isExecuting} />

          <div className="flex min-h-0 flex-1 flex-col px-4 py-3">
            <div className="flex-1 space-y-3 overflow-y-auto">
              {activeChat?.messages.map((message, index) => (
                <MessageBubble
                  key={message.id}
                  message={message}
                  prettyDate={prettyDate}
                  onAttachmentPreview={openAttachmentPreview}
                  isNewest={index === activeChat.messages.length - 1}
                  activeModelContextLength={activeModelInfo?.contextLength}
                  onReroll={message.role === "assistant" && !message._isStreaming ? () => handleReroll(index) : undefined}
                />
              ))}
              <div ref={bottomRef} />
            </div>

            <div
              className={cn(
                "relative mt-3 rounded-2xl border bg-slate-900/70 p-2 transition-all duration-300",
                "border-white/15",
              )}
            >
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept="image/*,.pdf,.docx,.odt,.odp,.pptx,.txt,.md,.csv,.json,.xml,.rtf"
                className="hidden"
                onChange={(event) => {
                  const files = Array.from(event.target.files ?? []);
                  if (files.length > 0) {
                    void uploadFiles(files);
                  }
                }}
              />

              {pendingAttachments.length > 0 && (
                <div className="mb-2 flex flex-wrap gap-2 px-2 pt-1">
                  {pendingAttachments.map((attachment) => {
                    const Icon =
                      attachment.kind === "image"
                        ? FileImage
                        : attachment.kind === "pdf"
                          ? FileText
                          : File;

                    return (
                      <div
                        key={attachment.id}
                        className="group inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/8 px-3 py-1 text-xs text-slate-100 animate-chip-in"
                      >
                        <Icon className="h-3.5 w-3.5 text-teal-200" />
                        <span className="max-w-[200px] truncate" title={attachment.fileName}>
                          {attachment.fileName}
                        </span>
                        <span className="text-slate-400">{formatBytes(attachment.size)}</span>
                        <button
                          type="button"
                          onClick={() => removeAttachment(attachment.id)}
                          className="rounded-full p-0.5 text-slate-400 transition hover:bg-white/10 hover:text-white"
                          aria-label={`Remove ${attachment.fileName}`}
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}

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
                placeholder={
                  agent.isAgentMode
                    ? "Ask the agent to create documents, analyze files, write code, search the web..."
                    : "Ask anything, or drop images/docs/PDFs here. Enter sends, Shift+Enter newline."
                }
                className="w-full resize-none bg-transparent px-2 py-1 text-sm text-slate-100 outline-none"
              />
              <div className="flex flex-wrap items-center justify-between gap-2 px-2 pb-1 pt-2">
                <div className="flex items-center gap-2 text-xs text-slate-400">
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploadingAttachments || pendingAttachments.length >= 8}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-white/5 px-2 py-1 text-slate-200 transition hover:bg-white/10 disabled:opacity-50"
                  >
                    {uploadingAttachments ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Paperclip className="h-3.5 w-3.5" />
                    )}
                    Attach
                  </button>
                  <span>
                    {agent.isAgentMode ? "Agent mode active" : "Tools enabled"} • 30-day encrypted files • {activeChat?.webSearchEnabled ? "Web search on" : "Web search off"}
                  </span>
                </div>
                <button
                  onClick={() => void sendMessage()}
                  disabled={sending || (!messageInput.trim() && pendingAttachments.length === 0)}
                  className="inline-flex items-center gap-2 rounded-xl bg-teal-400 px-3 py-2 text-sm font-semibold text-slate-900 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : agent.isAgentMode ? <Bot className="h-4 w-4" /> : <CornerDownLeft className="h-4 w-4" />}
                  {agent.isAgentMode ? "Run Agent" : "Send"}
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

        {agent.isAgentMode && agent.agentSession && (
          <AgentSidebar
            open={agent.sidebarOpen}
            onClose={agent.closeSidebar}
            activeTab={agent.activeTab}
            onSetTab={agent.setActiveTab}
            sessionId={agent.agentSession.id}
            terminalEntries={agent.terminalEntries}
            isExecuting={agent.isExecuting}
            artifacts={agent.artifacts}
            onClearTerminal={agent.clearTerminal}
          />
        )}
      </div>

      {previewAttachment && previewUrl && (
        <div
          className="absolute inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur"
          onClick={closeAttachmentPreview}
          role="dialog"
          aria-modal="true"
          aria-label="Attachment preview"
        >
          <div
            className="max-h-[92vh] w-full max-w-5xl overflow-hidden rounded-2xl border border-white/15 bg-slate-900/95"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-slate-100">{previewAttachment.fileName}</div>
                <div className="text-xs text-slate-400">{previewAttachment.mimeType} • {formatBytes(previewAttachment.size)}</div>
              </div>
              <button
                type="button"
                onClick={closeAttachmentPreview}
                className="rounded-lg border border-white/10 bg-white/5 p-1.5 text-slate-300 transition hover:bg-white/10 hover:text-white"
                aria-label="Close preview"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="max-h-[calc(92vh-64px)] overflow-auto bg-slate-950 p-3">
              {previewAttachment.kind === "image" ? (
                <img
                  src={previewUrl}
                  alt={previewAttachment.fileName}
                  className="mx-auto max-h-[calc(92vh-96px)] w-auto max-w-full rounded-lg"
                />
              ) : previewAttachment.kind === "pdf" ? (
                <iframe
                  src={previewUrl}
                  className="h-[78vh] w-full rounded-lg border border-white/10 bg-white"
                  title={previewAttachment.fileName}
                />
              ) : (
                <div className="flex min-h-[240px] flex-col items-center justify-center gap-3 text-center">
                  <File className="h-10 w-10 text-teal-200" />
                  <p className="max-w-lg text-sm text-slate-300">
                    This file type cannot be previewed inline. Open it in a new tab.
                  </p>
                  <a
                    href={previewUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center rounded-lg border border-teal-300/60 bg-teal-300/10 px-3 py-2 text-sm font-medium text-teal-100 transition hover:bg-teal-300/20"
                  >
                    Open file
                  </a>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
