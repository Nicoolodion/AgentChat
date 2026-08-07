import { prisma } from "@/lib/prisma";
import { normalizeDefaultModel } from "@/lib/nanogpt";
import type { CustomAgent } from "@/lib/chat-types";

function rowToAgent(row: {
  id: string;
  name: string;
  description: string | null;
  systemPrompt: string;
  model: string;
  defaultAttachmentIds: string;
  createdAt: Date;
  updatedAt: Date;
}): CustomAgent {
  let ids: string[] = [];
  try {
    const parsed = JSON.parse(row.defaultAttachmentIds || "[]");
    if (Array.isArray(parsed)) {
      ids = parsed.filter((x): x is string => typeof x === "string" && x.length > 0);
    }
  } catch {
    ids = [];
  }
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    systemPrompt: row.systemPrompt,
    model: row.model,
    defaultAttachmentIds: ids,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listCustomAgentsForUser(userId: string): Promise<CustomAgent[]> {
  const rows = await prisma.customAgent.findMany({
    where: { userId },
    orderBy: { updatedAt: "desc" },
  });
  return rows.map(rowToAgent);
}

export async function getCustomAgentForUser(
  userId: string,
  agentId: string,
): Promise<CustomAgent | null> {
  const row = await prisma.customAgent.findFirst({
    where: { id: agentId, userId },
  });
  if (!row) return null;
  return rowToAgent(row);
}

export type CustomAgentInput = {
  name: string;
  description?: string | null;
  systemPrompt: string;
  model: string;
  defaultAttachmentIds?: string[];
};

export async function createCustomAgentForUser(
  userId: string,
  input: CustomAgentInput,
): Promise<CustomAgent> {
  const created = await prisma.customAgent.create({
    data: {
      userId,
      name: input.name.trim().slice(0, 80),
      description: input.description ? input.description.trim().slice(0, 500) : null,
      systemPrompt: input.systemPrompt,
      model: normalizeDefaultModel(input.model),
      defaultAttachmentIds: JSON.stringify((input.defaultAttachmentIds ?? []).slice(0, 50)),
    },
  });
  return rowToAgent(created);
}

export async function updateCustomAgentForUser(
  userId: string,
  agentId: string,
  input: Partial<CustomAgentInput>,
): Promise<CustomAgent | null> {
  const existing = await prisma.customAgent.findFirst({
    where: { id: agentId, userId },
  });
  if (!existing) return null;

  const data: Record<string, unknown> = {};
  if (input.name !== undefined) data.name = input.name.trim().slice(0, 80);
  if (input.description !== undefined)
    data.description = input.description ? input.description.trim().slice(0, 500) : null;
  if (input.systemPrompt !== undefined) data.systemPrompt = input.systemPrompt;
  if (input.model !== undefined) data.model = normalizeDefaultModel(input.model);
  if (input.defaultAttachmentIds !== undefined)
    data.defaultAttachmentIds = JSON.stringify(input.defaultAttachmentIds.slice(0, 50));

  const updated = await prisma.customAgent.update({
    where: { id: agentId },
    data,
  });
  return rowToAgent(updated);
}

export async function deleteCustomAgentForUser(
  userId: string,
  agentId: string,
): Promise<boolean> {
  const deleted = await prisma.customAgent.deleteMany({
    where: { id: agentId, userId },
  });
  return deleted.count > 0;
}
