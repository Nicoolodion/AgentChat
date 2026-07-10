"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import type { Pluggable } from "unified";
import {
  Bot,
  Brain,
  CornerDownLeft,
  Download,
  File,
  FileImage,
  FileText,
  Globe,
  KeyRound,
  Loader2,
  Lock,
  LogOut,
  MessageSquarePlus,
  Paperclip,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  Upload,
  X,
  ChevronRight,
  Zap,
  Activity,
  Menu,
  Square,
} from "lucide-react";
import { useRouter, usePathname } from "next/navigation";

import {
  AgentModeToggle,
  AgentProgressBar,
  AgentSidebar,
  useAgent,
} from "@/components/agent";

import type {
  ChatDetail,
  ChatListItem,
  ChatMessage,
  MessageAttachmentRef,
  ModelInfo,
  ModelSource,
  ReasoningEffort,
  UploadedAttachment,
} from "@/lib/chat-types";
import { NEW_CHAT_ID, decodeUserAttachmentsPayload } from "@/lib/chat-types";
import { cn } from "@/lib/ui";
import { useChatStream } from "./chat/useChatStream";
import { formatTokensPerSecond, formatTTFT, MessageTimeline } from "./chat/MessageTimeline";

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
      "X-Requested-With": "ChatInterface",
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
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatPrice(perMillion?: number): string {
  if (perMillion === undefined || perMillion === null) return "";
  if (perMillion === 0) return "free";
  return `$${perMillion}`;
}

function formatContext(length?: number): string {
  if (!length) return "";
  if (length >= 1_000_000) return `${(length / 1_000_000).toFixed(length % 1_000_000 === 0 ? 0 : 1)}M`;
  return `${Math.round(length / 1000)}k`;
}

// ── User message bubble (unchanged) ───────────────────────────────────────────

// remarkBreaks preserves single newlines typed in the composer as <br> so
// multi-line prompts aren't collapsed by CommonMark's soft-wrap rule.
const REMARK_PLUGINS_USER: Pluggable[] = [remarkGfm, remarkBreaks];

