/**
 * Host workspace directory management for agent sessions.
 *
 * Each agent session gets a dedicated workspace directory on the host
 * filesystem under `data/agent-workspaces/{sessionId}/`.  The directory
 * structure mirrors what the sandbox container expects:
 *
 *   upload/   — files the user uploaded into the chat
 *   output/   — artifacts produced by the agent
 *   temp/     — scratch / intermediate files
 *
 * The host directory is bind-mounted into the Docker container at
 * `/workspace/{sessionId}/` so the agent processes see the exact same
 * files, but the data lives on the host where it is easy to back-up,
 * inspect, and clean up.
 */

import { mkdir, rm, readdir, stat, copyFile } from "node:fs/promises";
import path from "node:path";

import { env } from "@/lib/env";

const WORKSPACE_ROOT = path.resolve(process.cwd(), env.AGENT_WORKSPACE_DIR);

/**
 * Return the absolute host path for a session workspace.
 */
export function getHostWorkspacePath(sessionId: string): string {
  return path.join(WORKSPACE_ROOT, sessionId);
}

/**
 * Create the standard session directory structure on the host.
 *
 *   data/agent-workspaces/{sessionId}/
 *     upload/
 *     output/
 *     temp/
 */
export async function createHostWorkspace(sessionId: string): Promise<string> {
  const ws = getHostWorkspacePath(sessionId);
  await mkdir(path.join(ws, "upload"), { recursive: true });
  await mkdir(path.join(ws, "output"), { recursive: true });
  await mkdir(path.join(ws, "temp"), { recursive: true });
  return ws;
}

/**
 * Recursively delete a session's entire workspace from the host.
 */
export async function deleteHostWorkspace(sessionId: string): Promise<void> {
  const ws = getHostWorkspacePath(sessionId);
  await rm(ws, { recursive: true, force: true });
}

/**
 * List files inside a session workspace (on the host).  Used by the
 * file-explorer UI when the sandbox is offline.
 */
export async function listHostWorkspaceFiles(
  sessionId: string,
  subPath = "/"
): Promise<
  Array<{
    name: string;
    path: string;
    isDirectory: boolean;
    size: number;
    mimeType: string | null;
    modifiedAt: string;
  }>
> {
  const ws = getHostWorkspacePath(sessionId);
  const target = subPath === "/" ? ws : path.join(ws, subPath);

  const entries = await readdir(target, { withFileTypes: true }).catch(() => []);
  const files: Array<{
    name: string;
    path: string;
    isDirectory: boolean;
    size: number;
    mimeType: string | null;
    modifiedAt: string;
  }> = [];

  for (const entry of entries) {
    const entryPath = path.join(target, entry.name);
    const info = await stat(entryPath);
    files.push({
      name: entry.name,
      path: path.relative(ws, entryPath).replace(/\\/g, "/"),
      isDirectory: entry.isDirectory(),
      size: info.size,
      mimeType: entry.isDirectory() ? null : guessMimeType(entry.name),
      modifiedAt: info.mtime.toISOString(),
    });
  }

  files.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return files;
}

/**
 * Copy an existing file (e.g. a decrypted user attachment) into the
 * session's upload/ directory so the sandbox can read it.
 */
export async function copyFileToWorkspaceUpload(
  sessionId: string,
  sourcePath: string,
  destName: string
): Promise<void> {
  const uploadDir = path.join(getHostWorkspacePath(sessionId), "upload");
  await mkdir(uploadDir, { recursive: true });
  await copyFile(sourcePath, path.join(uploadDir, destName));
}

/**
 * Return the host path to a specific file inside the workspace.
 * Useful for direct reads when the sandbox is unreachable.
 */
export function resolveHostWorkspaceFile(sessionId: string, filePath: string): string {
  const ws = getHostWorkspacePath(sessionId);
  const resolved = path.resolve(ws, filePath);
  const normalizedWs = ws.split(path.sep).join("/").replace(/\/$/, "");
  const normalizedResolved = resolved.split(path.sep).join("/");
  if (
    !normalizedResolved.startsWith(normalizedWs + "/") &&
    normalizedResolved !== normalizedWs
  ) {
    throw new Error("Path traversal detected");
  }
  return resolved;
}

function guessMimeType(fileName: string): string | null {
  const ext = path.extname(fileName).toLowerCase();
  const map: Record<string, string> = {
    ".pdf": "application/pdf",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".html": "text/html",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".csv": "text/csv",
    ".json": "application/json",
    ".js": "text/javascript",
    ".ts": "text/typescript",
    ".py": "text/x-python",
    ".css": "text/css",
    ".zip": "application/zip",
  };
  return map[ext] ?? null;
}

export async function cleanupOldWorkspaces(maxAgeDays = 7): Promise<number> {
  const { prisma } = await import("@/lib/prisma");
  const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000);
  const oldSessions = await prisma.agentSession.findMany({
    where: {
      status: { in: ["completed", "error"] },
      completedAt: { lte: cutoff },
    },
    select: { id: true },
  });
  let cleaned = 0;
  for (const session of oldSessions) {
    try {
      await deleteHostWorkspace(session.id);
      cleaned++;
    } catch { /* best-effort */ }
  }
  return cleaned;
}
