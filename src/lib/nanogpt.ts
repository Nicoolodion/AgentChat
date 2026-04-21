import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
} from "openai/resources/chat/completions/completions";

import type { ModelInfo } from "@/lib/chat-types";
import { env } from "@/lib/env";
import { AGENT_TOOLS, executeAgentTool } from "@/lib/tools";

const nanoClient = new OpenAI({
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

export async function fetchModelsFromNanoGPT(): Promise<ModelInfo[]> {
  if (!env.NANOGPT_API_KEY) {
    return [
      {
        id: env.DEFAULT_MODEL,
        displayName: `${env.DEFAULT_MODEL} (configure NANOGPT_API_KEY for live models)`,
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
    throw new Error(`Failed to fetch models: ${response.status}`);
  }

  const json = (await response.json()) as { data?: ModelApiRow[] };
  const rows = Array.isArray(json.data) ? json.data : [];
  if (rows.length === 0) {
    return [{ id: env.DEFAULT_MODEL, displayName: env.DEFAULT_MODEL }];
  }

  return rows.map(normalizeModelRow);
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
}): Promise<CompletionResult> {
  if (!env.NANOGPT_API_KEY) {
    throw new Error("NANOGPT_API_KEY is not configured.");
  }

  const model = applyWebSearchSuffix(input.model, input.webSearchEnabled);
  const toolEvents: Array<{ name: string; result: unknown; ok: boolean }> = [];

  const conversation: ChatCompletionMessageParam[] = input.messages.map((msg) => ({
    role: msg.role,
    content: msg.content,
  }));
  const tools: ChatCompletionTool[] = AGENT_TOOLS.map((tool) => ({
    type: "function",
    function: {
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters,
    },
  }));

  for (let i = 0; i < 4; i += 1) {
    const response = await nanoClient.chat.completions.create({
      model,
      messages: conversation,
      tools,
      tool_choice: "auto",
      parallel_tool_calls: false,
      reasoning_effort: "low",
    });

    const choice = response.choices?.[0];
    const message = choice?.message;
    const toolCalls = message?.tool_calls ?? [];
    const extractedReasoning =
      typeof (message as { reasoning?: unknown } | undefined)?.reasoning === "string"
        ? ((message as { reasoning?: string }).reasoning ?? undefined)
        : undefined;

    if (!toolCalls.length) {
      return {
        content: message?.content ?? "",
        reasoning: extractedReasoning,
        providerModel: response.model,
        usagePromptTokens: response.usage?.prompt_tokens,
        usageCompletionTokens: response.usage?.completion_tokens,
        toolPayload: toolEvents.length ? JSON.stringify(toolEvents, null, 2) : undefined,
      };
    }

    conversation.push({
      role: "assistant",
      content: message?.content ?? "",
      tool_calls: toolCalls as ChatCompletionMessageToolCall[],
    });

    for (const toolCall of toolCalls) {
      const toolName =
        toolCall.type === "function" ? toolCall.function?.name : "unsupported_custom_tool";
      const toolArgs = toolCall.type === "function" ? toolCall.function?.arguments : undefined;

      const result = await executeAgentTool(
        toolName ?? "unknown_tool",
        toolArgs,
      );

      toolEvents.push({
        name: toolName ?? "unknown_tool",
        result: result.result ?? result.error,
        ok: result.ok,
      });

      conversation.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: JSON.stringify(result),
      });
    }
  }

  return {
    content: "The tool execution loop reached the safety limit.",
    toolPayload: JSON.stringify(toolEvents, null, 2),
  };
}
