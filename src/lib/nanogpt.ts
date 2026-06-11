import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
} from "openai/resources/chat/completions/completions";

import {
  buildMultimodalUserContent,
  isOversizeModelError,
  type PreparedAttachment,
} from "@/lib/attachments";
import type { ModelInfo } from "@/lib/chat-types";
import { env } from "@/lib/env";
import { AGENT_TOOLS, executeAgentTool } from "@/lib/tools";

const titleClient = new OpenAI({
  apiKey: env.NANOGPT_API_KEY ?? "missing",
  baseURL: env.NANOGPT_BASE_URL,
});

function countWords(str: string): number {
  return str
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0).length;
}

export const nanoClient = new OpenAI({
  apiKey: env.NANOGPT_API_KEY ?? "missing",
  baseURL: env.NANOGPT_BASE_URL,
});

type ModelApiRow = {
  id: string;
  name?: string;
  owned_by?: string;
  provider?: string;
  context_length?: number;
  contextWindow?: number;
  input_token_limit?: number;
  capabilities?: {
    vision?: boolean;
    tools?: boolean;
  };
};

function normalizeModelRow(row: ModelApiRow): ModelInfo {
  const contextLength =
    row.context_length ?? row.contextWindow ?? row.input_token_limit ?? undefined;

  return {
    id: row.id,
    displayName: row.name ?? row.id,
    provider: row.provider ?? row.owned_by,
    contextLength,
    supportsVision: row.capabilities?.vision,
    supportsTools: row.capabilities?.tools,
  };
}

export async function fetchModelsFromNanoGPT(filter?: string): Promise<ModelInfo[]> {
  const search = (filter ?? "").trim().toLowerCase();

  if (!env.NANOGPT_API_KEY) {
    const placeholder = env.DEFAULT_MODEL;
    if (search && !placeholder.toLowerCase().includes(search)) {
      return [];
    }
    return [
      {
        id: placeholder,
        name: placeholder,
        displayName: `${placeholder} (configure NANOGPT_API_KEY for live models)`,
      },
    ];
  }

  const response = await fetch(`${env.NANOGPT_BASE_URL}/v1/models?detailed=true`, {
    headers: {
      Authorization: `Bearer ${env.NANOGPT_API_KEY}`,
      "Content-Type": "application/json",
    },
    cache: "no-store",
  });

  if (!response.ok) {
    console.warn(`Could not fetch model list (${response.status}). Falling back to DEFAULT_MODEL.`);
    return [
      {
        id: env.DEFAULT_MODEL,
        name: env.DEFAULT_MODEL,
        displayName: env.DEFAULT_MODEL,
      },
    ];
  }

  const json = (await response.json()) as { data?: ModelApiRow[] };
  const rows = Array.isArray(json.data) ? json.data : [];
  if (rows.length === 0) {
    return [{ id: env.DEFAULT_MODEL, name: env.DEFAULT_MODEL, displayName: env.DEFAULT_MODEL }];
  }

  const filtered = search
    ? rows.filter(
        (row) =>
          row.id.toLowerCase().includes(search) ||
          (row.name ?? "").toLowerCase().includes(search) ||
          (row.owned_by ?? "").toLowerCase().includes(search),
      )
    : rows;

  return filtered.map(normalizeModelRow);
}

export function applyWebSearchSuffix(modelId: string, webSearchEnabled: boolean): string {
  const segments = modelId.split(":");
  const base = segments[0];
  const suffixes = segments.slice(1).filter((suffix) => !suffix.startsWith("online"));

  if (webSearchEnabled) {
    suffixes.unshift("online");
  }

  return [base, ...suffixes].join(":");
}

type MessageInput = {
  role: "system" | "user" | "assistant";
  content: string;
  tool_call_id?: string;
  name?: string;
};

async function buildConversationMessages(input: {
  messages: MessageInput[];
  attachments: PreparedAttachment[];
  latestUserPrompt?: string;
  compressedAttachments: boolean;
}): Promise<ChatCompletionMessageParam[]> {
  const baseConversation: ChatCompletionMessageParam[] = input.messages.map((msg) => ({
    role: msg.role,
    content: msg.content,
  }));

  if (input.attachments.length === 0) {
    return baseConversation;
  }

  const lastUserIndex = [...input.messages]
    .reverse()
    .findIndex((message) => message.role === "user");

  if (lastUserIndex === -1) {
    return baseConversation;
  }

  const absoluteUserIndex = input.messages.length - 1 - lastUserIndex;
  const prompt = input.latestUserPrompt ?? input.messages[absoluteUserIndex]?.content ?? "";

  const multimodalContent = await buildMultimodalUserContent({
    prompt,
    attachments: input.attachments,
    compressed: input.compressedAttachments,
  });

  baseConversation[absoluteUserIndex] = {
    role: "user",
    content: multimodalContent,
  } as ChatCompletionMessageParam;

  return baseConversation;
}

