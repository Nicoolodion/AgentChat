import { randomBytes } from "node:crypto";

import { decodeKeyFromBase64, decryptString, encryptString, unwrapUserKey } from "@/lib/crypto";
import { env } from "@/lib/env";
import { getSessionKey, hashToken } from "@/lib/keys";
import { getDummyPasswordHash, verifyPasswordHash } from "@/lib/password";
import { prisma } from "@/lib/prisma";

export type MobileAuthContext = {
  userId: string;
  username: string;
  userKey: Buffer;
  tokenId: string;
};

export function createMobileToken(): string {
  return randomBytes(48).toString("base64url");
}

/**
 * Resolve a mobile bearer token against the UserMobileToken table, mirroring the
 * cookie-session pattern in auth.ts: token hash lookup, expiry check, and
 * decryption of the per-user AES key wrapped under the session key. Unlike
 * sessions, the userKey here is re-derived from the user's password-wrapped key
 * via the shared SESSION_ENCRYPTION_KEY — so the mobile context carries the
 * exact same userKey used everywhere else for at-rest encryption.
 */
export async function resolveMobileAuth(request: Request): Promise<MobileAuthContext | null> {
  const header = request.headers.get("authorization") ?? "";
  if (!header.toLowerCase().startsWith("bearer ")) return null;
  const token = header.slice(7).trim();
  if (!token) return null;

  const tokenHash = hashToken(token);
  const record = await prisma.userMobileToken.findUnique({
    where: { tokenHash },
    include: { user: true },
  });
  if (!record) return null;

  if (record.expiresAt.getTime() <= Date.now()) {
    await prisma.userMobileToken.delete({ where: { id: record.id } }).catch(() => undefined);
    return null;
  }

  // The userKey is persisted on the token row wrapped under the shared
  // SESSION_ENCRYPTION_KEY (exact mirror of the Session.wrappedUserKey pattern).
  // This lets the mobile context carry the same AES key used everywhere else
  // for at-rest decryption, without needing the user's password at request time.
  const userKeyBase64 = decryptString(record.wrappedUserKeyCipher, getSessionKey());
  const userKey = decodeKeyFromBase64(userKeyBase64, "mobile wrapped user key");

  await prisma.userMobileToken.update({
    where: { id: record.id },
    data: { lastSeenAt: new Date() },
  }).catch(() => undefined);

  return {
    userId: record.user.id,
    username: record.user.username,
    userKey,
    tokenId: record.id,
  };
}

/**
 * Pair a username+password with a device, returning a bearer token. Mirrors
 * loginUser(): verify the password, derive the password key, decrypt the
 * userKey, re-wrap it under the session key, and persist a new
 * UserMobileToken row carrying the wrapped key + a fresh ntfy topic.
 */
export async function pairMobileDevice(input: {
  username: string;
  password: string;
  installId: string;
  label?: string;
}): Promise<{ token: string; userId: string; ntfyTopic: string; ntfyAuth: string | null } | null> {
  const normalized = input.username.trim().toLowerCase();
  const user = await prisma.user.findUnique({ where: { username: normalized } });
  if (!user) {
    await verifyPasswordHash(input.password, await getDummyPasswordHash());
    return null;
  }

  const ok = await verifyPasswordHash(input.password, user.passwordHash);
  if (!ok) return null;

  const { userKeyBase64, rewrappedUserKey } = await unwrapUserKey(
    user.wrappedUserKey,
    input.password,
    user.keyDerivationSalt,
  );
  if (rewrappedUserKey) {
    await prisma.user.update({
      where: { id: user.id },
      data: { wrappedUserKey: rewrappedUserKey },
    });
  }
  const wrappedSessionUserKey = encryptString(userKeyBase64, getSessionKey());

  const token = createMobileToken();
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + env.MOBILE_TOKEN_TTL_HOURS * 60 * 60 * 1000);
  const topicSuffix = randomBytes(8).toString("hex");
  const ntfyTopic = `user-${user.id}-${topicSuffix}`;
  const ntfyAuth = env.NTFY_DEFAULT_AUTH ?? null;

  await prisma.userMobileToken.create({
    data: {
      userId: user.id,
      wrappedUserKeyCipher: wrappedSessionUserKey,
      tokenHash,
      installId: input.installId,
      label: input.label ?? null,
      ntfyTopic,
      ntfyAuth,
      expiresAt,
    },
  });

  return { token, userId: user.id, ntfyTopic, ntfyAuth };
}
