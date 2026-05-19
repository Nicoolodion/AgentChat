/**
 * Agent Orchestrator
 *
 * Manages the ReAct loop for agent execution:
 *   1. Receives user message + session context
 *   2. Streams progress via SSE controller
 *   3. Calls LLM with tool definitions
 *   4. Executes tools via the Docker sandbox
 *   5. Persists tool calls & artifacts to the database
 */

import type { PrismaClient } from "@prisma/client";
import type OpenAI from "openai";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions/completions";

import { env } from "@/lib/env";
import { nanoClient } from "@/lib/nanogpt";
import { prisma } from "@/lib/prisma";
import {
  AgentArtifactKind,
  AgentSseEvent,
  AgentSession,
  AgentSessionStatus,
  AgentToolCallStatus,
} from "./types";
import {
  sandboxConvertDocxToPdf,
  sandboxConvertHtmlToPdf,
  sandboxExecPython,
  sandboxExecShell,
  sandboxFileDelete,
  sandboxFileList,
  sandboxFileRead,
  sandboxFileWrite,
  sandboxFileMove,
  sandboxFileInfo,
} from "./sandbox";

// ── Tool definitions for the LLM ─────────────────────────────────────────────

const AGENT_TOOL_SCHEMAS: ChatCompletionTool[] = [
  // ── File Tools ─────────────────────────────────────────────────────────────
  {
    type: "function",
    function: {
      name: "file_read",
      description: "Read content of a file in the workspace.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path within workspace" },
          encoding: { type: "string", enum: ["utf8", "base64"], default: "utf8" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "file_write",
      description: "Write content to a file in the workspace.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path within workspace" },
          content: { type: "string" },
          encoding: { type: "string", enum: ["utf8", "base64"], default: "utf8" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "file_list",
      description: "List files in a workspace directory.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", default: "/", description: "Directory path relative to workspace" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "file_delete",
      description: "Delete a file or directory in the workspace.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "chart_create",
      description: "Create a chart or image using matplotlib / Pillow. The working directory is already set to your session workspace. Use RELATIVE paths (e.g. 'output/chart.png').",
      parameters: {
        type: "object",
        properties: {
          python_code: { type: "string", description: "Python code using matplotlib or Pillow to generate the image/chart. Save to a relative path." },
          output_path: { type: "string", description: "Relative path for output image (e.g. 'output/chart.png')" },
        },
        required: ["python_code", "output_path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "image_analyze",
      description: "Analyze an image file using the current vision-capable model. Returns a textual description or answers a question about the image.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path to the image file in the workspace (e.g. 'upload/photo.jpg')" },
          prompt: { type: "string", description: "What to ask about the image. Default: 'Describe this image in detail.'", default: "Describe this image in detail." },
          detail: { type: "string", enum: ["high", "low"], description: "Vision detail level. Use 'low' for a faster, cheaper overview. Default: 'high'", default: "high" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "todo_create",
      description: "Create a todo list in the workspace.",
      parameters: {
        type: "object",
        properties: {
          items: { type: "array", items: { type: "string" }, description: "List of todo items" },
        },
        required: ["items"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "todo_read",
      description: "Read the current todo list from the workspace.",
      parameters: { type: "object", properties: {} },
    },
  },
];

// ── System prompt ────────────────────────────────────────────────────────────

const AGENT_SYSTEM_PROMPT = `You are the Chatinterface Agent — an autonomous reasoning engine that helps users create documents, analyze files, write code, search the web, and perform multi-step tasks.

## Workspace
You have a persistent workspace. The current working directory is already set to your session workspace directory which contains:
- upload/ — user uploaded files
- output/ — generated artifacts (place final deliverables here)
- temp/ — scratch space

IMPORTANT: Use RELATIVE paths in your Python code (e.g. 'output/report.docx', 'temp/data.csv'). The working directory is already set to your workspace root. If you need the absolute path, use the WORKSPACE_DIR environment variable.

## ReAct Loop
Think step-by-step. When you need to act, use a tool. After receiving tool results, decide the next step. Always explain your reasoning.

## Available Tools
### File I/O
- file_read(path, encoding?) — read a file
- file_write(path, content, encoding?) — write a file
- file_list(path?) — list directory contents
- file_delete(path) — delete a file
- file_move(source, destination) — move/rename a file
- file_info(path) — get file metadata

### Code Execution
- ipython(code, timeout?) — execute Python with persistent session state (matplotlib, Pillow, pandas, numpy, opencv, openpyxl, python-docx, pikepdf available)
- shell(command, working_dir?, timeout?) — run shell commands
- pip_install(package) — install a Python package

### Document Generation
- pdf_from_html(html_path, output_path) — convert HTML to PDF via Playwright
- docx_to_pdf(input_path, output_path) — convert DOCX to PDF via LibreOffice
- docx_create(output_path, python_code) — create Word doc using python-docx
- xlsx_create(output_path, python_code) — create Excel sheet using openpyxl
- pptx_create(output_path, python_code) — create PowerPoint using python-pptx
- libreoffice_convert(input_path, output_format, output_path?) — convert office formats

### Web & Search
- web_search(query, max_results?) — search the web via DuckDuckGo
- web_fetch(url, format?) — fetch a webpage (html, text, markdown)

### Charts & Images
- chart_create(python_code, output_path) — create matplotlib chart
- image_analyze(path, prompt?, detail?) — analyze an image with a vision model (high/low detail). Good for OCR, diagrams, or photo descriptions.

### Project Management
- todo_create(items) — create a todo list
- todo_read() — read current todo list

## Skills
Skills are mounted at /app/skills/ and provide domain expertise:
- /app/skills/docx/ — Word document creation (read SKILL.md for routing rules)
- /app/skills/pdf/ — PDF generation from HTML (read SKILL.md for routing rules)
- /app/skills/xlsx/ — Spreadsheet creation
- /app/skills/pptx/ — Presentation creation

To read a skill file, use file_read with the path /app/skills/<skill>/SKILL.md.

## Quality Standards
- Place all final deliverables in the output/ directory.
- Use clear, descriptive filenames.
- Summarize what you produced in your final message.
- If a step fails, retry with a different approach or ask the user.
- For document generation, read the relevant SKILL.md first to follow best practices.`;

// ── Orchestrator ─────────────────────────────────────────────────────────────

export type SseController = {
  enqueue: (data: string) => void;
  close: () => void;
};

export async function runAgentExecution(input: {
  sessionId: string;
  userMessage: string;
  priorConversation: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  model: string;
  sendEvent: (event: AgentSseEvent) => void;
}): Promise<{ content: string; reasoning?: string; toolCallsCount: number }> {
  const { sessionId, userMessage, priorConversation, model, sendEvent } = input;

  // Update session status
  await updateSessionStatus(sessionId, "thinking");
  sendEvent({ type: "status", data: { status: "thinking", step: "Analyzing request and planning steps" } });

  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: AGENT_SYSTEM_PROMPT },
    ...priorConversation.map((m) => ({ role: m.role, content: m.content }) as ChatCompletionMessageParam),
    { role: "user", content: userMessage },
  ];

  let finalContent = "";
  let finalReasoning = "";
  let toolCallsCount = 0;
  const maxToolCalls = Number(process.env.AGENT_MAX_TOOL_CALLS ?? "20");

  for (let iteration = 0; iteration < 4; iteration++) {
    const accumulatedToolCalls: Array<{
      id: string;
      type: string;
      function: { name: string; arguments: string };
    }> = [];
    let currentToolCallIndex = -1;
    let contentBuffer = "";

    const response = await nanoClient.chat.completions.create({
      model,
      messages,
      tools: AGENT_TOOL_SCHEMAS,
      tool_choice: "auto",
      parallel_tool_calls: false,
      stream: true,
    });

    for await (const chunk of response) {
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;

      const reasoningDelta = (delta as { reasoning?: string })?.reasoning;
      if (reasoningDelta) {
        finalReasoning += reasoningDelta;
        sendEvent({ type: "reasoning", data: { text: reasoningDelta } });
      }

      if (delta.content) {
        contentBuffer += delta.content;
        finalContent += delta.content;
        sendEvent({ type: "content", data: { text: delta.content } });
      }

      const toolCalls = delta.tool_calls ?? [];
      for (const toolCall of toolCalls) {
        const idx = toolCall.index ?? 0;
        if (idx !== currentToolCallIndex) {
          currentToolCallIndex = idx;
          accumulatedToolCalls[idx] = {
            id: toolCall.id ?? `call_${Date.now()}_${idx}`,
            type: toolCall.type ?? "function",
            function: {
              name: toolCall.function?.name ?? "",
              arguments: toolCall.function?.arguments ?? "",
            },
          };
          if (toolCall.function?.name) {
            sendEvent({
              type: "tool_start",
              data: {
                toolCallId: accumulatedToolCalls[idx].id,
                toolName: toolCall.function.name,
                arguments: safeParseArgs(toolCall.function.arguments ?? "{}"),
              },
            });
          }
        } else {
          const funcArgs = toolCall.function?.arguments;
          if (funcArgs) {
            accumulatedToolCalls[idx].function.arguments += funcArgs;
          }
        }
      }
    }

    if (accumulatedToolCalls.length === 0 || accumulatedToolCalls.every((tc) => !tc?.function?.name)) {
      // No tool calls — we're done
      await updateSessionStatus(sessionId, "completed");
      sendEvent({ type: "status", data: { status: "completed" } });
      return { content: contentBuffer || finalContent, reasoning: finalReasoning || undefined, toolCallsCount };
    }

    // Execute tool calls
    messages.push({ role: "assistant", content: contentBuffer, tool_calls: accumulatedToolCalls as any });

    await updateSessionStatus(sessionId, "executing");
    sendEvent({ type: "status", data: { status: "executing", step: `Executing ${accumulatedToolCalls.length} tool(s)` } });

    for (const tc of accumulatedToolCalls) {
      if (!tc?.function?.name) continue;
      toolCallsCount++;
      if (toolCallsCount > maxToolCalls) break;

      const toolCallId = tc.id;
      const toolName = tc.function.name;
      const toolArgs = safeParseArgs(tc.function.arguments ?? "{}");

      const toolCallRecord = await createToolCall(sessionId, toolName, tc.function.arguments);

      const startMs = Date.now();
      let result: { ok: boolean; result?: unknown; error?: string };
      let output = "";

      try {
        const execResult = await executeSandboxTool(sessionId, toolName, toolArgs);
        result = { ok: execResult.ok, result: execResult.result, error: execResult.error };
        output = execResult.stdout ?? "";

        // Detect artifacts after file-writing tools
        await scanForArtifacts(sessionId, toolName, toolArgs, sendEvent);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result = { ok: false, error: msg };
        output = msg;
      }

      const durationMs = Date.now() - startMs;
      await completeToolCall(toolCallRecord.id, result.ok ? "success" : "error", JSON.stringify(result), result.error ?? undefined, durationMs);

      sendEvent({
        type: "tool_output",
        data: { toolCallId, output: output.slice(0, 4000) },
      });
      sendEvent({
        type: "tool_done",
        data: { toolCallId, toolName, ok: result.ok, durationMs, error: result.error },
      });

      messages.push({
        role: "tool",
        tool_call_id: toolCallId,
        content: JSON.stringify(result),
      });
    }

    if (toolCallsCount > maxToolCalls) {
      finalContent += "\n\n[Reached maximum number of tool calls for this session.]";
      break;
    }
  }

  await updateSessionStatus(sessionId, "completed");
  sendEvent({ type: "status", data: { status: "completed" } });
  return { content: finalContent, reasoning: finalReasoning || undefined, toolCallsCount };
}

// ── Tool execution dispatcher ────────────────────────────────────────────────

async function executeSandboxTool(
  sessionId: string,
  toolName: string,
  args: Record<string, unknown>
): Promise<{ ok: boolean; result?: unknown; error?: string; stdout?: string }> {
  switch (toolName) {
    // ── File Tools ──────────────────────────────────────────────────────────
    case "file_read": {
      const path = String(args.path ?? "");
      const encoding = (args.encoding as "utf8" | "base64") ?? "utf8";
      const res = await sandboxFileRead(sessionId, path, encoding);
      return { ok: true, result: res, stdout: `Read ${res.size} bytes from ${path}` };
    }
    case "file_write": {
      const path = String(args.path ?? "");
      const content = String(args.content ?? "");
      const encoding = (args.encoding as "utf8" | "base64") ?? "utf8";
      const res = await sandboxFileWrite(sessionId, path, content, encoding);
      return { ok: true, result: res, stdout: `Wrote ${res.size} bytes to ${path}` };
    }
    case "file_list": {
      const dirPath = String(args.path ?? "/");
      const files = await sandboxFileList(sessionId, dirPath);
      return { ok: true, result: files, stdout: `Listed ${files.length} entries in ${dirPath}` };
    }
    case "file_delete": {
      const path = String(args.path ?? "");
      await sandboxFileDelete(sessionId, path);
      return { ok: true, result: { deleted: path }, stdout: `Deleted ${path}` };
    }
    case "file_move": {
      const source = String(args.source ?? "");
      const destination = String(args.destination ?? "");
      const res = await sandboxFileMove(sessionId, source, destination);
      return { ok: true, result: res, stdout: `Moved ${source} to ${destination}` };
    }
    case "file_info": {
      const path = String(args.path ?? "");
      const res = await sandboxFileInfo(sessionId, path);
      return { ok: true, result: res, stdout: `Info for ${path}: ${res.size} bytes, ${res.mime_type}` };
    }
    // ── Code Execution Tools ────────────────────────────────────────────────
    case "ipython": {
      const code = String(args.code ?? "");
      const timeout = Number(args.timeout ?? 60);
      const res = await sandboxExecPython(sessionId, code, timeout);
      return {
        ok: !res.error,
        result: res,
        error: res.error ?? undefined,
        stdout: res.stdout || res.stderr,
      };
    }
    case "shell": {
      const command = String(args.command ?? "");
      const workingDir = String(args.working_dir ?? "/");
      const timeout = Number(args.timeout ?? 30);
      const res = await sandboxExecShell(sessionId, command, workingDir, timeout);
      return {
        ok: res.exit_code === 0 && !res.error,
        result: res,
        error: res.error ?? (res.exit_code !== 0 ? `Exit code ${res.exit_code}` : undefined),
        stdout: res.stdout || res.stderr,
      };
    }
    case "pip_install": {
      const pkg = String(args.package ?? args.packages ?? "");
      const workspaceRes = await sandboxExecShell(sessionId, `mkdir -p /workspace/${sessionId}/python_libs`, "/", 10);
      const cmd = `pip install --target /workspace/${sessionId}/python_libs ${pkg}`;
      const res = await sandboxExecShell(sessionId, cmd, "/", 120);
      return {
        ok: res.exit_code === 0 && !res.error,
        result: res,
        error: res.error ?? (res.exit_code !== 0 ? `Exit code ${res.exit_code}` : undefined),
        stdout: res.stdout || res.stderr,
      };
    }
    // ── Document Generation Tools ───────────────────────────────────────────
    case "pdf_from_html": {
      const htmlPath = String(args.html_path ?? "");
      const outputPath = String(args.output_path ?? "");
      const res = await sandboxConvertHtmlToPdf(sessionId, htmlPath, outputPath);
      return { ok: true, result: res, stdout: `PDF created: ${outputPath} (${res.size} bytes)` };
    }
    case "docx_to_pdf": {
      const inputPath = String(args.input_path ?? "");
      const outputPath = String(args.output_path ?? "");
      const res = await sandboxConvertDocxToPdf(sessionId, inputPath, outputPath);
      return { ok: true, result: res, stdout: `PDF created: ${outputPath} (${res.size} bytes)` };
    }
    case "docx_create": {
      const outputPath = String(args.output_path ?? "");
      const pythonCode = String(args.python_code ?? "");
      await sandboxExecShell(sessionId, `mkdir -p "$(dirname '${outputPath.replace(/'/g, "'\\'")}')"`, "/", 10);
      const res = await sandboxExecPython(sessionId, pythonCode, 120);
      return {
        ok: !res.error,
        result: res,
        error: res.error ?? undefined,
        stdout: res.stdout || `DOCX created: ${outputPath}`,
      };
    }
    case "xlsx_create": {
      const outputPath = String(args.output_path ?? "");
      const pythonCode = String(args.python_code ?? "");
      await sandboxExecShell(sessionId, `mkdir -p "$(dirname '${outputPath.replace(/'/g, "'\\'")}')"`, "/", 10);
      const res = await sandboxExecPython(sessionId, pythonCode, 120);
      return {
        ok: !res.error,
        result: res,
        error: res.error ?? undefined,
        stdout: res.stdout || `XLSX created: ${outputPath}`,
      };
    }
    case "pptx_create": {
      const outputPath = String(args.output_path ?? "");
      const pythonCode = String(args.python_code ?? "");
      await sandboxExecShell(sessionId, `mkdir -p "$(dirname '${outputPath.replace(/'/g, "'\\'")}')"`, "/", 10);
      const res = await sandboxExecPython(sessionId, pythonCode, 120);
      return {
        ok: !res.error,
        result: res,
        error: res.error ?? undefined,
        stdout: res.stdout || `PPTX created: ${outputPath}`,
      };
    }
    case "libreoffice_convert": {
      const inputPath = String(args.input_path ?? "");
      const outputFormat = String(args.output_format ?? "pdf");
      const outputPath = String(args.output_path ?? "");
      const outDir = outputPath.includes("/") ? outputPath.substring(0, outputPath.lastIndexOf("/")) : "output";
      const cmd = `HOME=/tmp libreoffice --headless --nologo --convert-to ${outputFormat} --outdir ${outDir} ${inputPath}`;
      const res = await sandboxExecShell(sessionId, cmd, "/", 120);
      return {
        ok: res.exit_code === 0 && !res.error,
        result: res,
        error: res.error ?? (res.exit_code !== 0 ? `Exit code ${res.exit_code}` : undefined),
        stdout: res.stdout || `Converted ${inputPath} to ${outputFormat}`,
      };
    }
    // ── Web & Search Tools ──────────────────────────────────────────────────
    case "web_search": {
      const query = String(args.query ?? "");
      const maxResults = Math.min(Math.max(Number(args.max_results ?? 5), 1), 10);
      const searchCode = `
import json, urllib.request, urllib.parse
query = ${JSON.stringify(query)}
max_results = ${maxResults}
url = "https://duckduckgo.com/html/"
# Use html version since API requires key
try:
    req = urllib.request.Request(
        f"https://html.duckduckgo.com/html/?q={urllib.parse.quote(query)}",
        headers={"User-Agent": "Mozilla/5.0"}
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        html = resp.read().decode("utf-8", errors="replace")
    import re
    results = []
    for m in re.finditer(r'<a rel="nofollow" class="result__a" href="([^"]+)">([^<]+)</a>', html):
        if len(results) >= max_results:
            break
        results.append({"title": m.group(2).strip(), "url": m.group(1), "snippet": ""})
    # Try to get snippets
    snippets = re.findall(r'<a class="result__snippet"[^>]*>([^<]+)</a>', html)
    for i, s in enumerate(snippets):
        if i < len(results):
            results[i]["snippet"] = s.strip()
    print(json.dumps(results))
except Exception as e:
    print(json.dumps({"error": str(e)}))
`;
      const res = await sandboxExecPython(sessionId, searchCode, 30);
      let parsed: unknown = [];
      try {
        parsed = JSON.parse(res.stdout.trim().split("\n").pop() ?? "[]");
      } catch { /* ignore */ }
      return { ok: !res.error, result: parsed, stdout: res.stdout };
    }
    case "web_fetch": {
      const url = String(args.url ?? "");
      const format = (args.format as "html" | "text" | "markdown") ?? "text";
      const fetchCode = `
import urllib.request, re
url = ${JSON.stringify(url)}
try:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=20) as resp:
        html = resp.read().decode("utf-8", errors="replace")
    fmt = ${JSON.stringify(format)}
    if fmt == "text":
        # Strip tags
        text = re.sub(r'<[^>]+>', ' ', html)
        text = re.sub(r'\\s+', ' ', text).strip()
        print(text[:12000])
    elif fmt == "markdown":
        # Very basic html->md
        md = html
        md = re.sub(r'<h1[^>]*>([^<]+)</h1>', r'# \\1\\n', md)
        md = re.sub(r'<h2[^>]*>([^<]+)</h2>', r'## \\1\\n', md)
        md = re.sub(r'<h3[^>]*>([^<]+)</h3>', r'### \\1\\n', md)
        md = re.sub(r'<p[^>]*>([^<]+)</p>', r'\\1\\n\\n', md)
        md = re.sub(r'<li[^>]*>([^<]+)</li>', r'- \\1\\n', md)
        md = re.sub(r'<[^>]+>', ' ', md)
        md = re.sub(r'\\s+', ' ', md).strip()
        print(md[:12000])
    else:
        print(html[:15000])
except Exception as e:
    print(f"Fetch error: {e}")
`;
      const res = await sandboxExecPython(sessionId, fetchCode, 30);
      return { ok: !res.error, result: { content: res.stdout }, stdout: res.stdout };
    }
    // ── Chart & Image Tools ─────────────────────────────────────────────────
    case "chart_create": {
      const pythonCode = String(args.python_code ?? "");
      const outputPath = String(args.output_path ?? "");
      await sandboxExecShell(sessionId, `mkdir -p "$(dirname '${outputPath.replace(/'/g, "'\\'")}')"`, "/", 10);
      const res = await sandboxExecPython(sessionId, pythonCode, 120);
      return {
        ok: !res.error,
        result: res,
        error: res.error ?? undefined,
        stdout: res.stdout || `Chart saved to ${outputPath}`,
      };
    }
    case "image_analyze": {
      const imagePath = String(args.path ?? "");
      const prompt = String(args.prompt ?? "Describe this image in detail.");
      const detail = (args.detail as "high" | "low") ?? "high";
      const fileRes = await sandboxFileRead(sessionId, imagePath, "base64");
      const ext = imagePath.includes(".") ? imagePath.split(".").pop()!.toLowerCase() : "png";
      const mimeMap: Record<string, string> = {
        jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml",
      };
      const mime = mimeMap[ext] ?? "image/png";
      const dataUrl = `data:${mime};base64,${fileRes.content}`;
      const response = await nanoClient.chat.completions.create({
        model: env.DEFAULT_MODEL,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: dataUrl, detail } },
            ],
          },
        ],
        max_tokens: 2048,
      });
      const content = response.choices[0]?.message?.content ?? "";
      return { ok: true, result: { content }, stdout: content };
    }
    // ── Todo Tools ──────────────────────────────────────────────────────────
    case "todo_create": {
      const items = Array.isArray(args.items) ? args.items : [];
      const todoContent = items.map((item: unknown, i: number) => `${i + 1}. [ ] ${String(item)}`).join("\n");
      await sandboxFileWrite(sessionId, "temp/todo.md", todoContent, "utf8");
      return { ok: true, result: { items }, stdout: `Created todo list with ${items.length} items` };
    }
    case "todo_read": {
      try {
        const res = await sandboxFileRead(sessionId, "temp/todo.md", "utf8");
        return { ok: true, result: { content: res.content }, stdout: res.content };
      } catch {
        return { ok: true, result: { content: "" }, stdout: "No todo list found." };
      }
    }
    default:
      return { ok: false, error: `Unknown tool: ${toolName}` };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function safeParseArgs(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function updateSessionStatus(sessionId: string, status: AgentSessionStatus): Promise<void> {
  await prisma.agentSession.update({
    where: { id: sessionId },
    data: { status },
  });
}

async function createToolCall(sessionId: string, toolName: string, args: string): Promise<{ id: string }> {
  const record = await prisma.agentToolCall.create({
    data: {
      sessionId,
      toolName,
      arguments: args,
      status: "running",
    },
  });
  return { id: record.id };
}

async function completeToolCall(
  toolCallId: string,
  status: AgentToolCallStatus,
  result: string,
  error?: string,
  durationMs?: number
): Promise<void> {
  await prisma.agentToolCall.update({
    where: { id: toolCallId },
    data: {
      status,
      result,
      error,
      durationMs,
      completedAt: new Date(),
    },
  });
}

async function scanForArtifacts(
  sessionId: string,
  toolName: string,
  args: Record<string, unknown>,
  sendEvent: (event: AgentSseEvent) => void
): Promise<void> {
  // After file write or conversion tools, scan the output directory for new artifacts
  if (!["file_write", "pdf_from_html", "docx_to_pdf", "ipython", "docx_create", "xlsx_create", "pptx_create", "chart_create", "libreoffice_convert", "shell"].includes(toolName)) return;

  try {
    const files = await sandboxFileList(sessionId, "output/");
    const existingArtifacts = await prisma.agentArtifact.findMany({
      where: { sessionId },
      select: { storagePath: true },
    });
    const existingPaths = new Set(existingArtifacts.map((a) => a.storagePath));

    for (const file of files) {
      if (file.is_directory) continue;
      const relativePath = `output/${file.name}`;
      if (existingPaths.has(relativePath)) continue;

      const kind = inferArtifactKind(file.name, file.mime_type);
      const artifact = await prisma.agentArtifact.create({
        data: {
          sessionId,
          fileName: file.name,
          mimeType: file.mime_type ?? "application/octet-stream",
          size: file.size,
          kind,
          storagePath: relativePath,
          description: `Generated by ${toolName}`,
        },
      });

      sendEvent({
        type: "artifact",
        data: {
          artifact: {
            id: artifact.id,
            sessionId: artifact.sessionId,
            fileName: artifact.fileName,
            mimeType: artifact.mimeType,
            size: artifact.size,
            kind: artifact.kind as AgentArtifactKind,
            storagePath: artifact.storagePath,
            description: artifact.description ?? undefined,
            createdAt: artifact.createdAt.toISOString(),
          },
        },
      });
    }
  } catch {
    // Non-critical — don't fail the whole execution
  }
}

function inferArtifactKind(fileName: string, mimeType: string | null): AgentArtifactKind {
  const lowered = fileName.toLowerCase();
  if (lowered.endsWith(".pdf") || mimeType === "application/pdf") return "pdf";
  if (lowered.endsWith(".docx") || lowered.endsWith(".doc")) return "document";
  if (lowered.endsWith(".xlsx") || lowered.endsWith(".xls") || lowered.endsWith(".csv")) return "spreadsheet";
  if (lowered.endsWith(".pptx") || lowered.endsWith(".ppt")) return "presentation";
  if (lowered.endsWith(".png") || lowered.endsWith(".jpg") || lowered.endsWith(".jpeg") || lowered.endsWith(".webp") || lowered.endsWith(".gif")) return "image";
  if (lowered.endsWith(".zip") || lowered.endsWith(".tar") || lowered.endsWith(".gz")) return "archive";
  if (lowered.endsWith(".js") || lowered.endsWith(".ts") || lowered.endsWith(".py") || lowered.endsWith(".html") || lowered.endsWith(".css")) return "code";
  return "other";
}
