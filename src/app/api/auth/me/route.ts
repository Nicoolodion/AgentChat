import { NextResponse } from "next/server";

import { env } from "@/lib/env";
import { resolveAuthContext } from "@/lib/auth";

export async function GET(request: Request) {
  const auth = await resolveAuthContext(request);

  return NextResponse.json({
    authenticated: Boolean(auth),
    authRequired: env.AUTH_REQUIRED,
    registrationEnabled: env.REGISTRATION_ENABLED,
    user: auth
      ? {
          id: auth.userId,
          username: auth.username,
          isGuest: auth.isGuest,
        }
      : null,
  });
}
