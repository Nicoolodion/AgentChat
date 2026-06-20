import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions/completions";

import {
  buildMultimodalUserContent,
  isOversizeModelError,
  type PreparedAttachment,
} from "@/lib/attachments";
import type { ModelInfo, ReasoningEffort } from "@/lib/chat-types";
import { env } from "@/lib/env";

const titleClient = new OpenAI({
  apiKey: env.NANOGPT_API_KEY ?? "missing",
  baseURL: env.NANOGPT_BASE_URL,
});

// Neuralwatt models are namespaced with this prefix so the completion layer can
// route them to the Neuralwatt API instead of NanoGPT. The prefix is stripped
// before the model id is sent to the provider.
const NEURALWATT_PREFIX = "neuralwatt:";

export function isNeuralwattModel(modelId: string): boolean {
  return modelId.startsWith(NEURALWATT_PREFIX);
}

function stripNeuralwattPrefix(modelId: string): string {
  return modelId.slice(NEURALWATT_PREFIX.length);
}

/** Massaged model id to send to the chosen provider's API. */
export function resolveApiModelId(modelId: string): string {
  if (isNeuralwattModel(modelId)) return stripNeuralwattPrefix(modelId);
  return modelId;
}

let neuralwattClient: OpenAI | null = null;
function getNeuralwattClient(): OpenAI {
  if (!neuralwattClient) {
    neuralwattClient = new OpenAI({
      apiKey: env.NEURALWATT_API_KEY ?? "missing",
      baseURL: env.NEURALWATT_BASE_URL,
    });
  }
  return neuralwattClient;
}

/** Returns the OpenAI client that should serve completions for a given model. */
export function getOpenAIClientForModel(modelId: string): OpenAI {
  return isNeuralwattModel(modelId) ? getNeuralwattClient() : nanoClient;
}

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
    name: row.name ?? row.id,
    displayName: row.name ?? row.id,
    provider: row.provider ?? row.owned_by,
    source: "nanogpt",
    contextLength,
    supportsVision: row.capabilities?.vision,
    supportsTools: row.capabilities?.tools,
  };
}

// ── Neuralwatt provider ──────────────────────────────────────────────────────

type NeuralwattModelRow = {
  id: string;
  object?: string;
  created?: number;
  owned_by?: string;
  max_model_len?: number;
  metadata?: {
    display_name?: string;
    description?: string | null;
    provider?: string;
    huggingface_id?: string | null;
    pricing?: {
      input_per_million?: number;
      output_per_million?: number;
      cached_input_per_million?: number | null;
      cached_output_per_million?: number | null;
      currency?: string;
      pricing_tbd?: boolean;
    };
    capabilities?: {
      tools?: boolean;
      json_mode?: boolean;
      vision?: boolean;
      reasoning?: boolean;
      reasoning_effort?: boolean;
      streaming?: boolean;
      system_role?: boolean;
      developer_role?: boolean;
    };
    limits?: {
      max_context_length?: number | null;
      max_output_tokens?: number | null;
      max_images?: number | null;
    };
    deprecated?: boolean;
    deprecated_message?: string | null;
  };
};

function normalizeNeuralwattRow(row: NeuralwattModelRow): ModelInfo {
  const meta = row.metadata ?? {};
  const caps = meta.capabilities ?? {};
  const pricing = meta.pricing ?? {};
  const limits = meta.limits ?? {};

  const contextLength =
    limits.max_context_length ?? row.max_model_len ?? undefined;
  const display = meta.display_name ?? row.id;

  return {
    id: `${NEURALWATT_PREFIX}${row.id}`,
    name: display,
    displayName: display,
    provider: meta.provider ?? row.owned_by ?? "neuralwatt",
    source: "neuralwatt",
    description: meta.description ?? undefined,
    contextLength: contextLength ?? undefined,
    supportsVision: caps.vision,
    supportsTools: caps.tools,
    supportsJsonMode: caps.json_mode,
    supportsReasoning: caps.reasoning,
    supportsReasoningEffort: caps.reasoning_effort,
    supportsStreaming: caps.streaming,
    maxOutputTokens: limits.max_output_tokens ?? undefined,
    maxImages: limits.max_images ?? undefined,
    inputPricePerMillion: pricing.input_per_million,
    outputPricePerMillion: pricing.output_per_million,
    cachedInputPricePerMillion: pricing.cached_input_per_million ?? null,
    pricingTbd: pricing.pricing_tbd,
    deprecated: meta.deprecated,
  };
}

