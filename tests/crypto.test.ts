import { describe, expect, it } from "vitest";

import {
  decodeKeyFromBase64,
  decryptBuffer,
  decryptString,
  encryptBuffer,
  encryptString,
  generateRandomKeyBase64,
} from "@/lib/crypto";

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

  it("encrypts and decrypts binary payloads", () => {
    const key = decodeKeyFromBase64(generateRandomKeyBase64(), "test-key");
    const input = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255]);

    const cipher = encryptBuffer(input, key);
    const output = decryptBuffer(cipher, key);

    expect(output.equals(input)).toBe(true);
  });
});
