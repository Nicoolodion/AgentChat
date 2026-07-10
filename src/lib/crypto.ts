import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCallback } from "node:crypto";

const ALGO = "aes-256-gcm";
const IV_LENGTH = 12;
const KEY_LENGTH = 32;

type EncryptedPayload = {
  v: number;
  iv: string;
  tag: string;
  data: string;
};

function encodePayload(iv: Buffer, tag: Buffer, encrypted: Buffer): string {
  const payload: EncryptedPayload = {
    v: 1,
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    data: encrypted.toString("base64"),
  };

  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}

function decodePayload(cipherText: string): EncryptedPayload {
  let parsed: EncryptedPayload;
  try {
    parsed = JSON.parse(Buffer.from(cipherText, "base64").toString("utf8")) as EncryptedPayload;
  } catch {
    throw new Error("Invalid encrypted payload format.");
  }
  if (!parsed || typeof parsed.v !== "number" || parsed.v !== 1 || !parsed.data || !parsed.iv || !parsed.tag) {
    throw new Error("Invalid encrypted payload format.");
  }

  return parsed;
}

export function decodeKeyFromBase64(base64Key: string, label: string): Buffer {
  const decoded = Buffer.from(base64Key, "base64");
  if (decoded.length !== KEY_LENGTH) {
    throw new Error(`${label} must decode to ${KEY_LENGTH} bytes.`);
  }
  return decoded;
}

export function generateRandomKeyBase64(): string {
  return randomBytes(KEY_LENGTH).toString("base64");
}

export function generateSaltBase64(size = 16): string {
  return randomBytes(size).toString("base64");
}

export async function deriveKeyFromPassword(password: string, saltBase64: string): Promise<Buffer> {
  const salt = Buffer.from(saltBase64, "base64");
  return new Promise((resolve, reject) => {
    scryptCallback(
      password,
      salt,
      KEY_LENGTH,
      { N: 32768, r: 8, p: 1, maxmem: 128 * 1024 * 1024 },
      (err: Error | null, derivedKey: Buffer) => {
        if (err) reject(err);
        else resolve(derivedKey);
      },
    );
  });
}

export function encryptString(plainText: string, key: Buffer): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return encodePayload(iv, tag, encrypted);
}

export function decryptString(cipherText: string, key: Buffer): string {
  const parsed = decodePayload(cipherText);

  const decipher = createDecipheriv(ALGO, key, Buffer.from(parsed.iv, "base64"));
  decipher.setAuthTag(Buffer.from(parsed.tag, "base64"));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(parsed.data, "base64")),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
}

export function encryptJson<T>(value: T, key: Buffer): string {
  return encryptString(JSON.stringify(value), key);
}

export function decryptJson<T>(cipherText: string, key: Buffer): T {
  return JSON.parse(decryptString(cipherText, key)) as T;
}

export function encryptBuffer(plainBuffer: Buffer, key: Buffer): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plainBuffer), cipher.final()]);
  const tag = cipher.getAuthTag();
  return encodePayload(iv, tag, encrypted);
}

export function decryptBuffer(cipherText: string, key: Buffer): Buffer {
  const parsed = decodePayload(cipherText);
  const decipher = createDecipheriv(ALGO, key, Buffer.from(parsed.iv, "base64"));
  decipher.setAuthTag(Buffer.from(parsed.tag, "base64"));

  return Buffer.concat([
    decipher.update(Buffer.from(parsed.data, "base64")),
    decipher.final(),
  ]);
}
