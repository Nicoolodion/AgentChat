"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Folder,
  FolderOpen,
  File,
  FileImage,
  FileText,
  Globe,
  ChevronRight,
  ChevronDown,
  RefreshCw,
  Upload,
} from "lucide-react";
import type { SandboxFileInfo } from "@/lib/agent/types";

export function AgentFileExplorer({
  sessionId,
  onPreview,
}: {
  sessionId: string;
  onPreview?: (file: { path: string; name: string; mimeType: string }) => void;
}) {
  const [files, setFiles] = useState<SandboxFileInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set(["/"]));
  const [currentPath, setCurrentPath] = useState("/");

  const loadFiles = useCallback(
    async (path: string) => {
      setLoading(true);
      try {
        const res = await fetch(`/api/agent/sessions/${sessionId}/files?path=${encodeURIComponent(path)}`);
        if (!res.ok) throw new Error("Failed to load files");
        const data = (await res.json()) as { files: SandboxFileInfo[] };
        setFiles(data.files);
      } catch {
        setFiles([]);
      } finally {
        setLoading(false);
      }
    },
    [sessionId]
  );

  useEffect(() => {
    if (sessionId) {
      void loadFiles(currentPath);
    }
  }, [sessionId, currentPath, loadFiles]);

  function toggleExpand(path: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function getIcon(file: SandboxFileInfo) {
    if (file.isDirectory) return expanded.has(file.path) ? FolderOpen : Folder;
    if (file.mimeType?.startsWith("image/")) return FileImage;
    if (file.mimeType === "application/pdf") return FileText;
    if (file.mimeType === "text/html") return Globe;
    if (file.mimeType?.startsWith("text/")) return FileText;
    if (file.mimeType?.includes("officedocument.wordprocessingml")) return FileText;
    return File;
  }

  function getIconColor(file: SandboxFileInfo): string {
    if (file.isDirectory) return "text-amber-300";
    if (file.mimeType?.startsWith("image/")) return "text-teal-300";
    if (file.mimeType === "application/pdf") return "text-red-400";
    if (file.mimeType === "text/html") return "text-blue-400";
    if (file.mimeType?.startsWith("text/")) return "text-slate-300";
    if (file.mimeType?.includes("officedocument.wordprocessingml")) return "text-blue-400";
    return "text-slate-400";
  }

  function formatSize(size: number): string {
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  }

  async function handleUpload(event: React.ChangeEvent<HTMLInputElement>) {
    const files = event.target.files;
    if (!files || files.length === 0) return;

    const formData = new FormData();
    for (const file of files) {
      formData.append("files", file);
    }

    try {
      const res = await fetch(`/api/agent/sessions/${sessionId}/files/upload`, {
        method: "POST",
        body: formData,
      });
      if (!res.ok) throw new Error("Upload failed");
      await loadFiles(currentPath);
    } catch {
      // ignore
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-white/10 px-3 py-2">
        <div className="flex items-center gap-1 text-xs text-slate-400">
          <span className="font-mono">{currentPath}</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => loadFiles(currentPath)}
            className="rounded p-1 text-slate-400 transition hover:bg-white/10 hover:text-white"
            title="Refresh"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
          <label className="cursor-pointer rounded p-1 text-slate-400 transition hover:bg-white/10 hover:text-white">
            <Upload className="h-3.5 w-3.5" />
            <input type="file" multiple className="hidden" onChange={handleUpload} />
          </label>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-2">
        {files.length === 0 && !loading && (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-slate-500">
            <FolderOpen className="h-6 w-6" />
            <p className="text-xs">Workspace is empty</p>
            <p className="text-[10px]">Upload files or run the agent to create files</p>
          </div>
        )}

        {files.map((file) => {
          const Icon = getIcon(file);
          return (
            <div
              key={file.path}
              className="group flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 transition hover:bg-white/5"
              onClick={() => {
                if (file.isDirectory) {
                  setCurrentPath(file.path);
                  toggleExpand(file.path);
                } else {
                  onPreview?.({
                    path: file.path,
                    name: file.name,
                    mimeType: file.mimeType ?? "application/octet-stream",
                  });
                }
              }}
            >
              <Icon className={`h-4 w-4 shrink-0 ${getIconColor(file)}`} />
              <span className="min-w-0 flex-1 truncate text-xs text-slate-200">{file.name}</span>
              {!file.isDirectory && (
                <span className="text-[10px] text-slate-500">{formatSize(file.size)}</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
