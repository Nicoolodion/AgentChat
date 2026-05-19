"use client";

import { Bot, Wrench, AlertTriangle } from "lucide-react";

export function AgentMessageBadge({
  toolNames,
  durationSec,
  hasErrors,
}: {
  toolNames: string[];
  durationSec?: number;
  hasErrors?: boolean;
}) {
  return (
    <div className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-violet-400/20 bg-violet-400/10 px-2.5 py-1 text-[10px] text-violet-300">
      {hasErrors ? <AlertTriangle className="h-3 w-3 text-amber-300" /> : <Bot className="h-3 w-3" />}
      <span className="hidden sm:inline">Agent used:</span>
      <Wrench className="h-3 w-3 sm:hidden" />
      <span className="font-medium">{toolNames.join(", ")}</span>
      {typeof durationSec === "number" && (
        <span className="text-violet-400">({durationSec}s)</span>
      )}
    </div>
  );
}
