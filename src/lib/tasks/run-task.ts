import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";

import { decryptString, encryptString } from "@/lib/crypto";
import {
  appendMessageToChat,
  getConversationForModel,
} from "@/lib/chat-store";
import { runAgentExecution } from "@/lib/agent/orchestrator";
import type { AgentSseEvent } from "@/lib/agent/types";
import { agentSignals } from "@/lib/agent/runner-store";
import { generateChatTitle } from "@/lib/nanogpt";

import type { TaskSource } from "./types";

/**
 * Status for an attempted notification dispatch after a task completes.
 * The notify module (Phase B) is optional — if it isn't loaded yet this
 * stays a no-op so Phase A ships standalone.
 */
export type NotifyResult = {
  emailed: boolean;
  pushed: boolean;
};

type NotifyDispatcher = (input: {
  taskId: string;
  userId: string;
  userKey: Buffer;
  source: TaskSource;
  emailAddress: string | null;
  answeredFromDesktop: boolean;
  chatId: string | null;
}) => Promise<NotifyResult>;

// Injected by the notify module at module load (Phase B). Kept as a runtime
// hook so Phase A compiles + runs without the mail/push deps wired in.
let notifyDispatcher: NotifyDispatcher | null = null;

export function setNotifyDispatcher(fn: NotifyDispatcher): void {
  notifyDispatcher = fn;
}

const noopSendEvent = (_event: AgentSseEvent): void => {
  void _event;
  // Headless: events are persisted to the DB regardless (tool calls,
  // artifacts, session status). The SSE stream was only the live UI bridge.
};

/**
 * runTask — headless launcher. Mirrors /api/agent/sessions/[id]/execute's
 * ReadableStream.start() body, but with a noop sendEvent (no SSE client).
 *
 * Lifecycle:
 *   queued → running → {done | error | suppressed}
 *
 * After resolve:
 *   - if answeredFromDesktop === true → skip email+push, mark suppressed.
 *   - else → notifyDispatcher (email + ntfy push) if registered.
 */
export async function runTask(taskId: string): Promise<void> {
  const task = await prisma.mobileTask.findUnique({
    where: { id: taskId },
    include: { agentSession: true },
  });
  if (!task) return;

  const session = task.agentSession;
  if (!session) {
    await prisma.mobileTask.update({
      where: { id: taskId },
      data: { status: "error", errorMessage: "Agent session not found", completedAt: new Date() },
    });
    return;
  }

  if (agentSignals.has(session.id)) return;

  // Reload the userKey. The MobileTask row carries userId; the caller is
  // responsible for having passed a valid userKey. For the email-inbound path
  // we re-derive it via the same wrapped-key mechanism.
  // Since runTask is fire-and-forget, the caller MUST supply a resolver that
  // produces the userKey. We resolve it lazily here via a registry hook set
  // by the route that enqueues the task, so the key never serializes.

  const userKey = await resolveUserKey(task.userId);
  if (!userKey) {
    await prisma.mobileTask.update({
      where: { id: taskId },
      data: { status: "error", errorMessage: "Could not resolve userKey", completedAt: new Date() },
    });
    return;
  }

  const prompt = decryptString(task.prompt, userKey);

  const claimed = await prisma.mobileTask.updateMany({
    where: { id: taskId, status: "queued" },
    data: { status: "running", startedAt: new Date() },
  });
  if (claimed.count === 0) return;

  await appendMessageToChat({
    chatId: session.chatId,
    role: "user",
    content: prompt,
    userKey,
  });

  const priorConversation = await getConversationForModel({
    userId: task.userId,
    chatId: session.chatId,
    userKey,
    maxMessages: 30,
  });

  const ac = new AbortController();
  agentSignals.set(session.id, ac);

  try {
    const completion = await runAgentExecution({
      sessionId: session.id,
      userMessage: prompt,
      priorConversation,
      model: task.model ?? env.DEFAULT_MODEL,
      sendEvent: noopSendEvent,
      signal: ac.signal,
      taskSource: task.source as TaskSource,
    });

    await appendMessageToChat({
      chatId: session.chatId,
      role: "assistant",
      content: completion.content,
      reasoning: completion.reasoning,
      userKey,
      usagePromptTokens: completion.usagePromptTokens,
      usageCompletionTokens: completion.usageCompletionTokens,
      usageTotalTokens: completion.usageTotalTokens,
      usageCachedTokens: completion.usageCachedTokens,
      energyJoules: completion.energyJoules,
      energyKwh: completion.energyKwh,
      energyDurationSeconds: completion.energyDurationSeconds,
      providerModel: completion.providerModel,
      ttftMs: completion.ttftMs,
      avgTokensPerSecond: completion.avgTokensPerSecond,
    });

    // Async title generation (mirrors the desktop chat-send path) so the
    // email subject + sidebar entry are meaningful instead of "New chat".
    if (priorConversation.length <= 1) {
      void generateChatTitle({
        userMessage: prompt,
        assistantMessage: completion.content,
      })
        .then((title) =>
          prisma.chat.update({
            where: { id: session.chatId },
            data: title ? { encryptedTitle: encryptString(title, userKey) } : {},
          }),
        )
        .catch(() => undefined);
    }

    const markedDone = await prisma.mobileTask.update({
      where: { id: taskId },
      data: { status: "done", completedAt: new Date() },
      select: { answeredFromDesktop: true },
    });

    // Notify (email + push), unless the user already answered from desktop.
    if (markedDone.answeredFromDesktop) {
      await prisma.mobileTask.update({
        where: { id: taskId },
        data: { status: "suppressed" },
      });
      return;
    }

    if (notifyDispatcher) {
      try {
        await notifyDispatcher({
          taskId,
          userId: task.userId,
          userKey,
          source: task.source as TaskSource,
          emailAddress: task.emailAddress,
          answeredFromDesktop: false,
          chatId: task.chatId,
        });
      } catch (notifyErr) {
        console.error("[Task Notify Error]", notifyErr);
        // Notification failure does not un-done the task.
      }
    }
  } catch (error) {
    const aborted = (error as Error)?.name === "AbortError";
    const errMsg = aborted
      ? "Stopped by user"
      : error instanceof Error
        ? error.message
        : "Agent execution failed";
    await prisma.mobileTask.update({
      where: { id: taskId },
      data: {
        status: aborted ? "suppressed" : "error",
        errorMessage: aborted ? null : errMsg,
        completedAt: new Date(),
      },
    });
    if (!aborted) console.error("[Task Run Error]", error);
  } finally {
    agentSignals.delete(session.id);
  }
}