export async function fetchModelsFromNeuralwatt(filter?: string): Promise<ModelInfo[]> {
  const search = (filter ?? "").trim().toLowerCase();

  if (!env.NEURALWATT_API_KEY) {
    return [];
  }

  const response = await fetch(`${env.NEURALWATT_BASE_URL}/models`, {
    headers: {
      Authorization: `Bearer ${env.NEURALWATT_API_KEY}`,
      "Content-Type": "application/json",
    },
    cache: "no-store",
  });

  if (!response.ok) {
    console.warn(`Could not fetch Neuralwatt model list (${response.status}).`);
    return [];
  }

  const json = (await response.json()) as { data?: NeuralwattModelRow[] };
  const rows = Array.isArray(json.data) ? json.data : [];

  const filtered = search
    ? rows.filter(
        (row) =>
          row.id.toLowerCase().includes(search) ||
          (row.metadata?.display_name ?? "").toLowerCase().includes(search) ||
          (row.metadata?.provider ?? "").toLowerCase().includes(search),
      )
    : rows;

  return filtered
    .map(normalizeNeuralwattRow)
    .filter((m) => !m.deprecated);
}

// ── Combined catalog cache (server-side, short TTL) ─────────────────────────

let catalogCache: { ts: number; models: ModelInfo[] } | null = null;
const CATALOG_TTL_MS = 60_000;

export async function fetchModelCatalog(): Promise<ModelInfo[]> {
  const now = Date.now();
  if (catalogCache && now - catalogCache.ts < CATALOG_TTL_MS) {
    return catalogCache.models;
  }

  const [nanogptModels, neuralwattModels] = await Promise.all([
    fetchModelsFromNanoGPT().catch(() => [] as ModelInfo[]),
    fetchModelsFromNeuralwatt().catch(() => [] as ModelInfo[]),
  ]);

  const models = [...nanogptModels, ...neuralwattModels];
  catalogCache = { ts: now, models };
  return models;
}

/** Find a model in the (cached) combined catalog. Synchronous lookup only. */
function lookupCachedModel(modelId: string): ModelInfo | undefined {
  if (!catalogCache) return undefined;
  return catalogCache.models.find((m) => m.id === modelId);
}

/** Resolve the context window (in tokens) for a model id, best-effort. */
export async function resolveModelContextLength(modelId: string): Promise<number | undefined> {
  const cached = lookupCachedModel(modelId);
  if (cached) return cached.contextLength;

  const models = await fetchModelCatalog().catch(() => [] as ModelInfo[]);
  return models.find((m) => m.id === modelId)?.contextLength;
}

/**
 * Returns the reasoning_effort value to actually send (or undefined to let the
 * provider use its default). The capability is resolved against the combined
 * model catalog so we never send reasoning_effort to a model that doesn't
 * advertise support for it.
 */
export async function resolveReasoningEffort(
  modelId: string,
  effort: ReasoningEffort | undefined,
): Promise<ReasoningEffort | undefined> {
  if (!effort) return undefined;
  const info = lookupCachedModel(modelId)
    ?? (await fetchModelCatalog().catch(() => [] as ModelInfo[])).find((m) => m.id === modelId);
  return info?.supportsReasoningEffort ? effort : undefined;
}

/** Synchronous variant — only valid after the catalog cache is warm. */
export function isReasoningEffortSupported(modelId: string): boolean {
  return Boolean(lookupCachedModel(modelId)?.supportsReasoningEffort);
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
  // Neuralwatt models don't support the NanoGPT `:online` suffix; the provider
  // prefix is stripped so the bare id is sent to the API.
  if (isNeuralwattModel(modelId)) return stripNeuralwattPrefix(modelId);

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
};

export async function runNanoGPTCompletion(input: {
  model: string;
  webSearchEnabled: boolean;
  messages: MessageInput[];
  attachments?: PreparedAttachment[];
  latestUserPrompt?: string;
  reasoningEffort?: ReasoningEffort;
}): Promise<CompletionResult> {
  const result = await streamCompletionWithCallbacks(input, {
    onTTFT() {},
    onContent() {},
    onReasoning() {},
  });
  return result;
}

