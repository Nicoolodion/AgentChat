import { resolveAuthContext } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sandboxFileRead } from "@/lib/agent/sandbox";

function notFound() {
  return new Response(JSON.stringify({ error: "Session not found" }), {
    status: 404,
    headers: { "Content-Type": "application/json" },
  });
}

function forbidden() {
  return new Response(JSON.stringify({ error: "Access denied" }), {
    status: 403,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * GET /api/agent/sessions/:sessionId/files/download?path=...
 * Download a file from the workspace.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ sessionId: string }> }
) {
  try {
    const auth = await resolveAuthContext(request);
    if (!auth) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    const { sessionId } = await context.params;
    const session = await prisma.agentSession.findUnique({ where: { id: sessionId } });
    if (!session) return notFound();
    if (session.userId !== auth.userId) return forbidden();

    const { searchParams } = new URL(request.url);
    const path = searchParams.get("path") ?? "";

    if (!path || path.includes("..")) {
      return new Response(JSON.stringify({ error: "Invalid path" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const fileName = path.split("/").pop() ?? "download";
    const mimeType = getMimeType(fileName);

    const res = await sandboxFileRead(sessionId, path, "base64");
    const binary = Buffer.from(res.content, "base64");

    return new Response(binary, {
      headers: {
        "Content-Type": mimeType,
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Content-Length": String(binary.length),
      },
    });
  } catch (error) {
    console.error("[Agent Files Download Error]", error);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
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
