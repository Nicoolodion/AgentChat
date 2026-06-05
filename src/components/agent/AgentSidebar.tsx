"use client";

import { useEffect, useRef, useCallback } from "react";
import { FolderTree, Package, ChevronRight, ChevronLeft } from "lucide-react";
import { AgentFileExplorer } from "./AgentFileExplorer";
import { AgentArtifactsPanel } from "./AgentArtifactsPanel";
import type { AgentUIState } from "./use-agent";
import type { AgentArtifact } from "@/lib/agent/types";

export function AgentSidebar({
  open,
  onToggle,
  activeTab,
  onSetTab,
  sessionId,
  isExecuting,
  artifacts,
  onPreviewFile,
}: {
  open: boolean;
  onToggle: () => void;
  activeTab: AgentUIState["activeTab"];
  onSetTab: (tab: AgentUIState["activeTab"]) => void;
  sessionId: string;
  isExecuting: boolean;
  artifacts: AgentArtifact[];
  onPreviewFile?: (file: { path: string; name: string; mimeType: string }) => void;
}) {
  // Keyboard: Escape only closes on mobile; desktop uses toggle button
  const touchStartX = useRef<number | null>(null);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape" && open) {
        // On very small screens treat Escape as close; elsewhere ignore
        if (window.innerWidth < 1024) {
          onToggle();
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onToggle]);

  // Swipe-to-open/close on mobile
  const onTouchStart = useCallback((e: React.TouchEvent) => {
    touchStartX.current = e.changedTouches[0].screenX;
  }, []);
  const onTouchEnd = useCallback((e: React.TouchEvent) => {
    if (touchStartX.current == null) return;
    const deltaX = e.changedTouches[0].screenX - touchStartX.current;
    if (!open && deltaX < -40) onToggle();
    if (open && deltaX > 40) onToggle();
    touchStartX.current = null;
  }, [open, onToggle]);

  const tabs = [
    { id: "files" as const, label: "Files", icon: FolderTree },
    { id: "artifacts" as const, label: "Artifacts", icon: Package },
  ];

  return (
    <aside
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
      className="relative h-full transition-all duration-300 ease-in-out border-l border-white/10 bg-slate-950/80 backdrop-blur overflow-hidden"
      style={{
        width: open ? 360 : 48,
        minWidth: open ? 360 : 48,
        maxWidth: open ? 360 : 48,
      }}
    >
      {/* Collapsed vertical strip */}
      {!open && (
        <div className="flex h-full w-12 flex-col items-center gap-3 py-4">
          <button
            onClick={onToggle}
            className="rounded-lg p-1.5 text-slate-400 transition hover:bg-white/10 hover:text-white"
            title="Open agent panel"
            aria-label="Open agent panel"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>

          {tabs.map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                onClick={() => {
                  onSetTab(tab.id);
                  onToggle();
                }}
                className={`rounded-lg p-1.5 transition ${activeTab === tab.id ? "text-violet-300 bg-violet-400/10" : "text-slate-500 hover:text-slate-300"}`}
                title={tab.label}
                aria-label={tab.label}
              >
                <Icon className="h-4 w-4" />
              </button>
            );
          })}
        </div>
      )}

      {/* Expanded panel */}
      <div
        className={`absolute inset-0 flex w-[360px] flex-col transition-opacity duration-300 ${open ? "opacity-100" : "opacity-0 pointer-events-none"}`}
      >
        {/* Tabs + collapse button */}
        <div className="flex items-center border-b border-white/10">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => onSetTab(tab.id)}
                className={`relative flex flex-1 items-center justify-center gap-1.5 px-3 py-2.5 text-xs font-medium transition ${isActive ? "text-violet-300" : "text-slate-500 hover:text-slate-300"}`}
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
            onClick={onToggle}
            className="px-3 py-2.5 text-slate-500 transition hover:text-slate-300"
            title="Minimize panel"
            aria-label="Minimize panel"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>

        {/* Content */}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
            {activeTab === "files" && (
              <AgentFileExplorer sessionId={sessionId} onPreview={onPreviewFile} />
            )}
            {activeTab === "artifacts" && (
              <AgentArtifactsPanel artifacts={artifacts} sessionId={sessionId} />
            )}
          </div>
        </div>
      </div>

      {/* Slide-in backdrop for mobile (only when open) */}
      {open && (
        <div
          className="fixed inset-0 z-[-1] bg-slate-950/40 backdrop-blur-sm transition-opacity duration-300 lg:hidden"
          onClick={onToggle}
          style={{ opacity: open ? 1 : 0 }}
        />
      )}
    </aside>
  );
}
