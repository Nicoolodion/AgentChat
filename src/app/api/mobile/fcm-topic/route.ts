import { NextResponse } from "next/server";
import { z } from "zod";

import { resolveMobileAuth } from "@/lib/mobile-auth";
import { prisma } from "@/lib/prisma";

const updateSchema = z.object({
  ntfyTopic: z.string().min(4).max(128).optional(),
  ntfyAuth: z.string().max(512).nullable().optional(),
  label: z.string().max(64).optional(),
});

/**
 * POST /api/mobile/fcm-topic
 * Register/rotate the device's ntfy topic + publish-auth. The route name is
 * kept stable (historical) but now carries ntfy (UnifiedPush) topic+auth.
 */
export async function POST(request: Request) {
  const auth = await resolveMobileAuth(request);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = updateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request body" }, { status: 400 });

  const updated = await prisma.userMobileToken.update({
    where: { id: auth.tokenId },
    data: {
      ...(parsed.data.ntfyTopic ? { ntfyTopic: parsed.data.ntfyTopic } : {}),
      ...(parsed.data.ntfyAuth !== undefined ? { ntfyAuth: parsed.data.ntfyAuth } : {}),
      ...(parsed.data.label ? { label: parsed.data.label } : {}),
      lastSeenAt: new Date(),
    },
    select: { ntfyTopic: true, ntfyAuth: true },
  });

  return NextResponse.json({ ok: true, ntfyTopic: updated.ntfyTopic, ntfyAuth: updated.ntfyAuth });
}
