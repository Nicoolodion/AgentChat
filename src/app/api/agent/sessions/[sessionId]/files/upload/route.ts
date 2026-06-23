import { resolveAuthContext } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sandboxFileWrite, SandboxError } from "@/lib/agent/sandbox";
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
 * The session workspace is owned by a per-session uid (mode 0700), so the host
 * process cannot write into it directly. We proxy through the sandbox server
 * (/file/write, base64), which drops to the session uid. A host-filesystem
 * fallback is kept for legacy/pre-isolation sessions while the sandbox is
 * offline.
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

    const uploaded: Array<{ name: string; path: string; size: number }> = [];

    for (const file of files) {
      if (!(file instanceof File)) continue;

      if (file.size > 25 * 1024 * 1024) {
        return jsonError(`File ${file.name} exceeds 25MB limit`, 413);
      }

      const destRel = `upload/${file.name}`;
      const buffer = Buffer.from(await file.arrayBuffer());

      try {
        await sandboxFileWrite(
          sessionId,
          destRel,
          buffer.toString("base64"),
          "base64"
        );
      } catch (err) {
        // Sandbox unreachable — fall back to a direct host write (works only
        // for legacy sessions whose dirs are still host-accessible).
        if (!(err instanceof SandboxError) && !(err instanceof TypeError)) {
          throw err;
        }
        await createHostWorkspace(sessionId).catch(() => undefined);
        const destPath = resolveHostWorkspaceFile(sessionId, destRel);
        await mkdir(path.dirname(destPath), { recursive: true });
        await writeFile(destPath, buffer);
      }

      uploaded.push({
        name: file.name,
        path: destRel,
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
