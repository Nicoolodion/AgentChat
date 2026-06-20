export type ChatListItem = {
  id: string;
  title: string;
  model: string;
  webSearchEnabled: boolean;
  agentModeLocked: boolean | null;
  createdAt: string;
  updatedAt: string;
  lastMessagePreview: string;
};

export type ChatToolCall = {
  toolCallId: string;
  toolName: string;
  status: "running" | "success" | "error";
  durationMs?: number;
};

export type ChatMessage = {
  id: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  reasoning?: string;
  reasoningSegments?: Array<{ text: string; beforeToolIndex: number }>;
  toolPayload?: string;
  toolCalls?: ChatToolCall[];
  usagePromptTokens?: number;
  usageCompletionTokens?: number;
  providerModel?: string;
  ttftMs?: number;
  avgTokensPerSecond?: number;
  createdAt: string;
  _isStreaming?: boolean;
};

export type ChatDetail = {
  id: string;
  title: string;
  model: string;
  webSearchEnabled: boolean;
  agentModeLocked: boolean | null;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
  agentSession: { id: string; status: string } | null;
};

export type ModelSource = "nanogpt" | "neuralwatt";

export type ReasoningEffort = "low" | "medium" | "high" | "max";

export type ModelInfo = {
  id: string;
  displayName: string;
  name?: string;
  provider?: string;
  source?: ModelSource;
  contextLength?: number;
  supportsVision?: boolean;
  supportsTools?: boolean;
  supportsJsonMode?: boolean;
  supportsReasoning?: boolean;
  supportsReasoningEffort?: boolean;
  supportsStreaming?: boolean;
  maxOutputTokens?: number;
  maxImages?: number;
  inputPricePerMillion?: number;
  outputPricePerMillion?: number;
  cachedInputPricePerMillion?: number | null;
  pricingTbd?: boolean;
  deprecated?: boolean;
  description?: string | null;
};

export type AttachmentKind = "image" | "pdf" | "document" | "text" | "binary";

export type UploadedAttachment = {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
  kind: AttachmentKind;
  createdAt: string;
  expiresAt: string;
};

export type MessageAttachmentRef = {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
  kind: AttachmentKind;
};

type UserAttachmentsToolPayload = {
  type: "user_attachments_v1";
  items: MessageAttachmentRef[];
};

export function encodeUserAttachmentsPayload(items: MessageAttachmentRef[]): string {
  const payload: UserAttachmentsToolPayload = {
    type: "user_attachments_v1",
    items,
  };

  return JSON.stringify(payload);
}

export function decodeUserAttachmentsPayload(toolPayload?: string): MessageAttachmentRef[] {
  if (!toolPayload) return [];

  try {
    const parsed = JSON.parse(toolPayload) as UserAttachmentsToolPayload;
    if (parsed.type !== "user_attachments_v1" || !Array.isArray(parsed.items)) {
      return [];
    }

    return parsed.items.filter(
      (item): item is MessageAttachmentRef =>
        typeof item?.id === "string" &&
        typeof item?.fileName === "string" &&
        typeof item?.mimeType === "string" &&
        typeof item?.size === "number" &&
        typeof item?.kind === "string",
    );
  } catch {
    return [];
  }
}
