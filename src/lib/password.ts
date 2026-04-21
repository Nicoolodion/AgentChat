import { hash, verify } from "@node-rs/argon2";

const PASSWORD_RULE = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{10,128}$/;

export function validatePasswordStrength(password: string): boolean {
  return PASSWORD_RULE.test(password);
}

export async function hashPassword(password: string): Promise<string> {
  return hash(password, {
    // 2 is Argon2id in @node-rs/argon2.
    algorithm: 2,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
  });
}

export async function verifyPasswordHash(password: string, passwordHash: string): Promise<boolean> {
  return verify(passwordHash, password);
}
