import { NextResponse } from "next/server";

export function requireCsrfHeader(request: Request): NextResponse | null {
  if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") {
    return null;
  }

  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    return null;
  }

  const header = request.headers.get("x-requested-with");
  if (header !== "ChatInterface") {
    return NextResponse.json(
      { error: "Missing or invalid CSRF header." },
      { status: 403 },
    );
  }

  return null;
}
