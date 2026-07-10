import { NextResponse } from "next/server";

import { resolveAuthContext } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  sandboxFileList,
  type SandboxFileEntry,
} from "@/lib/agent/sandbox";
import { listHostWorkspaceFiles, createHostWorkspace, getHostWorkspacePath } from "@/lib/agent/workspace";
import path from "node:path";

function notFound() {
  return NextResponse.json({ error: "Session not found" }, { status: 404 });
}

function forbidden() {
  return NextResponse.json({ error: "Access denied" }, { status: 403 });
}

/**
 * Map a sandbox file entry (absolute /workspace/<sid>/... path, snake_case)
 * to the host-side shape the file-explorer UI expects (relative path,
 * camelCase).
 */
function mapEntry(sessionId: string, entry: SandboxFileEntry) {
  const marker = `/${sessionId}/`;
  const idx = entry.path.indexOf(marker);
  const rel =
    idx >= 0 ? entry.path.slice(idx + marker.length) : entry.name;
  return {
    name: entry.name,
    path: rel || "/",
    isDirectory: entry.is_directory,
    size: entry.size,
    mimeType: entry.mime_type,
    modifiedAt: entry.modified_at,
  };
}

/**
 * GET /api/agent/sessions/:sessionId/files?path=/
 * List files in the workspace.
 *
 * The session workspace is owned by a per-session uid (mode 0700), so the
 * host process cannot read it directly. We proxy through the sandbox server
 * (which runs as root and switches to the session uid). A host-filesystem
 * fallback is kept for when the sandbox is offline (best-effort; may be
 * permission-denied for isolated sessions).
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ sessionId: string }> }
) {
  try {
    const auth = await resolveAuthContext(request);
    if (!auth) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { sessionId } = await context.params;
    const session = await prisma.agentSession.findUnique({ where: { id: sessionId } });
    if (!session) return notFound();
    if (session.userId !== auth.userId) return forbidden();

    const { searchParams } = new URL(request.url);
    const reqPath = searchParams.get("path") ?? "/";

    const workspaceRoot = getHostWorkspacePath(sessionId);
    const normalizedReqPath = reqPath === "/" ? "." : reqPath;
    const resolvedPath = path.resolve(workspaceRoot, normalizedReqPath);
    const relPath = path.relative(workspaceRoot, resolvedPath);
    if (relPath.startsWith("..") || path.isAbsolute(relPath)) {
      return NextResponse.json({ error: "Invalid path" }, { status: 400 });
    }

    try {
      const entries = await sandboxFileList(sessionId, reqPath);
      return NextResponse.json({ files: entries.map((e) => mapEntry(sessionId, e)) });
    } catch {
      // Sandbox unreachable (network) or errored — best-effort host fallback so
      // the explorer still works for legacy/pre-isolation sessions offline.
      await createHostWorkspace(sessionId).catch(() => undefined);
      const files = await listHostWorkspaceFiles(sessionId, reqPath).catch(() => []);
      return NextResponse.json({ files });
    }
  } catch (error) {
    console.error("[Agent Files GET Error]", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
