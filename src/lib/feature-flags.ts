import { env } from "@/lib/env";

export function mailOutboundReady(): boolean {
  return Boolean(env.MAIL_SMTP_HOST && env.MAIL_SMTP_USER && env.MAIL_SMTP_PASS);
}

export function mailInboundEnabled(): boolean {
  return (
    env.MAIL_INBOUND_ENABLED &&
    Boolean(env.MAIL_INBOX_HOST && env.MAIL_INBOX_USER && env.MAIL_INBOX_PASS)
  );
}

export function ntfyReady(): boolean {
  return Boolean(env.NTFY_BASE_URL);
}
