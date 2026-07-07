import { marked } from "marked";

import { env } from "@/lib/env";

export type TaskEmailArtifact = {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
  kind: string;
  storagePath: string;
};

export type RenderTaskEmailInput = {
  taskId: string;
  promptPreview: string;
  resultText: string;
  artifacts: TaskEmailArtifact[];
  serverBaseUrl: string;
};

export type RenderedEmail = {
  subject: string;
  text: string;
  html: string;
};

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * renderTaskEmail — completion email for a finished task. Renders the original
 * prompt, the assistant's final answer (markdown → HTML), and the artifact
 * list as bearer-authed download links **and** attached inline. Threading
 * headers (Message-ID / In-Reply-To / References) are set by the caller via
 * sendMail.
 */
export function renderTaskEmail(input: RenderTaskEmailInput): RenderedEmail {
  const subject = `Task complete: ${input.promptPreview.slice(0, 60) || "Result"}`;

  const resultHtml = (() => {
    try {
      return marked.parse(input.resultText, { async: false }) as string;
    } catch {
      return `<pre>${escapeHtml(input.resultText)}</pre>`;
    }
  })();

  const artifactLines = input.artifacts.length
    ? input.artifacts
        .map((a) => {
          const url = `${input.serverBaseUrl}/api/mobile/tasks/${input.taskId}/artifacts/${encodeURIComponent(a.fileName)}`;
          return `<li><a href="${url}">${escapeHtml(a.fileName)}</a> (${formatBytes(a.size)})</li>`;
        })
        .join("\n")
    : "<li>(none)</li>";

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #1a1a1a; max-width: 640px; margin: 0 auto;">
  <p style="color:#64748b; font-size:13px;">Dein Task ist fertig.</p>
  <h2 style="margin-top:0;">Result</h2>
  <div style="line-height:1.6;">${resultHtml}</div>
  <h3>Artifacts</h3>
  <ul>${artifactLines}</ul>
  <hr style="margin-top:24px; border:none; border-top:1px solid #e2e8f0;">
  <p style="color:#64748b; font-size:12px;">Reply to this email to continue the conversation with the agent.</p>
</body>
</html>`;

  const text = [
    "Your task is complete.",
    "",
    input.resultText,
    "",
    input.artifacts.length
      ? `Artifacts:\n${input.artifacts.map((a) => `- ${a.fileName} (${formatBytes(a.size)})`).join("\n")}`
      : "",
    "",
    "Reply to this email to continue the conversation.",
  ]
    .filter((line) => line !== undefined)
    .join("\n");

  return { subject, text, html };
}

export function taskMessageId(taskId: string): string {
  const domain = (env.MAIL_FROM.split("@")[1] || "nicoolodion.com").replace(/>/g, "");
  return `<task-${taskId}@${domain}>`;
}
