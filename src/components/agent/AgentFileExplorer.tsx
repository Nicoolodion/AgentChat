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
  Download,
  Eye,
  ArrowUp,
  EyeOff,
} from "lucide-react";
import type { SandboxFileInfo } from "@/lib/agent/types";
import { cn } from "@/lib/ui";

export function AgentFileExplorer({
  sessionId,
  onPreview,
}: {
  sessionId: string;
  onPreview?: (file: { path: string; name: string; mimeType: string }) => void;
}) {
  const [tree, setTree] = useState<Map<string, SandboxFileInfo[]>>(new Map());
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set(["/"]));
  const [currentPath, setCurrentPath] = useState("/");
  const [hoveredFile, setHoveredFile] = useState<string | null>(null);
  // Internal working dirs/files (e.g. .home, .docx-work, .session_images,
  // .session_state.pkl, .iso_migrated) are hidden by default to keep the tree
  // focused on user-relevant output. "Advanced" reveals them.
  const [showHidden, setShowHidden] = useState(false);

  const loadFiles = useCallback(
    async (path: string) => {
      setLoadingPaths((prev) => {
        const next = new Set(prev);
        next.add(path);
        return next;
      });
      try {
        const res = await fetch(
          `/api/agent/sessions/${sessionId}/files?path=${encodeURIComponent(path)}`
        );
        if (!res.ok) throw new Error("Failed to load files");
        const data = (await res.json()) as { files: SandboxFileInfo[] };
        setTree((prev) => {
          const next = new Map(prev);
          next.set(path, data.files);
          return next;
        });
      } catch {
        setTree((prev) => {
          const next = new Map(prev);
          next.set(path, []);
          return next;
        });
      } finally {
        setLoadingPaths((prev) => {
          const next = new Set(prev);
          next.delete(path);
          return next;
        });
      }
    },
    [sessionId]
  );

  useEffect(() => {
    if (sessionId) {
      void loadFiles(currentPath);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps, react-hooks/set-state-in-effect
  }, [sessionId, currentPath, loadFiles]);

  function toggleExpand(path: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
    // auto-load children when expanding
    if (!expanded.has(path)) {
      void loadFiles(path);
    }
  }

  function getIcon(file: SandboxFileInfo, isOpen?: boolean) {
    if (file.isDirectory) return isOpen ? FolderOpen : Folder;
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

  function canPreview(file: SandboxFileInfo): boolean {
    if (file.isDirectory) return false;
    if (!file.mimeType) return false;
    const previewable = [
      "image/",
      "application/pdf",
      "text/",
      "text/html",
      "application/json",
    ];
    return previewable.some((p) => file.mimeType!.startsWith(p));
  }

  function downloadUrl(file: SandboxFileInfo): string {
    return `/api/agent/sessions/${sessionId}/files/download?path=${encodeURIComponent(
      file.path
    )}${file.mimeType ? `&mimeType=${encodeURIComponent(file.mimeType)}` : ""}`;
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
        headers: { "X-Requested-With": "ChatInterface" },
      });
      if (!res.ok) throw new Error("Upload failed");
      await loadFiles(currentPath);
    } catch {
      // ignore
    }
  }

  const parentPath =
    currentPath === "/"
      ? null
      : currentPath.replace(/\/$/, "").split("/").slice(0, -1).join("/") || "/";

  const currentFiles = tree.get(currentPath) ?? [];

  // Hide internal/dotfile entries at the workspace root unless "Advanced" is on.
  const visibleFiles =
    showHidden || currentPath !== "/"
      ? currentFiles
      : currentFiles.filter((f) => !f.name.startsWith("."));

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-white/10 px-3 py-2">
        <div className="flex items-center gap-1 text-xs text-slate-400">
          {parentPath !== null && (
            <button
              onClick={() => setCurrentPath(parentPath)}
              className="rounded p-0.5 text-slate-400 transition hover:bg-white/10 hover:text-white"
              title="Go up"
            >
              <ArrowUp className="h-3 w-3" />
            </button>
          )}
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
          {currentPath === "/" && (
            <button
              onClick={() => setShowHidden((v) => !v)}
              className={cn(
                "rounded p-1 transition hover:bg-white/10",
                showHidden ? "text-slate-200" : "text-slate-400 hover:text-white",
              )}
              title={showHidden ? "Hide internal files" : "Show internal files (Advanced)"}
            >
              {showHidden ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
            </button>
          )}
          <label className="cursor-pointer rounded p-1 text-slate-400 transition hover:bg-white/10 hover:text-white">
            <Upload className="h-3.5 w-3.5" />
            <input type="file" multiple className="hidden" onChange={handleUpload} />
          </label>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-2">
        {visibleFiles.length === 0 && !loadingPaths.has(currentPath) && (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-slate-500">
            <FolderOpen className="h-6 w-6" />
            <p className="text-xs">Workspace is empty</p>
            <p className="text-[10px]">Upload files or run the agent to create files</p>
          </div>
        )}

        {visibleFiles.map((file) => {
          const isOpen = expanded.has(file.path);
          const Icon = getIcon(file, isOpen);
          return (
            <div
              key={file.path}
              className="group relative flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 transition hover:bg-white/5"
              onMouseEnter={() => setHoveredFile(file.path)}
              onMouseLeave={() => setHoveredFile(null)}
              onClick={(e) => {
                // Don't navigate when clicking action buttons
                const target = e.target as HTMLElement;
                if (target.closest("[data-action]")) return;
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
              <span className="min-w-0 flex-1 truncate text-xs text-slate-200">
                {file.name}
              </span>

              <div className="flex items-center gap-1 opacity-0 transition group-hover:opacity-100">
                {canPreview(file) && (
                  <button
                    data-action
                    onClick={(e) => {
                      e.stopPropagation();
                      onPreview?.({
                        path: file.path,
                        name: file.name,
                        mimeType: file.mimeType ?? "application/octet-stream",
                      });
                    }}
                    className="rounded p-1 text-slate-400 transition hover:bg-white/10 hover:text-white"
                    title="Preview"
                  >
                    <Eye className="h-3.5 w-3.5" />
                  </button>
                )}
                <a
                  data-action
                  href={downloadUrl(file)}
                  download
                  onClick={(e) => e.stopPropagation()}
                  className="rounded p-1 text-slate-400 transition hover:bg-white/10 hover:text-white"
                  title="Download"
                >
                  <Download className="h-3.5 w-3.5" />
                </a>
              </div>

              {!file.isDirectory && hoveredFile !== file.path && (
                <span className="text-[10px] text-slate-500">{formatSize(file.size)}</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
