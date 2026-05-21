import { resolveAuthContext } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { resolveHostWorkspaceFile, createHostWorkspace } from "@/lib/agent/workspace";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

function jsonError(message: string, status: number) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * POST /api/agent/sessions/:sessionId/files/upload
 * Upload files into the workspace via multipart/form-data.
 *
 * Files are written directly to the host filesystem under
 * data/agent-workspaces/{sessionId}/upload/ so the sandbox
 * can see them immediately via the bind-mounted volume.
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

    if (files.length > 40) {
      return jsonError("Max 40 files per upload", 413);
    }

    // Ensure workspace exists
    await createHostWorkspace(session.chatId).catch(() => undefined);

    const uploaded: Array<{ name: string; path: string; size: number }> = [];

    for (const file of files) {
      if (!(file instanceof File)) continue;

      if (file.size > 25 * 1024 * 1024) {
        return jsonError(`File ${file.name} exceeds 25MB limit`, 413);
      }

      const buffer = Buffer.from(await file.arrayBuffer());
      const destPath = resolveHostWorkspaceFile(sessionId, `upload/${file.name}`);
      await mkdir(path.dirname(destPath), { recursive: true });
      await writeFile(destPath, buffer);

      uploaded.push({
        name: file.name,
        path: `upload/${file.name}`,
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
