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

/**
 * Sentinel chat id used for an unsaved "new chat" before the first message is
 * sent. It is never persisted: the URL `/chat/new-chat` shows a transient chat
 * that only gets a real id (and appears in the sidebar) once the first message
 * is sent.
 */
export const NEW_CHAT_ID = "new-chat";

/**
 * A segment of assistant content (or reasoning) that was emitted *before* the
 * tool call at `beforeToolIndex`. Segments with `beforeToolIndex >=
 * toolCalls.length` belong to the tail (after the last tool). This is what lets
 * the timeline render text/reasoning interleaved with tool calls in true
 * emission order instead of dumping everything at the bottom.
 */
export type MessageSegment = {
  text: string;
  beforeToolIndex: number;
};

export type ChatToolCall = {
  toolCallId: string;
  toolName: string;
  status: "running" | "success" | "error";
  durationMs?: number;
  /** Parsed arguments captured from the `tool_start` SSE event. */
  arguments?: Record<string, unknown>;
  /** Tool stdout/output captured from the `tool_output` SSE event. */
  output?: string;
  /** Error message captured from a failed `tool_done` event. */
  error?: string;
};

export type ChatMessage = {
  id: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  reasoning?: string;
  reasoningSegments?: MessageSegment[];
  contentSegments?: MessageSegment[];
  toolPayload?: string;
  toolCalls?: ChatToolCall[];
  usagePromptTokens?: number;
  usageCompletionTokens?: number;
  usageTotalTokens?: number;
  usageCachedTokens?: number;
  energyJoules?: number;
  energyKwh?: number;
  energyDurationSeconds?: number;
  providerModel?: string;
  ttftMs?: number;
  avgTokensPerSecond?: number;
  createdAt: string;
  _isStreaming?: boolean;
  /** True when the provider reported finish_reason "length" for this message
   *  (output truncated by max_output_tokens). Surfaces a "Continue generating"
   *  action. Transient — not persisted. */
  _truncated?: boolean;
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
