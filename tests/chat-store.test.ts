import { describe, expect, it } from "vitest";

import type { ChatMessage, ChatToolCall, MessageSegment } from "@/lib/chat-types";
import { normalizeSegments, normalizeToolCalls } from "@/lib/chat-store";

describe("normalizeToolCalls", () => {
  it("returns undefined for non-array input", () => {
    expect(normalizeToolCalls(undefined)).toBeUndefined();
    expect(normalizeToolCalls("nope")).toBeUndefined();
    expect(normalizeToolCalls({})).toBeUndefined();
  });

  it("returns undefined for an empty array (nothing to render)", () => {
    expect(normalizeToolCalls([])).toBeUndefined();
  });

  it("preserves legacy lightweight tool calls (no args/output)", () => {
    const raw = [
      { toolCallId: "c1", toolName: "web_fetch", status: "success", durationMs: 1200 },
    ];
    const out = normalizeToolCalls(raw);
    expect(out).toEqual([
      { toolCallId: "c1", toolName: "web_fetch", status: "success", durationMs: 1200 },
    ]);
  });

  it("preserves arguments + output + error on new-style tool calls", () => {
    const raw = [
      {
        toolCallId: "c1",
        toolName: "web_fetch",
        status: "success",
        durationMs: 50,
        arguments: { url: "https://x.test", format: "markdown" },
        output: "fetched text",
      },
      {
        toolCallId: "c2",
        toolName: "shell",
        status: "error",
        durationMs: 10,
        error: "Exit code 1",
      },
    ];
    const out = normalizeToolCalls(raw) as ChatToolCall[];
    expect(out[0]!.arguments).toEqual({ url: "https://x.test", format: "markdown" });
    expect(out[0]!.output).toBe("fetched text");
    expect(out[1]!.error).toBe("Exit code 1");
  });

  it("skips malformed entries and coerces bad status to running", () => {
    const raw = [
      "not-an-object",
      { toolCallId: "c1", toolName: "web_fetch", status: "bogus" },
      { toolName: "no-id" },
    ];
    const out = normalizeToolCalls(raw) as ChatToolCall[];
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ toolCallId: "c1", toolName: "web_fetch", status: "running" });
  });

  it("rejects array/non-object arguments", () => {
    const raw = [{ toolCallId: "c1", toolName: "t", status: "success", arguments: [1, 2] }];
    const out = normalizeToolCalls(raw) as ChatToolCall[];
    expect(out[0]!.arguments).toBeUndefined();
  });
});

describe("normalizeSegments", () => {
  it("returns undefined for non-array", () => {
    expect(normalizeSegments(undefined)).toBeUndefined();
    expect(normalizeSegments(null)).toBeUndefined();
  });

  it("returns undefined for empty array", () => {
    expect(normalizeSegments([])).toBeUndefined();
  });

  it("preserves valid segments", () => {
    const raw = [
      { text: "before tool 0", beforeToolIndex: 0 },
      { text: "tail", beforeToolIndex: 3 },
    ];
    expect(normalizeSegments(raw)).toEqual(raw as MessageSegment[]);
  });

  it("skips malformed segments", () => {
    const raw = [
      { text: "ok", beforeToolIndex: 1 },
      { text: "no-index" },
      { beforeToolIndex: 2 },
      "garbage",
    ];
    expect(normalizeSegments(raw)).toEqual([{ text: "ok", beforeToolIndex: 1 }]);
  });
});

/** Build a ChatMessage helper for timeline tests. */
function msg(partial: Partial<ChatMessage>): ChatMessage {
  return {
    id: "m1",
    role: "assistant",
    content: "",
    createdAt: "2026-06-20T10:00:00.000Z",
    ...partial,
  };
}

describe("ChatMessage type compiles with new fields", () => {
  it("accepts contentSegments, reasoningSegments and enriched toolCalls", () => {
    const m = msg({
      content: "final answer",
      reasoning: "thinking",
      contentSegments: [{ text: "final answer", beforeToolIndex: 2 }],
      reasoningSegments: [{ text: "thinking", beforeToolIndex: 0 }],
      toolCalls: [
        {
          toolCallId: "tc1",
          toolName: "web_fetch",
          status: "success",
          durationMs: 100,
          arguments: { url: "https://x.test" },
          output: "body",
        },
      ],
    });
    expect(m.toolCalls![0]!.arguments).toEqual({ url: "https://x.test" });
    expect(m.contentSegments).toHaveLength(1);
  });
});