/**
 * Resolve a user's encryption key from the encryption layer, without requiring
 * the password. The mobile bearer path stored a session-wrapped copy on the
 * UserMobileToken row; the desktop path can pass it directly. To avoid storing
 * raw keys anywhere, we resolve via a per-user key cache populated by the
 * enqueuing route. Falls back to the guest key when AUTH_REQUIRED=false.
 */
type KeyResolver = (userId: string) => Promise<Buffer | null>;
let userKeyResolver: KeyResolver | null = null;

export function setUserKeyResolver(fn: KeyResolver): void {
  userKeyResolver = fn;
}

async function resolveUserKey(userId: string): Promise<Buffer | null> {
  // Guest/local mode: APP_ENCRYPTION_KEY is the shared user key.
  if (!env.AUTH_REQUIRED) {
    const { decodeKeyFromBase64 } = await import("@/lib/crypto");
    return decodeKeyFromBase64(env.APP_ENCRYPTION_KEY, "APP_ENCRYPTION_KEY");
  }
  const { decodeKeyFromBase64, decryptString } = await import("@/lib/crypto");
  const sessionKey = decodeKeyFromBase64(env.SESSION_ENCRYPTION_KEY, "SESSION_ENCRYPTION_KEY");

  const unwrap = async (cipher: string, label: string): Promise<Buffer> => {
    const userKeyBase64 = decryptString(cipher, sessionKey);
    return decodeKeyFromBase64(userKeyBase64, label);
  };

  // Mobile/email path: resolve from the most recent active mobile token.
  const token = await prisma.userMobileToken.findFirst({
    where: { userId, expiresAt: { gt: new Date() } },
    orderBy: { lastSeenAt: "desc" },
    select: { wrappedUserKeyCipher: true },
  });
  if (token) return unwrap(token.wrappedUserKeyCipher, "mobile wrapped user key");

  // Desktop /m path: resolve from the most recent active cookie session. The
  // desktop /m page is cookie-authed and a user can run tasks without ever
  // pairing a phone — the Session row carries the same session-wrapped key.
  const session = await prisma.session.findFirst({
    where: { userId, expiresAt: { gt: new Date() } },
    orderBy: { updatedAt: "desc" },
    select: { wrappedUserKey: true },
  });
  if (session) return unwrap(session.wrappedUserKey, "session wrapped user key");

  return userKeyResolver ? userKeyResolver(userId) : null;
}
