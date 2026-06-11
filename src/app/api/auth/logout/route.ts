import { NextResponse } from "next/server";

import { clearSessionCookie, logoutUser, readSessionTokenFromRequest } from "@/lib/auth";
import { requireCsrfHeader } from "@/lib/csrf";

export async function POST(request: Request) {
  const csrfError = requireCsrfHeader(request);
  if (csrfError) return csrfError;

  const token = readSessionTokenFromRequest(request);
  await logoutUser(token);

  const response = NextResponse.json({ ok: true });
  clearSessionCookie(response);
  return response;
}
