import { resolveAuthContext } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sandboxFileWrite } from "@/lib/agent/sandbox";

function jsonError(message: string, status: number) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * POST /api/agent/sessions/:sessionId/files/upload
 * Upload files into the workspace via multipart/form-data.
 */
export async function POST(
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

    const formData = await request.formData();
    const files = formData.getAll("files");

    if (files.length === 0) {
      return jsonError("No files provided", 400);
    }

    if (files.length > 8) {
      return jsonError("Max 8 files per upload", 413);
    }

    const uploaded: Array<{ name: string; path: string; size: number }> = [];

    for (const file of files) {
      if (!(file instanceof File)) continue;

      if (file.size > 25 * 1024 * 1024) {
        return jsonError(`File ${file.name} exceeds 25MB limit`, 413);
      }

      const buffer = Buffer.from(await file.arrayBuffer());
      const base64 = buffer.toString("base64");
      const destPath = `upload/${file.name}`;

      await sandboxFileWrite(sessionId, destPath, base64, "base64");

      uploaded.push({
        name: file.name,
        path: `/workspace/${sessionId}/upload/${file.name}`,
        size: file.size,
      });
    }

    return new Response(JSON.stringify({ files: uploaded }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[Agent Files Upload Error]", error);
    return jsonError("Internal server error", 500);
  }
}
