import { NextResponse } from "next/server";
import { z } from "zod";

import { processInboundEmail, type InboundEmail } from "@/lib/mailbox";
import { mailInboundEnabled } from "@/lib/feature-flags";

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

/**
 * POST /api/email/inbound
 * Thin HTTP shim that feeds a parsed-mail JSON into the same processInboundEmail
 * core the IMAP poller uses. In production the IMAP poller is the source of
 * truth; this route makes the pipeline testable end-to-end without a live
 * mailbox. Disabled (503) when MAIL_INBOUND_ENABLED=false.
 */
export async function POST(request: Request) {
  if (!mailInboundEnabled()) {
    return NextResponse.json({ error: "Inbound email is disabled" }, { status: 503 });
  }
  const parsed = inboundSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request body", detail: parsed.error.issues }, { status: 400 });
  }
  const email: InboundEmail = {
    from: parsed.data.from,
    subject: parsed.data.subject,
    text: parsed.data.text,
    html: parsed.data.html,
    messageId: parsed.data.messageId,
    inReplyTo: parsed.data.inReplyTo,
    references: parsed.data.references,
    headers: parsed.data.headers,
  };
  try {
    await processInboundEmail(email);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: "Failed to process inbound email", detail: msg }, { status: 500 });
  }
}
