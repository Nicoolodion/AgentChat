import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { AttachmentKind } from "@/lib/chat-types";
import { decryptBuffer, decryptString, encryptBuffer, encryptString } from "@/lib/crypto";
import { env } from "@/lib/env";

const FILE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024;
const MAX_ATTACHMENTS_PER_MESSAGE = 40;
const MAX_TEXT_PER_ATTACHMENT = 32_000;
const MAX_TOTAL_EXTRACTED_TEXT = 28_000;
const MAX_PDF_IMAGE_PAGES = 100;
const IMAGE_RENDER_SCALE = 1.35;

const IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
]);

const TEXTISH_MIME_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
  "application/xml",
  "text/xml",
  "application/rtf",
]);

const EXTENSION_TO_MIME: Record<string, string> = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".xml": "application/xml",
  ".rtf": "application/rtf",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".odt": "application/vnd.oasis.opendocument.text",
  ".odp": "application/vnd.oasis.opendocument.presentation",
};

type StoredAttachmentMeta = {
  id: string;
  userId: string;
  fileName: string;
  mimeType: string;
  size: number;
  kind: AttachmentKind;
  createdAt: string;
  expiresAt: string;
};

export type UploadAttachmentResult = Omit<StoredAttachmentMeta, "userId">;

export type PreparedAttachment = {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
  kind: AttachmentKind;
  extractedText?: string;
  images: Array<{
    label: string;
    mimeType: string;
    buffer: Buffer;
  }>;
};

export class AttachmentError extends Error {
  statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
    this.name = "AttachmentError";
  }
}

function sanitizeFileName(fileName: string): string {
  const base = path.basename(fileName).replace(/[\r\n]/g, " ").trim();
  if (!base) return "file";
  return base.slice(0, 180);
}

function resolveMimeType(fileName: string, providedMimeType: string): string {
  const fallback = EXTENSION_TO_MIME[path.extname(fileName).toLowerCase()] ?? "application/octet-stream";
  const normalizedProvided = (providedMimeType || "").trim().toLowerCase();

  if (!normalizedProvided) return fallback;
  if (normalizedProvided === "application/octet-stream") return fallback;
  return normalizedProvided;
}

function classifyMime(mimeType: string): AttachmentKind {
  if (IMAGE_MIME_TYPES.has(mimeType)) return "image";
  if (mimeType === "application/pdf") return "pdf";

  if (
    mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    mimeType === "application/vnd.openxmlformats-officedocument.presentationml.presentation" ||
    mimeType === "application/vnd.oasis.opendocument.text" ||
    mimeType === "application/vnd.oasis.opendocument.presentation"
  ) {
    return "document";
  }

  if (TEXTISH_MIME_TYPES.has(mimeType) || mimeType.startsWith("text/")) {
    return "text";
  }

  return "binary";
}

function getDataRoot(): string {
  return path.resolve(process.cwd(), env.DATA_DIR);
}

function getUserDir(userId: string): string {
  return path.join(getDataRoot(), userId);
}

function getAttachmentDataPath(userId: string, attachmentId: string): string {
  return path.join(getUserDir(userId), `${attachmentId}.bin`);
}

function getAttachmentMetaPath(userId: string, attachmentId: string): string {
  return path.join(getUserDir(userId), `${attachmentId}.meta`);
}

async function ensureUserDir(userId: string): Promise<void> {
  await mkdir(getUserDir(userId), { recursive: true });
}