type CompletionResult = {
  content: string;
  reasoning?: string;
  providerModel?: string;
  usagePromptTokens?: number;
  usageCompletionTokens?: number;
  toolPayload?: string;
};

export async function runNanoGPTCompletion(input: {
  model: string;
  webSearchEnabled: boolean;
  messages: MessageInput[];
  attachments?: PreparedAttachment[];
  latestUserPrompt?: string;
}): Promise<CompletionResult> {
  const result = await streamCompletionWithCallbacks(input, {
    onTTFT() {},
    onContent() {},
    onReasoning() {},
    onToolStart() {},
    onToolDone() {},
  });
  return result;
}

type StreamCallbacks = {
  onContent: (text: string) => void;
  onReasoning: (text: string) => void;
  onTTFT: (ttftMs: number) => void;
  onToolStart: (name: string) => void;
  onToolDone: (name: string, ok: boolean) => void;
};

type StreamCompletionResult = CompletionResult & { ttftMs: number };

export async function streamCompletionWithCallbacks(
  input: {
    model: string;
    webSearchEnabled: boolean;
    messages: MessageInput[];
    attachments?: PreparedAttachment[];
    latestUserPrompt?: string;
  },
  callbacks: StreamCallbacks,
): Promise<StreamCompletionResult> {
  if (!env.NANOGPT_API_KEY) {
    throw new Error("NANOGPT_API_KEY is not configured.");
  }

  const startTime = Date.now();
  const model = applyWebSearchSuffix(input.model, input.webSearchEnabled);
  const toolEvents: Array<{ name: string; result: unknown; ok: boolean }> = [];
  const attachments = input.attachments ?? [];
  let usingCompressedAttachments = false;
  let conversation = await buildConversationMessages({
    messages: input.messages,
    attachments,
    latestUserPrompt: input.latestUserPrompt,
    compressedAttachments: false,
  });
  const tools: ChatCompletionTool[] = AGENT_TOOLS.map((tool) => ({
    type: "function",
    function: {
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters,
    },
  }));

    let finalContent = "";
  let finalReasoning = "";
  let providerModel: string | undefined;
  let usagePromptTokens: number | undefined;
  let usageCompletionTokens: number | undefined;
  let ttftMs: number | undefined;
  let ttftEmitted = false;
  let currentToolCallIndex = -1;
  let lastUsage: { prompt_tokens?: number; completion_tokens?: number } | undefined;
  const accumulatedToolCalls: Array<{
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }> = [];

  for (let i = 0; i < 4; i += 1) {
    accumulatedToolCalls.length = 0;
    currentToolCallIndex = -1;
    lastUsage = undefined;
    let contentBuffer = "";

    try {
      const response = await nanoClient.chat.completions.create({
        model,
        messages: conversation,
        tools,
        tool_choice: "auto",
        parallel_tool_calls: false,
        stream: true,
      });

      for await (const chunk of response) {
        lastUsage = chunk.usage ?? undefined;
        const choice = chunk.choices?.[0];
        const delta = choice?.delta;

        if (!ttftEmitted && (delta?.content || delta?.tool_calls || (delta as { reasoning?: unknown })?.reasoning)) {
          ttftMs = Date.now() - startTime;
          ttftEmitted = true;
          callbacks.onTTFT(ttftMs);
        }

        const reasoningDelta = (delta as { reasoning?: string })?.reasoning;
        if (reasoningDelta) {
          finalReasoning += reasoningDelta;
          callbacks.onReasoning(reasoningDelta);
        }

        if (delta?.content) {
          contentBuffer += delta.content;
          finalContent += delta.content;
          callbacks.onContent(delta.content);
        }

        const toolCalls = delta?.tool_calls ?? [];
        for (const toolCall of toolCalls) {
          const idx = toolCall.index ?? 0;
          if (idx !== currentToolCallIndex) {
            currentToolCallIndex = idx;
            const id = toolCall.id;
            const type = toolCall.type ?? "function";
            const funcName = toolCall.function?.name ?? "";
            const funcArgs = toolCall.function?.arguments ?? "";
            accumulatedToolCalls[idx] = {
              id: id ?? "",
              type,
              function: { name: funcName, arguments: funcArgs },
            };
            if (funcName) {
              callbacks.onToolStart(funcName);
            }
          } else {
            const funcArgs = toolCall.function?.arguments;
            if (funcArgs) {
              accumulatedToolCalls[idx].function.arguments += funcArgs;
            }
          }
        }
      }
    } catch (error) {
      if (!usingCompressedAttachments && attachments.length > 0 && i === 0 && isOversizeModelError(error)) {
        usingCompressedAttachments = true;
        finalContent = "";
        finalReasoning = "";
        ttftEmitted = false;
        ttftMs = undefined;
        toolEvents.length = 0;

        conversation = await buildConversationMessages({
          messages: input.messages,
          attachments,
          latestUserPrompt: input.latestUserPrompt,
          compressedAttachments: true,
        });

        i = -1;
        continue;
      }

      throw error;
    }

    usagePromptTokens = lastUsage?.prompt_tokens;
    usageCompletionTokens = lastUsage?.completion_tokens;
    providerModel = undefined;

    if (accumulatedToolCalls.length === 0) {
      const extractedReasoning =
        typeof (finalReasoning || undefined) === "string"
          ? (finalReasoning || undefined)
          : undefined;

      return {
        content: finalContent,
        reasoning: extractedReasoning,
        providerModel,
        usagePromptTokens,
        usageCompletionTokens,
        toolPayload: toolEvents.length ? JSON.stringify(toolEvents, null, 2) : undefined,
        ttftMs: ttftMs ?? Date.now() - startTime,
      };
    }

    const completeToolCalls = accumulatedToolCalls
      .filter(Boolean)
      .map((tc) => ({
        id: tc.id,
        type: tc.type,
        index: 0,
        function: {
          name: tc.function.name,
          arguments: tc.function.arguments,
        },
      })) as ChatCompletionMessageToolCall[];

    conversation.push({
      role: "assistant",
      content: contentBuffer,
      tool_calls: completeToolCalls,
    });

    for (const toolCall of completeToolCalls) {
      const toolName = toolCall.type === "function" ? toolCall.function?.name : "unknown_tool";
      const toolArgs = toolCall.type === "function" ? toolCall.function?.arguments : undefined;

      const result = await executeAgentTool(toolName ?? "unknown_tool", toolArgs);

      toolEvents.push({
        name: toolName ?? "unknown_tool",
        result: result.result ?? result.error,
        ok: result.ok,
      });

      callbacks.onToolDone(toolName ?? "unknown_tool", result.ok);

      conversation.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: JSON.stringify(result),
      });
    }
  }

  return {
    content: "The tool execution loop reached the safety limit.",
    reasoning: finalReasoning || undefined,
    toolPayload: JSON.stringify(toolEvents, null, 2),
    ttftMs: ttftMs ?? Date.now() - startTime,
  };
}

