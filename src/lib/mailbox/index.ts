import { env } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import { mailInboundEnabled } from "@/lib/feature-flags";
import { decryptString, encryptString, decodeKeyFromBase64 } from "@/lib/crypto";

import { createTask, enqueueTask } from "@/lib/tasks";
import { sendMail } from "@/lib/mail/send-mail";
import { taskMessageId } from "@/lib/mail/render-task-email";

export type InboundEmail = {
  from: string;
  subject: string;
  text: string;
  html?: string;
  messageId?: string;
  inReplyTo?: string;
  references?: string[];
  headers?: Record<string, string>;
};

let pollTimer: ReturnType<typeof setInterval> | null = null;
let pollInFlight = false;
let lastSeenUid = 0;

/**
 * Start the background IMAP poller. Self-gating: when MAIL_INBOUND_ENABLED is
 * false or IMAP creds are absent, this is a no-op. Started once at boot from
 * instrumentation.ts.
 */
export function startMailboxPoller(intervalSeconds?: number): void {
  if (!mailInboundEnabled()) return;
  if (pollTimer) return;
  const interval = (intervalSeconds ?? env.MAIL_INBOX_POLL_SECONDS) * 1000;
  // Fire once shortly after boot, then on the interval.
  setTimeout(() => {
    void pollInbox().catch(() => undefined);
  }, 5_000);
  pollTimer = setInterval(() => {
    void pollInbox().catch(() => undefined);
  }, interval);
}

