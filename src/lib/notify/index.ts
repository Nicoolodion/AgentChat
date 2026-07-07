import { readFile } from "node:fs/promises";

import { env } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import { mailOutboundReady, ntfyReady } from "@/lib/feature-flags";
import { decryptString } from "@/lib/crypto";

import { resolveHostWorkspaceFile } from "@/lib/agent/workspace";
import { sendMail } from "@/lib/mail/send-mail";
import { renderTaskEmail, taskMessageId } from "@/lib/mail/render-task-email";

import { setNotifyDispatcher, type NotifyResult } from "@/lib/tasks/run-task";
import type { TaskSource } from "@/lib/tasks/types";

type NotifyInput = {
  taskId: string;
  userId: string;
  userKey: Buffer;
  source: TaskSource;
  emailAddress: string | null;
  answeredFromDesktop: boolean;
  chatId: string | null;
};

/**
 * notifyTaskCompletion — registered as the task runner's notify dispatcher.
 *
 *   - emailing the result + artifacts when an emailAddress is set,
 *   - pushing an ntfy notification to each of the user's active device topics.
 *
 * Either leg is independently optional (gated on its env config), so the system
 * degrades gracefully: no SMTP → push-only; no ntfy → email-only; neither →
 * silent completion.
 */
export async function notifyTaskCompletion(input: NotifyInput): Promise<NotifyResult> {
  const emailed = await maybeEmail(input);
  const pushed = await maybePush(input);
  return { emailed, pushed };
}

async function maybeEmail(input: NotifyInput): Promise<boolean> {
  if (!input.emailAddress || !mailOutboundReady()) return false;
  if (input.answeredFromDesktop) return false;

  const task = await prisma.mobileTask.findUnique({
    where: { id: input.taskId },
    include: {
      chat: { select: { id: true, encryptedTitle: true } },
      agentSession: { select: { id: true, artifacts: true } },
    },
  });
  if (!task || !task.chat || !task.agentSession) return false;

  // Fetch the final assistant message text.
  const messages = await prisma.message.findMany({
    where: { chatId: task.chat.id, role: "assistant" },
    orderBy: { createdAt: "desc" },
    take: 1,
  });
  let resultText = "";
  if (messages.length > 0) {
    try {
      resultText = decryptString(messages[0].encryptedContent, input.userKey);
    } catch { /* fall back empty */ }
  }

  // Load artifact bytes host-side for inline attachment.
  const artifactFiles: Array<{
    filename: string;
    content: Buffer;
    contentType: string;
  }> = [];
  for (const a of task.agentSession.artifacts) {
    try {
      const absPath = resolveHostWorkspaceFile(task.agentSession!.id, a.storagePath);
      const content = await readFile(absPath);
      artifactFiles.push({ filename: a.fileName, content, contentType: a.mimeType });
    } catch (err) {
      console.error("[Notify artifact read error]", a.fileName, err);
    }
  }

  const promptPreview = (() => {
    try {
      return decryptString(task.prompt, input.userKey).slice(0, 120);
    } catch {
      return "";
    }
  })();

  const serverBaseUrl = process.env.PUBLIC_BASE_URL ?? "https://chat.nicoolodion.com";
  const rendered = renderTaskEmail({
    taskId: input.taskId,
    promptPreview,
    resultText,
    artifacts: task.agentSession.artifacts.map((a) => ({
      id: a.id,
      fileName: a.fileName,
      mimeType: a.mimeType,
      size: a.size,
      kind: a.kind,
      storagePath: a.storagePath,
    })),
    serverBaseUrl,
  });

  const messageId = taskMessageId(input.taskId);
  const references = task.emailThreadId ? [task.emailThreadId] : [];
  // Update the threading key so the next reply continues the same thread.
  await prisma.mobileTask.update({
    where: { id: input.taskId },
    data: { emailMessageId: messageId, emailThreadId: messageId },
  }).catch(() => undefined);

  const res = await sendMail({
    to: input.emailAddress,
    subject: rendered.subject,
    text: rendered.text,
    html: rendered.html,
    attachments: artifactFiles.map((f) => ({
      filename: f.filename,
      content: f.content,
      contentType: f.contentType,
    })),
    messageId,
    references: [messageId, ...references],
    headers: { "X-Task-Id": input.taskId },
  });

  return res.ok;
}

async function maybePush(input: NotifyInput): Promise<boolean> {
  if (!ntfyReady()) return false;

  const tokens = await prisma.userMobileToken.findMany({
    where: { userId: input.userId, expiresAt: { gt: new Date() } },
    select: { ntfyTopic: true, ntfyAuth: true },
  });
  if (tokens.length === 0) return false;

  const title = "Task finished";
  const body = await loadTaskTitle(input.taskId, input.userKey);

  const base = env.NTFY_BASE_URL!.replace(/\/$/, "");
  let anyOk = false;
  // Deduplicate by (topic) — multiple installs on one device may share a topic.
  const seenTopics = new Set<string>();
  for (const t of tokens) {
    if (seenTopics.has(t.ntfyTopic)) continue;
    seenTopics.add(t.ntfyTopic);
    try {
      const res = await fetch(`${base}/${t.ntfyTopic}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Title": title,
          ...(t.ntfyAuth ? { Authorization: `Bearer ${t.ntfyAuth}` } : {}),
          ...(env.NTFY_DEFAULT_AUTH && !t.ntfyAuth
            ? { Authorization: `Bearer ${env.NTFY_DEFAULT_AUTH}` }
            : {}),
        },
        body: JSON.stringify({
          taskId: input.taskId,
          chatId: input.chatId,
          kind: "done",
          title,
          body,
        }),
      });
      if (res.ok) anyOk = true;
    } catch (err) {
      console.error("[Notify ntfy push error]", t.ntfyTopic, err);
    }
  }
  return anyOk;
}

async function loadTaskTitle(taskId: string, userKey: Buffer): Promise<string> {
  const task = await prisma.mobileTask.findUnique({
    where: { id: taskId },
    include: { chat: { select: { encryptedTitle: true } } },
  });
  if (task?.chat?.encryptedTitle) {
    try {
      return decryptString(task.chat.encryptedTitle, userKey);
    } catch { /* fall back */ }
  }
  return "Your task completed.";
}

/**
 * Register the notify dispatcher with the task runner. Imported once at app
 * boot (instrumentation.ts) so it's wired before the first task finishes.
 */
export function registerNotifyDispatcher(): void {
  setNotifyDispatcher(notifyTaskCompletion);
}
