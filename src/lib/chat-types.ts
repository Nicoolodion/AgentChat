export type ChatListItem = {
  id: string;
  title: string;
  model: string;
  webSearchEnabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastMessagePreview: string;
};

export type ChatMessage = {
  id: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  reasoning?: string;
  toolPayload?: string;
  usagePromptTokens?: number;
  usageCompletionTokens?: number;
  providerModel?: string;
  createdAt: string;
};

export type ChatDetail = {
  id: string;
  title: string;
  model: string;
  webSearchEnabled: boolean;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
};

export type ModelInfo = {
  id: string;
  displayName: string;
  provider?: string;
  contextLength?: number;
  supportsVision?: boolean;
  supportsTools?: boolean;
};
