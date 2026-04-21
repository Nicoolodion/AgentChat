import { NextResponse } from "next/server";

import { clearSessionCookie, logoutUser, readSessionTokenFromRequest } from "@/lib/auth";

export async function POST(request: Request) {
  const token = readSessionTokenFromRequest(request);
  await logoutUser(token);

  const response = NextResponse.json({ ok: true });
  clearSessionCookie(response);
  return response;
}
