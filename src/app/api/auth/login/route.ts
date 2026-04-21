import { NextResponse } from "next/server";
import { z } from "zod";

import { loginUser, writeSessionCookie } from "@/lib/auth";
import { env } from "@/lib/env";
import { jsonError, requestIp } from "@/lib/http";
import { enforceRateLimit } from "@/lib/rate-limit";

const schema = z.object({
  username: z.string().min(3).max(32),
  password: z.string().min(10).max(128),
});

export async function POST(request: Request) {
  if (!env.AUTH_REQUIRED) {
    return NextResponse.json({ ok: true, authRequired: false });
  }

  const ip = requestIp(request);
  const rateLimit = enforceRateLimit(
    `login:${ip}`,
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
    return jsonError("Invalid login payload.", 400);
  }

  try {
    const session = await loginUser(parsed.data.username, parsed.data.password);
    const response = NextResponse.json({ ok: true, username: session.username });
    writeSessionCookie(response, session.token);
    return response;
  } catch {
    return jsonError("Invalid username or password.", 401);
  }
}
