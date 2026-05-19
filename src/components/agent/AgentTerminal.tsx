"use client";

import { useRef, useEffect, useState, useCallback } from "react";
import {
  Check,
  ChevronRight,
  ChevronDown,
  Loader2,
  X,
  Trash2,
  Copy,
  Terminal as TerminalIcon,
} from "lucide-react";
import type { TerminalEntry } from "./use-agent";

type ExpandedMap = Record<string, boolean>;

export function AgentTerminal({
  entries,
  isExecuting,
  onClear,
}: {
  entries: TerminalEntry[];
  isExecuting: boolean;
  onClear: () => void;
}) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState<ExpandedMap>({});

  // Smart auto-scroll: only scroll if user was near bottom before new entries arrive
  const shouldAutoScrollRef = useRef(true);

  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    shouldAutoScrollRef.current = nearBottom;
  }, []);

  useEffect(() => {
    if (shouldAutoScrollRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
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

  function groupEntriesByTool(): {
    key: string;
    status?: TerminalEntry & { type: "status" };
    start?: TerminalEntry & { type: "tool_start" };
    outputs: (TerminalEntry & { type: "tool_output" })[];
    done?: TerminalEntry & { type: "tool_done" };
    error?: TerminalEntry & { type: "error" };
    stepText?: string;
  }[] {
    const groups: ReturnType<typeof groupEntriesByTool> = [];
    let currentGroup: (typeof groups)[number] | null = null;

    for (const entry of entries) {
      if (entry.type === "status") {
        if (currentGroup) groups.push(currentGroup);
        currentGroup = { key: `status-${entry.timestamp}`, status: entry as any, outputs: [] };
        continue;
      }
      if (entry.type === "tool_start") {
        if (currentGroup) groups.push(currentGroup);
        currentGroup = {
          key: `tool-${(entry as any).toolName}-${entry.timestamp}`,
          start: entry as any,
          outputs: [],
        };
        continue;
      }
      if (entry.type === "tool_output") {
        if (currentGroup) {
          currentGroup.outputs.push(entry as any);
        } else {
          // orphan output
          groups.push({ key: `output-${entry.timestamp}`, outputs: [entry as any] });
        }
        continue;
      }
      if (entry.type === "tool_done") {
        if (currentGroup) {
          currentGroup.done = entry as any;
          groups.push(currentGroup);
          currentGroup = null;
        } else {
          groups.push({ key: `done-${entry.timestamp}`, done: entry as any, outputs: [] });
        }
        continue;
      }
      if (entry.type === "error") {
        if (currentGroup) {
          currentGroup.error = entry as any;
          groups.push(currentGroup);
          currentGroup = null;
        } else {
          groups.push({ key: `err-${entry.timestamp}`, error: entry as any, outputs: [] });
        }
        continue;
      }
      if (entry.type === "step") {
        if (currentGroup) groups.push(currentGroup);
        groups.push({ key: `step-${entry.timestamp}`, stepText: (entry as any).text, outputs: [] });
        currentGroup = null;
      }
    }
    if (currentGroup) groups.push(currentGroup);
    return groups;
  }

  function toggleExpanded(key: string) {
    setExpanded((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  const groups = groupEntriesByTool();

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

      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto px-3 py-2 font-mono text-xs"
      >
        {entries.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-slate-500">
            <TerminalIcon className="h-6 w-6" />
            <p>No activity yet</p>
            <p className="text-[10px]">The agent&apos;s actions will appear here</p>
          </div>
        )}

        {groups.map((group) => {
          const key = group.key;
          const isOpen = expanded[key] ?? false;

          // Status-only group
          if (group.status && !group.start && !group.done && !group.error) {
            return (
              <div key={key} className="mb-1.5">
                <div className="flex items-start gap-2 border-l-2 border-violet-500 pl-2">
                  <span className="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-violet-400" />
                  <div>
                    <span className="text-[10px] text-slate-500">
                      {formatTime(group.status.timestamp)}
                    </span>
                    <span className="ml-2 text-slate-300">{group.status.message}</span>
                  </div>
                </div>
              </div>
            );
          }

          // Step-only group
          if (group.key.startsWith("step-")) {
            const stepText = (group as any).stepText ?? "---";
            return (
              <div key={key} className="my-2 flex items-center gap-2">
                <div className="h-px flex-1 bg-white/10" />
                <span className="text-[10px] uppercase tracking-wider text-slate-500">{stepText}</span>
                <div className="h-px flex-1 bg-white/10" />
              </div>
            );
          }

          // Tool group
          if (group.start) {
            const hasError = group.error || (group.done && !group.done.ok);
            const ok = group.done?.ok ?? false;
            return (
              <div key={key} className="mb-2 rounded-lg border border-white/5 bg-slate-950/40">
                {/* Header row */}
                <button
                  onClick={() => toggleExpanded(key)}
                  className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition hover:bg-white/5"
                >
                  {isOpen ? (
                    <ChevronDown className="mt-px h-3 w-3 shrink-0 text-slate-500" />
                  ) : (
                    <ChevronRight className="mt-px h-3 w-3 shrink-0 text-slate-500" />
                  )}
                  <span className="text-[10px] text-slate-500">
                    {formatTime(group.start.timestamp)}
                  </span>
                  <span className="font-semibold text-violet-300">{group.start.toolName}</span>
                  {group.done ? (
                    ok ? (
                      <span className="ml-auto flex items-center gap-1 text-[10px] text-emerald-300">
                        <Check className="h-3 w-3" />
                        {group.done.durationMs}ms
                      </span>
                    ) : (
                      <span className="ml-auto flex items-center gap-1 text-[10px] text-red-300">
                        <X className="h-3 w-3" />
                        FAIL
                      </span>
                    )
                  ) : (
                    <span className="ml-auto flex items-center gap-1 text-[10px] text-amber-300">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      running
                    </span>
                  )}
                </button>

                {/* Collapsible body */}
                {isOpen && (
                  <div className="border-t border-white/5 px-2.5 py-2">
                    {/* Arguments */}
                    <div className="mb-2">
                      <div className="mb-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-500">
                        Arguments
                      </div>
                      <pre className="max-h-48 overflow-auto rounded bg-slate-950/60 p-1.5 text-[10px] text-slate-300">
                        {JSON.stringify(group.start.arguments, null, 2)}
                      </pre>
                    </div>

                    {/* Outputs */}
                    {group.outputs.length > 0 && (
                      <div className="mb-2">
                        <div className="mb-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-500">
                          Output ({group.outputs.length})
                        </div>
                        <div className="space-y-1">
                          {group.outputs.map((out, idx) => (
                            <pre
                              key={idx}
                              className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-slate-950/60 p-1.5 text-[10px] text-slate-300"
                            >
                              {out.output}
                            </pre>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Done / Error */}
                    {group.done && (
                      <div className="flex items-center gap-1.5 text-[10px]">
                        {group.done.ok ? (
                          <>
                            <Check className="h-3 w-3 text-emerald-400" />
                            <span className="text-emerald-300">Completed in {group.done.durationMs}ms</span>
                          </>
                        ) : (
                          <>
                            <X className="h-3 w-3 text-red-400" />
                            <span className="text-red-300">Failed{group.error ? `: ${group.error.message}` : ""}</span>
                          </>
                        )}
                      </div>
                    )}
                    {group.error && (
                      <div className="mt-1 flex items-center gap-1.5 text-[10px] text-red-300">
                        <X className="h-3 w-3 text-red-400" />
                        <span>{group.error.message}</span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          }

          // Orphan error
          if (group.error) {
            return (
              <div key={key} className="mb-1.5 flex items-start gap-2 border-l-2 border-red-500 pl-2">
                <X className="mt-0.5 h-3 w-3 shrink-0 text-red-400" />
                <div>
                  <span className="text-[10px] text-slate-500">
                    {formatTime(group.error.timestamp)}
                  </span>
                  <span className="ml-2 text-red-300">{group.error.message}</span>
                </div>
              </div>
            );
          }

          // Orphan output
          if (group.outputs.length > 0) {
            return (
              <div key={key} className="mb-1.5 space-y-1">
                {group.outputs.map((out, idx) => (
                  <pre
                    key={idx}
                    className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-slate-950/60 p-1.5 text-[10px] text-slate-300"
                  >
                    {out.output}
                  </pre>
                ))}
              </div>
            );
          }

          return null;
        })}

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
