import { NextResponse } from "next/server";
import { z } from "zod";

import { resolveMobileAuth } from "@/lib/mobile-auth";
import { prisma } from "@/lib/prisma";

const localeSchema = z.object({
  country: z.string().length(2).optional(),
  language: z.string().max(16).optional(),
  timezone: z.string().max(64).optional(),
});

/**
 * GET /api/mobile/locale  — returns the user's locale profile (seeded lazily
 * from the Accept-Language header on first read if none exists yet).
 */
export async function GET(request: Request) {
  const auth = await resolveMobileAuth(request);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let profile = await prisma.userProfile.findUnique({
    where: { userId: auth.userId },
    select: { country: true, language: true, timezone: true },
  });

  if (!profile) {
    const accept = request.headers.get("accept-language") ?? "";
    const lang = parseAcceptLanguage(accept);
    if (lang) {
      try {
        profile = await prisma.userProfile.create({
          data: { userId: auth.userId, language: lang.language, country: lang.country ?? null },
          select: { country: true, language: true, timezone: true },
        });
      } catch {
        // Race: another request created it; re-read.
        profile = await prisma.userProfile.findUnique({
          where: { userId: auth.userId },
          select: { country: true, language: true, timezone: true },
        });
      }
    }
  }

  return NextResponse.json({ locale: profile ?? null });
}

/**
 * POST /api/mobile/locale — set the user's country/language/timezone explicitly
 * (the picker in /m + the native app). Used for "Wahlumfragen → Austria".
 */
export async function POST(request: Request) {
  const auth = await resolveMobileAuth(request);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = localeSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request body" }, { status: 400 });

  const profile = await prisma.userProfile.upsert({
    where: { userId: auth.userId },
    create: {
      userId: auth.userId,
      country: parsed.data.country ?? null,
      language: parsed.data.language ?? null,
      timezone: parsed.data.timezone ?? null,
    },
    update: {
      ...(parsed.data.country !== undefined ? { country: parsed.data.country } : {}),
      ...(parsed.data.language !== undefined ? { language: parsed.data.language } : {}),
      ...(parsed.data.timezone !== undefined ? { timezone: parsed.data.timezone } : {}),
    },
    select: { country: true, language: true, timezone: true },
  });

  return NextResponse.json({ ok: true, locale: profile });
}

function parseAcceptLanguage(header: string): { language: string; country: string | null } | null {
  const first = header.split(",")[0]?.trim();
  if (!first) return null;
  const tag = first.split(";")[0]!.trim();
  if (!tag) return null;
  // de-AT, en-US, etc.
  const parts = tag.split("-");
  const language = parts[0]?.toLowerCase() ?? null;
  const country = parts[1]?.toUpperCase() ?? null;
  if (!language) return null;
  return { language, country };
}
