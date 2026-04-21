import { NextResponse } from "next/server";
import { z } from "zod";

import { registerUser, validateUsername } from "@/lib/auth";
import { env } from "@/lib/env";
import { jsonError, requestIp } from "@/lib/http";
import { validatePasswordStrength } from "@/lib/password";
import { enforceRateLimit } from "@/lib/rate-limit";

const schema = z.object({
  username: z.string().min(3).max(32),
  password: z.string().min(10).max(128),
});

export async function POST(request: Request) {
  if (!env.REGISTRATION_ENABLED) {
    return jsonError("Registration is disabled by configuration.", 403);
  }

  const ip = requestIp(request);
  const rateLimit = enforceRateLimit(
    `register:${ip}`,
    env.RATE_LIMIT_MAX_REQUESTS,
    env.RATE_LIMIT_WINDOW_SECONDS,
  );

  if (!rateLimit.ok) {
    return NextResponse.json(
      { error: `Too many attempts. Retry in ${rateLimit.retryAfterSeconds}s.` },
      { status: 429 },
    );
  }

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return jsonError("Invalid registration payload.", 400);
  }

  const username = parsed.data.username.trim().toLowerCase();
  const password = parsed.data.password;

  if (!validateUsername(username)) {
    return jsonError("Username must be 3-32 chars and use letters, numbers, -, _, or .", 400);
  }

  if (!validatePasswordStrength(password)) {
    return jsonError(
      "Password must be 10+ chars and include uppercase, lowercase, and a number.",
      400,
    );
  }

  try {
    await registerUser(username, password);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Registration failed.";
    return jsonError(message, 400);
  }
}
