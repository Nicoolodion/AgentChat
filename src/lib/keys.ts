import { createHash } from "node:crypto";

import { decodeKeyFromBase64 } from "@/lib/crypto";
import { env } from "@/lib/env";

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function getSessionKey(): Buffer {
  return decodeKeyFromBase64(env.SESSION_ENCRYPTION_KEY, "SESSION_ENCRYPTION_KEY");
}
