import { prisma } from "@/lib/prisma";

export async function enforceRateLimit(
  key: string,
  maxRequests: number,
  windowSeconds: number,
): Promise<{ ok: boolean; retryAfterSeconds: number }> {
  const now = new Date();
  const resetAt = new Date(Date.now() + windowSeconds * 1000);

  const incremented = await prisma.rateLimitBucket.updateMany({
    where: { key, count: { lt: maxRequests }, resetAt: { gt: now } },
    data: { count: { increment: 1 } },
  });

  if (incremented.count > 0) {
    return { ok: true, retryAfterSeconds: 0 };
  }

  const existing = await prisma.rateLimitBucket.findUnique({ where: { key } });

  if (!existing || existing.resetAt <= now) {
    await prisma.rateLimitBucket.upsert({
      where: { key },
      create: { key, count: 1, resetAt },
      update: { count: 1, resetAt },
    });
    return { ok: true, retryAfterSeconds: 0 };
  }

  const retryAfterSeconds = Math.max(1, Math.ceil((existing.resetAt.getTime() - Date.now()) / 1000));
  return { ok: false, retryAfterSeconds };
}

export async function cleanupExpiredBuckets(): Promise<number> {
  const result = await prisma.rateLimitBucket.deleteMany({
    where: { resetAt: { lte: new Date() } },
  });
  return result.count;
}
