import { NextResponse } from "next/server";

import { resolveMobileAuth } from "@/lib/mobile-auth";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";

/**
 * GET /api/mobile/settings
 * Returns the user's default model, verified email, and locale profile — the
 * data the Android app shows on its Settings screen.
 */
export async function GET(request: Request) {
  const auth = await resolveMobileAuth(request);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const [email, profile] = await Promise.all([
    prisma.userEmail.findFirst({
      where: { userId: auth.userId },
      select: { address: true, verifiedAt: true },
    }),
    prisma.userProfile.findUnique({
      where: { userId: auth.userId },
      select: { country: true, language: true, timezone: true },
    }),
  ]);

  return NextResponse.json({
    defaultModel: env.DEFAULT_MODEL,
    verifiedEmail: email?.verifiedAt ? email.address : null,
    pendingEmail: email && !email.verifiedAt ? email.address : null,
    locale: profile ?? null,
    pushEnabled: Boolean(env.NTFY_BASE_URL),
    mailEnabled: Boolean(env.MAIL_SMTP_HOST && env.MAIL_SMTP_USER),
  });
}
