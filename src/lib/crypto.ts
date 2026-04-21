import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCallback } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);

const ALGO = "aes-256-gcm";
const IV_LENGTH = 12;
const KEY_LENGTH = 32;

type EncryptedPayload = {
  v: number;
  iv: string;
  tag: string;
  data: string;
};

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
  const result = (await scrypt(password, salt, KEY_LENGTH)) as Buffer;
  return Buffer.from(result);
}

export function encryptString(plainText: string, key: Buffer): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  const payload: EncryptedPayload = {
    v: 1,
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    data: encrypted.toString("base64"),
  };

  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}

export function decryptString(cipherText: string, key: Buffer): string {
  const parsed = JSON.parse(Buffer.from(cipherText, "base64").toString("utf8")) as EncryptedPayload;
  if (!parsed?.data || !parsed?.iv || !parsed?.tag) {
    throw new Error("Invalid encrypted payload format.");
  }

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
