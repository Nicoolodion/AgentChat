import { randomUUID } from "node:crypto";

export const AGENT_TOOLS = [
  {
    type: "function",
    function: {
      name: "get_current_time",
      description: "Return the current UTC date/time in ISO format.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
  {
    type: "function",
    function: {
      name: "math_basic",
      description: "Run a basic arithmetic operation.",
      parameters: {
        type: "object",
        properties: {
          left: { type: "number", description: "Left number" },
          right: { type: "number", description: "Right number" },
          operation: {
            type: "string",
            enum: ["add", "subtract", "multiply", "divide"],
            description: "Operation to run",
          },
        },
        required: ["left", "right", "operation"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "generate_uuid",
      description: "Generate a random UUID v4 string.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
] as const;

type ToolResult = {
  ok: boolean;
  result?: unknown;
  error?: string;
};

function safeParseArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function runMath(args: Record<string, unknown>): ToolResult {
  const left = Number(args.left);
  const right = Number(args.right);
  const operation = String(args.operation ?? "");

  if (Number.isNaN(left) || Number.isNaN(right)) {
    return { ok: false, error: "Invalid numeric inputs." };
  }

  if (operation === "divide" && right === 0) {
    return { ok: false, error: "Division by zero is not allowed." };
  }

  if (operation === "add") return { ok: true, result: left + right };
  if (operation === "subtract") return { ok: true, result: left - right };
  if (operation === "multiply") return { ok: true, result: left * right };
  if (operation === "divide") return { ok: true, result: left / right };

  return { ok: false, error: "Unknown operation." };
}

export async function executeAgentTool(name: string, rawArguments?: string): Promise<ToolResult> {
  const args = safeParseArgs(rawArguments);

  if (name === "get_current_time") {
    return {
      ok: true,
      result: {
        nowUtc: new Date().toISOString(),
        unixMs: Date.now(),
      },
    };
  }

  if (name === "math_basic") {
    return runMath(args);
  }

  if (name === "generate_uuid") {
    return { ok: true, result: randomUUID() };
  }

  return { ok: false, error: `Unknown tool: ${name}` };
}
