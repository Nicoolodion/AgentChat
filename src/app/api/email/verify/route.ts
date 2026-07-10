import { prisma } from "@/lib/prisma";

/**
 * GET /api/email/verify?token=...
 * Public verification endpoint (the link is the secret, signed via a per-row
 * random token). Flips `verifiedAt` on the matching UserEmail row.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  if (!token || !/^[a-f0-9]{16,128}$/i.test(token)) {
    return new Response("Invalid verification link", { status: 400 });
  }

  const row = await prisma.userEmail.findFirst({
    where: { verifyToken: token },
    select: { id: true, verifiedAt: true, address: true },
  });
  if (!row) return new Response("Verification link not found or already used", { status: 404 });

  if (!row.verifiedAt) {
    await prisma.userEmail.update({
      where: { id: row.id },
      data: { verifiedAt: new Date(), verifyToken: null },
    });
  }

  return new Response(
    `<html><body style="font-family:sans-serif;padding:2rem"><h1>Email verified</h1><p>${escapeHtml(String(row.address))} is now linked to your account. You can close this tab.</p></body></html>`,
    { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return c;
    }
  });
}
