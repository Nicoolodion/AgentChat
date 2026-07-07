import { resolveMobileAuth } from "@/lib/mobile-auth";
import { prisma } from "@/lib/prisma";
import { readFile } from "node:fs/promises";
import { resolveHostWorkspaceFile } from "@/lib/agent/workspace";

/**
 * GET /api/mobile/tasks/:id/artifacts/:name
 * Stream an artifact (owner-scoped). The file is read host-side from the
 * session workspace — no sandbox hop needed for reads (the workspace dir is
 * bind-mounted to the app container too).
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string; name: string }> },
) {
  const auth = await resolveMobileAuth(request);
  if (!auth) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });

  const { id, name } = await context.params;

  const task = await prisma.mobileTask.findFirst({
    where: { id, userId: auth.userId },
    select: { agentSessionId: true },
  });
  if (!task || !task.agentSessionId) {
    return new Response(JSON.stringify({ error: "Task or session not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
  }

  // The artifact row guarantees ownership + lets us cross-check the requested
  // name against the session's registered artifacts.
  const artifact = await prisma.agentArtifact.findFirst({
    where: { sessionId: task.agentSessionId, fileName: name },
    select: { storagePath: true, mimeType: true, fileName: true },
  });
  if (!artifact) {
    return new Response(JSON.stringify({ error: "Artifact not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
  }

  let absPath: string;
  try {
    absPath = resolveHostWorkspaceFile(task.agentSessionId, artifact.storagePath);
  } catch {
    return new Response(JSON.stringify({ error: "Invalid artifact path" }), { status: 400, headers: { "Content-Type": "application/json" } });
  }

  let bytes: Buffer;
  try {
    bytes = await readFile(absPath);
  } catch {
    return new Response(JSON.stringify({ error: "Artifact file missing on disk" }), { status: 410, headers: { "Content-Type": "application/json" } });
  }

  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type": artifact.mimeType || "application/octet-stream",
      "Content-Length": String(bytes.length),
      "Content-Disposition": `attachment; filename="${artifact.fileName.replace(/"/g, "")}"`,
      "Cache-Control": "private, max-age=3600",
    },
  });
}
