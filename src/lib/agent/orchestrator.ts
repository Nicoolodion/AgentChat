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
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions/completions";

import { env } from "@/lib/env";
import { nanoClient } from "@/lib/nanogpt";
import { prisma } from "@/lib/prisma";
import {
  AgentArtifactKind,
  AgentSseEvent,
  AgentSessionStatus,
  AgentToolCallStatus,
} from "./types";
import { safeParseArgs } from "./parse-args";
import { AGENT_TOOL_SCHEMAS, SKILL_EXTENSIONS, buildSystemPrompt } from "./tool-schemas";
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
  sandboxHealthCheck,
} from "./sandbox";

// ── Orchestrator ─────────────────────────────────────────────────────────────

export type SseController = {
  enqueue: (data: string) => void;
  close: () => void;
};

const MAX_CONVERSATION_CHARS = 80000;

function summarizeOldMessages(messages: ChatCompletionMessageParam[]): ChatCompletionMessageParam[] {
  let totalChars = 0;
  for (const m of messages) totalChars += typeof m.content === "string" ? m.content.length : 0;

  if (totalChars <= MAX_CONVERSATION_CHARS) return messages;

  const systemMsg = messages.find((m) => m.role === "system");
  const nonSystem = messages.filter((m) => m.role !== "system");

  const recentCount = 10;
  const recent = nonSystem.slice(-recentCount);
  const old = nonSystem.slice(0, -recentCount);

  if (old.length === 0) return messages;

  const summaryParts: string[] = [];
  for (const m of old) {
    const content = typeof m.content === "string" ? m.content : "";
    summaryParts.push(`${m.role}: ${content.slice(0, 200)}`);
  }

  const summaryContent = `[Earlier conversation summarized]\n${summaryParts.join("\n")}`;

  const result: ChatCompletionMessageParam[] = [];
  if (systemMsg) result.push(systemMsg);
  result.push({ role: "user", content: summaryContent });
  result.push({ role: "assistant", content: "Understood. I will continue from where we left off." });
  result.push(...recent);
  return result;
}

