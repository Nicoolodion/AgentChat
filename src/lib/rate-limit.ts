import { prisma } from "@/lib/prisma";

export async function enforceRateLimit(
  key: string,
  maxRequests: number,
  windowSeconds: number,
): Promise<{ ok: boolean; retryAfterSeconds: number }> {
  const now = new Date();

  const current = await prisma.rateLimitBucket.findUnique({ where: { key } });

  if (!current || current.resetAt <= now) {
    await prisma.rateLimitBucket.upsert({
      where: { key },
      create: { key, count: 1, resetAt: new Date(Date.now() + windowSeconds * 1000) },
      update: { count: 1, resetAt: new Date(Date.now() + windowSeconds * 1000) },
    });
    return { ok: true, retryAfterSeconds: 0 };
  }

  if (current.count >= maxRequests) {
    const retryAfterSeconds = Math.max(1, Math.ceil((current.resetAt.getTime() - Date.now()) / 1000));
    return { ok: false, retryAfterSeconds };
  }

  await prisma.rateLimitBucket.update({
    where: { key },
    data: { count: current.count + 1 },
  });
  return { ok: true, retryAfterSeconds: 0 };
}

export async function cleanupExpiredBuckets(): Promise<number> {
  const result = await prisma.rateLimitBucket.deleteMany({
    where: { resetAt: { lte: new Date() } },
  });
  return result.count;
}
