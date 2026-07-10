import { z } from "zod";

const boolLike = z
  .union([z.boolean(), z.string()])
  .transform((value) => {
    if (typeof value === "boolean") return value;
    const normalized = value.trim().toLowerCase();
    return ["1", "true", "yes", "on"].includes(normalized);
  });

const KNOWN_BAD_KEYS = new Set([
  "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
  "ZmVkY2JhOTg3NjU0MzIxMGZlZGNiYTk4NzY1NDMyMTA=",
]);

const base64KeySchema = z.string().refine((val) => {
  if (KNOWN_BAD_KEYS.has(val)) {
    return false;
  }
  try {
    const decoded = Buffer.from(val, "base64");
    return decoded.length === 32;
  } catch {
    return false;
  }
}, "Encryption key must be a valid base64-encoded 32-byte key (not the default)");

const envSchema = z.object({
  DATABASE_URL: z.string().default("file:./prisma/dev.db"),
  NANOGPT_API_KEY: z.string().optional(),
  NANOGPT_BASE_URL: z.string().url().default("https://nano-gpt.com/api/v1"),
  NEURALWATT_API_KEY: z.string().optional(),
  NEURALWATT_BASE_URL: z.string().url().default("https://api.neuralwatt.com/v1"),
  DEFAULT_MODEL: z.string().default("moonshotai/kimi-k2.6:thinking"),
  TITLE_MODEL: z.string().default("Qwen/Qwen3.6-35B-A3B"),
  AUTH_REQUIRED: boolLike.default(true),
  REGISTRATION_ENABLED: boolLike.default(true),
  COOKIE_NAME: z.string().default("chatinterface_session"),
  COOKIE_SECURE: boolLike.optional(),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(24 * 7),
  APP_ENCRYPTION_KEY: base64KeySchema.default(
    "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="
  ),
  SESSION_ENCRYPTION_KEY: base64KeySchema.default(
    "ZmVkY2JhOTg3NjU0MzIxMGZlZGNiYTk4NzY1NDMyMTA="
  ),
  GUEST_USERNAME: z.string().default("local-user"),
  RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(25),
  DATA_DIR: z.string().default("data"),
  // Agent configuration
  AGENT_ENABLED: boolLike.default(true),
  AGENT_SANDBOX_URL: z.string().default("http://127.0.0.1:18080"),
  AGENT_MAX_TOOL_CALLS: z.coerce.number().int().positive().default(50),
  AGENT_IMAGE_ANALYZE_MAX_BATCH: z.coerce.number().int().positive().default(15),
  AGENT_IMAGE_ANALYZE_MAX_CONCURRENCY: z.coerce.number().int().positive().default(2),
  AGENT_WORKSPACE_DIR: z.string().default("data/agent-workspaces"),
  // Optional override models for image analysis. When set, image_analyze routes
  // to AGENT_VISION_MODEL first (instead of the session model) and falls back to
  // AGENT_VISION_FALLBACK_MODEL on a refusal / empty response before retrying.
  AGENT_VISION_MODEL: z.string().optional(),
  AGENT_VISION_FALLBACK_MODEL: z.string().optional(),
  // Local OCR engine (llama.cpp + PaddleOCR-VL-1.6 in the agent sandbox). When
  // false, the OCR tool is never advertised to the agent (no sandbox probe).
  AGENT_OCR_ENABLED: boolLike.default(true),
  SEARXNG_URL: z.string().optional(),

  // ── Mobile Task Launcher / Email-reply feature ───────────────────────────
  // Mobile bearer tokens mirror Session TTL by default (7 days).
  MOBILE_TOKEN_TTL_HOURS: z.coerce.number().int().positive().default(24 * 7),
  // Title (subject line) model for task emails; defaults to TITLE_MODEL.
  TASK_TITLE_MODEL: z.string().optional(),

  // Outbound mail (SMTP) — all optional. When MAIL_SMTP_HOST is unset the app
  // skips the email-completion path entirely (push-only or nothing).
  MAIL_FROM: z.string().default("agent@nicoolodion.com"),
  MAIL_SMTP_HOST: z.string().optional(),
  MAIL_SMTP_PORT: z.coerce.number().int().positive().default(587),
  MAIL_SMTP_SECURE: boolLike.default(false),
  MAIL_SMTP_USER: z.string().optional(),
  MAIL_SMTP_PASS: z.string().optional(),

  // Inbound mail (IMAP poller). Disable with MAIL_INBOUND_ENABLED=false.
  MAIL_INBOUND_ENABLED: boolLike.default(true),
  MAIL_INBOX_HOST: z.string().optional(),
  MAIL_INBOX_PORT: z.coerce.number().int().positive().default(993),
  MAIL_INBOX_USER: z.string().optional(),
  MAIL_INBOX_PASS: z.string().optional(),
  MAIL_INBOX_POLL_SECONDS: z.coerce.number().int().positive().default(30),

  // Push (self-hosted ntfy / UnifiedPush). No Firebase.
  NTFY_BASE_URL: z.string().optional(),
  NTFY_DEFAULT_AUTH: z.string().optional(),
});

