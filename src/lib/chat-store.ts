import type { Chat, Message } from "@prisma/client";

import { decryptString, encryptString } from "@/lib/crypto";
import type { ChatDetail, ChatListItem, ChatMessage, ChatToolCall } from "@/lib/chat-types";
import { prisma } from "@/lib/prisma";

type ChatWithLatestMessage = Chat & { messages: Message[] };

function decryptMessage(row: Message, userKey: Buffer): ChatMessage {
  const rawToolCalls = row.encryptedToolCalls
    ? decryptString(row.encryptedToolCalls, userKey)
    : undefined;
  return {
    id: row.id,
    role: row.role as ChatMessage["role"],
    content: decryptString(row.encryptedContent, userKey),
    reasoning: row.encryptedReasoning
      ? decryptString(row.encryptedReasoning, userKey)
      : undefined,
    toolPayload: row.encryptedToolPayload
      ? decryptString(row.encryptedToolPayload, userKey)
      : undefined,
    toolCalls: rawToolCalls ? (JSON.parse(rawToolCalls) as ChatMessage["toolCalls"]) : undefined,
    usagePromptTokens: row.usagePromptTokens ?? undefined,
    usageCompletionTokens: row.usageCompletionTokens ?? undefined,
    providerModel: row.providerModel ?? undefined,
    ttftMs: row.ttftMs ?? undefined,
    avgTokensPerSecond: row.avgTokensPerSecond ?? undefined,
    createdAt: row.createdAt.toISOString(),
  };
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
  const deleted = await prisma.chat.deleteMany({
    where: { id: chatId, userId },
  });

  return deleted.count > 0;
}

export async function appendMessageToChat(input: {
  chatId: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  userKey: Buffer;
  reasoning?: string;
  toolPayload?: string;
  toolCalls?: ChatToolCall[];
  usagePromptTokens?: number;
  usageCompletionTokens?: number;
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
      encryptedToolPayload: input.toolPayload
        ? encryptString(input.toolPayload, input.userKey)
        : null,
      encryptedToolCalls: input.toolCalls?.length
        ? encryptString(JSON.stringify(input.toolCalls), input.userKey)
        : null,
      usagePromptTokens: input.usagePromptTokens,
      usageCompletionTokens: input.usageCompletionTokens,
      providerModel: input.providerModel,
      ttftMs: input.ttftMs,
      avgTokensPerSecond: input.avgTokensPerSecond,
    },
  });

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
    },
    orderBy: { createdAt: "asc" },
    take: input.maxMessages ?? 30,
  });

  return rows
    .filter((row) => row.role === "system" || row.role === "user" || row.role === "assistant")
    .map((row) => ({
      role: row.role as "system" | "user" | "assistant",
      content: decryptString(row.encryptedContent, input.userKey),
    }));
}
