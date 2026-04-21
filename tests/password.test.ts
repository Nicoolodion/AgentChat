import { describe, expect, it } from "vitest";

import { hashPassword, validatePasswordStrength, verifyPasswordHash } from "@/lib/password";

describe("password helpers", () => {
  it("validates password complexity policy", () => {
    expect(validatePasswordStrength("weakpass")).toBe(false);
    expect(validatePasswordStrength("StrongPass123")).toBe(true);
  });

  it("hashes and verifies passwords", async () => {
    const password = "StrongPass123";
    const passwordHash = await hashPassword(password);

    await expect(verifyPasswordHash(password, passwordHash)).resolves.toBe(true);
    await expect(verifyPasswordHash("wrong-password", passwordHash)).resolves.toBe(false);
  });
});
