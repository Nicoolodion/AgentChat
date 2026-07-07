import { NextResponse } from "next/server";
import { z } from "zod";
import { randomBytes } from "node:crypto";

import { resolveMobileAuth } from "@/lib/mobile-auth";
import { prisma } from "@/lib/prisma";
import { mailOutboundReady } from "@/lib/feature-flags";
import { sendMail } from "@/lib/mail/send-mail";

const requestSchema = z.object({
  address: z.string().email().max(254),
});

/**
 * POST /api/mobile/email/verify/request
 * Set (or update) the user's verified email address. Sends a signed
 * verification link; clicking it flips `verifiedAt` so inbound emails from
 * this address are trusted (and completion emails are delivered here).
 */
export async function POST(request: Request) {
  const auth = await resolveMobileAuth(request);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid email" }, { status: 400 });

  const address = parsed.data.address.toLowerCase().trim();

  // Upsert the email row: one address per user, one user per address.
  const existing = await prisma.userEmail.findFirst({
    where: { OR: [{ userId: auth.userId }, { address }] },
  });
  const verifyToken = randomBytes(24).toString("hex");

  if (existing && existing.userId !== auth.userId) {
    return NextResponse.json({ error: "Email already associated with another account" }, { status: 409 });
  }

  await prisma.userEmail.upsert({
    where: { userId: auth.userId },
    create: {
      userId: auth.userId,
      address,
      verifyToken,
    },
    update: {
      address,
      verifyToken,
      verifiedAt: null,
    },
  });

  const baseUrl = (process.env.PUBLIC_BASE_URL ?? "https://chat.nicoolodion.com").replace(/\/$/, "");
  const link = `${baseUrl}/api/email/verify?token=${verifyToken}`;

  if (mailOutboundReady()) {
    const res = await sendMail({
      to: address,
      subject: "Verify your email — Chatinterface Agent",
      text: `Click the link to verify your email:\n${link}\n\nThis link confirms that ${address} belongs to your account so the agent can email you task results and accept email replies.`,
      html: `<p>Click <a href="${link}">here</a> to verify your email.</p><p style="color:#64748b;font-size:12px;">This link confirms that ${address} belongs to your account so the agent can email you task results and accept email replies.</p>`,
    });
    if (!res.ok) {
      return NextResponse.json({ error: "Failed to send verification email", detail: res.error }, { status: 502 });
    }
  }

  return NextResponse.json({ ok: true, address, sent: mailOutboundReady() });
}
