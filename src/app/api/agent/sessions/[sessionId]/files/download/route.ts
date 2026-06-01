/**
 * GET /api/agent/sessions/:sessionId/files/download?path=...
 * Download a file or a zipped folder from the workspace.
 */
import { resolveAuthContext } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { resolveHostWorkspaceFile } from "@/lib/agent/workspace";
import { readFile, stat, rm } from "node:fs/promises";
import path from "node:path";

function jsonError(message: string, status: number) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

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

    // Directory → zip it (cross-platform)
    if (pathStat.isDirectory()) {
      const folderName = filePath.replace(/\/$/, "").split("/").pop() ?? "download";
      const { tmpdir } = await import("node:os");
      const tmpZip = path.join(tmpdir(), `agent-${sessionId}-${Date.now()}.zip`);

      await zipDirectory(resolvedPath, tmpZip);
      const binary = await readFile(tmpZip);
      await rm(tmpZip, { force: true }).catch(() => undefined);

      return new Response(binary, {
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename="${folderName}.zip"`,
          "Content-Length": String(binary.length),
        },
      });
    }

    const binary = await readFile(resolvedPath);
    const fileName = filePath.split("/").pop() ?? "download";
    const mimeType = searchParams.get("mimeType") ?? getMimeType(fileName);

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

async function zipDirectory(srcDir: string, outZip: string): Promise<void> {
  const { spawn } = await import("node:child_process");
  const isWindows = process.platform === "win32";

  if (isWindows) {
    await new Promise<void>((resolve, reject) => {
      const ps = spawn("powershell", [
        "-NoProfile",
        "-Command",
        `Compress-Archive -Path '${srcDir.replace(/'/g, "''")}\*' -DestinationPath '${outZip.replace(/'/g, "''")}' -Force`,
      ]);
      ps.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`zip exited ${code}`))));
      ps.on("error", reject);
    });
    return;
  }

  try {
    await new Promise<void>((resolve, reject) => {
      const z = spawn("zip", ["-r", "-q", outZip, "."], { cwd: srcDir });
      z.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`zip exited ${code}`))));
      z.on("error", reject);
    });
    return;
  } catch {
    // fall through to JSZip
  }

  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();
  await addDirToZip(zip, srcDir, "");
  const buf = await zip.generateAsync({ type: "nodebuffer" });
  const { writeFile } = await import("node:fs/promises");
  await writeFile(outZip, buf);
}

type JSZipInstance = {
  file: (name: string, data: Buffer | string) => void;
  generateAsync: (opts: { type: "nodebuffer" }) => Promise<Buffer>;
};

async function addDirToZip(zip: JSZipInstance, dir: string, prefix: string): Promise<void> {
  const { readdir, readFile } = await import("node:fs/promises");
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      await addDirToZip(zip, full, rel);
    } else {
      const data = await readFile(full);
      zip.file(rel, data);
    }
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