const TITLE_SYSTEM_PROMPT =
  "You are a title generator. Given a user's first message and the AI's response, generate a concise descriptive title for this chat. Output ONLY the title - no quotes, no explanation, no extra text. Keep it to 6 words or fewer. Use title case.";

export async function generateChatTitle({
  userMessage,
  assistantMessage,
}: {
  userMessage: string;
  assistantMessage: string;
}): Promise<string> {
  if (!env.NANOGPT_API_KEY) {
    return "New chat";
  }

  const maxAttempts = 3;
  let lastResult = "";

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const response = await titleClient.chat.completions.create({
        model: env.TITLE_MODEL,
        messages: [
          { role: "system", content: TITLE_SYSTEM_PROMPT },
          {
            role: "user",
            content: `User: ${userMessage.replace(/\n/g, " ")}\nAI: ${assistantMessage.replace(/\n/g, " ").slice(0, 500)}`,
          },
        ],
        max_tokens: 60,
        temperature: 0.3,
      });

      const rawTitle =
        response.choices?.[0]?.message?.content?.trim() ?? "";

      if (countWords(rawTitle) >= 2 && countWords(rawTitle) <= 10) {
        return rawTitle;
      }

      lastResult = rawTitle;
    } catch {
      lastResult = "";
    }
  }

  if (lastResult && countWords(lastResult) >= 2 && countWords(lastResult) <= 14) {
    return lastResult;
  }

  return "New chat";
}
