import { NextResponse } from "next/server";
import { z } from "zod";

import { pairMobileDevice } from "@/lib/mobile-auth";
import { enforceRateLimit } from "@/lib/rate-limit";
import { env } from "@/lib/env";

const pairSchema = z.object({
  username: z.string().min(3).max(32),
  password: z.string().min(1).max(256),
  installId: z.string().min(8).max(128),
  label: z.string().max(64).optional(),
});

/**
 * POST /api/mobile/pair
 * Exchange username + password (+ installId) for a bearer token and the ntfy
 * topic the device should subscribe to. No CSRF (bearer auth, not cookies).
 */
export async function POST(request: Request) {
  const rateKey = `mobile-pair:${request.headers.get("x-forwarded-for") ?? "unknown"}`;
  const rate = await enforceRateLimit(rateKey, 10, 60);
  if (!rate.ok) {
    return NextResponse.json({ error: "Too many attempts" }, { status: 429, headers: { "Retry-After": String(rate.retryAfterSeconds) } });
  }

  const parsed = pairSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (env.AUTH_REQUIRED === false) {
    return NextResponse.json(
      { error: "Mobile pairing unavailable in guest/local mode" },
      { status: 403 },
    );
  }

  const result = await pairMobileDevice(parsed.data);
  if (!result) {
    return NextResponse.json({ error: "Invalid username or password" }, { status: 401 });
  }

  return NextResponse.json({
    token: result.token,
    userId: result.userId,
    ntfyTopic: result.ntfyTopic,
    ntfyAuth: result.ntfyAuth,
    ntfyBaseUrl: env.NTFY_BASE_URL ?? null,
  }, { status: 201 });
}
