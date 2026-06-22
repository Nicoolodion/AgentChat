/**
 * Docker Sandbox lifecycle management and HTTP API client.
 *
 * The orchestrator communicates with a sandbox container via HTTP.
 * For Phase 1 we target a single shared container with session-scoped
 * workspace directories.  The container is started on-demand and can be
 * reused for multiple sessions.
 */

import { env } from "@/lib/env";

const SANDBOX_BASE_URL =
  process.env.AGENT_SANDBOX_URL ?? "http://127.0.0.1:18080";

const DEFAULT_TIMEOUT = 30_000;
const SANDBOX_HEALTH_TIMEOUT = 5_000;
const SANDBOX_UNAVAILABLE_RESULT = {
  stdout: "",
  stderr: "Sandbox is unavailable. Please try again later.",
  images: [],
  error: "Sandbox container is unreachable. Agent features are unavailable.",
  execution_time_ms: 0,
};

// ── Low-level helpers ────────────────────────────────────────────────────────

async function sandboxFetch<T = unknown>(
  path: string,
  init?: RequestInit & { timeout?: number }
): Promise<T> {
  const url = `${SANDBOX_BASE_URL}${path}`;
  const controller = new AbortController();
  const timeoutMs = init?.timeout ?? DEFAULT_TIMEOUT;

  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
    clearTimeout(timer);

    let body: Record<string, unknown>;
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch (parseErr) {
      if (!res.ok) {
        throw new SandboxError(`sandbox ${res.status} (non-JSON response)`, res.status);
      }
      throw new SandboxError(
        `Failed to parse sandbox response from ${path}: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
        502,
      );
    }

    if (!res.ok) {
      const msg =
        (body as { error?: string }).error ?? `sandbox ${res.status}`;
      throw new SandboxError(msg, res.status);
    }

    return body as T;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

export class SandboxError extends Error {
  statusCode?: number;
  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = "SandboxError";
    this.statusCode = statusCode;
  }
}

// ── Session workspace management ─────────────────────────────────────────────

export type SandboxExecPythonResult = {
  stdout: string;
  stderr: string;
  images: string[];
  error: string | null;
  execution_time_ms: number;
};

export type SandboxExecShellResult = {
  stdout: string;
  stderr: string;
  exit_code: number;
  error: string | null;
  duration_ms: number;
};

export type SandboxFileEntry = {
  name: string;
  path: string;
  is_directory: boolean;
  size: number;
  mime_type: string | null;
  modified_at: string;
};

/**
 * Ensure the sandbox container is reachable.
 */
export async function sandboxHealthCheck(): Promise<boolean> {
  try {
    const res = (await sandboxFetch("/health", { timeout: 5_000 })) as {
      status: string;
    };
    return res.status === "ok" || res.status === "degraded";
  } catch {
    return false;
  }
}

/**
 * Create the session workspace directories inside the sandbox container.
 */
export async function sandboxCreateWorkspace(
  sessionId: string
): Promise<{ path: string }> {
  // The container automatically creates directories on first access,
  // but we explicitly touch the upload / output / temp dirs so the
  // explorer doesn't show an empty workspace.
  await sandboxExecShell(sessionId, "mkdir -p upload output temp", "/");
  return { path: `/workspace/${sessionId}` };
}

/**
 * Execute Python code inside the sandbox (persistent per sessionId).
 */
export async function sandboxExecPython(
  sessionId: string,
  code: string,
  timeout = 60
): Promise<SandboxExecPythonResult> {
  const res = await sandboxFetch<SandboxExecPythonResult>("/exec/python", {
    method: "POST",
    body: JSON.stringify({ code, session_id: sessionId, timeout }),
    timeout: (timeout + 5) * 1000,
  });
  return res;
}

/**
 * Execute Python code with real-time streaming of stdout/stderr. The
 * `onChunk` callback fires for each line of output as it is produced, so
 * long-running commands show progress in the UI instead of only after
 * completion. Returns the final result record.
 */
export async function sandboxExecPythonStream(
  sessionId: string,
  code: string,
  timeout: number,
  onChunk: (stream: "stdout" | "stderr", text: string) => void
): Promise<SandboxExecPythonResult> {
  const url = `${SANDBOX_BASE_URL}/exec/python/stream`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), (timeout + 10) * 1000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, session_id: sessionId, timeout }),
      signal: controller.signal,
    });
    if (!res.ok || !res.body) {
      // Fall back to non-streaming execution on any error.
      const r = await sandboxExecPython(sessionId, code, timeout);
      if (r.stdout) onChunk("stdout", r.stdout);
      if (r.stderr) onChunk("stderr", r.stderr);
      return r;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let result: SandboxExecPythonResult | null = null;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line.trim()) continue;
        let evt: { t?: string; s?: string; data?: SandboxExecPythonResult };
        try {
          evt = JSON.parse(line);
        } catch {
          continue;
        }
        if (evt.t === "stdout" && typeof evt.s === "string") {
          onChunk("stdout", evt.s);
        } else if (evt.t === "stderr" && typeof evt.s === "string") {
          onChunk("stderr", evt.s);
        } else if (evt.t === "result" && evt.data) {
          result = evt.data;
        }
      }
    }
    if (result) return result;
    // No result record arrived — fall back.
    return await sandboxExecPython(sessionId, code, timeout);
  } catch (err) {
    // Abort due to our own timeout: surface a clean timeout error.
    if ((err as Error).name === "AbortError") {
      return {
        stdout: "",
        stderr: "",
        images: [],
        error: `Execution timed out after ${timeout}s`,
        execution_time_ms: timeout * 1000,
      };
    }
    // Network/sandbox error — fall back to non-streaming path which has its
    // own graceful-unavailable handling.
    try {
      const r = await sandboxExecPython(sessionId, code, timeout);
      if (r.stdout) onChunk("stdout", r.stdout);
      if (r.stderr) onChunk("stderr", r.stderr);
      return r;
    } catch {
      throw err;
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Execute a shell command inside the sandbox.
 */
export async function sandboxExecShell(
  sessionId: string,
  command: string,
  workingDir = "/",
  timeout = 30
): Promise<SandboxExecShellResult> {
  const res = await sandboxFetch<SandboxExecShellResult>("/exec/shell", {
    method: "POST",
    body: JSON.stringify({
      command,
      session_id: sessionId,
      working_dir: workingDir,
      timeout,
    }),
    timeout: (timeout + 5) * 1000,
  });
  return res;
}

// ── File operations ──────────────────────────────────────────────────────────

export async function sandboxFileRead(
  sessionId: string,
  filePath: string,
  encoding: "utf8" | "base64" = "utf8"
): Promise<{ content: string; size: number; modified_at: string }> {
  const res = (await sandboxFetch("/file/read", {
    method: "POST",
    body: JSON.stringify({ path: filePath, encoding, session_id: sessionId }),
    timeout: encoding === "base64" ? 120_000 : DEFAULT_TIMEOUT,
  })) as {
    content: string;
    size: number;
    modified_at: string;
  };
  return res;
}

export async function sandboxFileWrite(
  sessionId: string,
  filePath: string,
  content: string,
  encoding: "utf8" | "base64" = "utf8"
): Promise<{ path: string; size: number }> {
  const res = (await sandboxFetch("/file/write", {
    method: "POST",
    body: JSON.stringify({
      path: filePath,
      content,
      encoding,
      session_id: sessionId,
    }),
  })) as { path: string; size: number };
  return res;
}

export async function sandboxFileList(
  sessionId: string,
  dirPath = "/"
): Promise<SandboxFileEntry[]> {
  const res = (await sandboxFetch("/file/list", {
    method: "POST",
    body: JSON.stringify({ path: dirPath, session_id: sessionId }),
  })) as { files: SandboxFileEntry[] };
  return res.files ?? [];
}

export async function sandboxFileDelete(
  sessionId: string,
  filePath: string
): Promise<void> {
  await sandboxFetch("/file/delete", {
    method: "POST",
    body: JSON.stringify({ path: filePath, session_id: sessionId }),
  });
}

export async function sandboxFileMove(
  sessionId: string,
  source: string,
  destination: string
): Promise<{ source: string; destination: string }> {
  const res = (await sandboxFetch("/file/move", {
    method: "POST",
    body: JSON.stringify({ source, destination, session_id: sessionId }),
  })) as { source: string; destination: string };
  return res;
}

export async function sandboxFileInfo(
  sessionId: string,
  filePath: string
): Promise<{ name: string; path: string; size: number; mime_type: string | null; modified_at: string; is_directory: boolean }> {
  const res = (await sandboxFetch("/file/info", {
    method: "POST",
    body: JSON.stringify({ path: filePath, session_id: sessionId }),
  })) as { name: string; path: string; size: number; mime_type: string | null; modified_at: string; is_directory: boolean };
  return res;
}

// ── Conversions ──────────────────────────────────────────────────────────────

export type SandboxWebRenderResult = {
  url: string;
  final_url: string;
  title: string;
  content_type: string;
  html: string;
  size: number;
};

export type SandboxCookie = {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  http_only?: boolean;
  secure?: boolean;
};

/**
 * Render a URL with headless Chromium (Playwright) so that JavaScript-heavy
 * SPAs build their DOM before capture. Supports an optional cookie jar for
 * authenticated browsing of user-specified sites.
 */
export async function sandboxWebRender(
  sessionId: string,
  url: string,
  options?: {
    cookies?: SandboxCookie[];
    waitFor?: string;
    timeout?: number;
  }
): Promise<SandboxWebRenderResult> {
  const res = (await sandboxFetch("/web/render", {
    method: "POST",
    body: JSON.stringify({
      url,
      session_id: sessionId,
      cookies: options?.cookies ?? [],
      wait_for: options?.waitFor ?? "",
      timeout: options?.timeout ?? 35,
    }),
    timeout: (options?.timeout ?? 35) * 1000 + 10_000,
  })) as SandboxWebRenderResult;
  return res;
}

// ── Conversions (continued) ─────────────────────────────────────────────────

export type SandboxDocxReadResult = {
  path: string;
  paragraphs: Array<{
    index: number;
    text: string;
    style: string;
    alignment: string;
    is_heading: boolean;
    heading_level: number;
    has_image: boolean;
  }>;
  tables: Array<{
    index: number;
    rows: number;
    columns: number;
    data: string[][];
  }>;
  images: Array<{
    index: number;
    mime_type: string;
    size: number;
    extension: string;
    data_url?: string;
    note?: string;
  }>;
  paragraph_count: number;
  table_count: number;
  image_count: number;
  text_summary: string;
};

export async function sandboxDocxRead(
  sessionId: string,
  filePath: string,
  includeImages = true,
  maxImageWidth = 800
): Promise<SandboxDocxReadResult> {
  const res = (await sandboxFetch("/docx/read", {
    method: "POST",
    body: JSON.stringify({
      path: filePath,
      session_id: sessionId,
      include_images: includeImages,
      max_image_width: maxImageWidth,
    }),
    timeout: 60_000,
  })) as SandboxDocxReadResult;
  return res;
}

export type SandboxDocxTemplateFillResult = {
  output_path: string;
  size: number;
  sections_added: number;
  section_names: string[];
  images_inserted: number;
  cover_preserved: boolean;
  cover_replacements_applied: number;
  summary: string;
};

export async function sandboxDocxTemplateFill(
  sessionId: string,
  templatePath: string,
  outputPath: string,
  sections: Array<{
    heading?: string;
    heading_level?: number;
    content?: string;
    images?: Array<{ path: string; caption?: string; width?: number }>;
  }>,
  options?: {
    keepCoverPage?: boolean;
    coverReplacements?: Record<string, string>;
    includeToc?: boolean;
  }
): Promise<SandboxDocxTemplateFillResult> {
  const res = (await sandboxFetch("/docx/template-fill", {
    method: "POST",
    body: JSON.stringify({
      template_path: templatePath,
      output_path: outputPath,
      sections,
      session_id: sessionId,
      keep_cover_page: options?.keepCoverPage ?? true,
      cover_replacements: options?.coverReplacements ?? {},
      include_toc: options?.includeToc ?? false,
    }),
    timeout: 120_000,
  })) as SandboxDocxTemplateFillResult;
  return res;
}

export async function sandboxConvertHtmlToPdf(
  sessionId: string,
  inputPath: string,
  outputPath: string,
  options?: Record<string, unknown>
): Promise<{ output_path: string; size: number }> {
  const res = (await sandboxFetch("/convert/html-to-pdf", {
    method: "POST",
    body: JSON.stringify({
      input_path: inputPath,
      output_path: outputPath,
      options: options ?? {},
      session_id: sessionId,
    }),
    timeout: 130_000,
  })) as { output_path: string; size: number };
  return res;
}

export async function sandboxConvertDocxToPdf(
  sessionId: string,
  inputPath: string,
  outputPath: string
): Promise<{ output_path: string; size: number }> {
  const res = (await sandboxFetch("/convert/docx-to-pdf", {
    method: "POST",
    body: JSON.stringify({
      input_path: inputPath,
      output_path: outputPath,
      session_id: sessionId,
    }),
    timeout: 130_000,
  })) as { output_path: string; size: number };
  return res;
}

export async function sandboxDocxBuild(
  sessionId: string,
  outputPath: string,
  programCs?: string
): Promise<{ output_path: string; size: number; stdout: string }> {
  const res = (await sandboxFetch("/docx/build", {
    method: "POST",
    body: JSON.stringify({
      output_path: outputPath,
      program_cs: programCs,
      session_id: sessionId,
    }),
    timeout: 310_000,
  })) as { output_path: string; size: number; stdout: string };
  return res;
}

// ── PPTX / PPTD skill ────────────────────────────────────────────────────────

export type SandboxPptxRunResult = {
  action: string;
  exit_code: number;
  stdout: string;
  stderr: string;
  duration_ms: number;
  output_path?: string;
  size?: number;
  output_dir?: string;
  images?: string[];
};

/**
 * Run a kimi_pptd subcommand (the PPTD skill's runtime binary) on a workspace
 * file. Actions: `check` (validate a .pptd), `convert` (.pptd <-> .pptx, auto
 * detected by extension), `screenshot` (render .pptx/.pptd pages to PNGs).
 */
export async function sandboxPptxRun(
  sessionId: string,
  action: "check" | "convert" | "screenshot",
  params: { input_path: string; output_path?: string; pages?: string }
): Promise<SandboxPptxRunResult> {
  const res = (await sandboxFetch("/pptx/run", {
    method: "POST",
    body: JSON.stringify({
      action,
      session_id: sessionId,
      input_path: params.input_path,
      output_path: params.output_path ?? "",
      pages: params.pages ?? "",
    }),
    timeout: 310_000,
  })) as SandboxPptxRunResult;
  return res;
}
