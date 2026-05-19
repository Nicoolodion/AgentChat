"use client";

import { Bot, Loader2, Lock } from "lucide-react";

export function AgentModeToggle({
  isOn,
  isInitializing,
  locked,
  onToggle,
}: {
  isOn: boolean;
  isInitializing: boolean;
  locked: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={isInitializing || locked}
      className="inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-sm transition disabled:opacity-60 disabled:cursor-not-allowed"
      style={{
        borderColor: isOn ? "rgba(167,139,250,0.5)" : "rgba(255,255,255,0.15)",
        backgroundColor: isOn ? "rgba(167,139,250,0.15)" : "rgba(15,23,42,1)",
        color: isOn ? "#c4b5fd" : "#94a3b8",
      }}
      aria-pressed={isOn}
      aria-label="Toggle agent mode"
      title={locked ? "Mode is locked after first message" : "Toggle agent mode"}
    >
      {isInitializing ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : locked ? (
        <Lock className="h-3.5 w-3.5" />
      ) : (
        <Bot className="h-4 w-4" />
      )}
      <span className="hidden sm:inline">{locked ? "Agent Locked" : "Agent"}</span>
    </button>
  );
}
