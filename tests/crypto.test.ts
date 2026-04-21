import { describe, expect, it } from "vitest";

import { decryptString, encryptString, generateRandomKeyBase64, decodeKeyFromBase64 } from "@/lib/crypto";

describe("crypto helpers", () => {
  it("encrypts and decrypts a plaintext value", () => {
    const key = decodeKeyFromBase64(generateRandomKeyBase64(), "test-key");
    const plain = "hello secure world";

    const cipher = encryptString(plain, key);
    const decrypted = decryptString(cipher, key);

    expect(decrypted).toBe(plain);
  });

  it("fails to decrypt with the wrong key", () => {
    const keyA = decodeKeyFromBase64(generateRandomKeyBase64(), "test-key-a");
    const keyB = decodeKeyFromBase64(generateRandomKeyBase64(), "test-key-b");
    const cipher = encryptString("top secret", keyA);

    expect(() => decryptString(cipher, keyB)).toThrow();
  });
});
