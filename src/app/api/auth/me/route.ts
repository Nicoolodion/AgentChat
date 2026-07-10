import { NextResponse } from "next/server";

import { env } from "@/lib/env";
import { resolveAuthContext } from "@/lib/auth";
import { sandboxHealthCheck } from "@/lib/agent/sandbox";

let sandboxHealthCache: { ts: number; online: boolean } | null = null;
const SANDBOX_HEALTH_TTL_MS = 30_000;

export async function GET(request: Request) {
  const auth = await resolveAuthContext(request);

  let sandboxOnline = false;
  if (auth && env.AGENT_ENABLED) {
    const now = Date.now();
    if (sandboxHealthCache && now - sandboxHealthCache.ts < SANDBOX_HEALTH_TTL_MS) {
      sandboxOnline = sandboxHealthCache.online;
    } else {
      sandboxOnline = await sandboxHealthCheck().catch(() => false);
      sandboxHealthCache = { ts: now, online: sandboxOnline };
    }
  }

  return NextResponse.json({
    authenticated: Boolean(auth),
    authRequired: env.AUTH_REQUIRED,
    registrationEnabled: env.REGISTRATION_ENABLED,
    agentEnabled: env.AGENT_ENABLED,
    sandboxOnline,
    user: auth
      ? {
          id: auth.userId,
          username: auth.username,
          isGuest: auth.isGuest,
        }
      : null,
  });
}