type StreamCallbacks = {
  onContent: (text: string) => void;
  onReasoning: (text: string) => void;
  onTTFT: (ttftMs: number) => void;
};

type StreamCompletionResult = CompletionResult & { ttftMs: number };

export async function streamCompletionWithCallbacks(
  input: {
    model: string;
    webSearchEnabled: boolean;
    messages: MessageInput[];
    attachments?: PreparedAttachment[];
    latestUserPrompt?: string;
    reasoningEffort?: ReasoningEffort;
  },
  callbacks: StreamCallbacks,
): Promise<StreamCompletionResult> {
  const hasNeuralwattKey = Boolean(env.NEURALWATT_API_KEY);
  const isNeuralwatt = isNeuralwattModel(input.model);
  if (isNeuralwatt && !hasNeuralwattKey) {
    throw new Error("NEURALWATT_API_KEY is not configured for the selected model.");
  }
  if (!isNeuralwatt && !env.NANOGPT_API_KEY) {
    throw new Error("NANOGPT_API_KEY is not configured.");
  }

  const startTime = Date.now();
  const client = getOpenAIClientForModel(input.model);
  const model = applyWebSearchSuffix(input.model, input.webSearchEnabled);
  const attachments = input.attachments ?? [];

  const effectiveReasoningEffort = await resolveReasoningEffort(input.model, input.reasoningEffort);
  const createOptions: Record<string, unknown> = {
    model,
    messages: [] as ChatCompletionMessageParam[],
    stream: true,
  };
  if (effectiveReasoningEffort) {
    createOptions.reasoning_effort = effectiveReasoningEffort;
  }
  let usingCompressedAttachments = false;
  let conversation = await buildConversationMessages({
    messages: input.messages,
    attachments,
    latestUserPrompt: input.latestUserPrompt,
    compressedAttachments: false,
  });

  let finalContent = "";
  let finalReasoning = "";
  let providerModel: string | undefined;
  let ttftMs: number | undefined;
  let ttftEmitted = false;
  let lastUsage: { prompt_tokens?: number; completion_tokens?: number } | undefined;

  type StreamChunk = {
    usage?: { prompt_tokens?: number; completion_tokens?: number };
    choices?: Array<{ delta?: { content?: string; reasoning?: string; tool_calls?: unknown[] } }>;
  };

  const drain = async (response: AsyncIterable<StreamChunk>) => {
    for await (const chunk of response) {
      const usage = chunk.usage ?? undefined;
      if (usage) lastUsage = usage;
      const choice = chunk.choices?.[0];
      const delta = choice?.delta;

      if (!ttftEmitted && (delta?.content || delta?.reasoning)) {
        ttftMs = Date.now() - startTime;
        ttftEmitted = true;
        callbacks.onTTFT(ttftMs);
      }

      if (delta?.reasoning) {
        finalReasoning += delta.reasoning;
        callbacks.onReasoning(delta.reasoning);
      }

      if (delta?.content) {
        finalContent += delta.content;
        callbacks.onContent(delta.content);
      }
    }
  };

  try {
    createOptions.messages = conversation;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response = await client.chat.completions.create(createOptions as any) as any;
    await drain(response);
  } catch (error) {
    if (!usingCompressedAttachments && attachments.length > 0 && isOversizeModelError(error)) {
      usingCompressedAttachments = true;
      finalContent = "";
      finalReasoning = "";
      ttftEmitted = false;
      ttftMs = undefined;

      conversation = await buildConversationMessages({
        messages: input.messages,
        attachments,
        latestUserPrompt: input.latestUserPrompt,
        compressedAttachments: true,
      });

      createOptions.messages = conversation;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const retryResponse = await client.chat.completions.create(createOptions as any) as any;
      await drain(retryResponse);
    } else {
      throw error;
    }
  }

  const usagePromptTokens = lastUsage?.prompt_tokens;
  const usageCompletionTokens = lastUsage?.completion_tokens;

  return {
    content: finalContent,
    reasoning: finalReasoning || undefined,
    providerModel,
    usagePromptTokens,
    usageCompletionTokens,
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