function UserBubble({
  message,
  onAttachmentPreview,
  prettyDate,
  onEdit,
}: {
  message: ChatMessage;
  onAttachmentPreview: (a: MessageAttachmentRef) => void;
  prettyDate: (iso: string) => string;
  onEdit: () => void;
}) {
  const attachments = decodeUserAttachmentsPayload(message.toolPayload);
  const displayContent =
    attachments.length > 0
      ? message.content.replace(/\n\nAttached files:[\s\S]*$/, "").trimEnd()
      : message.content;

  return (
    <div className="ml-auto max-w-[85%] rounded-2xl border border-teal-300/40 bg-teal-400/15 px-4 py-3">
      <div className="mb-1 flex items-center gap-2 text-xs uppercase tracking-wide text-slate-300">
        <Sparkles className="h-3.5 w-3.5" />
        you
        <span className="text-slate-500">{prettyDate(message.createdAt)}</span>
        <button
          type="button"
          onClick={onEdit}
          className="ml-auto rounded px-1.5 py-0.5 text-[10px] text-slate-400 transition hover:bg-white/10 hover:text-white"
        >
          Edit
        </button>
      </div>
      {attachments.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {attachments.map((a) => {
            const isImage = a.kind === "image";
            const Icon = isImage ? FileImage : FileText;
            return (
              <button
                key={a.id}
                onClick={() => onAttachmentPreview(a)}
                className="group flex items-center gap-2 overflow-hidden rounded-xl border border-white/15 bg-white/5 px-3 py-1.5 text-left transition hover:border-teal-300/50 hover:bg-white/10"
              >
                <Icon className="h-4 w-4 text-teal-200" />
                <div className="min-w-0">
                  <div className="truncate text-xs font-medium text-slate-100" title={a.fileName}>
                    {a.fileName}
                  </div>
                  <div className="text-[10px] text-slate-400">{formatBytes(a.size)}</div>
                </div>
              </button>
            );
          })}
        </div>
      )}
      {displayContent && (
        <div className="max-w-none text-slate-100">
          <ReactMarkdown
            remarkPlugins={REMARK_PLUGINS_USER}
            components={{
              p: ({ children }) => <p className="mb-1.5 text-sm leading-relaxed last:mb-0">{children}</p>,
              ul: ({ children }) => <ul className="mb-1.5 ml-4 list-disc text-sm last:mb-0">{children}</ul>,
              ol: ({ children }) => <ol className="mb-1.5 ml-4 list-decimal text-sm last:mb-0">{children}</ol>,
              li: ({ children }) => <li className="mb-0.5 leading-relaxed">{children}</li>,
              a: ({ href, children }) => (
                <a href={href} target="_blank" rel="noopener noreferrer" className="text-teal-200 underline underline-offset-2 hover:text-teal-100">
                  {children}
                </a>
              ),
              blockquote: ({ children }) => (
                <blockquote className="mb-1.5 border-l-2 border-teal-300/40 pl-2 italic text-slate-200">{children}</blockquote>
              ),
              hr: () => <hr className="my-2 border-white/10" />,
              pre: ({ children }) => (
                <pre className="my-1.5 overflow-x-auto rounded-lg border border-white/10 bg-slate-900/80 p-2 text-[12px] leading-relaxed text-slate-100">
                  {children}
                </pre>
              ),
              code: ({ className, children }) => {
                const isBlock = className?.includes("language-");
                if (isBlock) return <>{children}</>;
                return (
                  <code className="rounded bg-white/10 px-1 py-0.5 font-mono text-[12px] text-slate-100">
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
    </div>
  );
}

// ── Assistant message bubble with timeline ───────────────────────────────────

function AssistantBubble({
  message,
  toolOutputs,
  toolArguments,
  prettyDate,
  isNewest,
  onReroll,
  onContinue,
  activeModelContextLength,
}: {
  message: ChatMessage;
  toolOutputs: { toolCallId: string; output: string; timestamp?: number }[];
  toolArguments: Record<string, Record<string, unknown>>;
  prettyDate: (iso: string) => string;
  isNewest: boolean;
  onReroll?: () => void;
  onContinue?: () => void;
  activeModelContextLength?: number;
}) {
  const isStreaming = !!message._isStreaming;
  const isEmpty = !message.content && !message.reasoning && !message.toolCalls?.length;

  return (
    <div className="max-w-[92%] rounded-2xl border border-white/15 bg-white/5 px-4 py-3">
      <div className="mb-2 flex items-center gap-2 text-xs uppercase tracking-wide text-slate-300">
        <Bot className="h-3.5 w-3.5" />
        assistant
        <span className="text-slate-500">{prettyDate(message.createdAt)}</span>
        {message.ttftMs && (
          <span className="flex items-center gap-1 text-[10px] font-medium text-emerald-300">
            <Zap className="h-3 w-3" />
            {formatTTFT(message.ttftMs)} TTFT
          </span>
        )}
        {message.avgTokensPerSecond && (
          <span className="flex items-center gap-1 text-[10px] font-medium text-amber-300">
            <Activity className="h-3 w-3" />
            {formatTokensPerSecond(message.avgTokensPerSecond)}
          </span>
        )}
        {message.providerModel && (
          <span className="ml-auto font-mono text-[10px] text-slate-500">{message.providerModel}</span>
        )}
      </div>

      {isEmpty && isStreaming ? (
        <div className="flex items-center gap-1.5 py-2 text-slate-400">
          <div className="h-1.5 w-1.5 animate-bounce rounded-full bg-teal-300" style={{ animationDelay: "0ms" }} />
          <div className="h-1.5 w-1.5 animate-bounce rounded-full bg-teal-300" style={{ animationDelay: "150ms" }} />
          <div className="h-1.5 w-1.5 animate-bounce rounded-full bg-teal-300" style={{ animationDelay: "300ms" }} />
          <span className="ml-2 text-xs">Thinking…</span>
        </div>
      ) : (
        <MessageTimeline message={message} toolOutputs={toolOutputs} toolArguments={toolArguments} isStreaming={isStreaming} />
      )}

      {(() => {
        const p = message.usagePromptTokens ?? 0;
        const c = message.usageCompletionTokens ?? 0;
        const total = message.usageTotalTokens ?? p + c;
        const cached = message.usageCachedTokens;
        const energy = message.energyJoules;
        const dur = message.energyDurationSeconds;
        if (!p && !c && !energy) return null;
        return (
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-slate-500">
            <span>
              prompt {p} / completion {c}
              {cached ? ` / cached ${cached}` : ""}
            </span>
            {total > 0 && <span className="font-mono">{total} total</span>}
            {isNewest && activeModelContextLength && (
              <span className="font-mono">
                {total} / {Math.round(activeModelContextLength / 1000)}k context
              </span>
            )}
            {energy != null && (
              <span title="Provider-reported energy for this response">
                {energy >= 1 ? `${energy.toFixed(1)} J` : `${(energy * 1000).toFixed(1)} mJ`}
                {dur != null ? ` · ${(dur * 1000).toFixed(0)} ms` : ""}
              </span>
            )}
          </div>
        );
      })()}

      {!isStreaming && (onReroll || (message._truncated && onContinue)) && (
        <div className="mt-2 flex items-center justify-end gap-2">
          {message._truncated && onContinue && (
            <button
              type="button"
              onClick={onContinue}
              className="inline-flex items-center gap-1.5 rounded-lg border border-teal-300/30 bg-teal-400/10 px-2.5 py-1 text-[11px] text-teal-100 transition hover:bg-teal-400/20 hover:text-white"
              title="Continue generating (output was truncated)"
            >
              <RefreshCw className="h-3 w-3" />
              Continue
            </button>
          )}
          {onReroll && (
            <button
              type="button"
              onClick={onReroll}
              className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] text-slate-300 transition hover:bg-white/10 hover:text-white"
              title="Regenerate response"
            >
              <RefreshCw className="h-3 w-3" />
              Reroll
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main app shell ───────────────────────────────────────────────────────────

export function ChatApp({ initialChatId }: { initialChatId: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const dragCounterRef = useRef(0);

  const [me, setMe] = useState<MePayload | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  // The server-normalized configured DEFAULT_MODEL, used as the preselected
  // model for new chats instead of blindly taking models[0] (which, with only a
  // Neuralwatt key, used to be a non-routable bare NanoGPT placeholder).
  const [defaultModelId, setDefaultModelId] = useState<string>("");
  const [chats, setChats] = useState<ChatListItem[]>([]);
  const [activeChat, setActiveChat] = useState<ChatDetail | null>(null);
  const [messageInput, setMessageInput] = useState("");
  const [loading, setLoading] = useState(true);
  const [pendingAttachments, setPendingAttachments] = useState<UploadedAttachment[]>([]);
  const [uploadingAttachments, setUploadingAttachments] = useState(false);
  const [dropOverlayActive, setDropOverlayActive] = useState(false);
  const [previewAttachment, setPreviewAttachment] = useState<MessageAttachmentRef | null>(null);
  const [agentFilePreview, setAgentFilePreview] = useState<{
    path: string; name: string; mimeType: string;
  } | null>(null);
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const [modelSearch, setModelSearch] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [reasoningEffort, setReasoningEffort] = useState<"none" | ReasoningEffort>("none");
  // Inline chat rename: editingChatId holds the chat being renamed; renameDraft
  // is the live text. Enter/blur commits, Escape cancels.
  const [editingChatId, setEditingChatId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  // Active agent runs in OTHER chats (so the sidebar can badge them). Polled
  // every few seconds while the tab is visible.
  const [activeRunChats, setActiveRunChats] = useState<Record<string, { title: string; status: string }>>({});
  // Ref mirror so the polling effect (mounted once) can read the latest value
  // without re-subscribing on every change and stacking intervals.
  const activeRunChatsRef = useRef<Record<string, { title: string; status: string }>>({});

  const modelDropdownRef = useRef<HTMLDivElement | null>(null);
  const modelSearchRef = useRef<HTMLInputElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  // "Stick to bottom" — when true, new content auto-scrolls the view to the
  // bottom. Flipped to false the moment the user scrolls up away from the
  // bottom, and re-enabled once they scroll all the way back down. This stops
  // the chat from fighting the user while they read history, but keeps
  // streaming output pinned to the bottom the rest of the time.
  const stickToBottomRef = useRef(true);

  // The transient "new chat" is not persisted until the first message is sent,
  // so it never appears in /api/chats output. We track whether we are currently
  // showing it from a fresh route entry (vs. a client-side swap we initiated
  // ourselves) to drive the initial sync.
  // Guards the popstate handler from re-triggering our own navigations and
  // from running before boot is ready.
  const interactiveRef = useRef(false);

  const agent = useAgent(activeChat?.id);

  // A new chat is always shown with web search on when the agent is enabled —
  // the agent already has web_search / web_fetch as tools, so the toggle is
  // redundant in agent mode. `webSearchEnabled` stays false on the DB until the
  // chat is actually persisted.
  const webSearchActive = agent.isAgentMode ? true : (activeChat?.webSearchEnabled ?? false);

  // Stream hook
  const stream = useChatStream({
    chat: activeChat ?? { id: "", messages: [] } as unknown as ChatDetail,
    agentEnabled: agent.isAgentMode,
    onTitleUpdate: (title) => {
      setActiveChat((c) => (c ? { ...c, title } : c));
      setChats((prev) =>
        prev.map((c) => (activeChat && c.id === activeChat.id ? { ...c, title, updatedAt: new Date().toISOString() } : c)),
      );
    },
    onChatsRefresh: async () => {
      const { chats: chatRows } = await apiFetch<{ chats: ChatListItem[] }>("/api/chats");
      setChats(chatRows);
    },
    onSseEvent: (event, data) => {
      // Forward every agent-relevant event to the sidebar terminal so the
      // operator sees tool calls appear the moment they happen.
      if (!agent.isAgentMode) return;
      const forwarded = forwardAgentEvent(event, data);
      if (forwarded) agent.processSseEvent(forwarded.event, forwarded.data);
    },
  });

  // ── URL helpers ────────────────────────────────────────────────────────
  // Chat switches stay in-memory (instant) while the address bar is kept in
  // sync via the History API. The server-rendered `/chat/[chatId]` route is
  // only used for deep links / refreshes / new tabs.
  function chatIdFromPath(path: string | null): string | null {
    if (!path) return null;
    const m = path.match(/^\/chat\/([^/]+)$/);
    return m ? decodeURIComponent(m[1]!) : null;
  }

  function pushChatUrl(chatId: string, opts?: { replace?: boolean }) {
    if (typeof window === "undefined") return;
    const url = `/chat/${chatId}`;
    const current = window.location.pathname;
    if (current === url) return;
    try {
      if (opts?.replace) window.history.replaceState({ chatId }, "", url);
      else window.history.pushState({ chatId }, "", url);
    } catch {
      // Some environments (e.g. privacy mode) throw on history writes.
    }
  }

  // Boot: load identity + model list + chat list, then resolve whatever chat the
  // URL points at (a real id, or the "new-chat" sentinel for a fresh chat).
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
        const [{ models: modelRows, defaultModel: serverDefaultModel }, { chats: chatRows }] = await Promise.all([
          apiFetch<{ models: ModelInfo[]; defaultModel?: string }>("/api/models"),
          apiFetch<{ chats: ChatListItem[] }>("/api/chats"),
        ]);
        setModels(modelRows);
        if (serverDefaultModel) setDefaultModelId(serverDefaultModel);
        setChats(chatRows);

        const pickDefault = serverDefaultModel || modelRows[0]?.id || "";
        const targetId = chatIdFromPath(pathname) ?? initialChatId;
        if (targetId && targetId !== NEW_CHAT_ID) {
          const ok = await openChat(targetId, { skipHistory: true });
          if (!ok) {
            // Unknown chat id — fall back to a fresh new chat.
            startNewChat(pickDefault, { skipHistory: true, replace: true });
          }
        } else {
          startNewChat(pickDefault, { skipHistory: true, replace: true });
        }
        interactiveRef.current = true;
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    };
    void boot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // React to browser back/forward between chats (deep-link navigation that we
  // did not initiate via pushState). Our own navigations set state and update
  // activeChat directly, so this only fires for genuine history traversals.
  useEffect(() => {
    function onPop() {
      if (!interactiveRef.current) return;
      const id = chatIdFromPath(window.location.pathname);
      if (!id) return;
      if (id === NEW_CHAT_ID) {
        startNewChat(undefined, { skipHistory: true });
      } else {
        void openChat(id, { skipHistory: true });
      }
    }
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Poll for actively-running agent sessions across all of the user's chats so
  // the sidebar can badge chats that are still executing (e.g. in another tab).
  // Paused while the tab is hidden, and backs off to a slow cadence when there
  // are no active runs (instead of hammering the endpoint at a fixed 5s forever).
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    async function pollActiveRuns() {
      if (typeof document !== "undefined" && document.hidden) return;
      try {
        const data = await apiFetch<{ sessions: Array<{ chatId: string; title: string; status: string }> }>(
          "/api/agent/sessions?active=true",
        );
        if (cancelled) return;
        const map: Record<string, { title: string; status: string }> = {};
        for (const s of data.sessions ?? []) map[s.chatId] = { title: s.title, status: s.status };
        activeRunChatsRef.current = map;
        setActiveRunChats(map);
      } catch {
        // ignore — best-effort indicator
      }
    }
    function scheduleNext() {
      if (cancelled) return;
      // Fast while there are active runs to watch; idle otherwise.
      const hasActive = Object.keys(activeRunChatsRef.current).length > 0;
      const delay = hasActive ? 4000 : 30000;
      timer = setTimeout(async () => {
        await pollActiveRuns();
        scheduleNext();
      }, delay);
    }
    void pollActiveRuns();
    scheduleNext();
    const onVis = () => { if (!document.hidden) { void pollActiveRuns(); } };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  // The number of OTHER chats (not the one currently open) with active runs —
  // drives the summary chip at the top of the sidebar.
  const otherActiveRunCount = useMemo(
    () => Object.keys(activeRunChats).filter((id) => id !== activeChat?.id).length,
    [activeRunChats, activeChat?.id],
  );

  // Auto-scroll: keep the view pinned to the bottom while streaming, but only
  // while the user is "stuck" to the bottom. Manual scrolling up pauses
  // auto-scroll; scrolling back to the very bottom re-enables it.
  const isNearBottom = useCallback((threshold = 80) => {
    const el = scrollContainerRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    const el = scrollContainerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);

  // A signature that changes on every visible update: a new message, more
  // streamed tokens, new reasoning, new tool calls, or new tool output. Using
  // this (rather than just `messages.length`) is what makes the view track the
  // stream token-by-token instead of catching up only when a message is added.
  const streamProgressKey = useMemo(() => {
    const last = stream.messages[stream.messages.length - 1];
    const lastSig = last
      ? `${last.content?.length ?? 0}|${last.reasoning?.length ?? 0}|${last.toolCalls?.length ?? 0}|${last.contentSegments?.length ?? 0}|${last.reasoningSegments?.length ?? 0}`
      : "";
    let toolOutLen = 0;
    let toolOutChars = 0;
    for (const list of Object.values(stream.toolOutputs)) {
      toolOutLen += list.length;
      for (const o of list) toolOutChars += o.output?.length ?? 0;
    }
    return `${stream.messages.length}|${toolOutLen}|${toolOutChars}|${lastSig}`;
  }, [stream.messages, stream.toolOutputs]);

  useEffect(() => {
    if (!stickToBottomRef.current) return;
    // rAF so layout from the new content has settled before we measure height.
    const raf = requestAnimationFrame(() => scrollToBottom("auto"));
    return () => cancelAnimationFrame(raf);
  }, [streamProgressKey, scrollToBottom]);

  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const nearBottom = isNearBottom();
    stickToBottomRef.current = nearBottom;
    setShowScrollBtn(!nearBottom);
  }, [isNearBottom]);

  // Jump to the bottom (instant) whenever a different chat is opened so the
  // latest message is in view, then re-enable stick-to-bottom.
  useEffect(() => {
    stickToBottomRef.current = true;
    const raf = requestAnimationFrame(() => {
      setShowScrollBtn(false);
      scrollToBottom("auto");
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeChat?.id]);

  const activeModelInfo = useMemo(() => {
    if (!activeChat) return null;
    return models.find((m) => m.id === activeChat.model) ?? null;
  }, [activeChat, models]);
  const activeModelDisplay = activeModelInfo?.name ?? activeModelInfo?.displayName ?? activeChat?.model;

  useEffect(() => {
    if (modelDropdownOpen) {
      setTimeout(() => modelSearchRef.current?.focus(), 0);
    }
  }, [modelDropdownOpen]);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (modelDropdownOpen && modelDropdownRef.current && !modelDropdownRef.current.contains(e.target as Node)) {
        setModelDropdownOpen(false);
      }
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [modelDropdownOpen]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.ctrlKey && e.key === "n" && !e.shiftKey) {
        e.preventDefault();
        startNewChat(activeChat?.model ?? (defaultModelId || models[0]?.id));
      }
      if (e.ctrlKey && e.shiftKey && (e.key === "N" || e.key === "n")) {
        e.preventDefault();
        document.querySelector<HTMLTextAreaElement>("textarea")?.focus();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeChat, models, defaultModelId]);

  // Keep web search in sync with the agent toggle: enabling the agent forces
  // web search on (the agent already has web tools). Only persisted for chats
  // that aren't mode-locked yet (i.e. before the first message) to avoid a
  // write on every loaded agent chat.
  useEffect(() => {
    if (!activeChat) return;
    if (!agent.isAgentMode) return;
    if (activeChat.webSearchEnabled) return;
    if (activeChat.agentModeLocked !== null && activeChat.id !== NEW_CHAT_ID) return;
    void updateChat({ webSearchEnabled: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.isAgentMode, activeChat?.id, activeChat?.webSearchEnabled, activeChat?.agentModeLocked]);

  const displayModels = useMemo(() => {
    const q = modelSearch.trim().toLowerCase();
    if (!q) return models;
    return models.filter(
      (m) => m.id.toLowerCase().includes(q) || m.displayName.toLowerCase().includes(q),
    );
  }, [modelSearch, models]);

  // Group models into provider sections (NanoGPT / Neuralwatt) preserving order.
  const groupedModels = useMemo(() => {
    const order: ModelSource[] = ["neuralwatt", "nanogpt"];
    const sections = new Map<ModelSource, ModelInfo[]>();
    for (const m of displayModels) {
      const key: ModelSource = m.source ?? "nanogpt";
      const list = sections.get(key) ?? [];
      list.push(m);
      sections.set(key, list);
    }
    return order
      .filter((src) => sections.has(src))
      .map((src) => ({
        source: src,
        label: src === "neuralwatt" ? "Neuralwatt" : "NanoGPT",
        models: sections.get(src)!,
      }))
      .concat(
        [...sections.keys()]
          .filter((k) => k !== "neuralwatt" && k !== "nanogpt")
          .map((k) => ({ source: k, label: k, models: sections.get(k)! })),
      );
  }, [displayModels]);

  // ── Chat CRUD (URL-driven) ───────────────────────────────────────────────
  // The active chat is the single source of truth in memory; the address bar
  // is mirrored via the History API so deep links and browser tabs keep
  // working. A "new chat" is transient (id = NEW_CHAT_ID) and is NOT persisted
  // until the first message is sent (see sendMessage).

  function makeTransientChat(modelId?: string): ChatDetail {
    const now = new Date().toISOString();
    return {
      id: NEW_CHAT_ID,
      title: "New chat",
      model: modelId ?? (defaultModelId || models[0]?.id) ?? "",
      webSearchEnabled: false,
      agentModeLocked: null,
      createdAt: now,
      updatedAt: now,
      messages: [],
      agentSession: null,
    };
  }

  function startNewChat(modelId?: string, opts?: { skipHistory?: boolean; replace?: boolean }) {
    const transient = makeTransientChat(modelId);
    // Let the stream hook resync to the (empty) transient messages normally —
    // there is nothing in-flight to preserve here.
    setActiveChat(transient);
    setMessageInput("");
    setPendingAttachments([]);
    if (!opts?.skipHistory) pushChatUrl(NEW_CHAT_ID, { replace: opts?.replace });
  }

  async function reloadChats() {
    const { chats: rows } = await apiFetch<{ chats: ChatListItem[] }>("/api/chats");
    setChats(rows);
    return rows;
  }

  async function openChat(chatId: string, opts?: { skipHistory?: boolean }): Promise<boolean> {
    try {
      const { chat } = await apiFetch<{ chat: ChatDetail }>(`/api/chats/${chatId}`);
      // NOTE: intentionally NOT calling stream.adoptChatId() here — we want the
      // hook's resync effect to fire so the freshly-loaded chat's messages are
      // populated (and any in-flight send from the previous chat is aborted).
      setActiveChat(chat);
      setMessageInput("");
      setPendingAttachments([]);
      void agent.syncChatMode(chat);
      if (!opts?.skipHistory) pushChatUrl(chat.id);
      return true;
    } catch {
      return false;
    }
  }

  async function createChatNow(input: {
    model?: string;
    webSearchEnabled: boolean;
    agentEnabled: boolean;
  }): Promise<ChatListItem> {
    const { chat } = await apiFetch<{ chat: ChatListItem }>("/api/chats", {
      method: "POST",
      body: JSON.stringify({
        model: input.model || undefined,
        webSearchEnabled: input.webSearchEnabled,
      }),
    });
    // Deliberately NOT prepended to the sidebar here: the new chat must only
    // appear once a message has actually been sent. The sidebar is refreshed
    // from the server in sendMessage after the stream finishes, at which
    // point the chat has a message and sorts to the top.
    return chat;
  }

  async function updateChat(payload: Partial<Pick<ChatDetail, "title" | "model" | "webSearchEnabled">>) {
    if (!activeChat || activeChat.id === NEW_CHAT_ID) {
      // Transient chat: keep changes client-side until the chat is persisted.
      setActiveChat((c) => (c ? { ...c, ...payload } : c));
      return;
    }
    const { chat } = await apiFetch<{ chat: ChatDetail }>(`/api/chats/${activeChat.id}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
    setActiveChat(chat);
    setChats((prev) =>
      prev.map((c) => (c.id === chat.id ? { ...c, title: chat.title, model: chat.model, webSearchEnabled: chat.webSearchEnabled } : c)),
    );
  }

  // Commit an inline edit of a sidebar chat title. Patches the chat directly
  // (independent of which chat is active) so renaming works on any chat.
  async function commitRename(chatId: string, newTitle: string) {
    const trimmed = newTitle.trim();
    setEditingChatId(null);
    if (!trimmed) return;
    // Optimistically update the sidebar so the change feels instant; revert via
    // the server response on success.
    setChats((prev) => prev.map((c) => (c.id === chatId ? { ...c, title: trimmed } : c)));
    setActiveChat((c) => (c && c.id === chatId ? { ...c, title: trimmed } : c));
    try {
      const { chat } = await apiFetch<{ chat: ChatDetail }>(`/api/chats/${chatId}`, {
        method: "PATCH",
        body: JSON.stringify({ title: trimmed }),
      });
      setChats((prev) => prev.map((c) => (c.id === chatId ? { ...c, title: chat.title } : c)));
      setActiveChat((c) => (c && c.id === chatId ? { ...c, title: chat.title } : c));
    } catch (err) {
      console.error("Rename failed", err);
    }
  }

  async function deleteChat(chatId: string) {
    await apiFetch(`/api/chats/${chatId}`, { method: "DELETE" });
    const remaining = chats.filter((c) => c.id !== chatId);
    setChats(remaining);
    // Move to the next chat, or fall back to a fresh new chat.
    if (remaining.length && chatId === activeChat?.id) {
      await openChat(remaining[0]!.id);
    } else if (chatId === activeChat?.id) {
      startNewChat(defaultModelId || models[0]?.id);
    }
  }

  // ── Attachments ──────────────────────────────────────────────────────────
  const uploadFiles = useCallback(
    async (files: File[]) => {
      if (!files.length || uploadingAttachments) return;
      setUploadingAttachments(true);
      try {
        const fd = new FormData();
        for (const f of files) fd.append("files", f, f.name);
        const res = await fetch("/api/uploads", { method: "POST", body: fd, headers: { "X-Requested-With": "ChatInterface" } });
        const j = (await res.json().catch(() => ({}))) as { attachments?: UploadedAttachment[]; error?: string };
        if (!res.ok) throw new Error(j.error ?? "Upload failed");
        setPendingAttachments((curr) => [...curr, ...(j.attachments ?? [])].slice(0, 40));
      } catch (err) {
        console.error(err);
      } finally {
        setUploadingAttachments(false);
        if (fileInputRef.current) fileInputRef.current.value = "";
      }
    },
    [uploadingAttachments],
  );

  // Drag and drop
  useEffect(() => {
    function hasFiles(e: DragEvent) {
      const t = e.dataTransfer?.types;
      return Boolean(t && Array.from(t).includes("Files"));
    }
    function onEnter(e: DragEvent) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragCounterRef.current += 1;
      setDropOverlayActive(true);
    }
    function onLeave(e: DragEvent) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
      if (dragCounterRef.current === 0) setDropOverlayActive(false);
    }
    function onOver(e: DragEvent) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    }
    function onDrop(e: DragEvent) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragCounterRef.current = 0;
      setDropOverlayActive(false);
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length) void uploadFiles(files);
    }
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("dragover", onOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("drop", onDrop);
    };
  }, [uploadFiles]);

  // ── Send message ─────────────────────────────────────────────────────────
  async function sendMessage() {
    if (!activeChat || stream.sending) return;
    if (!messageInput.trim() && !pendingAttachments.length) return;

    const atts = [...pendingAttachments];
    const text = messageInput;
    setMessageInput("");
    setPendingAttachments([]);

    const effort = reasoningEffort === "none" ? undefined : reasoningEffort;

    // A transient "new chat" is persisted lazily on the first message: create
    // the DB row now, then stream the message against the fresh id, then adopt
    // that id locally + update the URL so the chat gets a real subpath and
    // appears in the sidebar.
    if (activeChat.id === NEW_CHAT_ID) {
      const usingAgent = agent.isAgentMode;
      try {
        const created = await createChatNow({
          model: activeChat.model || defaultModelId || models[0]?.id,
          // Agent mode always implies web search on (the agent ships web
          // tools). For normal mode, honour the user's toggle from the
          // transient chat.
          webSearchEnabled: usingAgent ? true : (activeChat.webSearchEnabled ?? false),
          agentEnabled: usingAgent,
        });

        // For agent runs, materialize the agent session up front so the
        // sidebar (which needs a session id) is live during the first run.
        if (usingAgent) {
          try {
            const res = await fetch("/api/agent/sessions", {
              method: "POST",
              headers: { "Content-Type": "application/json", "X-Requested-With": "ChatInterface" },
              body: JSON.stringify({ chatId: created.id }),
            });
            const data = (await res.json().catch(() => ({}))) as { session?: { id: string; status: string } };
            if (data.session) void agent.loadSession(data.session.id);
          } catch {
            // The message endpoint will upsert a session as a fallback.
          }
        }

        await stream.send({
          text,
          attachments: atts,
          reasoningEffort: effort,
          chatIdOverride: created.id,
        });

        // Adopt the real id so the resync effect does not wipe the just-streamed
        // messages, then mirror the URL and refresh the sidebar so the chat (now
        // with a message) appears.
        stream.adoptChatId(created.id);
        setActiveChat((c) =>
          c
            ? {
                ...c,
                id: created.id,
                agentModeLocked: usingAgent ? true : c.agentModeLocked,
                webSearchEnabled: usingAgent ? true : (c.webSearchEnabled ?? false),
              }
            : c,
        );
        pushChatUrl(created.id, { replace: true });
        await reloadChats();
      } catch (err) {
        // Restore the composer contents so the user can retry.
        setMessageInput(text);
        setPendingAttachments(atts);
        console.error(err);
      }
      return;
    }

    await stream.send({ text, attachments: atts, reasoningEffort: effort });
  }

  // Continue a truncated assistant message. Streams the model's continuation
  // against the existing conversation and appends to the same persisted
  // message, so the full response stays coherent across both modes.
  async function continueLatest(index: number) {
    if (!activeChat || stream.sending) return;
    const target = stream.messages[index];
    if (!target || target.role !== "assistant") return;
    if (activeChat.id === NEW_CHAT_ID) return;
    await stream.continueGeneration({ messageId: target.id });
  }

  async function reroll(index: number) {
    if (!activeChat || stream.sending) return;
    const target = stream.messages[index];
    if (!target || target.role !== "assistant") return;
    let userIdx = -1;
    for (let i = index - 1; i >= 0; i--) {
      if (stream.messages[i]!.role === "user") {
        userIdx = i;
        break;
      }
    }
    if (userIdx === -1) return;
    const userMsg = stream.messages[userIdx]!;
    const userAtts = decodeUserAttachmentsPayload(userMsg.toolPayload);

    // Remove the assistant message from local state and server
    const newMsgs = stream.messages.filter((_, i) => i !== index);
    stream.reset(newMsgs);
    try {
      await apiFetch(`/api/chats/${activeChat.id}/messages/${target.id}`, { method: "DELETE" });
    } catch {
      // ignore
    }
    await stream.send({
      text: userMsg.content.replace(/\n\nAttached files:[\s\S]*$/, "").trimEnd(),
      reasoningEffort: reasoningEffort === "none" ? undefined : reasoningEffort,
      attachments: userAtts.map((a) => ({
        id: a.id,
        fileName: a.fileName,
        mimeType: a.mimeType,
        size: a.size,
        kind: a.kind,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      })),
    });
  }

  async function logout() {
    await apiFetch("/api/auth/logout", { method: "POST" });
    router.replace("/login");
  }

  function exportChat(format: "json" | "markdown") {
    if (!activeChat) return;
    // The live message list (stream.messages) is always more up-to-date than
    // activeChat.messages — the latter is only refreshed on chat load, so right
    // after a send (before any page refresh) it would still be empty/stale.
    // Merge the live messages + agent session into the exported payload so the
    // JSON reflects the conversation the user actually sees.
    const liveSession =
      agent.agentSession
        ? { id: agent.agentSession.id, status: agent.agentSession.status }
        : activeChat.agentSession;
    const exportPayload = {
      ...activeChat,
      messages: stream.messages,
      agentSession: liveSession,
      artifacts: agent.artifacts,
      updatedAt: new Date().toISOString(),
    };
    let content: string;
    let filename: string;
    if (format === "json") {
      // messages[].toolCalls now carry arguments + output, so the exported
      // JSON is a faithful record of the whole conversation.
      content = JSON.stringify(exportPayload, null, 2);
      filename = `${exportPayload.title.replace(/[^a-zA-Z0-9]/g, "_")}.json`;
    } else {
      const lines = exportPayload.messages.map((m) => {
        const role = m.role === "user" ? "**You**" : m.role === "assistant" ? "**Assistant**" : m.role;
        let body = m.content;
        const toolCalls = m.toolCalls ?? [];
        if (toolCalls.length > 0) {
          const toolBlock = toolCalls
            .map((tc) => {
              const args = tc.arguments ? JSON.stringify(tc.arguments) : "—";
              const status = tc.status === "error" ? " (failed)" : "";
              const header = "- tool `" + tc.toolName + "`" + status + "  args: " + args;
              const out = tc.output ? "\n```\n" + tc.output.slice(0, 2000) + "\n```" : "";
              return header + out;
            })
            .join("\n");
          body = `${m.content}\n\n#### Tool calls\n${toolBlock}`.trim();
        }
        return `${role}:\n${body}`;
      });
      content = `# ${exportPayload.title}\n\n${lines.join("\n\n---\n\n")}`;
      filename = `${exportPayload.title.replace(/[^a-zA-Z0-9]/g, "_")}.md`;
    }
    const blob = new Blob([content], { type: format === "json" ? "application/json" : "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  // Tool outputs (flat list for timeline)
  async function handleEditMessage(msg: ChatMessage) {
    if (!activeChat || stream.sending) return;
    const idx = stream.messages.findIndex((m) => m.id === msg.id);
    if (idx === -1) return;

    // The assistant reply that directly follows the user message (if any)
    const following = stream.messages.slice(idx + 1);
    const assistantReply = following.find((m) => m.role === "assistant");
    const assistantEndIdx = assistantReply
      ? idx + 1 + following.indexOf(assistantReply)
      : -1;

    // Everything from the edited user message up to (and including) its assistant
    // reply is removed so re-sending produces a clean exchange.
    const removeEnd = assistantEndIdx === -1 ? idx : assistantEndIdx;
    const toRemove = stream.messages.slice(idx, removeEnd + 1);
    const removeIds = new Set(toRemove.map((m) => m.id));

    stream.reset(stream.messages.filter((m) => !removeIds.has(m.id)));

    // Populate the composer with the original text so the user can tweak it.
    setMessageInput(msg.content.replace(/\n\nAttached files:[\s\S]*$/, "").trimEnd());

    // Best-effort delete the persisted messages on the server. Optimistic temp
    // ids (e.g. right after sending) can't be resolved here; the done-event
    // sync replaces those with real ids so deletion works on later edits.
    for (const m of toRemove) {
      if (m.id.startsWith("user-temp-") || m.id.startsWith("temp-")) continue;
      try {
        await apiFetch(`/api/chats/${activeChat.id}/messages/${m.id}`, { method: "DELETE" });
      } catch {
        // ignore — local state is already correct
      }
    }

    setTimeout(() => document.querySelector<HTMLTextAreaElement>("textarea")?.focus(), 0);
  }

  const flatToolOutputs = useMemo(
    () => Object.values(stream.toolOutputs).flat(),
    [stream.toolOutputs],
  );

  // The agent sidebar (and the grid column it occupies) only exists once we
  // have an agent session. On a fresh "new chat" with agent mode toggled on
  // there is no session yet (it is created when the first message is sent), so
  // we must not reserve an empty column for it.
  const showAgentSidebar = agent.isAgentMode && !!agent.agentSession;

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="flex items-center gap-3 rounded-full border border-white/20 bg-slate-900/70 px-5 py-3 text-slate-100 shadow-2xl">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading workspace…
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex h-screen bg-[radial-gradient(circle_at_20%_20%,rgba(13,148,136,0.18),transparent_35%),radial-gradient(circle_at_85%_5%,rgba(251,146,60,0.2),transparent_30%),linear-gradient(135deg,#0f172a,#111827_45%,#020617)] p-3 md:p-5">
      {dropOverlayActive && (
        <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center bg-slate-950/60 backdrop-blur-sm">
          <div className="flex items-center gap-2 rounded-full border border-teal-300/80 bg-teal-300/10 px-5 py-3 text-sm font-medium text-teal-100">
            <Upload className="h-4 w-4" /> Drop files anywhere to attach
          </div>
        </div>
      )}

      <div
        className={cn(
          "grid h-full w-full grid-cols-1 overflow-hidden rounded-3xl border border-white/10 bg-slate-950/60 shadow-[0_30px_80px_rgba(2,6,23,.5)] backdrop-blur",
          showAgentSidebar && agent.sidebarOpen ? "xl:grid-cols-[320px_minmax(0,1fr)_360px]" :
            showAgentSidebar ? "xl:grid-cols-[320px_minmax(0,1fr)_48px]" :
              "xl:grid-cols-[320px_minmax(0,1fr)]",
        )}
      >
        {/* ── Left: chat list ─────────────────────────────────────────────── */}
        {mobileSidebarOpen && (
          <div className="fixed inset-0 z-40 bg-slate-950/60 backdrop-blur-sm xl:hidden" onClick={() => setMobileSidebarOpen(false)} />
        )}
        <aside className={cn(
          "border-b border-white/10 p-4 xl:border-b-0 xl:border-r",
          mobileSidebarOpen ? "fixed inset-y-0 left-0 z-50 w-80 bg-slate-950" : "hidden xl:block",
        )}>
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <div className="text-xs uppercase tracking-[0.2em] text-teal-300">Chatinterface</div>
              <div className="text-lg font-semibold text-white">NanoGPT Agent Desk</div>
            </div>
            <div className="flex items-center gap-2">
              <a
                href={`/chat/${NEW_CHAT_ID}`}
                onClick={(e) => {
                  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
                  e.preventDefault();
                  startNewChat(activeChat?.model ?? (defaultModelId || models[0]?.id));
                }}
                className="inline-flex items-center gap-2 rounded-full bg-teal-400 px-3 py-2 text-xs font-semibold text-slate-900 transition hover:bg-teal-300"
              >
                <MessageSquarePlus className="h-4 w-4" />
                New
              </a>
              <button
                onClick={() => setMobileSidebarOpen(false)}
                aria-label="Close sidebar"
                className="xl:hidden rounded-lg border border-white/10 p-1.5 text-slate-300 hover:bg-white/10"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          <div className="mb-4 rounded-2xl border border-white/10 bg-white/5 p-3 text-xs text-slate-300">
            <div className="flex items-center gap-2 text-slate-400">
              <KeyRound className="h-4 w-4" />
              Signed in as {me?.user?.username ?? "anonymous"}
            </div>
          </div>

          {otherActiveRunCount > 0 && (
            <div className="mb-4 flex items-center gap-2 rounded-2xl border border-violet-300/30 bg-violet-400/10 p-3 text-xs text-violet-100">
              <span className="relative flex h-2 w-2 shrink-0">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-violet-400 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-violet-400" />
              </span>
              {otherActiveRunCount} agent {otherActiveRunCount === 1 ? "run" : "runs"} active in other chat{otherActiveRunCount === 1 ? "" : "s"}
            </div>
          )}

          <div className="max-h-[calc(100vh-220px)] space-y-2 overflow-y-auto pr-1">
            {chats.map((c) => (
              <a
                key={c.id}
                href={`/chat/${c.id}`}
                onClick={(e) => {
                  // Let the browser handle modifier/middle clicks (open in new
                  // tab) so users can run several chats concurrently. A plain
                  // left click stays an instant in-memory swap.
                  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
                  e.preventDefault();
                  void openChat(c.id);
                }}
                className={cn(
                  "group block w-full cursor-pointer rounded-2xl border px-3 py-2 text-left transition",
                  activeChat?.id === c.id ? "border-teal-300/60 bg-teal-400/20" : "border-white/10 bg-white/5 hover:bg-white/10",
                )}
              >
                  <div className="flex items-start justify-between gap-2">
                  {editingChatId === c.id ? (
                    <input
                      autoFocus
                      value={renameDraft}
                      onChange={(e) => setRenameDraft(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      onDoubleClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          void commitRename(c.id, renameDraft);
                        } else if (e.key === "Escape") {
                          e.preventDefault();
                          setEditingChatId(null);
                        }
                      }}
                      onBlur={() => void commitRename(c.id, renameDraft)}
                      className="min-w-0 flex-1 rounded border border-teal-300/50 bg-slate-900 px-1.5 py-0.5 text-sm text-white outline-none"
                      aria-label="Rename chat"
                      maxLength={120}
                    />
                  ) : (
                    <div
                      className="line-clamp-1 text-sm font-medium text-white"
                      title="Double-click to rename"
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        e.preventDefault();
                        setRenameDraft(c.title);
                        setEditingChatId(c.id);
                      }}
                    >
                      {c.title}
                    </div>
                  )}
                  {confirmDeleteId === c.id ? (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        void deleteChat(c.id);
                        setConfirmDeleteId(null);
                      }}
                      className="shrink-0 rounded bg-rose-500/80 px-1.5 py-0.5 text-[10px] font-semibold text-white"
                    >
                      Confirm?
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setConfirmDeleteId(c.id);
                        setTimeout(() => setConfirmDeleteId((prev) => prev === c.id ? null : prev), 3000);
                      }}
                      className="opacity-0 transition group-hover:opacity-100"
                      aria-label="Delete chat"
                    >
                      <Trash2 className="h-4 w-4 text-rose-300" />
                    </button>
                  )}
                </div>
                <div className="mt-1 flex items-center gap-2">
                  <div className="line-clamp-2 text-xs text-slate-300">{c.lastMessagePreview}</div>
                  {(stream.sending || agent.isExecuting) && activeChat?.id === c.id && (
                    <span className="relative flex h-2 w-2 shrink-0">
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-teal-400 opacity-75" />
                      <span className="relative inline-flex h-2 w-2 rounded-full bg-teal-400" />
                    </span>
                  )}
                </div>
                <div className="mt-1 flex items-center gap-2 text-[11px] text-slate-400">
                  <span>{prettyDate(c.updatedAt)}</span>
                  {activeRunChats[c.id] && activeChat?.id !== c.id && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-violet-400/15 px-1.5 py-0.5 text-[10px] font-medium text-violet-200" title={`Agent ${activeRunChats[c.id]!.status} in background`}>
                      <span className="relative flex h-1.5 w-1.5">
                        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-violet-400 opacity-75" />
                        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-violet-400" />
                      </span>
                      running
                    </span>
                  )}
                </div>
              </a>
            ))}
          </div>
        </aside>

        {/* ── Center: conversation ───────────────────────────────────────── */}
        <main className="relative flex min-h-0 flex-col">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={() => setMobileSidebarOpen(true)}
                className="inline-flex items-center justify-center rounded-xl border border-white/15 bg-slate-900 p-2 text-slate-200 hover:bg-slate-800 xl:hidden"
              >
                <Menu className="h-4 w-4" />
              </button>
              <div className="relative" ref={modelDropdownRef}>
                <button
                  onClick={() => setModelDropdownOpen((p) => !p)}
                  aria-label="Select model"
                  className="min-w-[240px] truncate rounded-xl border border-white/15 bg-slate-900 px-3 py-2 text-left text-sm text-slate-100 outline-none ring-teal-300/40 focus:ring"
                >
                  <span className="font-mono text-xs">{activeModelDisplay ?? "Select model"}</span>
                </button>
                {modelDropdownOpen && (
                  <div className="absolute z-50 mt-1 w-[calc(100%+2px)] rounded-xl border border-white/10 bg-slate-900 shadow-2xl">
                    <input
                      ref={modelSearchRef}
                      type="text"
                      value={modelSearch}
                      onChange={(e) => setModelSearch(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") setModelDropdownOpen(false);
                      }}
                      className="w-full border-b border-white/10 bg-transparent px-3 py-2 text-sm text-white outline-none placeholder:text-slate-500"
                      placeholder="Search models..."
                    />
                    <div className="max-h-[320px] overflow-y-auto p-1">
                      {groupedModels.map((section) => (
                        <div key={section.source} className="mb-1">
                          <div className="sticky top-0 z-10 flex items-center gap-2 bg-slate-900 px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                            <span
                              className={cn(
                                "h-1.5 w-1.5 rounded-full",
                                section.source === "neuralwatt" ? "bg-emerald-400" : "bg-teal-400",
                              )}
                            />
                            {section.label}
                            <span className="text-slate-600">· {section.models.length}</span>
                          </div>
                          {section.models.map((m) => {
                            const inputHint = m.inputPricePerMillion;
                            const outputHint = m.outputPricePerMillion;
                            return (
                              <button
                                key={m.id}
                                onClick={() => {
                                  void updateChat({ model: m.id });
                                  setModelDropdownOpen(false);
                                  setModelSearch("");
                                }}
                                className={cn(
                                  "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left transition",
                                  activeChat?.model === m.id ? "bg-teal-400/20 text-teal-100" : "text-slate-300 hover:bg-white/10",
                                )}
                              >
                                <div className="min-w-0 flex-1">
                                  <div className="flex items-center gap-1.5">
                                    <span className="truncate font-mono text-xs text-white">{m.name || m.displayName}</span>
                                    {m.supportsVision && <span className="text-[10px]" title="Vision">👁</span>}
                                    {m.supportsTools && <span className="text-[10px]" title="Tool support">🔧</span>}
                                    {m.supportsReasoning && <span className="text-[10px]" title="Reasoning">🧠</span>}
                                    {m.supportsJsonMode && <span className="text-[10px]" title="JSON mode">{"{}"}</span>}
                                    {m.contextLength && (
                                      <span className="text-[10px] text-slate-500" title="Context window">
                                        {formatContext(m.contextLength)}
                                      </span>
                                    )}
                                    {m.maxOutputTokens && (
                                      <span className="text-[10px] text-slate-600" title="Max output tokens">
                                        →{formatContext(m.maxOutputTokens)}
                                      </span>
                                    )}
                                    {m.deprecated && (
                                      <span className="rounded bg-amber-400/20 px-1 text-[9px] font-semibold text-amber-300">
                                        DEPRECATED
                                      </span>
                                    )}
                                  </div>
                                  <div className="flex items-center gap-2 truncate text-[11px] text-slate-400">
                                    <span className="truncate">{m.displayName}</span>
                                    {m.pricingTbd ? (
                                      <span className="shrink-0 text-slate-500">pricing TBD</span>
                                    ) : (inputHint !== undefined || outputHint !== undefined) ? (
                                      <span className="shrink-0 font-mono text-[10px] text-slate-500" title="Per million tokens (in / out)">
                                        {formatPrice(inputHint)} / {formatPrice(outputHint)}
                                      </span>
                                    ) : null}
                                  </div>
                                </div>
                                {activeChat?.model === m.id && (
                                  <span className="text-[10px] font-semibold text-teal-300">ACTIVE</span>
                                )}
                              </button>
                            );
                          })}
                        </div>
                      ))}
                      {groupedModels.length === 0 && (
                        <div className="px-3 py-4 text-center text-xs text-slate-500">No models found</div>
                      )}
                    </div>
                  </div>
                )}
              </div>

              <button
                onClick={() => {
                  // Web search is forced on while the agent is enabled (the
                  // agent already has web_search/web_fetch tools), so it can't
                  // be toggled off in agent mode.
                  if (agent.isAgentMode) return;
                  void updateChat({ webSearchEnabled: !(activeChat?.webSearchEnabled ?? false) });
                }}
                disabled={agent.isAgentMode}
                title={agent.isAgentMode ? "Web search is always available to the agent" : "Toggle web search"}
                className={cn(
                  "inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-sm transition",
                  webSearchActive
                    ? "border-emerald-300/70 bg-emerald-400/20 text-emerald-100"
                    : "border-white/15 bg-slate-900 text-slate-300",
                  agent.isAgentMode && "cursor-not-allowed",
                )}
              >
                {webSearchActive ? <Globe className="h-4 w-4" /> : <Search className="h-4 w-4" />}
                Web Search
                {agent.isAgentMode && <Lock className="h-3 w-3 text-emerald-200/80" />}
              </button>

              {activeModelInfo?.supportsReasoningEffort && (
                <label className="inline-flex items-center gap-1.5 rounded-xl border border-white/15 bg-slate-900 px-3 py-1.5 text-sm text-slate-200" title="Reasoning effort (optional — leave on Auto for the provider's default)">
                  <Brain className="h-3.5 w-3.5 text-violet-300" />
                  <span className="hidden text-xs text-slate-400 sm:inline">Effort</span>
                  <select
                    value={reasoningEffort}
                    onChange={(e) => setReasoningEffort(e.target.value as "none" | ReasoningEffort)}
                    className="cursor-pointer bg-transparent text-sm text-slate-100 outline-none"
                  >
                    <option className="bg-slate-900" value="none">Auto</option>
                    <option className="bg-slate-900" value="low">low</option>
                    <option className="bg-slate-900" value="medium">medium</option>
                    <option className="bg-slate-900" value="high">high</option>
                    <option className="bg-slate-900" value="max">max</option>
                  </select>
                </label>
              )}

              <AgentModeToggle
                isOn={agent.isAgentMode}
                isInitializing={agent.isInitializing}
                locked={agent.modeLocked}
                onToggle={() => void agent.toggleAgentMode()}
              />
            </div>

            <div className="flex items-center gap-2">
              <div className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-slate-300">
                Context: {activeModelInfo?.contextLength ? formatContext(activeModelInfo.contextLength) : "unknown"}
              </div>
              <button
                onClick={() => exportChat("json")}
                className="inline-flex items-center gap-2 rounded-xl border border-white/15 bg-slate-900 px-3 py-2 text-sm text-slate-200 hover:bg-slate-800"
                title="Export chat as JSON"
              >
                <Download className="h-4 w-4" />
              </button>
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
            <div ref={scrollContainerRef} className="relative flex-1 space-y-3 overflow-y-auto" onScroll={handleScroll}>
              {stream.messages.map((m, i) =>
                m.role === "user" ? (
                  <UserBubble
                    key={m.id}
                    message={m}
                    onAttachmentPreview={setPreviewAttachment}
                    prettyDate={prettyDate}
                    onEdit={() => handleEditMessage(m)}
                  />
                ) : m.role === "assistant" ? (
                  <AssistantBubble
                    key={m.id}
                    message={m}
                    toolOutputs={flatToolOutputs}
                    toolArguments={stream.toolArguments}
                    prettyDate={prettyDate}
                    isNewest={i === stream.messages.length - 1}
                    onReroll={!m._isStreaming ? () => void reroll(i) : undefined}
                    onContinue={
                      !m._isStreaming && m._truncated && activeChat && activeChat.id !== NEW_CHAT_ID
                        ? () => void continueLatest(i)
                        : undefined
                    }
                    activeModelContextLength={activeModelInfo?.contextLength}
                  />
                ) : null,
              )}
              <div ref={bottomRef} />
            </div>
            {showScrollBtn && (
              <button
                type="button"
                onClick={() => { stickToBottomRef.current = true; setShowScrollBtn(false); scrollToBottom("smooth"); }}
                className="absolute bottom-20 right-8 z-10 rounded-full border border-white/20 bg-slate-900/90 p-2 text-slate-300 shadow-lg transition hover:bg-slate-800 hover:text-white"
                aria-label="Scroll to bottom"
              >
                <ChevronRight className="h-4 w-4 rotate-90" />
              </button>
            )}

            {/* Composer */}
            <div className="relative mt-3 rounded-2xl border border-white/15 bg-slate-900/70 p-2">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept="image/*,.pdf,.docx,.odt,.odp,.pptx,.txt,.md,.csv,.json,.xml,.rtf"
                className="hidden"
                aria-label="Attach files"
                onChange={(e) => {
                  const files = Array.from(e.target.files ?? []);
                  if (files.length) void uploadFiles(files);
                }}
              />

              {pendingAttachments.length > 0 && (
                <div className="mb-2 flex flex-wrap gap-2 px-2 pt-1">
                  {pendingAttachments.map((a) => {
                    const Icon = a.kind === "image" ? FileImage : a.kind === "pdf" ? FileText : File;
                    return (
                      <div
                        key={a.id}
                        className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/10 px-3 py-1 text-xs text-slate-100"
                      >
                        <Icon className="h-3.5 w-3.5 text-teal-200" />
                        <span className="max-w-[200px] truncate" title={a.fileName}>{a.fileName}</span>
                        <span className="text-slate-400">{formatBytes(a.size)}</span>
                        <button
                          type="button"
                          onClick={() => setPendingAttachments((p) => p.filter((x) => x.id !== a.id))}
                          className="rounded-full p-0.5 text-slate-400 transition hover:bg-white/10 hover:text-white"
                          aria-label={`Remove ${a.fileName}`}
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
                onChange={(e) => setMessageInput(e.target.value)}
                aria-label="Message composer"
                onPaste={(e) => {
                  // Allow pasting images directly into the composer (mirrors the
                  // drag-and-drop path). Text-only pastes fall through to the
                  // default so caret/copy-paste keeps working.
                  const items = e.clipboardData?.items;
                  if (!items) return;
                  const imageFiles: File[] = [];
                  for (const item of Array.from(items)) {
                    if (item.kind === "file" && item.type.startsWith("image/")) {
                      const file = item.getAsFile();
                      if (file) imageFiles.push(file);
                    }
                  }
                  if (imageFiles.length) {
                    e.preventDefault();
                    // Give pasted images a friendly filename when the clipboard
                    // doesn't carry one (common for screenshots). Use window.File so
                    // the lucide `File` icon import doesn't shadow the DOM ctor.
                    const DomFile = window.File;
                    const named = imageFiles.map((f, i) =>
                      f.name && /\.\w{2,5}$/.test(f.name)
                        ? f
                        : new DomFile([f], `pasted-${Date.now()}-${i + 1}.${f.type.split("/")[1] ?? "png"}`, {
                            type: f.type,
                          }),
                    );
                    void uploadFiles(named);
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void sendMessage();
                  }
                }}
                rows={3}
                placeholder={
                  agent.isAgentMode
                    ? "Ask the agent to create documents, analyze files, write code, search the web..."
                    : "Ask anything, or drop/paste images/docs/PDFs here. Enter sends, Shift+Enter newline."
                }
                className="w-full resize-none bg-transparent px-2 py-1 text-sm text-slate-100 outline-none"
              />
              <div className="flex flex-wrap items-center justify-between gap-2 px-2 pb-1 pt-2">
                <div className="flex items-center gap-2 text-xs text-slate-400">
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploadingAttachments || pendingAttachments.length >= 40}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-white/5 px-2 py-1 text-slate-200 transition hover:bg-white/10 disabled:opacity-50"
                  >
                    {uploadingAttachments ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Paperclip className="h-3.5 w-3.5" />}
                    Attach
                  </button>
                  <span>
                    {agent.isAgentMode ? "Agent mode active" : "Tools enabled"} • 30-day encrypted files •{" "}
                    {webSearchActive ? "Web search on" : "Web search off"}
                  </span>
                </div>
                <button
                  onClick={() => {
                    if (agent.isAgentMode && (stream.sending || agent.isExecuting)) {
                      stream.cancel();
                      void agent.stopAgent();
                    } else {
                      void sendMessage();
                    }
                  }}
                  disabled={!stream.sending && !messageInput.trim() && !pendingAttachments.length}
                  className="inline-flex items-center gap-2 rounded-xl bg-teal-400 px-3 py-2 text-sm font-semibold text-slate-900 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {stream.sending || agent.isExecuting ? (
                    agent.isAgentMode ? (
                      <>
                        <Square className="h-3.5 w-3.5 fill-current" />
                        Stop Agent
                      </>
                    ) : (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    )
                  ) : agent.isAgentMode ? (
                    <Bot className="h-4 w-4" />
                  ) : (
                    <CornerDownLeft className="h-4 w-4" />
                  )}
                  {!(stream.sending || agent.isExecuting) && (agent.isAgentMode ? "Run Agent" : "Send")}
                </button>
              </div>
            </div>

            {stream.error && (
              <div className="mt-2 rounded-xl border border-rose-400/40 bg-rose-500/15 px-3 py-2 text-sm text-rose-200">
                {stream.error}
              </div>
            )}
          </div>

          {/* File preview (agent) */}
          {agentFilePreview && agent.agentSession && (
            <FilePreviewDialog
              file={agentFilePreview}
              sessionId={agent.agentSession.id}
              onClose={() => setAgentFilePreview(null)}
            />
          )}
        </main>

        {/* ── Right: agent sidebar ───────────────────────────────────────── */}
        {showAgentSidebar && agent.agentSession && (
          <AgentSidebar
            open={agent.sidebarOpen}
            onToggle={agent.sidebarOpen ? agent.closeSidebar : agent.openSidebar}
            activeTab={agent.activeTab}
            onSetTab={agent.setActiveTab}
            sessionId={agent.agentSession.id}
            isExecuting={agent.isExecuting}
            artifacts={agent.artifacts}
            onPreviewFile={(f) => setAgentFilePreview(f)}
          />
        )}
      </div>

      {/* Attachment preview (user uploads) */}
      {previewAttachment && (
        <AttachmentPreviewDialog
          attachment={previewAttachment}
          onClose={() => setPreviewAttachment(null)}
        />
      )}
    </div>
  );
}

// ── File preview dialog (agent) ──────────────────────────────────────────────

function FilePreviewDialog({
  file,
  sessionId,
  onClose,
}: {
  file: { path: string; name: string; mimeType: string };
  sessionId: string;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    dialogRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const url = `/api/agent/sessions/${sessionId}/files/download?path=${encodeURIComponent(file.path)}&preview=1&mimeType=${encodeURIComponent(file.mimeType)}`;
  const downloadUrl = `/api/agent/sessions/${sessionId}/files/download?path=${encodeURIComponent(file.path)}&mimeType=${encodeURIComponent(file.mimeType)}`;

  return (
    <div
      className="absolute inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={file.name}
        className="max-h-[92vh] w-full max-w-4xl overflow-hidden rounded-2xl border border-white/15 bg-slate-900/95"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-slate-100">{file.name}</div>
            <div className="text-xs text-slate-400">{file.mimeType}</div>
          </div>
          <div className="flex items-center gap-2">
            <a
              href={downloadUrl}
              download
              className="inline-flex items-center rounded-lg border border-teal-300/60 bg-teal-300/10 px-3 py-1.5 text-xs font-medium text-teal-100 transition hover:bg-teal-300/20"
            >
              <Download className="mr-1.5 h-3.5 w-3.5" />
              Download
            </a>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-white/10 bg-white/5 p-1.5 text-slate-300 transition hover:bg-white/10 hover:text-white"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
        <div className="max-h-[calc(92vh-64px)] overflow-auto bg-slate-950 p-3">
          {file.mimeType.startsWith("image/") ? (
            <img src={url} alt={file.name} className="mx-auto max-h-[78vh] w-auto max-w-full rounded-lg" />
          ) : file.mimeType === "application/pdf" || file.mimeType.startsWith("text/") || file.mimeType === "application/json" ? (
            <iframe src={url} className="h-[78vh] w-full rounded-lg border border-white/10 bg-white" title={file.name} />
          ) : (
            <div className="flex min-h-[240px] flex-col items-center justify-center gap-3 text-center">
              <File className="h-10 w-10 text-teal-200" />
              <p className="max-w-lg text-sm text-slate-300">This file type cannot be previewed inline.</p>
              <a
                href={downloadUrl}
                download
                className="inline-flex items-center rounded-lg border border-teal-300/60 bg-teal-300/10 px-3 py-2 text-sm font-medium text-teal-100 transition hover:bg-teal-300/20"
              >
                <Download className="mr-1.5 h-4 w-4" />
                Download
              </a>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Attachment preview (user) ────────────────────────────────────────────────

function AttachmentPreviewDialog({
  attachment,
  onClose,
}: {
  attachment: MessageAttachmentRef;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    dialogRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const url = `/api/uploads/${encodeURIComponent(attachment.id)}`;
  return (
    <div
      className="absolute inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={attachment.fileName}
        className="max-h-[92vh] w-full max-w-5xl overflow-hidden rounded-2xl border border-white/15 bg-slate-900/95"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-slate-100">{attachment.fileName}</div>
            <div className="text-xs text-slate-400">
              {attachment.mimeType} • {formatBytes(attachment.size)}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-white/10 bg-white/5 p-1.5 text-slate-300 transition hover:bg-white/10 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="max-h-[calc(92vh-64px)] overflow-auto bg-slate-950 p-3">
          {attachment.kind === "image" ? (
            <img src={url} alt={attachment.fileName} className="mx-auto max-h-[78vh] w-auto max-w-full rounded-lg" />
          ) : attachment.kind === "pdf" ? (
            <iframe src={url} className="h-[78vh] w-full rounded-lg border border-white/10 bg-white" title={attachment.fileName} />
          ) : (
            <div className="flex min-h-[240px] flex-col items-center justify-center gap-3 text-center">
              <File className="h-10 w-10 text-teal-200" />
              <p className="max-w-lg text-sm text-slate-300">This file type cannot be previewed inline.</p>
              <a
                href={url}
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
  );
}
/**
 * Translate a useChatStream SSE event into the shape the agent sidebar's
 * handleSseEvent expects. The stream uses `replay_tool_*` for events that
 * arrive from the re-attach endpoint, and `tool_start`/`tool_output`/
 * `tool_done` for live events. The sidebar hook only knows the live names,
 * so we map the replay ones back to the live names (the data shape is
 * identical, only the event name differs).
 */
function forwardAgentEvent(
  event: string,
  data: Record<string, unknown>,
): { event: string; data: Record<string, unknown> } | null {
  switch (event) {
    case "replay_tool_start":
      return { event: "tool_start", data };
    case "replay_tool_output":
      return { event: "tool_output", data };
    case "replay_tool_done":
      return { event: "tool_done", data };
    // Live tool events arrive with the same name+shape the sidebar hook
    // expects, so forward them unchanged. Without these the default returns
    // null and the agent sidebar terminal stays empty during a fresh send.
    case "tool_start":
      return { event: "tool_start", data };
    case "tool_output":
      return { event: "tool_output", data };
    case "tool_done":
      return { event: "tool_done", data };
    case "status":
      return { event: "status", data };
    case "error":
      return { event: "error", data };
    // `artifact` events are emitted by the orchestrator as files are created,
    // and the terminal `done` event carries a full artifacts[] array. Without
    // forwarding these, the Artifacts panel stays empty until a page refresh.
    case "artifact":
      return { event: "artifact", data };
    case "done":
      return { event: "done", data };
    default:
      return null;
  }
}

