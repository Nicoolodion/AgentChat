import { NextResponse } from "next/server";
import { z } from "zod";
import { timingSafeEqual } from "node:crypto";

import { processInboundEmail, type InboundEmail } from "@/lib/mailbox";
import { mailInboundEnabled } from "@/lib/feature-flags";
import { log } from "@/lib/logger";

const inboundSchema = z.object({
  from: z.string().min(3),
  subject: z.string().optional().default(""),
  text: z.string().optional().default(""),
  html: z.string().optional(),
  messageId: z.string().optional(),
  inReplyTo: z.string().optional(),
  references: z.array(z.string()).optional(),
  headers: z.record(z.string(), z.string()).optional(),
});

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * POST /api/email/inbound
 * Thin HTTP shim that feeds a parsed-mail JSON into the same processInboundEmail
 * core the IMAP poller uses. In production the IMAP poller is the source of
 * truth; this route makes the pipeline testable end-to-end without a live
 * mailbox. Disabled (503) when MAIL_INBOUND_ENABLED=false.
 *
 * Authenticated via `Authorization: Bearer <MAIL_INBOUND_WEBHOOK_SECRET>`; the
 * route is denied entirely (503) when that secret is unset, and 401 otherwise
 * unless the header matches. The `from` field is only honored from an
 * authenticated caller (the trusted envelope source) — never from an anonymous
 * HTTP body.
 */
export async function POST(request: Request) {
  const secret = process.env.MAIL_INBOUND_WEBHOOK_SECRET;
  if (!secret) {
    log.error("MAIL_INBOUND_WEBHOOK_SECRET is not configured; denying inbound email request");
    return NextResponse.json({ error: "Inbound email webhook is not configured." }, { status: 503 });
  }
  const authHeader = request.headers.get("authorization");
  const provided = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : "";
  if (!provided || !constantTimeEqual(provided, secret)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  if (!mailInboundEnabled()) {
    return NextResponse.json({ error: "Inbound email is disabled." }, { status: 503 });
  }
  const parsed = inboundSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    log.warn("Inbound email request body failed validation", {
      issues: parsed.error.issues,
    });
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  const email: InboundEmail = {
    from: parsed.data.from,
    subject: parsed.data.subject,
    text: parsed.data.text,
    ...(parsed.data.html !== undefined ? { html: parsed.data.html } : {}),
    ...(parsed.data.messageId !== undefined ? { messageId: parsed.data.messageId } : {}),
    ...(parsed.data.inReplyTo !== undefined ? { inReplyTo: parsed.data.inReplyTo } : {}),
    ...(parsed.data.references !== undefined ? { references: parsed.data.references } : {}),
    ...(parsed.data.headers !== undefined ? { headers: parsed.data.headers } : {}),
  };
  try {
    await processInboundEmail(email);
    return NextResponse.json({ ok: true });
  } catch (err) {
    log.error("Failed to process inbound email", {
      err: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Failed to process inbound email." }, { status: 500 });
  }
}