async function safeDeleteFile(filePath: string): Promise<void> {
  await rm(filePath, { force: true }).catch(() => undefined);
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function cleanupPlainText(text: string): string {
  return text
    .replace(/\r/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[\t ]+/g, " ")
    .trim();
}

function extractTextFromXml(xml: string): string {
  const withNewlines = xml
    .replace(/<\/(w:p|a:p|text:p|p|div|tr|li)>/g, "\n")
    .replace(/<br\s*\/?\s*>/g, "\n");

  const withoutTags = withNewlines.replace(/<[^>]+>/g, " ");
  return cleanupPlainText(decodeXmlEntities(withoutTags));
}

function shrinkText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...[truncated]`;
}

async function extractOfficeZipText(buffer: Buffer, fileName: string): Promise<string | undefined> {
  const ext = path.extname(fileName).toLowerCase();
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(buffer);

  if (ext === ".docx") {
    const doc = zip.file("word/document.xml");
    if (!doc) return undefined;
    return extractTextFromXml(await doc.async("string"));
  }

  if (ext === ".pptx") {
    const slideFiles = Object.keys(zip.files)
      .filter((name) => name.startsWith("ppt/slides/slide") && name.endsWith(".xml"))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

    if (slideFiles.length === 0) return undefined;

    const parts: string[] = [];
    for (const name of slideFiles) {
      const content = await zip.file(name)?.async("string");
      if (!content) continue;
      const text = extractTextFromXml(content);
      if (text) parts.push(text);
    }

    return cleanupPlainText(parts.join("\n\n"));
  }

  if (ext === ".odt" || ext === ".odp") {
    const content = await zip.file("content.xml")?.async("string");
    if (!content) return undefined;
    return extractTextFromXml(content);
  }

  return undefined;
}

type PdfAnalysis = {
  text: string;
  images: Array<{ label: string; mimeType: string; buffer: Buffer }>;
};

async function analyzePdf(buffer: Buffer): Promise<PdfAnalysis> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const { createCanvas } = await import("@napi-rs/canvas");

  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    disableWorker: true,
    isEvalSupported: false,
    useWorkerFetch: false,
  } as unknown as ArrayBuffer);

  const doc = await loadingTask.promise;
  const images: Array<{ label: string; mimeType: string; buffer: Buffer }> = [];
  const textParts: string[] = [];

  const pagesForImages = Math.min(doc.numPages, MAX_PDF_IMAGE_PAGES);
  const pagesForText = Math.min(doc.numPages, 16);

  for (let pageIndex = 1; pageIndex <= pagesForText; pageIndex += 1) {
    const page = await doc.getPage(pageIndex);
    const textContent = await page.getTextContent();
    const pageText = textContent.items
      .map((item) => ("str" in item ? item.str : ""))
      .join(" ")
      .trim();

    if (pageText) {
      textParts.push(`Page ${pageIndex}: ${pageText}`);
    }

    if (pageIndex <= pagesForImages) {
      const viewport = page.getViewport({ scale: IMAGE_RENDER_SCALE });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const context = canvas.getContext("2d");

      await page.render({
        canvasContext: context as unknown as CanvasRenderingContext2D,
        viewport,
      } as unknown as Parameters<typeof page.render>[0]).promise;

      images.push({
        label: `Page ${pageIndex}`,
        mimeType: "image/png",
        buffer: canvas.toBuffer("image/png"),
      });
    }
  }

  await doc.destroy().catch(() => undefined);

  return {
    text: cleanupPlainText(textParts.join("\n\n")),
    images,
  };
}

async function extractTextForAttachment(
  fileName: string,
  mimeType: string,
  buffer: Buffer,
): Promise<string | undefined> {
  if (classifyMime(mimeType) === "text") {
    return cleanupPlainText(buffer.toString("utf8"));
  }

  if (
    mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    mimeType === "application/vnd.openxmlformats-officedocument.presentationml.presentation" ||
    mimeType === "application/vnd.oasis.opendocument.text" ||
    mimeType === "application/vnd.oasis.opendocument.presentation"
  ) {
    return extractOfficeZipText(buffer, fileName);
  }

  return undefined;
}

function formatUploadResult(meta: StoredAttachmentMeta): UploadAttachmentResult {
  return {
    id: meta.id,
    fileName: meta.fileName,
    mimeType: meta.mimeType,
    size: meta.size,
    kind: meta.kind,
    createdAt: meta.createdAt,
    expiresAt: meta.expiresAt,
  };
}

export function isOversizeModelError(err: unknown): boolean {
  const asError = err as { message?: string; status?: number; response?: { status?: number } };
  const status = asError.status ?? asError.response?.status;
  if (status === 413 || status === 414) return true;

  const message = (asError.message ?? "").toLowerCase();
  return (
    message.includes("payload") ||
    message.includes("too large") ||
    message.includes("context length") ||
    message.includes("maximum context") ||
    message.includes("request entity")
  );
}

export async function cleanupExpiredAttachmentsForUser(userId: string): Promise<void> {
  const userDir = getUserDir(userId);
  const cutoff = Date.now() - FILE_TTL_MS;

  const entries = await readdir(userDir, { withFileTypes: true }).catch(() => []);

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".bin") && !entry.name.endsWith(".meta")) continue;

    const filePath = path.join(userDir, entry.name);
    const fileStat = await stat(filePath).catch(() => null);
    if (!fileStat) continue;
    if (fileStat.mtimeMs > cutoff) continue;
    await safeDeleteFile(filePath);
  }
}

export async function saveAttachmentForUser(input: {
  userId: string;
  userKey: Buffer;
  fileName: string;
  mimeType: string;
  bytes: Buffer;
}): Promise<UploadAttachmentResult> {
  const fileName = sanitizeFileName(input.fileName);
  const mimeType = resolveMimeType(fileName, input.mimeType);
  const kind = classifyMime(mimeType);

  if (input.bytes.length === 0) {
    throw new AttachmentError(`File ${fileName} is empty.`, 400);
  }

  if (input.bytes.length > MAX_FILE_SIZE_BYTES) {
    throw new AttachmentError(`File ${fileName} exceeds 25 MB.`, 413);
  }

  await ensureUserDir(input.userId);
  await cleanupExpiredAttachmentsForUser(input.userId);

  const id = randomUUID().replace(/-/g, "");
  const nowIso = new Date().toISOString();
  const expiresAt = new Date(Date.now() + FILE_TTL_MS).toISOString();

  const meta: StoredAttachmentMeta = {
    id,
    userId: input.userId,
    fileName,
    mimeType,
    size: input.bytes.length,
    kind,
    createdAt: nowIso,
    expiresAt,
  };

  const encryptedMeta = encryptString(JSON.stringify(meta), input.userKey);
  const encryptedPayload = encryptBuffer(input.bytes, input.userKey);

  await writeFile(getAttachmentMetaPath(input.userId, id), encryptedMeta, "utf8");
  await writeFile(getAttachmentDataPath(input.userId, id), encryptedPayload, "utf8");

  return formatUploadResult(meta);
}

async function loadStoredAttachment(input: {
  userId: string;
  userKey: Buffer;
  attachmentId: string;
}): Promise<{ meta: StoredAttachmentMeta; bytes: Buffer }> {
  const attachmentId = input.attachmentId.trim();
  if (!/^[a-zA-Z0-9]{16,64}$/.test(attachmentId)) {
    throw new AttachmentError("Invalid attachment id.", 400);
  }

  const [metaCipher, dataCipher] = await Promise.all([
    readFile(getAttachmentMetaPath(input.userId, attachmentId), "utf8").catch(() => null),
    readFile(getAttachmentDataPath(input.userId, attachmentId), "utf8").catch(() => null),
  ]);

  if (!metaCipher || !dataCipher) {
    throw new AttachmentError("Attachment not found.", 404);
  }

  let meta: StoredAttachmentMeta;
  try {
    meta = JSON.parse(decryptString(metaCipher, input.userKey)) as StoredAttachmentMeta;
  } catch {
    throw new AttachmentError("Unable to decrypt attachment metadata.", 403);
  }

  if (meta.userId !== input.userId || meta.id !== attachmentId) {
    throw new AttachmentError("Attachment access denied.", 403);
  }

  if (new Date(meta.expiresAt).getTime() <= Date.now()) {
    await Promise.all([
      safeDeleteFile(getAttachmentMetaPath(input.userId, attachmentId)),
      safeDeleteFile(getAttachmentDataPath(input.userId, attachmentId)),
    ]);
    throw new AttachmentError("Attachment expired.", 410);
  }

  const bytes = decryptBuffer(dataCipher, input.userKey);
  return { meta, bytes };
}

export async function getAttachmentForUser(input: {
  userId: string;
  userKey: Buffer;
  attachmentId: string;
}): Promise<{ meta: UploadAttachmentResult; bytes: Buffer }> {
  const { meta, bytes } = await loadStoredAttachment(input);
  return {
    meta: formatUploadResult(meta),
    bytes,
  };
}

async function compressImage(buffer: Buffer): Promise<Buffer> {
  const { createCanvas, loadImage } = await import("@napi-rs/canvas");
  const image = await loadImage(buffer);

  const maxWidth = 1280;
  const maxHeight = 1280;
  const ratio = Math.min(1, maxWidth / image.width, maxHeight / image.height);
  const width = Math.max(1, Math.round(image.width * ratio));
  const height = Math.max(1, Math.round(image.height * ratio));

  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0, width, height);

  return canvas.toBuffer("image/jpeg", 78);
}

function toDataUrl(mimeType: string, buffer: Buffer): string {
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

export async function prepareAttachmentsForModel(input: {
  userId: string;
  userKey: Buffer;
  attachmentIds: string[];
}): Promise<PreparedAttachment[]> {
  const ids = Array.from(new Set(input.attachmentIds.map((id) => id.trim()).filter(Boolean)));
  if (ids.length === 0) return [];
  if (ids.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    throw new AttachmentError(`Attach up to ${MAX_ATTACHMENTS_PER_MESSAGE} files per message.`, 400);
  }

  await cleanupExpiredAttachmentsForUser(input.userId);

  const prepared: PreparedAttachment[] = [];

  for (const attachmentId of ids) {
    const { meta, bytes } = await loadStoredAttachment({
      userId: input.userId,
      userKey: input.userKey,
      attachmentId,
    });

    if (meta.kind === "image") {
      prepared.push({
        id: meta.id,
        fileName: meta.fileName,
        mimeType: meta.mimeType,
        size: meta.size,
        kind: meta.kind,
        images: [{ label: meta.fileName, mimeType: meta.mimeType, buffer: bytes }],
      });
      continue;
    }

    if (meta.kind === "pdf") {
      const pdf = await analyzePdf(bytes);
      prepared.push({
        id: meta.id,
        fileName: meta.fileName,
        mimeType: meta.mimeType,
        size: meta.size,
        kind: meta.kind,
        extractedText: shrinkText(pdf.text, MAX_TEXT_PER_ATTACHMENT),
        images: pdf.images,
      });
      continue;
    }

    const extractedText = await extractTextForAttachment(meta.fileName, meta.mimeType, bytes);
    prepared.push({
      id: meta.id,
      fileName: meta.fileName,
      mimeType: meta.mimeType,
      size: meta.size,
      kind: meta.kind,
      extractedText: extractedText ? shrinkText(extractedText, MAX_TEXT_PER_ATTACHMENT) : undefined,
      images: [],
    });
  }

  return prepared;
}

function formatAttachmentSummary(attachments: PreparedAttachment[]): string {
  const names = attachments.map((file) => file.fileName).join(", ");
  return `Attached files: ${names}`;
}

function buildAttachmentTextContext(attachments: PreparedAttachment[]): string {
  let budget = MAX_TOTAL_EXTRACTED_TEXT;
  const blocks: string[] = [];

  for (const attachment of attachments) {
    if (!attachment.extractedText) continue;
    if (budget <= 0) break;

    const content = attachment.extractedText.slice(0, budget);
    budget -= content.length;

    blocks.push(`File ${attachment.fileName}\n${content}`);
  }

  return blocks.join("\n\n");
}

export async function buildMultimodalUserContent(input: {
  prompt: string;
  attachments: PreparedAttachment[];
  compressed: boolean;
}): Promise<string | Array<{ type: "text" | "image_url"; text?: string; image_url?: { url: string; detail?: "high" | "low" } }>> {
  if (input.attachments.length === 0) {
    return input.prompt;
  }

  const summary = formatAttachmentSummary(input.attachments);
  const extractedText = buildAttachmentTextContext(input.attachments);

  const textBlock = [
    input.prompt,
    "",
    summary,
    extractedText ? `\nExtracted document context:\n${extractedText}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const parts: Array<{ type: "text" | "image_url"; text?: string; image_url?: { url: string; detail?: "high" | "low" } }> = [
    { type: "text", text: textBlock },
  ];

  const imageLimit = input.compressed ? 8 : 12;
  let imageCount = 0;

  for (const attachment of input.attachments) {
    for (const image of attachment.images) {
      if (imageCount >= imageLimit) break;

      const imageBuffer = input.compressed ? await compressImage(image.buffer) : image.buffer;
      const mimeType = input.compressed ? "image/jpeg" : image.mimeType;
      const dataUrl = toDataUrl(mimeType, imageBuffer);

      parts.push({
        type: "image_url",
        image_url: {
          url: dataUrl,
          detail: input.compressed ? "low" : "high",
        },
      });

      imageCount += 1;
    }

    if (imageCount >= imageLimit) break;
  }

  return parts;
}

export function appendAttachmentSummaryToMessage(prompt: string, attachments: PreparedAttachment[]): string {
  if (attachments.length === 0) return prompt;
  return `${prompt}\n\n${formatAttachmentSummary(attachments)}`;
}

export const attachmentLimits = {
  maxFileSizeBytes: MAX_FILE_SIZE_BYTES,
  maxAttachmentsPerMessage: MAX_ATTACHMENTS_PER_MESSAGE,
};
