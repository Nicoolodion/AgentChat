"use client";

import { useRef, useEffect } from "react";
import { Check, ChevronRight, Loader2, X, Trash2, Copy, Terminal as TerminalIcon } from "lucide-react";
import type { TerminalEntry } from "./use-agent";

export function AgentTerminal({
  entries,
  isExecuting,
  onClear,
}: {
  entries: TerminalEntry[];
  isExecuting: boolean;
  onClear: () => void;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [entries.length, isExecuting]);

  function formatTime(ts: number): string {
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
  }

  async function copyAll() {
    const text = entries
      .map((e) => {
        const time = formatTime(e.timestamp);
        switch (e.type) {
          case "status":
            return `[${time}] ${e.message}`;
          case "tool_start":
            return `[${time}] > ${e.toolName} ${JSON.stringify(e.arguments)}`;
          case "tool_output":
            return `[${time}] Output: ${e.output}`;
          case "tool_done":
            return `[${time}] ${e.ok ? "OK" : "FAIL"} ${e.toolName} (${e.durationMs}ms)`;
          case "error":
            return `[${time}] ERROR: ${e.message}`;
          case "step":
            return `[${time}] --- ${e.text} ---`;
        }
      })
      .join("\n");
    await navigator.clipboard.writeText(text);
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-white/10 px-3 py-2">
        <div className="flex items-center gap-2 text-xs text-slate-400">
          <TerminalIcon className="h-3.5 w-3.5" />
          {entries.length} entries
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={copyAll}
            className="rounded p-1 text-slate-400 transition hover:bg-white/10 hover:text-white"
            title="Copy all"
          >
            <Copy className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={onClear}
            className="rounded p-1 text-slate-400 transition hover:bg-white/10 hover:text-white"
            title="Clear"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-2 font-mono text-xs">
        {entries.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-slate-500">
            <TerminalIcon className="h-6 w-6" />
            <p>No activity yet</p>
            <p className="text-[10px]">The agent&apos;s actions will appear here</p>
          </div>
        )}

        {entries.map((entry, i) => (
          <div key={i} className="mb-1.5">
            {entry.type === "status" && (
              <div className="flex items-start gap-2 border-l-2 border-violet-500 pl-2">
                <span className="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-violet-400" />
                <div>
                  <span className="text-[10px] text-slate-500">{formatTime(entry.timestamp)}</span>
                  <span className="ml-2 text-slate-300">{entry.message}</span>
                </div>
              </div>
            )}

            {entry.type === "tool_start" && (
              <div className="flex items-start gap-2 pl-2">
                <ChevronRight className="mt-0.5 h-3 w-3 shrink-0 text-violet-400" />
                <div>
                  <span className="text-[10px] text-slate-500">{formatTime(entry.timestamp)}</span>
                  <span className="ml-2 font-semibold text-violet-300">{entry.toolName}</span>
                  <pre className="mt-0.5 max-h-24 overflow-auto rounded bg-slate-950/50 p-1 text-[10px] text-slate-400">
                    {JSON.stringify(entry.arguments, null, 2)}
                  </pre>
                </div>
              </div>
            )}

            {entry.type === "tool_output" && (
              <div className="flex items-start gap-2 pl-6">
                <Check className="mt-0.5 h-3 w-3 shrink-0 text-emerald-400" />
                <div className="flex-1">
                  <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded bg-slate-950/50 p-1 text-[10px] text-slate-300">
                    {entry.output}
                  </pre>
                </div>
              </div>
            )}

            {entry.type === "tool_done" && (
              <div className="flex items-start gap-2 pl-6">
                {entry.ok ? (
                  <Check className="mt-0.5 h-3 w-3 shrink-0 text-emerald-400" />
                ) : (
                  <X className="mt-0.5 h-3 w-3 shrink-0 text-red-400" />
                )}
                <div>
                  <span className="text-[10px] text-slate-500">{formatTime(entry.timestamp)}</span>
                  <span className={`ml-2 ${entry.ok ? "text-emerald-300" : "text-red-300"}`}>
                    {entry.toolName} {entry.ok ? "done" : "failed"} ({entry.durationMs}ms)
                  </span>
                </div>
              </div>
            )}

            {entry.type === "error" && (
              <div className="flex items-start gap-2 border-l-2 border-red-500 pl-2">
                <X className="mt-0.5 h-3 w-3 shrink-0 text-red-400" />
                <div>
                  <span className="text-[10px] text-slate-500">{formatTime(entry.timestamp)}</span>
                  <span className="ml-2 text-red-300">{entry.message}</span>
                </div>
              </div>
            )}

            {entry.type === "step" && (
              <div className="my-2 flex items-center gap-2">
                <div className="h-px flex-1 bg-white/10" />
                <span className="text-[10px] uppercase tracking-wider text-slate-500">{entry.text}</span>
                <div className="h-px flex-1 bg-white/10" />
              </div>
            )}
          </div>
        ))}

        {isExecuting && (
          <div className="flex items-center gap-2 py-2 pl-2 text-slate-400">
            <Loader2 className="h-3 w-3 animate-spin" />
            <span className="text-[10px]">Running...</span>
          </div>
        )}

        <div ref={bottomRef} />
      </div>
    </div>
  );
}