export async function runAgentExecution(input: {
  sessionId: string;
  userMessage: string;
  priorConversation: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  model: string;
  sendEvent: (event: AgentSseEvent) => void;
  signal?: AbortSignal;
  reasoningEffort?: "low" | "medium" | "high";
}): Promise<{ content: string; reasoning?: string; toolCallsCount: number }> {
  const { sessionId, userMessage, priorConversation, model, sendEvent, signal, reasoningEffort } = input;

  // Check sandbox availability before starting
  try {
    const sandboxOk = await sandboxHealthCheck();
    if (!sandboxOk) {
      await updateSessionStatus(sessionId, "error");
      sendEvent({ type: "status", data: { status: "error", step: "Sandbox is unavailable" } });
      return {
        content: "The agent sandbox is currently unavailable. Please try again later or use normal chat mode.",
        toolCallsCount: 0,
      };
    }
  } catch {
    // If health check itself fails, continue — execution will fail gracefully
  }

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

    const trimmedMessages = summarizeOldMessages(messages);
    const createOptions: Record<string, unknown> = {
      model,
      messages: trimmedMessages,
      tools: AGENT_TOOL_SCHEMAS,
      tool_choice: "auto",
      parallel_tool_calls: true,
      stream: true,
    };
    if (reasoningEffort) {
      createOptions.reasoning_effort = reasoningEffort;
    }

    const response = await nanoClient.chat.completions.create(
      createOptions as any,
      { signal },
    ) as any;

    for await (const chunk of response as AsyncIterable<any>) {
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
      const compileCheck = await sandboxExecPython(sessionId, `compile(${JSON.stringify(code)}, '<string>', 'exec')`, 10);
      if (compileCheck.error) {
        return { ok: false, error: `Syntax error: ${compileCheck.stderr || compileCheck.error}`, result: null };
      }
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
      const pkg = String(args.package ?? args.packages ?? "").replace(/[^a-zA-Z0-9._\-[\]=<>]/g, "");
      if (!pkg) return { ok: false, error: "Invalid package name" };
      await sandboxExecShell(sessionId, `mkdir -p /workspace/${sessionId}/python_libs`, "/", 10);
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
      const sectionsPath = String(args.sections_path ?? "");
      let sections = Array.isArray(args.sections) ? args.sections : [];
      const keepCoverPage = args.keep_cover_page !== false;
      const coverReplacements = (args.cover_replacements as Record<string, string>) ?? {};
      if (!templatePath) {
        return { ok: false, error: "docx_template_fill requires template_path" };
      }
      if (sectionsPath && sections.length === 0) {
        try {
          const fileRes = await sandboxFileRead(sessionId, sectionsPath, "utf8");
          const parsed = JSON.parse(fileRes.content);
          sections = Array.isArray(parsed) ? parsed : (parsed.sections ?? []);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { ok: false, error: `Failed to read/parse sections_path '${sectionsPath}': ${msg}` };
        }
      }
      if (sections.length === 0) {
        return { ok: false, error: "docx_template_fill requires sections or sections_path with at least one section" };
      }
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
      const dirPath = outputPath.includes("/") ? outputPath.substring(0, outputPath.lastIndexOf("/")) : "output";
      await sandboxExecPython(sessionId, `import os; os.makedirs(${JSON.stringify(dirPath)}, exist_ok=True)`, 10);
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
      const dirPath = outputPath.includes("/") ? outputPath.substring(0, outputPath.lastIndexOf("/")) : "output";
      await sandboxExecPython(sessionId, `import os; os.makedirs(${JSON.stringify(dirPath)}, exist_ok=True)`, 10);
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
      const dirPath = outputPath.includes("/") ? outputPath.substring(0, outputPath.lastIndexOf("/")) : "output";
      await sandboxExecPython(sessionId, `import os; os.makedirs(${JSON.stringify(dirPath)}, exist_ok=True)`, 10);
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
      const dirPath = outputPath.includes("/") ? outputPath.substring(0, outputPath.lastIndexOf("/")) : "output";
      await sandboxExecPython(sessionId, `import os; os.makedirs(${JSON.stringify(dirPath)}, exist_ok=True)`, 10);
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
      const outputFormat = String(args.output_format ?? "pdf").replace(/[^a-z0-9]/g, "");
      const outputPath = String(args.output_path ?? "");
      const outDir = outputPath.includes("/") ? outputPath.substring(0, outputPath.lastIndexOf("/")) : "output";
      await sandboxExecPython(sessionId, `import os; os.makedirs(${JSON.stringify(outDir)}, exist_ok=True)`, 10);
      const cmd = `HOME=/tmp libreoffice --headless --nologo --convert-to ${outputFormat} --outdir "${outDir.replace(/"/g, '\\"')}" "${inputPath.replace(/"/g, '\\"')}"`;
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
      const searxngUrl = process.env.SEARXNG_URL ?? "";
      const searchCode = `
import json, urllib.request, urllib.parse, os, re
query = ${JSON.stringify(query)}
max_results = ${maxResults}
searxng_url = ${JSON.stringify(searxngUrl)}
results = []
try:
    if searxng_url:
        req = urllib.request.Request(
            f"{searxng_url.rstrip('/')}/search?q={urllib.parse.quote(query)}&format=json",
            headers={"User-Agent": "Mozilla/5.0"}
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8", errors="replace"))
        for item in data.get("results", [])[:max_results]:
            results.append({"title": item.get("title", ""), "url": item.get("url", ""), "snippet": item.get("content", "")})
    else:
        req = urllib.request.Request(
            f"https://api.duckduckgo.com/?q={urllib.parse.quote(query)}&format=json&no_html=1",
            headers={"User-Agent": "Mozilla/5.0"}
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8", errors="replace"))
        for topic in data.get("RelatedTopics", [])[:max_results]:
            if isinstance(topic, dict) and "Text" in topic:
                results.append({"title": topic.get("Text", "")[:80], "url": topic.get("FirstURL", ""), "snippet": topic.get("Text", "")})
        if not results:
            req = urllib.request.Request(
                f"https://html.duckduckgo.com/html/?q={urllib.parse.quote(query)}",
                headers={"User-Agent": "Mozilla/5.0"}
            )
            with urllib.request.urlopen(req, timeout=15) as resp:
                html = resp.read().decode("utf-8", errors="replace")
            for m in re.finditer(r'<a rel="nofollow" class="result__a" href="([^"]+)">([^<]+)</a>', html):
                if len(results) >= max_results:
                    break
                results.append({"title": m.group(2).strip(), "url": m.group(1), "snippet": ""})
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
        text = re.sub(r'<[^>]+>', ' ', html)
        text = re.sub(r'\\s+', ' ', text).strip()
        print(text[:12000])
    elif fmt == "markdown":
        try:
            from markdownify import markdownify as md
            print(md(html)[:12000])
        except ImportError:
            result = html
            result = re.sub(r'<script[^>]*>[\\s\\S]*?</script>', '', result, flags=re.IGNORECASE)
            result = re.sub(r'<style[^>]*>[\\s\\S]*?</style>', '', result, flags=re.IGNORECASE)
            for i in range(1, 7):
                result = re.sub(rf'<h{i}[^>]*>([\\s\\S]*?)</h{i}>', '#' * i + r' \\1\\n', result, flags=re.IGNORECASE)
            result = re.sub(r'<p[^>]*>([\\s\\S]*?)</p>', r'\\1\\n\\n', result, flags=re.IGNORECASE)
            result = re.sub(r'<li[^>]*>([\\s\\S]*?)</li>', r'- \\1\\n', result, flags=re.IGNORECASE)
            result = re.sub(r'<a[^>]*href="([^"]+)"[^>]*>([\\s\\S]*?)</a>', r'[\\2](\\1)', result, flags=re.IGNORECASE)
            result = re.sub(r'<(strong|b)[^>]*>([\\s\\S]*?)</(strong|b)>', r'**\\2**', result, flags=re.IGNORECASE)
            result = re.sub(r'<(em|i)[^>]*>([\\s\\S]*?)</(em|i)>', r'*\\2*', result, flags=re.IGNORECASE)
            result = re.sub(r'<code[^>]*>([\\s\\S]*?)</code>', chr(96) + r'\\1' + chr(96), result, flags=re.IGNORECASE)
            result = re.sub(r'<[^>]+>', ' ', result)
            result = re.sub(r'\\n{3,}', '\\n\\n', result)
            result = re.sub(r' {2,}', ' ', result)
            print(result.strip()[:12000])
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
      const dirPath = outputPath.includes("/") ? outputPath.substring(0, outputPath.lastIndexOf("/")) : "output";
      await sandboxExecPython(sessionId, `import os; os.makedirs(${JSON.stringify(dirPath)}, exist_ok=True)`, 10);
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

      const NO_IMAGE_PATTERNS = [
        /no image (was |is )?(attached|provided|uploaded|found|included|visible)/i,
        /did not (attach|upload|provide|include) (an? |the )?image/i,
        /please (provide|upload|share|attach) (the |an? )?image/i,
        /i (cannot|can't|am unable to) (see|describe|view|analyze) (the |an? |any )?image/i,
        /i don'?t see (any |an? )?image/i,
        /no image (available|present|shown|displayed)/i,
        /image (is )?missing|missing image/i,
        /forgot (to )?(attach|upload|include|provide)/i,
      ];

      function isNoImageResponse(text: string): boolean {
        return NO_IMAGE_PATTERNS.some((p) => p.test(text));
      }

      async function analyzeSingle(imagePath: string, maxRetries = 2): Promise<void> {
        let attempts = 0;
        while (attempts <= maxRetries) {
          attempts++;
          try {
            const fileRes = await sandboxFileRead(sessionId, imagePath, "base64");
            if (!fileRes.content || fileRes.content.length < 100) {
              if (attempts <= maxRetries) continue;
              results.push({ path: imagePath, content: "", ok: false, error: `Failed to read image data from sandbox (${fileRes.content?.length ?? 0} bytes)` });
              return;
            }
            const ext = imagePath.includes(".") ? imagePath.split(".").pop()!.toLowerCase() : "png";
            const mimeMap: Record<string, string> = {
              jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml",
            };
            const mime = mimeMap[ext] ?? "image/png";
            const dataUrl = `data:${mime};base64,${fileRes.content}`;
            const useDetail = attempts > 1 ? "low" : detail;
            const response = await nanoClient.chat.completions.create({
              model,
              messages: [
                {
                  role: "user",
                  content: [
                    { type: "text", text: fullPrompt },
                    { type: "image_url", image_url: { url: dataUrl, detail: useDetail } },
                  ],
                },
              ],
              max_tokens: 1024,
            });
            const content = response.choices[0]?.message?.content ?? "";
            if (content.trim().length === 0 || isNoImageResponse(content)) {
              if (attempts <= maxRetries) continue;
              results.push({ path: imagePath, content: "", ok: false, error: "Vision model could not see the image after retries" });
              return;
            }
            results.push({ path: imagePath, content, ok: true });
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
