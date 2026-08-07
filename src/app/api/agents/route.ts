import { NextResponse } from "next/server";
import { z } from "zod";

import {
  createCustomAgentForUser,
  listCustomAgentsForUser,
} from "@/lib/custom-agents";
import { resolveAuthContext } from "@/lib/auth";
import { requireCsrfHeader } from "@/lib/csrf";

const agentSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(500).optional().nullable(),
  systemPrompt: z.string().max(20000).default(""),
  model: z.string().min(1).max(150).regex(/^[a-zA-Z0-9/._:-]+$/),
  defaultAttachmentIds: z.array(z.string().min(1).max(120)).max(50).default([]),
});

export async function GET(request: Request) {
  const auth = await resolveAuthContext(request);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const agents = await listCustomAgentsForUser(auth.userId);
  return NextResponse.json({ agents });
}

export async function POST(request: Request) {
  const csrfError = requireCsrfHeader(request);
  if (csrfError) return csrfError;

  const auth = await resolveAuthContext(request);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = agentSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid agent payload.", details: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const agent = await createCustomAgentForUser(auth.userId, {
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      systemPrompt: parsed.data.systemPrompt,
      model: parsed.data.model,
      defaultAttachmentIds: parsed.data.defaultAttachmentIds,
    });
    return NextResponse.json({ agent }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to create agent.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
