import nodemailer, { type Transporter } from "nodemailer";

import { env } from "@/lib/env";
import { mailOutboundReady } from "@/lib/feature-flags";

let transporter: Transporter | null = null;

function getTransporter(): Transporter {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: env.MAIL_SMTP_HOST,
      port: env.MAIL_SMTP_PORT,
      secure: env.MAIL_SMTP_SECURE,
      auth:
        env.MAIL_SMTP_USER && env.MAIL_SMTP_PASS
          ? { user: env.MAIL_SMTP_USER, pass: env.MAIL_SMTP_PASS }
          : undefined,
      pool: true,
      maxConnections: 5,
      maxMessages: 100,
    });
  }
  return transporter;
}

export type SendMailInput = {
  to: string;
  subject: string;
  text?: string;
  html?: string;
  attachments?: Array<{
    filename: string;
    content: Buffer | string;
    contentType?: string;
    cid?: string;
  }>;
  messageId?: string;
  inReplyTo?: string;
  references?: string[];
  headers?: Record<string, string>;
};

export type SendMailResult = { ok: boolean; messageId?: string; error?: string };

/**
 * sendMail — pooled SMTP outbound. No-op (returns ok:false) when SMTP is not
 * configured, so callers can decide whether a missing email is fatal.
 */
export async function sendMail(input: SendMailInput): Promise<SendMailResult> {
  if (!mailOutboundReady()) {
    return { ok: false, error: "SMTP not configured" };
  }

  const extraHeaders: Record<string, string> = { ...(input.headers ?? {}) };
  if (input.messageId) extraHeaders["Message-ID"] = input.messageId;
  if (input.inReplyTo) extraHeaders["In-Reply-To"] = input.inReplyTo;
  if (input.references && input.references.length > 0) {
    extraHeaders["References"] = input.references.join(" ");
  }

  try {
    const info = await getTransporter().sendMail({
      from: env.MAIL_FROM,
      to: input.to,
      subject: input.subject,
      text: input.text,
      html: input.html,
      attachments: input.attachments,
      headers: extraHeaders,
    });
    return { ok: true, messageId: info.messageId };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[Mailer sendMail error]", msg);
    return { ok: false, error: msg };
  }
}
