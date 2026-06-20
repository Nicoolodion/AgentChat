import { describe, expect, it } from "vitest";

import type { ChatMessage } from "@/lib/chat-types";
import { buildSteps, type TimelineStep, type ToolOutputEntry } from "@/components/chat/MessageTimeline";

function msg(partial: Partial<ChatMessage>): ChatMessage {
  return {
    id: "m1",
    role: "assistant",
    content: "",
    createdAt: "2026-06-20T10:00:00.000Z",
    ...partial,
  };
}

const kinds = (steps: TimelineStep[]) => steps.map((s) => s.kind);

describe("buildSteps: legacy (no segments)", () => {
  it("places reasoning first, then tools, then a single trailing text block", () => {
    const m = msg({
      reasoning: "think",
      content: "answer",
      toolCalls: [
        { toolCallId: "t1", toolName: "web_fetch", status: "success", durationMs: 10 },
        { toolCallId: "t2", toolName: "shell", status: "success", durationMs: 5 },
      ],
    });
    const steps = buildSteps(m, [], {});
    expect(kinds(steps)).toEqual(["reasoning", "tool", "tool", "text"]);
    expect((steps[0] as { text: string }).text).toBe("think");
    expect((steps[steps.length - 1] as { text: string }).text).toBe("answer");
  });

  it("omits empty text/reasoning steps", () => {
    const m = msg({ content: "   ", toolCalls: [{ toolCallId: "t1", toolName: "x", status: "success" }] });
    const steps = buildSteps(m, [], {});
    expect(kinds(steps)).toEqual(["tool"]);
  });
});

describe("buildSteps: interleaving with segments", () => {
  it("interleaves reasoning + content + tools in emission order, plus a tail", () => {
    const m = msg({
      content: "intro final",
      reasoningSegments: [
        { text: "reason-before-0", beforeToolIndex: 0 },
        { text: "reason-before-1", beforeToolIndex: 1 },
        { text: "reason-tail", beforeToolIndex: 2 },
      ],
      contentSegments: [
        { text: "intro", beforeToolIndex: 0 },
        { text: "middle", beforeToolIndex: 2 },
        { text: "final", beforeToolIndex: 2 },
      ],
      toolCalls: [
        { toolCallId: "t1", toolName: "web_fetch", status: "success" },
        { toolCallId: "t2", toolName: "shell", status: "success" },
      ],
    });
    const steps = buildSteps(m, [], {});
    // Expected order:
    // reasoning-before-0, content(intro), tool0,
    // reasoning-before-1, tool1,
    // reasoning-tail, content(middle), content(final)
    expect(kinds(steps)).toEqual([
      "reasoning",
      "text",
      "tool",
      "reasoning",
      "tool",
      "reasoning",
      "text",
      "text",
    ]);
    expect((steps[1] as { text: string }).text).toBe("intro");
    expect((steps[6] as { text: string }).text).toBe("middle");
    expect((steps[7] as { text: string }).text).toBe("final");
  });

  it("does NOT collapse content into a single trailing block when segments exist", () => {
    const m = msg({
      content: "a b",
      contentSegments: [
        { text: "a", beforeToolIndex: 0 },
        { text: "b", beforeToolIndex: 1 },
      ],
      toolCalls: [
        { toolCallId: "t1", toolName: "x", status: "success" },
        { toolCallId: "t2", toolName: "y", status: "success" },
      ],
    });
    const steps = buildSteps(m, [], {});
    const textSteps = steps.filter((s) => s.kind === "text");
    expect(textSteps).toHaveLength(2);
    expect((textSteps[0] as { text: string }).text).toBe("a");
    expect((textSteps[1] as { text: string }).text).toBe("b");
  });
});

describe("buildSteps: tool args/output resolution (refresh-safe)", () => {
  const callWithPersisted = (output?: string) => ({
    toolCallId: "t1",
    toolName: "web_fetch",
    status: "success" as const,
    durationMs: 12,
    arguments: { url: "https://persisted.test" },
    output,
  });

  it("uses persisted arguments and output when no live maps are provided (after refresh)", () => {
    const m = msg({ toolCalls: [callWithPersisted("persisted-body")] });
    const steps = buildSteps(m, [], undefined);
    const tool = steps.find((s) => s.kind === "tool") as Extract<TimelineStep, { kind: "tool" }>;
    expect(tool.arguments).toEqual({ url: "https://persisted.test" });
    expect(tool.outputs).toEqual([{ toolCallId: "t1", output: "persisted-body" }]);
  });

  it("prefers live streamed outputs over persisted output", () => {
    const m = msg({ toolCalls: [callWithPersisted("persisted-body")] });
    const live: ToolOutputEntry[] = [{ toolCallId: "t1", output: "live-body" }];
    const steps = buildSteps(m, live, {});
    const tool = steps.find((s) => s.kind === "tool") as Extract<TimelineStep, { kind: "tool" }>;
    expect(tool.outputs).toEqual([{ toolCallId: "t1", output: "live-body" }]);
  });

  it("falls back to live toolArguments when the call has no persisted arguments", () => {
    const m = msg({
      toolCalls: [{ toolCallId: "t1", toolName: "web_fetch", status: "success" }],
    });
    const steps = buildSteps(m, [], { t1: { url: "https://live.test" } });
    const tool = steps.find((s) => s.kind === "tool") as Extract<TimelineStep, { kind: "tool" }>;
    expect(tool.arguments).toEqual({ url: "https://live.test" });
  });
});
