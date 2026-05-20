import { resolveAuthContext } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  resolveHostWorkspaceFile,
  getHostWorkspacePath,
} from "@/lib/agent/workspace";
import { readFile, stat, readdir } from "node:fs/promises";
import path from "node:path";

function jsonError(message: string, status: number) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * GET /api/agent/sessions/:sessionId/files/download?path=...
 * Download a file or a zipped folder from the workspace.
 *
 * Reads directly from the host filesystem (data/agent-workspaces/)
 * so it works even when the sandbox container is offline.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ sessionId: string }> }
) {
  try {
    const auth = await resolveAuthContext(request);
    if (!auth) {
      return jsonError("Unauthorized", 401);
    }

    const { sessionId } = await context.params;
    const session = await prisma.agentSession.findUnique({ where: { id: sessionId } });
    if (!session) return jsonError("Session not found", 404);
    if (session.userId !== auth.userId) return jsonError("Access denied", 403);

    const { searchParams } = new URL(request.url);
    const filePath = searchParams.get("path") ?? "";
    const isPreview = searchParams.get("preview") === "1";

    if (!filePath || filePath.includes("..")) {
      return jsonError("Invalid path", 400);
    }

    const resolvedPath = resolveHostWorkspaceFile(sessionId, filePath);
    const pathStat = await stat(resolvedPath).catch(() => null);
    if (!pathStat) {
      return jsonError("File not found", 404);
    }

    // Directory → zip it
    if (pathStat.isDirectory()) {
      const folderName = filePath.replace(/\/$/, "").split("/").pop() ?? "download";
      const { spawn } = await import("node:child_process");
      const { tmpdir } = await import("node:os");
      const tmpZip = path.join(tmpdir(), `agent-${sessionId}-${Date.now()}.zip`);

      await new Promise<void>((resolve, reject) => {
        const zip = spawn("powershell", [
          "-Command",
          `Compress-Archive -Path '${resolvedPath.replace(/'/g, "''")}\*' -DestinationPath '${tmpZip.replace(/'/g, "''")}' -Force`,
        ]);
        zip.on("close", (code) => {
          if (code === 0) resolve();
          else reject(new Error(`zip exited ${code}`));
        });
        zip.on("error", reject);
      });

      const binary = await readFile(tmpZip);
      await import("node:fs/promises").then((fs) => fs.rm(tmpZip, { force: true }));

      return new Response(binary, {
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename="${folderName}.zip"`,
          "Content-Length": String(binary.length),
        },
      });
    }

    // Single file
    const binary = await readFile(resolvedPath);
    const fileName = filePath.split("/").pop() ?? "download";
    const mimeType =
      searchParams.get("mimeType") ?? getMimeType(fileName);

    return new Response(binary, {
      headers: {
        "Content-Type": mimeType,
        "Content-Disposition": `${isPreview ? "inline" : "attachment"}; filename="${fileName}"`,
        "Content-Length": String(binary.length),
      },
    });
  } catch (error) {
    console.error("[Agent Files Download Error]", error);
    return jsonError("Internal server error", 500);
  }
}

function getMimeType(fileName: string): string {
  const ext = fileName.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    pdf: "application/pdf",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    html: "text/html",
    txt: "text/plain",
    md: "text/markdown",
    csv: "text/csv",
    json: "application/json",
    js: "text/javascript",
    ts: "text/typescript",
    py: "text/x-python",
    css: "text/css",
    zip: "application/zip",
  };
  return map[ext ?? ""] ?? "application/octet-stream";
}
