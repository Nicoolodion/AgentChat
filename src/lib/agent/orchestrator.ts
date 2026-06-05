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
  sandboxDocxBuild,
  sandboxDocxRead,
  sandboxDocxTemplateFill,
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
      name: "file_move",
      description: "Move or rename a file within the workspace.",
      parameters: {
        type: "object",
        properties: {
          source: { type: "string", description: "Source path relative to workspace" },
          destination: { type: "string", description: "Destination path relative to workspace" },
        },
        required: ["source", "destination"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "file_info",
      description: "Get file metadata (size, mime type, modified time).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
        },
        required: ["path"],
      },
    },
  },
  // ── Code Execution Tools ───────────────────────────────────────────────────
  {
    type: "function",
    function: {
      name: "ipython",
      description: "Execute Python code with persistent session state. Matplotlib, Pillow, pandas, numpy, opencv, openpyxl, python-docx, pikepdf are available.",
      parameters: {
        type: "object",
        properties: {
          code: { type: "string", description: "Python code to execute" },
          timeout: { type: "number", default: 60, description: "Max execution time in seconds" },
        },
        required: ["code"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "shell",
      description: "Execute a shell command in the workspace.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command" },
          working_dir: { type: "string", default: "/", description: "Working directory relative to workspace" },
          timeout: { type: "number", default: 30 },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "pip_install",
      description: "Install a Python package via pip in the sandbox.",
      parameters: {
        type: "object",
        properties: {
          package: { type: "string", description: "Package name (e.g. 'openpyxl', 'requests')" },
        },
        required: ["package"],
      },
    },
  },
  // ── Document Generation Tools ──────────────────────────────────────────────
  {
    type: "function",
    function: {
      name: "pdf_from_html",
      description: "Convert an HTML file to PDF using Playwright + Paged.js.",
      parameters: {
        type: "object",
        properties: {
          html_path: { type: "string", description: "Relative path to HTML file" },
          output_path: { type: "string", description: "Relative path for output PDF" },
        },
        required: ["html_path", "output_path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "docx_to_pdf",
      description: "Convert a DOCX file to PDF using LibreOffice.",
      parameters: {
        type: "object",
        properties: {
          input_path: { type: "string" },
          output_path: { type: "string" },
        },
        required: ["input_path", "output_path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "docx_read",
      description: "Read and parse a .docx file, returning structured content (paragraphs with styles, tables, images). Use this instead of ipython or file_read for .docx files. Returns a text_summary plus structured data.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to the .docx file (e.g. 'upload/template.docx')" },
          include_images: { type: "boolean", default: true, description: "Whether to include image metadata" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "docx_template_fill",
      description: "Fill a .docx template with new content while preserving the template's cover page, tables, headers/footers, and styles. Use this when the user provides a template/example document and wants a new document following its format. Supports content sections with headings + text, image insertion, and cover page text replacement. PREFERRED over WIR editing when most of the document content needs replacing.",
      parameters: {
        type: "object",
        properties: {
          template_path: { type: "string", description: "Path to the template .docx file (e.g. 'upload/Musterprotokoll.docx')" },
          output_path: { type: "string", description: "Output path for the new document (e.g. 'output/Protokoll.docx')" },
          sections: {
            type: "array",
            description: "Content sections to add after the cover page",
            items: {
              type: "object",
              properties: {
                heading: { type: "string", description: "Section heading text" },
                heading_level: { type: "number", description: "Heading level (1-4, default 1)", default: 1 },
                content: { type: "string", description: "Section body content (supports **bold**, *italic*, - bullets, 1. numbered lists, ### sub-headings)" },
                images: {
                  type: "array",
                  description: "Images to insert in this section",
                  items: {
                    type: "object",
                    properties: {
                      path: { type: "string", description: "Relative path to image file" },
                      caption: { type: "string", description: "Optional caption below the image" },
                      width: { type: "number", description: "Width in inches (default 5.0)", default: 5.0 },
                    },
                    required: ["path"],
                  },
                },
              },
              required: ["heading"],
            },
          },
          keep_cover_page: { type: "boolean", default: true, description: "Preserve the template's cover page (first tables before any heading)" },
          cover_replacements: {
            type: "object",
            description: "Text replacements on the cover page: {search_text: replacement_text}",
            additionalProperties: { type: "string" },
          },
        },
        required: ["template_path", "output_path", "sections"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "docx_create",
      description: "Create a Word document using python-docx. The working directory is already set to your session workspace. Use RELATIVE paths (e.g. 'output/file.docx'). The output/ directory exists. You can also use the WORKSPACE_DIR variable for absolute paths.",
      parameters: {
        type: "object",
        properties: {
          output_path: { type: "string", description: "Relative path for output DOCX (e.g. 'output/report.docx')" },
          python_code: { type: "string", description: "Python code using python-docx to build the document. Use relative paths or WORKSPACE_DIR for absolute paths." },
        },
        required: ["output_path", "python_code"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "docx_build",
      description: "Build a high-quality Word document using the DOCX skill's C# + OpenXML SDK pipeline. IMPORTANT: First write your Program.cs using file_write to a path like 'temp/Program.cs', then provide that path in program_cs_path. This avoids JSON escaping issues with inline code. Only use program_cs for very short snippets.",
      parameters: {
        type: "object",
        properties: {
          output_path: { type: "string", description: "Relative path for output DOCX (e.g. 'output/report.docx')" },
          program_cs_path: { type: "string", description: "Relative path to the C# source file previously written via file_write (e.g. 'temp/Program.cs'). Preferred over program_cs." },
          program_cs: { type: "string", description: "C# source code string (fallback — prefer program_cs_path to avoid escaping issues)." },
        },
        required: ["output_path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "xlsx_create",
      description: "Create an Excel spreadsheet using openpyxl. The working directory is already set to your session workspace. Use RELATIVE paths (e.g. 'output/file.xlsx'). The output/ directory exists. You can also use the WORKSPACE_DIR variable for absolute paths.",
      parameters: {
        type: "object",
        properties: {
          output_path: { type: "string", description: "Relative path for output XLSX (e.g. 'output/data.xlsx')" },
          python_code: { type: "string", description: "Python code using openpyxl to build the spreadsheet. Use relative paths or WORKSPACE_DIR for absolute paths." },
        },
        required: ["output_path", "python_code"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "pptx_create",
      description: "Create a PowerPoint presentation using python-pptx. The working directory is already set to your session workspace. Use RELATIVE paths (e.g. 'output/file.pptx'). The output/ directory exists. You can also use the WORKSPACE_DIR variable for absolute paths.",
      parameters: {
        type: "object",
        properties: {
          output_path: { type: "string", description: "Relative path for output PPTX (e.g. 'output/slides.pptx')" },
          python_code: { type: "string", description: "Python code using python-pptx to build the presentation. Use relative paths or WORKSPACE_DIR for absolute paths." },
        },
        required: ["output_path", "python_code"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "libreoffice_convert",
      description: "Convert between office formats using LibreOffice (e.g. docx to pdf, pptx to pdf, etc).",
      parameters: {
        type: "object",
        properties: {
          input_path: { type: "string" },
          output_format: { type: "string", description: "Target format extension e.g. 'pdf', 'docx', 'html'" },
          output_path: { type: "string" },
        },
        required: ["input_path", "output_format"],
      },
    },
  },
  // ── Web & Search Tools ─────────────────────────────────────────────────────
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the web using DuckDuckGo. Returns a list of search results with title, URL, and snippet.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          max_results: { type: "number", default: 5, description: "Maximum number of results (1-10)" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_fetch",
      description: "Fetch a webpage and return its content as text, HTML, or markdown.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string" },
          format: { type: "string", enum: ["html", "text", "markdown"], default: "text" },
        },
        required: ["url"],
      },
    },
  },
  // ── Image & Chart Tools ────────────────────────────────────────────────────
  {
    type: "function",
    function: {
      name: "chart_create",
      description: "Create a chart using matplotlib and save it as an image. The working directory is already set to your session workspace. Use RELATIVE paths (e.g. 'output/chart.png'). The output/ directory exists. You can also use the WORKSPACE_DIR variable for absolute paths.",
      parameters: {
        type: "object",
        properties: {
          python_code: { type: "string", description: "Python code using matplotlib to create the chart. Use relative paths or WORKSPACE_DIR for absolute paths." },
          output_path: { type: "string", description: "Relative path for output image (e.g. output/chart.png)" },
        },
        required: ["python_code", "output_path"],
      },
    },
  },
    {
    type: "function",
    function: {
      name: "image_analyze",
      description: "Analyze one or more image files using the vision-capable model. Returns an array of descriptions, one per image, in the same order as the input paths. The tool is batched automatically, so you can pass many paths at once.",
      parameters: {
        type: "object",
        properties: {
          paths: { type: "array", items: { type: "string" }, description: "Relative paths to the image files in the workspace (e.g. ['upload/photo1.jpg', 'upload/photo2.png'])." },
          prompt: { type: "string", description: "What to ask about each image. Default: 'Describe this image concisely.'", default: "Describe this image concisely." },
          detail: { type: "string", enum: ["high", "low"], description: "Vision detail level. Use 'low' for a faster, cheaper overview. Default: 'high'", default: "high" },
        },
        required: ["paths"],
      },
    },
  },
  // ── Todo / Project Management Tools ────────────────────────────────────────
  {
    type: "function",
    function: {
      name: "todo_create",
      description: "Create a todo list in the workspace for tracking progress.",
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
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
];

// ── System prompt ────────────────────────────────────────────────────────────

const AGENT_SYSTEM_PROMPT_BASE = `You are the Chatinterface Agent — an autonomous reasoning engine that helps users create documents, analyze files, write code, search the web, and perform multi-step tasks.

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
- docx_read(path) — read and parse a .docx file (returns structured content: paragraphs, tables, images). Use this instead of file_read for .docx files.
- docx_template_fill(template_path, output_path, sections, keep_cover_page?, cover_replacements?) — fill a .docx template with new content while preserving cover page, tables, styles. Each section has heading + content + images. PREFERRED over WIR when creating a new document from a template/example.
- docx_create(output_path, python_code) — create Word doc using python-docx
- docx_build(output_path, program_cs_path?, program_cs?) — build high-quality Word doc using C# + OpenXML SDK. IMPORTANT: write Program.cs via file_write first, then pass the path in program_cs_path.
- xlsx_create(output_path, python_code) — create Excel sheet using openpyxl
- pptx_create(output_path, python_code) — create PowerPoint using python-pptx
- libreoffice_convert(input_path, output_format, output_path?) — convert office formats

### Web & Search
- web_search(query, max_results?) — search the web via DuckDuckGo
- web_fetch(url, format?) — fetch a webpage (html, text, markdown)

### Charts & Images
- chart_create(python_code, output_path) — create matplotlib chart
- image_analyze(paths, prompt?, detail?) — analyze multiple images in one call. Pass all relevant image paths together; the tool batches them automatically.

### Project Management
- todo_create(items) — create a todo list
- todo_read() — read current todo list

## Skills
Skills are mounted at /app/skills/ and provide domain expertise for document generation tasks. The relevant SKILL.md content for your task is automatically injected below when applicable.
- /app/skills/docx/ — Word documents (C# + OpenXML SDK creation, WIR editing)
- /app/skills/pdf/ — PDF generation from HTML

If you need a skill not included below, use file_read with the path /app/skills/<skill>/SKILL.md.

## Quality Standards
- Place all final deliverables in the output/ directory.
- Use clear, descriptive filenames.
- Summarize what you produced in your final message.
- If a step fails, retry with a different approach or ask the user.
- For document generation, the relevant SKILL.md has been included — follow its routing rules and quality standards.`;

const SKILL_EXTENSIONS: Record<string, string> = {
  ".docx": "docx",
  ".doc": "docx",
  ".pdf": "pdf",
};

function buildSystemPrompt(skillContent?: Map<string, string>): string {
  let prompt = AGENT_SYSTEM_PROMPT_BASE;

  if (skillContent && skillContent.size > 0) {
    const sections: string[] = [];
    for (const [skillName, content] of skillContent) {
      sections.push(`## Skill: ${skillName}\n\n${content}`);
    }
    prompt += `\n\n---\n\n# Auto-Loaded Skill Instructions\n\nThe following skill instructions were automatically loaded based on the files in the upload/ directory. Follow these rules without needing to read them again:\n\n${sections.join("\n\n")}`;
  }

  return prompt;
}

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
  signal?: AbortSignal;
}): Promise<{ content: string; reasoning?: string; toolCallsCount: number }> {
  const { sessionId, userMessage, priorConversation, model, sendEvent, signal } = input;

  // Update session status
  await updateSessionStatus(sessionId, "thinking");
  sendEvent({ type: "status", data: { status: "thinking", step: "Analyzing request and planning steps" } });

  // Auto-detect relevant skills from uploaded files
  const skillContent = new Map<string, string>();
  try {
    const files = await sandboxFileList(sessionId, "upload/");
    const neededSkills = new Set<string>();
    for (const file of files) {
      const ext = file.name.includes(".") ? "." + file.name.split(".").pop()!.toLowerCase() : "";
      const skill = SKILL_EXTENSIONS[ext];
      if (skill) neededSkills.add(skill);
    }
    // Also check the user message for skill-relevant keywords
    const msgLower = userMessage.toLowerCase();
    if (msgLower.includes("docx") || msgLower.includes(".doc") || msgLower.includes("word") || msgLower.includes("protokoll") || msgLower.includes("protocol")) {
      neededSkills.add("docx");
    }
    if (msgLower.includes("pdf") || msgLower.includes("report")) {
      neededSkills.add("pdf");
    }
    for (const skill of neededSkills) {
      try {
        const res = await sandboxFileRead(sessionId, `/app/skills/${skill}/SKILL.md`, "utf8");
        if (res.content) skillContent.set(skill, res.content);
      } catch { /* skill file may not exist */ }
    }
  } catch { /* workspace may not have files yet */ }

  const systemPrompt = buildSystemPrompt(skillContent);

  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    ...priorConversation.map((m) => ({ role: m.role, content: m.content }) as ChatCompletionMessageParam),
    { role: "user", content: userMessage },
  ];

  let finalContent = "";
  let finalReasoning = "";
  let toolCallsCount = 0;
  const maxToolCalls = Number(process.env.AGENT_MAX_TOOL_CALLS ?? "50");

  for (let iteration = 0; iteration < 50 && toolCallsCount < maxToolCalls; iteration++) {
    if (signal?.aborted) break;
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
    }, { signal });

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
        } else {
          const funcArgs = toolCall.function?.arguments;
          if (funcArgs) {
            accumulatedToolCalls[idx].function.arguments += funcArgs;
          }
        }
      }
    }

    // Validate and finalize tool calls
    const validToolCalls = accumulatedToolCalls.filter((tc) => tc?.function?.name);

    // Emit tool_start events once arguments are fully assembled
    for (const tc of validToolCalls) {
      sendEvent({
        type: "tool_start",
        data: {
          toolCallId: tc.id,
          toolName: tc.function.name,
          arguments: safeParseArgs(tc.function.arguments),
        },
      });
    }

    if (validToolCalls.length === 0) {
      // No tool calls — we're done
      await updateSessionStatus(sessionId, "completed");
      sendEvent({ type: "status", data: { status: "completed" } });
      return { content: contentBuffer || finalContent, reasoning: finalReasoning || undefined, toolCallsCount };
    }

    // Execute tool calls
    messages.push({ role: "assistant", content: contentBuffer, tool_calls: validToolCalls as any });

    await updateSessionStatus(sessionId, "executing");
    sendEvent({ type: "status", data: { status: "executing", step: `Executing ${validToolCalls.length} tool(s)` } });

    for (const tc of validToolCalls) {
      if (signal?.aborted) break;
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
        const execResult = await executeSandboxTool(sessionId, toolName, toolArgs, model);
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

  if (signal?.aborted) {
    await updateSessionStatus(sessionId, "idle");
    sendEvent({ type: "status", data: { status: "idle", step: "Stopped by user" } });
    finalContent += "\n\n[Session stopped by user.]";
  } else {
    await updateSessionStatus(sessionId, "completed");
    sendEvent({ type: "status", data: { status: "completed" } });
  }
  return { content: finalContent, reasoning: finalReasoning || undefined, toolCallsCount };
}

// ── Tool execution dispatcher ────────────────────────────────────────────────

async function executeSandboxTool(
  sessionId: string,
  toolName: string,
  args: Record<string, unknown>,
  model: string
): Promise<{ ok: boolean; result?: unknown; error?: string; stdout?: string }> {
  switch (toolName) {
    // ── File Tools ──────────────────────────────────────────────────────────
    case "file_read": {
      const path = String(args.path ?? "");
      const encoding = (args.encoding as "utf8" | "base64") ?? "utf8";
      const res = await sandboxFileRead(sessionId, path, encoding);
      return { ok: true, result: res, stdout: `` };
    }
    case "file_write": {
      const path = String(args.path ?? "");
      const content = String(args.content ?? "");
      const encoding = (args.encoding as "utf8" | "base64") ?? "utf8";
      const res = await sandboxFileWrite(sessionId, path, content, encoding);
      return { ok: true, result: res, stdout: `` };
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
    case "docx_read": {
      const docxPath = String(args.path ?? "");
      const includeImages = args.include_images !== false;
      try {
        const res = await sandboxDocxRead(sessionId, docxPath, includeImages);
        const summary = [
          `Parsed ${docxPath}: ${res.paragraph_count} paragraphs, ${res.table_count} tables, ${res.image_count} images`,
          "",
          res.text_summary,
        ].join("\n");
        return { ok: true, result: res, stdout: summary };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: `docx_read failed: ${msg}` };
      }
    }
    case "docx_template_fill": {
      const templatePath = String(args.template_path ?? "");
      const outputPath = String(args.output_path ?? "");
      const sections = Array.isArray(args.sections) ? args.sections : [];
      const keepCoverPage = args.keep_cover_page !== false;
      const coverReplacements = (args.cover_replacements as Record<string, string>) ?? {};
      try {
        const res = await sandboxDocxTemplateFill(
          sessionId,
          templatePath,
          outputPath,
          sections as Array<{
            heading?: string;
            heading_level?: number;
            content?: string;
            images?: Array<{ path: string; caption?: string; width?: number }>;
          }>,
          { keepCoverPage, coverReplacements }
        );
        return { ok: true, result: res, stdout: res.summary };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: `docx_template_fill failed: ${msg}` };
      }
    }
    case "docx_create": {
      const outputPath = String(args.output_path ?? "");
      const pythonCode = String(args.python_code ?? "");
      await sandboxExecShell(sessionId, `mkdir -p "$(dirname '${outputPath.replace(/'/g, "'\'")}')"`, "/", 10);
      const res = await sandboxExecPython(sessionId, pythonCode, 120);
      return {
        ok: !res.error,
        result: res,
        error: res.error ?? undefined,
        stdout: res.stdout || `DOCX created: ${outputPath}`,
      };
    }
    case "docx_build": {
      const outputPath = String(args.output_path ?? "");
      let programCs = String(args.program_cs ?? "");
      const programCsPath = String(args.program_cs_path ?? "");
      await sandboxExecShell(sessionId, `mkdir -p "$(dirname '${outputPath.replace(/'/g, "'\'")}')"`, "/", 10);
      if (programCsPath) {
        try {
          const fileRes = await sandboxFileRead(sessionId, programCsPath, "utf8");
          programCs = fileRes.content;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { ok: false, error: `Failed to read program_cs_path '${programCsPath}': ${msg}` };
        }
      }
      const res = await sandboxDocxBuild(sessionId, outputPath, programCs || undefined);
      return {
        ok: true,
        result: res,
        stdout: res.stdout || `DOCX built: ${outputPath} (${res.size} bytes)`,
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
      const paths = Array.isArray(args.paths) ? args.paths.filter((p): p is string => typeof p === "string") : [];
      if (paths.length === 0) return { ok: false, error: "No image paths provided." };

      const maxBatch = Math.max(1, Number(env.AGENT_IMAGE_ANALYZE_MAX_BATCH ?? 15));
      const maxConcurrency = Math.max(1, Number(env.AGENT_IMAGE_ANALYZE_MAX_CONCURRENCY ?? 2));

      if (paths.length > maxBatch) {
        return { ok: false, error: `Too many images. Max ${maxBatch} per call, received ${paths.length}. Call the tool multiple times.` };
      }

      const promptBase = String(args.prompt ?? "Describe this image concisely.");
      const detail = (args.detail as "high" | "low") ?? "high";
      const fullPrompt = `${promptBase} Keep the description concise and focused — under 300 words.`;

      const results: Array<{ path: string; content: string; ok: boolean; error?: string }> = [];

      async function analyzeSingle(imagePath: string, maxRetries = 2): Promise<void> {
        let attempts = 0;
        while (attempts <= maxRetries) {
          attempts++;
          try {
            const fileRes = await sandboxFileRead(sessionId, imagePath, "base64");
            const ext = imagePath.includes(".") ? imagePath.split(".").pop()!.toLowerCase() : "png";
            const mimeMap: Record<string, string> = {
              jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml",
            };
            const mime = mimeMap[ext] ?? "image/png";
            const dataUrl = `data:${mime};base64,${fileRes.content}`;
            const response = await nanoClient.chat.completions.create({
              model,
              messages: [
                {
                  role: "user",
                  content: [
                    { type: "text", text: fullPrompt },
                    { type: "image_url", image_url: { url: dataUrl, detail } },
                  ],
                },
              ],
              max_tokens: 1024,
            });
            const content = response.choices[0]?.message?.content ?? "";
            if (content.trim().length > 0) {
              results.push({ path: imagePath, content, ok: true });
              return;
            }
            if (attempts <= maxRetries) continue;
            results.push({ path: imagePath, content: "", ok: false, error: "Vision model returned empty response after retries" });
            return;
          } catch (err) {
            if ((err as Error).name === "AbortError") throw err;
            const msg = err instanceof Error ? err.message : String(err);
            results.push({ path: imagePath, content: "", ok: false, error: msg });
            return;
          }
        }
      }

      // Process ALL images in batches with limited concurrency
      for (let i = 0; i < paths.length; i += maxConcurrency) {
        const batch = paths.slice(i, i + maxConcurrency);
        await Promise.all(batch.map((p) => analyzeSingle(p)));
      }

      results.sort((a, b) => paths.indexOf(a.path) - paths.indexOf(b.path));
      const combined = results.map((r) => `--- ${r.path} ---\n${r.ok ? r.content : `Error: ${r.error}`}`).join("\n\n");
      const allOk = results.every((r) => r.ok);
      return { ok: allOk, result: { descriptions: results, combined }, stdout: combined };
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
  if (!["file_write", "pdf_from_html", "docx_to_pdf", "ipython", "docx_create", "docx_build", "docx_template_fill", "xlsx_create", "pptx_create", "chart_create", "libreoffice_convert", "shell"].includes(toolName)) return;

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