export function stopMailboxPoller(): void {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

/**
 * pollInbox — IMAP fetch of unread messages for the agent mailbox since the
 * last seen UID. Each message is handed to processInboundEmail.
 */
export async function pollInbox(): Promise<number> {
  if (pollInFlight) return 0;
  if (!mailInboundEnabled()) return 0;
  pollInFlight = true;
  let processed = 0;
  try {
    const { ImapFlow } = await import("imapflow");
    const client = new ImapFlow({
      host: env.MAIL_INBOX_HOST!,
      port: env.MAIL_INBOX_PORT,
      secure: true,
      auth: { user: env.MAIL_INBOX_USER!, pass: env.MAIL_INBOX_PASS! },
      logger: false,
    });
    await client.connect();
    try {
      const lock = await client.getMailboxLock("INBOX");
      try {
        // Search for messages with UID greater than lastSeenUid.
        const range = lastSeenUid > 0 ? `${lastSeenUid + 1}:*` : "1:*";
        for await (const msg of client.fetch(range, {
          uid: true,
          envelope: true,
          source: true,
          headers: true,
        })) {
          if (msg.uid && msg.uid > lastSeenUid) lastSeenUid = msg.uid;
          try {
            const { simpleParser } = await import("mailparser");
            const parsed = await simpleParser(msg.source as Buffer);
            const fromAddr = parsed.from?.value?.[0]?.address ?? "";
            const headers: Record<string, string> = {};
            for (const key of parsed.headers.keys()) {
              const v = parsed.headers.get(key);
              if (typeof v === "string") headers[key.toLowerCase()] = v;
            }
            const inbound: InboundEmail = {
              from: fromAddr,
              subject: parsed.subject ?? "",
              text: parsed.text ?? "",
              html: parsed.html ? String(parsed.html) : undefined,
              messageId: parsed.messageId ?? undefined,
              inReplyTo: parsed.inReplyTo ?? undefined,
              references: parsed.references
                ? String(parsed.references).split(/\s+/).filter(Boolean)
                : undefined,
              headers,
            };
            await processInboundEmail(inbound);
            processed++;
          } catch (err) {
            console.error("[Mailbox message parse error]", err);
          }
        }
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => undefined);
    }
  } catch (err) {
    console.error("[Mailbox poll error]", err);
  } finally {
    pollInFlight = false;
  }
  return processed;
}

/**
 * processInboundEmail — core handler, shared by the IMAP poller and the
 * /api/email/inbound HTTP shim.
 *
 * Flow (per plan §9):
 *   - reply (References/In-Reply-To/X-Task-Id) → resolve the existing
 *     MobileTask → append the stripped body as a user Message on the same
 *     chat → re-run the agent (enqueueTask after creating a continuation task).
 *   - fresh email from a verified UserEmail → body as new prompt → createTask
 *     with source "email".
 *   - unverified sender → auto-reply with a one-time verification link.
 */
export async function processInboundEmail(email: InboundEmail): Promise<void> {
  const sender = email.from.toLowerCase().trim();
  if (!sender) return;

  // 1. Reply-continuation: look for a task id in headers/preferences.
  const xTaskId = email.headers?.["x-task-id"];
  const threadKey =
    xTaskId ??
    (email.references && email.references.length > 0 ? email.references[email.references.length - 1] : null) ??
    email.inReplyTo ??
    null;

  if (threadKey) {
    await handleReply(email, sender, threadKey);
    return;
  }

  // 2. Fresh email from a verified sender.
  const userEmail = await prisma.userEmail.findUnique({
    where: { address: sender },
  });
  if (!userEmail || !userEmail.verifiedAt) {
    await sendVerificationChallenge(sender);
    return;
  }

  const user = await prisma.user.findUnique({
    where: { id: userEmail.userId },
    select: { id: true, username: true },
  });
  if (!user) return;

  const userKey = await resolveUserKeyForUser(user.id);
  if (!userKey) return;

  const prompt = (email.text || stripHtml(email.html) || email.subject || "").trim();
  if (!prompt) return;

  const created = await createTask({
    userId: user.id,
    userKey,
    username: user.username,
    prompt,
    source: "email",
    emailAddress: userEmail.address,
  });

  // Stamp the threading key so the completion email will thread with this
  // inbound message.
  const msgId = taskMessageId(created.taskId);
  await prisma.mobileTask.update({
    where: { id: created.taskId },
    data: {
      emailMessageId: msgId,
      emailThreadId: email.messageId ?? msgId,
    },
  }).catch(() => undefined);

  enqueueTask(created.taskId);
}

async function handleReply(email: InboundEmail, _sender: string, threadKey: string): Promise<void> {
  // The thread key may be a <task-...@domain> Message-ID OR a raw taskId.
  const taskId = extractTaskIdFromMessageId(threadKey) ?? threadKey;

  const task = await prisma.mobileTask.findUnique({
    where: { id: taskId },
    include: {
      user: { select: { id: true, username: true } },
      agentSession: { select: { id: true, chatId: true } },
    },
  });
  if (!task || !task.agentSession || !task.user) return;

  const userKey = await resolveUserKeyForUser(task.user.id);
  if (!userKey) return;

  // Strip quoted reply text (mailparser usually leaves the bottom-quote; do a
  // best-effort trim at the first quoted-section marker).
  const body = stripQuotedReply(email.text || stripHtml(email.html) || "");
  if (!body.trim()) return;

  // Append the reply as a new user message on the same chat, then enqueue a
  // continuation task that re-runs the agent with the updated conversation.
  // We model this as a new MobileTask row linked to the same session/chat so
  // the completion email continues the same mail thread.
  const { appendMessageToChat } = await import("@/lib/chat-store");
  await appendMessageToChat({
    chatId: task.agentSession.chatId,
    role: "user",
    content: body,
    userKey,
  });

  const continuation = await prisma.mobileTask.create({
    data: {
      userId: task.user.id,
      agentSessionId: task.agentSession.id,
      chatId: task.agentSession.chatId,
      source: "email",
      prompt: encryptString(body, userKey),
      model: task.model,
      status: "queued",
      emailAddress: task.emailAddress,
      emailThreadId: email.messageId ?? task.emailThreadId,
    },
  });

  enqueueTask(continuation.id);
}

async function sendVerificationChallenge(address: string): Promise<void> {
  // Auto-reply to unverified senders with a verification link. The link
  // flips a UserEmail row's verifiedAt — but there's no row yet for an
  // unknown address, so we create a pending one owned by a sentinel (null
  // user impossible with FK; instead we require the user to first pair from
  // the app, then reply-trigger flows). For now: best-effort auto-reply that
  // tells them to pair via the app first.
  if (!env.MAIL_SMTP_HOST) return;
  const baseUrl = (process.env.PUBLIC_BASE_URL ?? "https://chat.nicoolodion.com").replace(/\/$/, "");
  await sendMail({
    to: address,
    subject: "Re: verify your email to use the agent",
    text: `Hello,\n\nYour email address isn't linked to a Chatinterface account yet. Pair your device in the mobile app (Settings → Verify email), then reply to a task result to continue the conversation.\n\nThis keeps the agent mailbox private to verified users.\n\nURL: ${baseUrl}/m`,
    html: `<p>Hello,</p><p>Your email address isn't linked to a Chatinterface account yet. Pair your device in the mobile app (Settings → Verify email), then reply to a task result to continue the conversation.</p>`,
  }).catch(() => undefined);
}

function extractTaskIdFromMessageId(id: string): string | null {
  const m = id.match(/<task-([^>@]+)@/i);
  return m ? m[1]! : null;
}

function stripHtml(html?: string): string {
  if (!html) return "";
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripQuotedReply(text: string): string {
  // Common quote markers used by Outlook/Gmail/Apple Mail.
  const markers = [
    /^On .* wrote:$/im,
    /^Am .* schrieb:$/im,
    /^Am .* um .* schrieb:$/im,
    /^-+\s*Original Message\s*-+/im,
    /^> /im,
  ];
  for (const re of markers) {
    const m = text.match(re);
    if (m && m.index !== undefined) {
      return text.slice(0, m.index).trim();
    }
  }
  return text.trim();
}

async function resolveUserKeyForUser(userId: string): Promise<Buffer | null> {
  if (!env.AUTH_REQUIRED) {
    return decodeKeyFromBase64(env.APP_ENCRYPTION_KEY, "APP_ENCRYPTION_KEY");
  }
  const sessionKey = decodeKeyFromBase64(env.SESSION_ENCRYPTION_KEY, "SESSION_ENCRYPTION_KEY");
  const unwrap = async (cipher: string): Promise<Buffer> =>
    decodeKeyFromBase64(decryptString(cipher, sessionKey), "wrapped user key");

  const token = await prisma.userMobileToken.findFirst({
    where: { userId, expiresAt: { gt: new Date() } },
    orderBy: { lastSeenAt: "desc" },
    select: { wrappedUserKeyCipher: true },
  });
  if (token) return unwrap(token.wrappedUserKeyCipher);

  // Fall back to the cookie Session row (desktop-only user replying by email).
  const session = await prisma.session.findFirst({
    where: { userId, expiresAt: { gt: new Date() } },
    orderBy: { updatedAt: "desc" },
    select: { wrappedUserKey: true },
  });
  if (session) return unwrap(session.wrappedUserKey);

  return null;
}
