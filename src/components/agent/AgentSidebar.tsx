"use client";

import { useEffect } from "react";
import { Terminal, FolderTree, Package, ChevronRight, X } from "lucide-react";
import { AgentTerminal } from "./AgentTerminal";
import { AgentFileExplorer } from "./AgentFileExplorer";
import { AgentArtifactsPanel } from "./AgentArtifactsPanel";
import type { TerminalEntry, AgentUIState } from "./use-agent";
import type { AgentArtifact } from "@/lib/agent/types";

export function AgentSidebar({
  open,
  onClose,
  activeTab,
  onSetTab,
  sessionId,
  terminalEntries,
  isExecuting,
  artifacts,
  onClearTerminal,
  onPreviewFile,
}: {
  open: boolean;
  onClose: () => void;
  activeTab: AgentUIState["activeTab"];
  onSetTab: (tab: AgentUIState["activeTab"]) => void;
  sessionId: string;
  terminalEntries: TerminalEntry[];
  isExecuting: boolean;
  artifacts: AgentArtifact[];
  onClearTerminal: () => void;
  onPreviewFile?: (file: { path: string; name: string; mimeType: string }) => void;
}) {
  // Keyboard: Escape closes sidebar
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape" && open) {
        onClose();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const tabs = [
    { id: "terminal" as const, label: "Terminal", icon: Terminal },
    { id: "files" as const, label: "Files", icon: FolderTree },
    { id: "artifacts" as const, label: "Artifacts", icon: Package },
  ];

  return (
    <>
      {/* Mobile backdrop */}
      {open && (
        <div
          className="fixed inset-0 z-30 bg-slate-950/60 backdrop-blur-sm lg:hidden"
          onClick={onClose}
        />
      )}

      <aside
        className={`fixed right-0 top-0 z-40 flex h-full w-full flex-col border-l border-white/10 bg-slate-950/80 backdrop-blur transition-transform duration-300 lg:relative lg:w-[360px] lg:translate-x-0 ${
          open ? "translate-x-0" : "translate-x-full lg:hidden"
        }`}
      >
        {/* Tabs */}
        <div className="flex items-center border-b border-white/10">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => onSetTab(tab.id)}
                className={`relative flex flex-1 items-center justify-center gap-1.5 px-3 py-2.5 text-xs font-medium transition ${
                  isActive ? "text-violet-300" : "text-slate-500 hover:text-slate-300"
                }`}
              >
                <Icon className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">{tab.label}</span>
                {isActive && (
                  <span className="absolute bottom-0 left-2 right-2 h-0.5 rounded-t bg-violet-400" />
                )}
              </button>
            );
          })}
          <button
            onClick={onClose}
            className="px-3 py-2.5 text-slate-500 transition hover:text-slate-300 lg:hidden"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-hidden">
          {activeTab === "terminal" && (
            <AgentTerminal
              entries={terminalEntries}
              isExecuting={isExecuting}
              onClear={onClearTerminal}
            />
          )}
          {activeTab === "files" && (
            <AgentFileExplorer sessionId={sessionId} onPreview={onPreviewFile} />
          )}
          {activeTab === "artifacts" && (
            <AgentArtifactsPanel artifacts={artifacts} sessionId={sessionId} />
          )}
        </div>
      </aside>
    </>
  );
}
