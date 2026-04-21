import { z } from "zod";

const boolLike = z
  .union([z.boolean(), z.string()])
  .transform((value) => {
    if (typeof value === "boolean") return value;
    const normalized = value.trim().toLowerCase();
    return ["1", "true", "yes", "on"].includes(normalized);
  });

const envSchema = z.object({
  DATABASE_URL: z.string().default("file:./prisma/dev.db"),
  NANOGPT_API_KEY: z.string().optional(),
  NANOGPT_BASE_URL: z.string().url().default("https://nano-gpt.com/api"),
  DEFAULT_MODEL: z.string().default("gpt-4o-mini"),
  TITLE_MODEL: z.string().default("Qwen/Qwen3.6-35B-A3B"),
  AUTH_REQUIRED: boolLike.default(true),
  REGISTRATION_ENABLED: boolLike.default(true),
  COOKIE_NAME: z.string().default("chatinterface_session"),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(24 * 7),
  APP_ENCRYPTION_KEY: z
    .string()
    .default("MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="),
  SESSION_ENCRYPTION_KEY: z
    .string()
    .default("ZmVkY2JhOTg3NjU0MzIxMGZlZGNiYTk4NzY1NDMyMTA="),
  GUEST_USERNAME: z.string().default("local-user"),
  RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(25),
});

export const env = envSchema.parse({
  DATABASE_URL: process.env.DATABASE_URL,
  NANOGPT_API_KEY: process.env.NANOGPT_API_KEY,
  NANOGPT_BASE_URL: process.env.NANOGPT_BASE_URL,
  DEFAULT_MODEL: process.env.DEFAULT_MODEL,
  TITLE_MODEL: process.env.TITLE_MODEL,
  AUTH_REQUIRED: process.env.AUTH_REQUIRED,
  REGISTRATION_ENABLED: process.env.REGISTRATION_ENABLED,
  COOKIE_NAME: process.env.COOKIE_NAME,
  SESSION_TTL_HOURS: process.env.SESSION_TTL_HOURS,
  APP_ENCRYPTION_KEY: process.env.APP_ENCRYPTION_KEY,
  SESSION_ENCRYPTION_KEY: process.env.SESSION_ENCRYPTION_KEY,
  GUEST_USERNAME: process.env.GUEST_USERNAME,
  RATE_LIMIT_WINDOW_SECONDS: process.env.RATE_LIMIT_WINDOW_SECONDS,
  RATE_LIMIT_MAX_REQUESTS: process.env.RATE_LIMIT_MAX_REQUESTS,
});
