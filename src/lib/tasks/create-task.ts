import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { normalizeDefaultModel } from "@/lib/nanogpt";

import { encryptString } from "@/lib/crypto";
import { createChatForUser } from "@/lib/chat-store";
import { createHostWorkspace } from "@/lib/agent/workspace";
import { sandboxCreateWorkspace, sandboxFileWrite, sandboxHealthCheck } from "@/lib/agent/sandbox";
import { getAttachmentForUser } from "@/lib/attachments";

import type { CreateTaskInput, CreateTaskResult } from "./types";

/**
 * createTask — Phase A entry point.
 *
 * Mirrors the chat-creation + agent-session creation flow in
 * /api/agent/sessions/route.ts + /api/agent/sessions/[id]/execute/route.ts, but
 * bundles it into a single headless unit. A "Task" is a Chat (agentModeLocked
 * so the session can be reactivated on email reply) + an AgentSession + a
 * MobileTask row that carries queue/email/desktop-suppress state.
 *
 * The prompt is encrypted with the userKey on the MobileTask row so a future
 * "list my tasks" query doesn't need to decrypt chat titles to render.
 */
export async function createTask(input: CreateTaskInput): Promise<CreateTaskResult> {
  const model = normalizeDefaultModel(input.model?.trim() || env.DEFAULT_MODEL);

  // Create the chat (1:1 per task). agentModeLocked=true so the session
  // survives re-runs (replies via email reactivate the same session instead
  // of deleting + recreating it — exactly the desktop execute/route.ts path).
  const chat = await createChatForUser({
    userId: input.userId,
    userKey: input.userKey,
    model,
    webSearchEnabled: true,
    title: input.prompt.slice(0, 80),
  });

  // Create the agent session first so the host workspace can be keyed by
  // the session id — matching every read path (notify, send_email,
  // artifacts route, file-explorer) that resolves under
  // data/agent-workspaces/{agentSessionId}/.
  const agentSession = await prisma.agentSession.create({
    data: {
      chatId: chat.id,
      userId: input.userId,
      status: "idle",
      workspacePath: "",
    },
  });

  // Create the host + sandbox workspace dirs, keyed by session id.
  const workspacePath = await createHostWorkspace(agentSession.id).catch(() =>
    // Fallback: the host-workspace path is deterministic anyway.
    `${env.AGENT_WORKSPACE_DIR}/${agentSession.id}`,
  );

  await prisma.agentSession.update({
    where: { id: agentSession.id },
    data: { workspacePath },
  });

  const sandboxHealthy = await sandboxHealthCheck().catch(() => false);
  if (sandboxHealthy) {
    await sandboxCreateWorkspace(agentSession.id).catch(() => undefined);
  }

  // Copy attachments into the session workspace upload/ dir, exactly like
  // the execute route. The host can't write into the per-session uid-owned
  // directory directly, so proxy through sandboxFileWrite.
  if (input.attachmentIds && input.attachmentIds.length > 0) {
    for (const attachmentId of input.attachmentIds) {
      try {
        const { meta, bytes } = await getAttachmentForUser({
          userId: input.userId,
          userKey: input.userKey,
          attachmentId,
        });
        await sandboxFileWrite(
          agentSession.id,
          `upload/${meta.fileName}`,
          bytes.toString("base64"),
          "base64",
        );
      } catch (attachErr) {
        console.error("[Task Attachment Copy Error]", attachErr);
        // Continue — the agent can still work without this file.
      }
    }
  }

  // Persist the MobileTask row carrying task-level state.
  const task = await prisma.mobileTask.create({
    data: {
      userId: input.userId,
      agentSessionId: agentSession.id,
      chatId: chat.id,
      source: input.source,
      prompt: encryptString(input.prompt, input.userKey),
      model,
      status: "queued",
      emailAddress: input.emailAddress ?? null,
      emailThreadId: input.emailThreadId ?? null,
    },
  });

  return {
    taskId: task.id,
    chatId: chat.id,
    agentSessionId: agentSession.id,
    status: "queued",
  };
}
