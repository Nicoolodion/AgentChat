import type { Chat, Message } from "@prisma/client";

import { decryptString, encryptString } from "@/lib/crypto";
import type { ChatDetail, ChatListItem, ChatMessage, ChatToolCall, MessageSegment } from "@/lib/chat-types";
import { prisma } from "@/lib/prisma";
import { deleteHostWorkspace } from "@/lib/agent/workspace";

type ChatWithLatestMessage = Chat & { messages: Message[] };

/**
 * Validate + normalize a persisted ChatToolCall JSON array. Older rows only
 * store {toolCallId, toolName, status, durationMs}; newer rows also carry
 * arguments/output/error. We accept both and strip anything malformed so a
 * single bad row never breaks the whole chat.
 */
export function normalizeToolCalls(raw: unknown): ChatToolCall[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: ChatToolCall[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const tc = item as Record<string, unknown>;
    if (typeof tc.toolCallId !== "string" || typeof tc.toolName !== "string") continue;
    const status = tc.status === "running" || tc.status === "success" || tc.status === "error" ? tc.status : "running";
    const call: ChatToolCall = {
      toolCallId: tc.toolCallId,
      toolName: tc.toolName,
      status,
    };
    if (typeof tc.durationMs === "number") call.durationMs = tc.durationMs;
    if (tc.arguments && typeof tc.arguments === "object" && !Array.isArray(tc.arguments)) {
      call.arguments = tc.arguments as Record<string, unknown>;
    }
    if (typeof tc.output === "string") call.output = tc.output;
    if (typeof tc.error === "string") call.error = tc.error;
    out.push(call);
  }
  return out.length ? out : undefined;
}

export function normalizeSegments(raw: unknown): MessageSegment[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: MessageSegment[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const seg = item as Record<string, unknown>;
    if (typeof seg.text !== "string") continue;
    if (typeof seg.beforeToolIndex !== "number") continue;
    out.push({ text: seg.text, beforeToolIndex: seg.beforeToolIndex });
  }
  return out.length ? out : undefined;
}

