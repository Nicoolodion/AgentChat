"use client";

import { Bot, Loader2 } from "lucide-react";

export function AgentModeToggle({
  isOn,
  isInitializing,
  onToggle,
}: {
  isOn: boolean;
  isInitializing: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={isInitializing}
      className="inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-sm transition"
      style={{
        borderColor: isOn ? "rgba(167,139,250,0.5)" : "rgba(255,255,255,0.15)",
        backgroundColor: isOn ? "rgba(167,139,250,0.15)" : "rgba(15,23,42,1)",
        color: isOn ? "#c4b5fd" : "#94a3b8",
      }}
      aria-pressed={isOn}
      aria-label="Toggle agent mode"
    >
      {isInitializing ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <Bot className="h-4 w-4" />
      )}
      <span className="hidden sm:inline">Agent</span>
    </button>
  );
}
