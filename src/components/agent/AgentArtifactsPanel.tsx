"use client";

import { FileText, FileImage, FileCode, FileArchive, Database, Presentation, PackageOpen, Download } from "lucide-react";
import type { AgentArtifact } from "@/lib/agent/types";

export function AgentArtifactsPanel({
  artifacts,
  sessionId,
}: {
  artifacts: AgentArtifact[];
  sessionId: string;
}) {
  function getIcon(kind: string) {
    switch (kind) {
      case "pdf": return FileText;
      case "document": return FileText;
      case "image": return FileImage;
      case "code": return FileCode;
      case "spreadsheet": return Database;
      case "presentation": return Presentation;
      case "archive": return FileArchive;
      default: return FileText;
    }
  }

  function getColor(kind: string): string {
    switch (kind) {
      case "pdf": return "text-red-400";
      case "document": return "text-blue-400";
      case "image": return "text-emerald-400";
      case "code": return "text-amber-400";
      case "spreadsheet": return "text-green-400";
      case "presentation": return "text-orange-400";
      case "archive": return "text-purple-400";
      default: return "text-slate-400";
    }
  }

  function formatSize(size: number): string {
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-white/10 px-3 py-2 text-xs text-slate-400">
        {artifacts.length} artifact{artifacts.length !== 1 ? "s" : ""}
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        {artifacts.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-slate-500">
            <PackageOpen className="h-6 w-6" />
            <p className="text-xs">No artifacts yet</p>
            <p className="text-[10px]">Generated files will appear here</p>
          </div>
        )}

        <div className="grid grid-cols-1 gap-2">
          {artifacts.map((artifact) => {
            const Icon = getIcon(artifact.kind);
            const downloadUrl = `/api/agent/sessions/${sessionId}/files/download?path=${encodeURIComponent(artifact.storagePath)}`;
            return (
              <div
                key={artifact.id}
                className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/5 p-3 transition hover:bg-white/10"
              >
                <Icon className={`h-8 w-8 shrink-0 ${getColor(artifact.kind)}`} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-slate-200" title={artifact.fileName}>
                    {artifact.fileName}
                  </div>
                  <div className="text-[10px] text-slate-500">
                    {formatSize(artifact.size)} • {artifact.kind}
                  </div>
                  {artifact.description && (
                    <div className="mt-0.5 truncate text-[10px] text-slate-400">{artifact.description}</div>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  <a
                    href={downloadUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="rounded p-1.5 text-slate-400 transition hover:bg-white/10 hover:text-white"
                    title="Download"
                    aria-label={`Download ${artifact.fileName}`}
                  >
                    <Download className="h-4 w-4" />
                  </a>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