function decryptMessage(row: Message, userKey: Buffer): ChatMessage {
  const rawToolCalls = row.encryptedToolCalls
    ? decryptString(row.encryptedToolCalls, userKey)
    : undefined;
  const rawReasoningSegments = row.encryptedReasoningSegments
    ? decryptString(row.encryptedReasoningSegments, userKey)
    : undefined;
  const rawContentSegments = row.encryptedContentSegments
    ? decryptString(row.encryptedContentSegments, userKey)
    : undefined;
  return {
    id: row.id,
    role: row.role as ChatMessage["role"],
    content: decryptString(row.encryptedContent, userKey),
    reasoning: row.encryptedReasoning
      ? decryptString(row.encryptedReasoning, userKey)
      : undefined,
    reasoningSegments: rawReasoningSegments
      ? normalizeSegments(safeJson(rawReasoningSegments))
      : undefined,
    contentSegments: rawContentSegments
      ? normalizeSegments(safeJson(rawContentSegments))
      : undefined,
    toolPayload: row.encryptedToolPayload
      ? decryptString(row.encryptedToolPayload, userKey)
      : undefined,
    toolCalls: rawToolCalls ? normalizeToolCalls(safeJson(rawToolCalls)) : undefined,
    usagePromptTokens: row.usagePromptTokens ?? undefined,
    usageCompletionTokens: row.usageCompletionTokens ?? undefined,
    usageTotalTokens: row.usageTotalTokens ?? undefined,
    usageCachedTokens: row.usageCachedTokens ?? undefined,
    energyJoules: row.energyJoules ?? undefined,
    energyKwh: row.energyKwh ?? undefined,
    energyDurationSeconds: row.energyDurationSeconds ?? undefined,
    providerModel: row.providerModel ?? undefined,
    ttftMs: row.ttftMs ?? undefined,
    avgTokensPerSecond: row.avgTokensPerSecond ?? undefined,
    createdAt: row.createdAt.toISOString(),
  };
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

function chatToListItem(chat: ChatWithLatestMessage, userKey: Buffer): ChatListItem {
  const latest = chat.messages[0];
  const preview = latest
    ? decryptString(latest.encryptedContent, userKey).slice(0, 120)
    : "No messages yet";

  return {
    id: chat.id,
    title: decryptString(chat.encryptedTitle, userKey),
    model: chat.model,
    webSearchEnabled: chat.webSearchEnabled,
    agentModeLocked: chat.agentModeLocked,
    createdAt: chat.createdAt.toISOString(),
    updatedAt: chat.updatedAt.toISOString(),
    lastMessagePreview: preview,
  };
}

export async function createChatForUser(input: {
  userId: string;
  userKey: Buffer;
  model: string;
  webSearchEnabled: boolean;
  title?: string;
}): Promise<ChatListItem> {
  const title = input.title?.trim() || "New chat";
  const chat = await prisma.chat.create({
    data: {
      userId: input.userId,
      encryptedTitle: encryptString(title, input.userKey),
      model: input.model,
      webSearchEnabled: input.webSearchEnabled,
    },
    include: {
      messages: {
        orderBy: { createdAt: "desc" },
        take: 1,
      },
    },
  });

  return chatToListItem(chat, input.userKey);
}

export async function listChatsForUser(userId: string, userKey: Buffer): Promise<ChatListItem[]> {
  const chats = await prisma.chat.findMany({
    where: { userId },
    orderBy: { updatedAt: "desc" },
    include: {
      messages: {
        orderBy: { createdAt: "desc" },
        take: 1,
      },
    },
  });

  return chats
    .map((chat) => {
      try {
        return chatToListItem(chat, userKey);
      } catch {
        return null;
      }
    })
    .filter((c): c is ChatListItem => c !== null);
}

export async function getChatDetailForUser(
  userId: string,
  chatId: string,
  userKey: Buffer,
): Promise<ChatDetail | null> {
  const chat = await prisma.chat.findFirst({
    where: { id: chatId, userId },
    include: {
      messages: {
        orderBy: { createdAt: "asc" },
      },
      agentSession: {
        select: { id: true, status: true },
      },
    },
  });

  if (!chat) return null;

  return {
    id: chat.id,
    title: decryptString(chat.encryptedTitle, userKey),
    model: chat.model,
    webSearchEnabled: chat.webSearchEnabled,
    agentModeLocked: chat.agentModeLocked,
    createdAt: chat.createdAt.toISOString(),
    updatedAt: chat.updatedAt.toISOString(),
    messages: chat.messages
      .map((msg) => {
        try {
          return decryptMessage(msg, userKey);
        } catch {
          return null;
        }
      })
      .filter((m): m is ChatMessage => m !== null),
    agentSession: chat.agentSession
      ? { id: chat.agentSession.id, status: chat.agentSession.status }
      : null,
  };
}

export async function updateChatSettingsForUser(input: {
  userId: string;
  chatId: string;
  userKey: Buffer;
  model?: string;
  webSearchEnabled?: boolean;
  title?: string;
}): Promise<ChatDetail | null> {
  const existing = await prisma.chat.findFirst({
    where: { id: input.chatId, userId: input.userId },
    include: { messages: { orderBy: { createdAt: "asc" } }, agentSession: { select: { id: true, status: true } } },
  });

  if (!existing) return null;

  const updated = await prisma.chat.update({
    where: { id: input.chatId },
    data: {
      model: input.model ?? existing.model,
      webSearchEnabled:
        typeof input.webSearchEnabled === "boolean"
          ? input.webSearchEnabled
          : existing.webSearchEnabled,
      encryptedTitle:
        typeof input.title === "string"
          ? encryptString(input.title.trim() || "New chat", input.userKey)
          : existing.encryptedTitle,
    },
    include: { messages: { orderBy: { createdAt: "asc" } }, agentSession: { select: { id: true, status: true } } },
  });

  return {
    id: updated.id,
    title: decryptString(updated.encryptedTitle, input.userKey),
    model: updated.model,
    webSearchEnabled: updated.webSearchEnabled,
    agentModeLocked: updated.agentModeLocked,
    createdAt: updated.createdAt.toISOString(),
    updatedAt: updated.updatedAt.toISOString(),
    // Some legacy rows may not decrypt (e.g. a key migration in progress or a
    // pre-production row). Rather than failing the whole PATCH, return those
    // messages as empty placeholders so the chat remains usable.
    messages: updated.messages.map((msg) => {
      try {
        return decryptMessage(msg, input.userKey);
      } catch {
        return {
          id: msg.id,
          role: msg.role as ChatMessage["role"],
          content: "",
          createdAt: msg.createdAt.toISOString(),
        } as ChatMessage;
      }
    }),
    agentSession: updated.agentSession
      ? { id: updated.agentSession.id, status: updated.agentSession.status }
      : null,
  };
}

export async function deleteChatForUser(userId: string, chatId: string): Promise<boolean> {
  const chat = await prisma.chat.findFirst({
    where: { id: chatId, userId },
    include: { agentSession: { select: { id: true } } },
  });
  if (!chat) return false;

  if (chat.agentSession) {
    try {
      // Host workspaces may have been created keyed by either chatId (sessions
      // route) or the agent session id (execute/files routes). Delete both
      // candidate dirs idempotently so neither orphans.
      await deleteHostWorkspace(chatId);
      await deleteHostWorkspace(chat.agentSession.id);
    } catch {
      // best-effort; don't block chat deletion
    }
  }

  const deleted = await prisma.chat.deleteMany({
    where: { id: chatId, userId },
  });

  return deleted.count > 0;
}

const MAX_MESSAGES_PER_CHAT = 500;
const PRUNE_INTERVAL = 50;

export async function appendMessageToChat(input: {
  chatId: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  userKey: Buffer;
  reasoning?: string;
  reasoningSegments?: MessageSegment[];
  contentSegments?: MessageSegment[];
  toolPayload?: string;
  toolCalls?: ChatToolCall[];
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
}): Promise<ChatMessage> {
  const message = await prisma.message.create({
    data: {
      chatId: input.chatId,
      role: input.role,
      encryptedContent: encryptString(input.content, input.userKey),
      encryptedReasoning: input.reasoning
        ? encryptString(input.reasoning, input.userKey)
        : null,
      encryptedReasoningSegments: input.reasoningSegments?.length
        ? encryptString(JSON.stringify(input.reasoningSegments), input.userKey)
        : null,
      encryptedContentSegments: input.contentSegments?.length
        ? encryptString(JSON.stringify(input.contentSegments), input.userKey)
        : null,
      encryptedToolPayload: input.toolPayload
        ? encryptString(input.toolPayload, input.userKey)
        : null,
      encryptedToolCalls: input.toolCalls?.length
        ? encryptString(JSON.stringify(input.toolCalls), input.userKey)
        : null,
      usagePromptTokens: input.usagePromptTokens,
      usageCompletionTokens: input.usageCompletionTokens,
      usageTotalTokens: input.usageTotalTokens,
      usageCachedTokens: input.usageCachedTokens,
      energyJoules: input.energyJoules,
      energyKwh: input.energyKwh,
      energyDurationSeconds: input.energyDurationSeconds,
      providerModel: input.providerModel,
      ttftMs: input.ttftMs,
      avgTokensPerSecond: input.avgTokensPerSecond,
    },
  });

  const chatMessageCount = await prisma.message.count({ where: { chatId: input.chatId } });
  if (chatMessageCount - MAX_MESSAGES_PER_CHAT >= PRUNE_INTERVAL) {
    const oldest = await prisma.message.findMany({
      where: { chatId: input.chatId },
      orderBy: { createdAt: "asc" },
      take: chatMessageCount - MAX_MESSAGES_PER_CHAT,
      select: { id: true },
    });
    await prisma.message.deleteMany({
      where: { id: { in: oldest.map((m) => m.id) } },
    });
  }

  return decryptMessage(message, input.userKey);
}

export async function getChatByIdForUser(userId: string, chatId: string): Promise<Chat | null> {
  return prisma.chat.findFirst({ where: { id: chatId, userId } });
}

export async function getChatWithAgentSessionByIdForUser(userId: string, chatId: string): Promise<(Chat & { agentSession: { id: string; status: string } | null }) | null> {
  return prisma.chat.findFirst({
    where: { id: chatId, userId },
    include: { agentSession: { select: { id: true, status: true } } },
  });
}

export async function deleteMessageForUser(userId: string, chatId: string, messageId: string): Promise<boolean> {
  const message = await prisma.message.findFirst({
    where: { id: messageId, chatId, chat: { userId } },
  });
  if (!message) return false;

  await prisma.message.delete({ where: { id: messageId } });
  return true;
}

/**
 * Append continuation text to an existing assistant message. Used by the
 * "Continue generating" flow: the model resumes after a truncation and its new
 * output is grafted onto the same persisted message so the full response stays
 * coherent. Returns the updated message (decrypted) or null if not found.
 *
 * `reasoning` continues are not supported — only content segments are appended.
 */
export async function appendContentToMessageForUser(input: {
  userId: string;
  chatId: string;
  messageId: string;
  userKey: Buffer;
  appendContent: string;
}): Promise<ChatMessage | null> {
  const updated = await prisma.$transaction(async (tx) => {
    const message = await tx.message.findFirst({
      where: { id: input.messageId, chatId: input.chatId, chat: { userId: input.userId } },
    });
    if (!message) return null;

    const existingContent = decryptString(message.encryptedContent, input.userKey);
    return tx.message.update({
      where: { id: input.messageId },
      data: {
        encryptedContent: encryptString(existingContent + input.appendContent, input.userKey),
      },
    });
  });

  if (!updated) return null;
  return decryptMessage(updated, input.userKey);
}

/**
 * Append a content segment that was emitted on the *tail* of a message (after
 * the last tool call). Used by the agent "Continue generating" flow so the
 * continued text is persisted in the same ordered-segment structure the
 * timeline renders. `beforeToolIndex` is set to the existing tool-call count so
 * the continuation renders after everything else.
 */
export async function appendTailSegmentToMessageForUser(input: {
  userId: string;
  chatId: string;
  messageId: string;
  userKey: Buffer;
  segmentText: string;
  beforeToolIndex: number;
}): Promise<ChatMessage | null> {
  const updated = await prisma.$transaction(async (tx) => {
    const message = await tx.message.findFirst({
      where: { id: input.messageId, chatId: input.chatId, chat: { userId: input.userId } },
    });
    if (!message) return null;

    const existingSegmentsRaw = message.encryptedContentSegments
      ? decryptString(message.encryptedContentSegments, input.userKey)
      : "[]";
    const existingSegments = (safeJson(existingSegmentsRaw) ?? []) as MessageSegment[];
    existingSegments.push({ text: input.segmentText, beforeToolIndex: input.beforeToolIndex });

    const existingContent = decryptString(message.encryptedContent, input.userKey);

    return tx.message.update({
      where: { id: input.messageId },
      data: {
        encryptedContent: encryptString(existingContent + input.segmentText, input.userKey),
        encryptedContentSegments: encryptString(JSON.stringify(existingSegments), input.userKey),
      },
    });
  });

  if (!updated) return null;
  return decryptMessage(updated, input.userKey);
}

export async function getConversationForModel(input: {
  userId: string;
  chatId: string;
  userKey: Buffer;
  maxMessages?: number;
}): Promise<Array<{ role: "system" | "user" | "assistant"; content: string }>> {
  const rows = await prisma.message.findMany({
    where: {
      chatId: input.chatId,
      chat: { userId: input.userId },
      role: { in: ["system", "user", "assistant"] },
    },
    orderBy: { createdAt: "asc" },
    take: input.maxMessages ?? 30,
  });

  return rows.map((row) => ({
    role: row.role as "system" | "user" | "assistant",
    content: decryptString(row.encryptedContent, input.userKey),
  }));
}
