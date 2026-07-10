import { hash, verify } from "@node-rs/argon2";

const PASSWORD_RULE = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{10,128}$/;

export function validatePasswordStrength(password: string): boolean {
  return PASSWORD_RULE.test(password);
}

function getHashOptions() {
  const isProduction = process.env.NODE_ENV === "production";
  return {
    algorithm: 2 as const,
    memoryCost: isProduction ? 65_536 : 19_456,
    timeCost: isProduction ? 3 : 2,
    parallelism: 1,
  };
}

export async function hashPassword(password: string): Promise<string> {
  return hash(password, getHashOptions());
}

export async function verifyPasswordHash(password: string, passwordHash: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch (error) {
    void import("@/lib/logger")
      .then((m) => m.log.warn("Password hash verification threw — treating as invalid credentials.", {
        name: error instanceof Error ? error.name : String(error),
        message: error instanceof Error ? error.message : undefined,
      }))
      .catch(() => undefined);
    return false;
  }
}

let dummyHashCache: string | null = null;

export async function getDummyPasswordHash(): Promise<string> {
  if (!dummyHashCache) {
    dummyHashCache = await hash("dummy", getHashOptions());
  }
  return dummyHashCache;
}
