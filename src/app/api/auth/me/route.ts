import { NextResponse } from "next/server";

import { env } from "@/lib/env";
import { resolveAuthContext } from "@/lib/auth";
import { sandboxHealthCheck } from "@/lib/agent/sandbox";

export async function GET(request: Request) {
  const auth = await resolveAuthContext(request);

  let sandboxOnline = false;
  if (env.AGENT_ENABLED) {
    sandboxOnline = await sandboxHealthCheck().catch(() => false);
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
