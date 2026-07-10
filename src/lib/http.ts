import { NextResponse } from "next/server";

export function requestIp(request: Request): string {
  const fwd = request.headers.get("x-forwarded-for");
  if (fwd) {
    const first = fwd.split(",")[0]?.trim() ?? "";
    if (isValidIp(first)) return first;
  }
  const realIp = request.headers.get("x-real-ip")?.trim() ?? "";
  if (isValidIp(realIp)) return realIp;
  return "unknown";
}

function isValidIp(ip: string): boolean {
  if (!ip) return false;
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) || /^[0-9a-fA-F:]+$/.test(ip);
}

export function jsonError(message: string, status = 400): NextResponse {
  return NextResponse.json({ error: message }, { status });
}