export const env = envSchema.parse({
  DATABASE_URL: process.env.DATABASE_URL,
  NANOGPT_API_KEY: process.env.NANOGPT_API_KEY,
  NANOGPT_BASE_URL: process.env.NANOGPT_BASE_URL,
  NEURALWATT_API_KEY: process.env.NEURALWATT_API_KEY,
  NEURALWATT_BASE_URL: process.env.NEURALWATT_BASE_URL,
  DEFAULT_MODEL: process.env.DEFAULT_MODEL,
  TITLE_MODEL: process.env.TITLE_MODEL,
  AUTH_REQUIRED: process.env.AUTH_REQUIRED,
  REGISTRATION_ENABLED: process.env.REGISTRATION_ENABLED,
  COOKIE_NAME: process.env.COOKIE_NAME,
  COOKIE_SECURE: process.env.COOKIE_SECURE,
  SESSION_TTL_HOURS: process.env.SESSION_TTL_HOURS,
  APP_ENCRYPTION_KEY: process.env.APP_ENCRYPTION_KEY,
  SESSION_ENCRYPTION_KEY: process.env.SESSION_ENCRYPTION_KEY,
  GUEST_USERNAME: process.env.GUEST_USERNAME,
  RATE_LIMIT_WINDOW_SECONDS: process.env.RATE_LIMIT_WINDOW_SECONDS,
  RATE_LIMIT_MAX_REQUESTS: process.env.RATE_LIMIT_MAX_REQUESTS,
  DATA_DIR: process.env.DATA_DIR,
  AGENT_ENABLED: process.env.AGENT_ENABLED,
  AGENT_SANDBOX_URL: process.env.AGENT_SANDBOX_URL,
  AGENT_MAX_TOOL_CALLS: process.env.AGENT_MAX_TOOL_CALLS,
  AGENT_IMAGE_ANALYZE_MAX_BATCH: process.env.AGENT_IMAGE_ANALYZE_MAX_BATCH,
  AGENT_IMAGE_ANALYZE_MAX_CONCURRENCY: process.env.AGENT_IMAGE_ANALYZE_MAX_CONCURRENCY,
  AGENT_WORKSPACE_DIR: process.env.AGENT_WORKSPACE_DIR,
  AGENT_VISION_MODEL: process.env.AGENT_VISION_MODEL,
  AGENT_VISION_FALLBACK_MODEL: process.env.AGENT_VISION_FALLBACK_MODEL,
  AGENT_OCR_ENABLED: process.env.AGENT_OCR_ENABLED,
  SEARXNG_URL: process.env.SEARXNG_URL,
  MOBILE_TOKEN_TTL_HOURS: process.env.MOBILE_TOKEN_TTL_HOURS,
  TASK_TITLE_MODEL: process.env.TASK_TITLE_MODEL,
  MAIL_FROM: process.env.MAIL_FROM,
  MAIL_SMTP_HOST: process.env.MAIL_SMTP_HOST,
  MAIL_SMTP_PORT: process.env.MAIL_SMTP_PORT,
  MAIL_SMTP_SECURE: process.env.MAIL_SMTP_SECURE,
  MAIL_SMTP_USER: process.env.MAIL_SMTP_USER,
  MAIL_SMTP_PASS: process.env.MAIL_SMTP_PASS,
  MAIL_INBOUND_ENABLED: process.env.MAIL_INBOUND_ENABLED,
  MAIL_INBOX_HOST: process.env.MAIL_INBOX_HOST,
  MAIL_INBOX_PORT: process.env.MAIL_INBOX_PORT,
  MAIL_INBOX_USER: process.env.MAIL_INBOX_USER,
  MAIL_INBOX_PASS: process.env.MAIL_INBOX_PASS,
  MAIL_INBOX_POLL_SECONDS: process.env.MAIL_INBOX_POLL_SECONDS,
  NTFY_BASE_URL: process.env.NTFY_BASE_URL,
  NTFY_DEFAULT_AUTH: process.env.NTFY_DEFAULT_AUTH,
});
