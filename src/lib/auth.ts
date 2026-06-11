import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import {
  decodeKeyFromBase64,
  decryptString,
  deriveKeyFromPassword,
  encryptString,
  generateRandomKeyBase64,
  generateSaltBase64,
} from "@/lib/crypto";
import { env } from "@/lib/env";
import { hashPassword, verifyPasswordHash } from "@/lib/password";
import { prisma } from "@/lib/prisma";

export type AuthContext = {
  userId: string;
  username: string;
  userKey: Buffer;
  isGuest: boolean;
};

const USERNAME_RULE = /^[a-zA-Z0-9_\-.]{3,32}$/;

function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

export function validateUsername(username: string): boolean {
  return USERNAME_RULE.test(username);
}

function createSessionToken(): string {
  return randomBytes(48).toString("base64url");
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function getSessionKey(): Buffer {
  return decodeKeyFromBase64(env.SESSION_ENCRYPTION_KEY, "SESSION_ENCRYPTION_KEY");
}

function getGuestUserKey(): Buffer {
  return decodeKeyFromBase64(env.APP_ENCRYPTION_KEY, "APP_ENCRYPTION_KEY");
}

async function ensureGuestUser(): Promise<{ id: string; username: string }> {
  const user = await prisma.user.upsert({
    where: { username: normalizeUsername(env.GUEST_USERNAME) },
    update: {},
    create: {
      username: normalizeUsername(env.GUEST_USERNAME),
      passwordHash: "auth-disabled",
      keyDerivationSalt: "auth-disabled",
      wrappedUserKey: "auth-disabled",
      isSystem: true,
    },
    select: { id: true, username: true },
  });

  return user;
}

function parseCookie(headerValue: string | null, key: string): string | null {
  if (!headerValue) return null;
  const chunks = headerValue.split(";");
  for (const rawChunk of chunks) {
    const chunk = rawChunk.trim();
    if (!chunk.startsWith(`${key}=`)) continue;
    return decodeURIComponent(chunk.slice(key.length + 1));
  }
  return null;
}

async function loadSessionByToken(token: string): Promise<AuthContext | null> {
  const tokenHash = hashToken(token);
  const session = await prisma.session.findUnique({
    where: { tokenHash },
    include: { user: true },
  });

  if (!session) return null;
  if (session.expiresAt.getTime() <= Date.now()) {
    await prisma.session.delete({ where: { id: session.id } });
    return null;
  }

  const userKeyBase64 = decryptString(session.wrappedUserKey, getSessionKey());
  const userKey = decodeKeyFromBase64(userKeyBase64, "wrapped user key");

  return {
    userId: session.user.id,
    username: session.user.username,
    userKey,
    isGuest: false,
  };
}

export async function resolveAuthContext(request: Request): Promise<AuthContext | null> {
  if (!env.AUTH_REQUIRED) {
    const guest = await ensureGuestUser();
    return {
      userId: guest.id,
      username: guest.username,
      userKey: getGuestUserKey(),
      isGuest: true,
    };
  }

  const token = parseCookie(request.headers.get("cookie"), env.COOKIE_NAME);
  if (!token) return null;
  return loadSessionByToken(token);
}

export async function resolveServerAuthContext(): Promise<AuthContext | null> {
  if (!env.AUTH_REQUIRED) {
    const guest = await ensureGuestUser();
    return {
      userId: guest.id,
      username: guest.username,
      userKey: getGuestUserKey(),
      isGuest: true,
    };
  }

  const cookieStore = await cookies();
  const token = cookieStore.get(env.COOKIE_NAME)?.value;
  if (!token) return null;
  return loadSessionByToken(token);
}

export async function registerUser(username: string, password: string): Promise<void> {
  const normalizedUsername = normalizeUsername(username);
  if (!validateUsername(normalizedUsername)) {
    throw new Error("Username must be 3-32 chars and use letters, numbers, -, _, or .");
  }

  const existing = await prisma.user.findUnique({ where: { username: normalizedUsername } });
  if (existing) {
    throw new Error("Username already exists.");
  }

  const passwordHash = await hashPassword(password);
  const keyDerivationSalt = generateSaltBase64();
  const passwordDerivedKey = await deriveKeyFromPassword(password, keyDerivationSalt);

  const userKeyBase64 = generateRandomKeyBase64();
  const wrappedUserKey = encryptString(userKeyBase64, passwordDerivedKey);

  await prisma.user.create({
    data: {
      username: normalizedUsername,
      passwordHash,
      keyDerivationSalt,
      wrappedUserKey,
    },
  });
}

export async function loginUser(
  username: string,
  password: string,
): Promise<{ token: string; username: string }> {
  const normalizedUsername = normalizeUsername(username);
  const user = await prisma.user.findUnique({ where: { username: normalizedUsername } });
  if (!user) {
    throw new Error("Invalid username or password.");
  }

  const ok = await verifyPasswordHash(password, user.passwordHash);
  if (!ok) {
    throw new Error("Invalid username or password.");
  }

  const passwordDerivedKey = await deriveKeyFromPassword(password, user.keyDerivationSalt);
  const userKeyBase64 = decryptString(user.wrappedUserKey, passwordDerivedKey);
  const wrappedSessionUserKey = encryptString(userKeyBase64, getSessionKey());

  const token = createSessionToken();
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + env.SESSION_TTL_HOURS * 60 * 60 * 1000);

  await prisma.session.create({
    data: {
      userId: user.id,
      tokenHash,
      wrappedUserKey: wrappedSessionUserKey,
      expiresAt,
    },
  });

  return { token, username: user.username };
}

export async function logoutUser(token: string | null): Promise<void> {
  if (!token) return;
  const tokenHash = hashToken(token);
  await prisma.session.deleteMany({ where: { tokenHash } });
}

export function writeSessionCookie(response: NextResponse, token: string): void {
  response.cookies.set({
    name: env.COOKIE_NAME,
    value: token,
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: env.SESSION_TTL_HOURS * 60 * 60,
  });
}

export function clearSessionCookie(response: NextResponse): void {
  response.cookies.set({
    name: env.COOKIE_NAME,
    value: "",
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 0,
  });
}

export function readSessionTokenFromRequest(request: Request): string | null {
  return parseCookie(request.headers.get("cookie"), env.COOKIE_NAME);
}

export async function cleanupExpiredSessions(): Promise<number> {
  const result = await prisma.session.deleteMany({
    where: { expiresAt: { lte: new Date() } },
  });
  return result.count;
}

let cleanupTimer: ReturnType<typeof setInterval> | null = null;

export function startSessionCleanup(intervalMs = 60 * 60 * 1000): void {
  void cleanupExpiredSessions();
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    void cleanupExpiredSessions().catch(() => {});
  }, intervalMs);
}
