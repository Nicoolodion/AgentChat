import { NextResponse } from "next/server";
import { z } from "zod";

import {
  deleteCustomAgentForUser,
  getCustomAgentForUser,
  updateCustomAgentForUser,
} from "@/lib/custom-agents";
import { resolveAuthContext } from "@/lib/auth";
import { requireCsrfHeader } from "@/lib/csrf";

const updateSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  description: z.string().max(500).optional().nullable(),
  systemPrompt: z.string().max(20000).optional(),
  model: z.string().min(1).max(150).regex(/^[a-zA-Z0-9/._:-]+$/).optional(),
  defaultAttachmentIds: z.array(z.string().min(1).max(120)).max(50).optional(),
});

export async function GET(
  request: Request,
  context: { params: Promise<{ agentId: string }> },
) {
  const auth = await resolveAuthContext(request);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { agentId } = await context.params;
  const agent = await getCustomAgentForUser(auth.userId, agentId);
  if (!agent) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }
  return NextResponse.json({ agent });
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ agentId: string }> },
) {
  const csrfError = requireCsrfHeader(request);
  if (csrfError) return csrfError;

  const auth = await resolveAuthContext(request);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = updateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid update payload.", details: parsed.error.flatten() }, { status: 400 });
  }

  const { agentId } = await context.params;
  const updated = await updateCustomAgentForUser(auth.userId, agentId, parsed.data);
  if (!updated) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }
  return NextResponse.json({ agent: updated });
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ agentId: string }> },
) {
  const csrfError = requireCsrfHeader(request);
  if (csrfError) return csrfError;

  const auth = await resolveAuthContext(request);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { agentId } = await context.params;
  const ok = await deleteCustomAgentForUser(auth.userId, agentId);
  if (!ok) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }
  // Detach any chats that were bound to the now-deleted agent so they fall back
  // to plain model mode instead of dangling.
  await import("@/lib/prisma").then(({ prisma }) =>
    prisma.chat.updateMany({
      where: { userId: auth.userId, customAgentId: agentId },
      data: { customAgentId: null },
    }),
  );
  return NextResponse.json({ ok: true });
}
