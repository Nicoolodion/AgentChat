/**
 * MessageTimeline
 *
 * Renders an assistant message as an ordered vertical timeline:
 *
 *   [reasoning]   ← collapsed by default (preview only), click to expand
 *   [tool call]   ← with arguments preview, running / done / failed
 *   [tool output] ← streamed text under the call
 *   [text]        ← the final assistant text (rendered as markdown)
 *   [more tools…]
 *   [more text…]
 *
 * A vertical rail runs down the left side connecting every step, with a small
 * colored dot indicating the step type. Each step can be expanded/collapsed
 * individually.
 *
 * Step ordering is preserved exactly as the agent emitted it (reasoning →
 * tool → output → text → tool → text …), not bundled by kind like the
 * previous implementation did.
 */

import { useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  AlertTriangle,
  Brain,
  Check,
  ChevronRight,
  ChevronDown,
  Loader2,
  Wrench,
  MessageSquareText,
  Zap,
  Activity,
} from "lucide-react";

import { cn } from "@/lib/ui";
import type { ChatMessage, ChatToolCall } from "@/lib/chat-types";

export type ToolOutputEntry = {
  toolCallId: string;
  output: string;
  timestamp?: number;
};

export type TimelineStep =
  | { kind: "reasoning"; id: string; text: string }
  | { kind: "tool"; id: string; call: ChatToolCall; arguments?: Record<string, unknown>; outputs: ToolOutputEntry[] }
  | { kind: "text"; id: string; text: string };

type Props = {
  message: ChatMessage;
  toolOutputs: ToolOutputEntry[];
  toolArguments?: Record<string, Record<string, unknown>>;
  isStreaming: boolean;
};

export function MessageTimeline({ message, toolOutputs, toolArguments, isStreaming }: Props) {
  const steps = useMemo(
    () => buildSteps(message, toolOutputs, toolArguments),
    [message, toolOutputs, toolArguments],
  );
  return (
    <div className="relative pl-7">
      {/* Vertical rail */}
      <div className="pointer-events-none absolute left-2 top-3 bottom-3 w-px bg-gradient-to-b from-teal-400/50 via-white/10 to-white/5" />
      <ol className="space-y-3">
        {steps.map((step, idx) => (
          <li key={step.id} className="relative">
            <StepDot step={step} />
            <div className="ml-4">
              <StepBody step={step} isStreaming={isStreaming && idx === steps.length - 1} />
            </div>
          </li>
        ))}

        {isStreaming && steps.length === 0 && (
          <li className="relative">
            <span className="absolute -left-4 top-2 h-2 w-2 rounded-full bg-teal-300 animate-pulse" />
            <span className="ml-2 text-xs text-slate-400">Thinking…</span>
          </li>
        )}
        {isStreaming &&
          steps.length > 0 &&
          (() => {
            const last = steps[steps.length - 1]!;
            if (last.kind === "reasoning") return true;
            if (last.kind === "tool" && last.call.status === "running") return true;
            return false;
          })() && (
            <li className="relative">
              <span className="absolute -left-4 top-2 flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-teal-400 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-teal-300" />
              </span>
            </li>
          )}
      </ol>
    </div>
  );
}

function StepDot({ step }: { step: TimelineStep }) {
  if (step.kind === "reasoning") {
    return (
      <span
        className="absolute -left-[18px] top-2 inline-flex h-4 w-4 items-center justify-center rounded-full border border-violet-300/40 bg-violet-400/10"
        aria-hidden
      >
        <Brain className="h-2.5 w-2.5 text-violet-200" />
      </span>
    );
  }
  if (step.kind === "tool") {
    const status = step.call.status;
    const dotCls =
      status === "running"
        ? "bg-amber-300 animate-pulse"
        : status === "success"
          ? "bg-emerald-300"
          : "bg-rose-300";
    return (
      <span
        className={cn(
          "absolute -left-[18px] top-2 inline-flex h-4 w-4 items-center justify-center rounded-full border border-white/15 bg-slate-900",
        )}
        aria-hidden
      >
        <span className={cn("h-1.5 w-1.5 rounded-full", dotCls)} />
      </span>
    );
  }
  return (
    <span
      className="absolute -left-[18px] top-2 inline-flex h-4 w-4 items-center justify-center rounded-full border border-teal-300/40 bg-teal-400/10"
      aria-hidden
    >
      <MessageSquareText className="h-2.5 w-2.5 text-teal-200" />
    </span>
  );
}

function StepBody({ step, isStreaming }: { step: TimelineStep; isStreaming: boolean }) {
  if (step.kind === "reasoning") {
    return <ReasoningStep text={step.text} />;
  }
  if (step.kind === "tool") {
    return <ToolStep call={step.call} args={step.arguments} outputs={step.outputs} isStreaming={isStreaming} />;
  }
  return <TextStep text={step.text} isStreaming={isStreaming} />;
}

function ReasoningStep({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const preview = useMemo(() => buildPreview(text, 140), [text]);

  return (
    <div className="rounded-lg border border-violet-300/15 bg-violet-400/5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-[11px] font-medium text-violet-200 hover:bg-violet-400/5"
        aria-expanded={open}
      >
        {open ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
        <Brain className="h-3 w-3 shrink-0" />
        <span className="truncate">{open ? "Reasoning" : preview}</span>
        <span className="ml-auto text-[10px] text-violet-300/70">{text.length} chars</span>
      </button>
      {open && (
        <div className="border-t border-violet-300/10 px-2.5 py-2 text-[11px] leading-relaxed text-slate-200">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              pre: ({ children }) => (
                <pre className="overflow-x-auto rounded-md bg-slate-950/80 p-2 text-[10px] leading-relaxed text-slate-200">
                  {children}
                </pre>
              ),
              code: ({ className, children }) => {
                const isBlock = className?.includes("language-");
                if (isBlock) return <>{children}</>;
                return (
                  <code className="rounded bg-white/10 px-1 py-0.5 font-mono text-[10px] text-slate-100">
                    {children}
                  </code>
                );
              },
            }}
          >
            {text}
          </ReactMarkdown>
        </div>
      )}
    </div>
  );
}

function ToolStep({
  call,
  args,
  outputs,
  isStreaming,
}: {
  call: ChatToolCall;
  args?: Record<string, unknown>;
  outputs: ToolOutputEntry[];
  isStreaming: boolean;
}) {
  const [open, setOpen] = useState(call.status !== "success" || outputs.length > 0);
  const status = call.status;
  const label = toolCallLabel(call.toolName, args);

  return (
    <div
      className={cn(
        "rounded-lg border bg-slate-900/40",
        status === "running" && "border-amber-300/30",
        status === "success" && "border-emerald-300/20",
        status === "error" && "border-rose-300/30",
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-2.5 py-2 text-left text-[11px] hover:bg-white/5"
        aria-expanded={open}
      >
        {open ? <ChevronDown className="h-3 w-3 shrink-0 text-slate-500" /> : <ChevronRight className="h-3 w-3 shrink-0 text-slate-500" />}
        <Wrench className="h-3.5 w-3.5 shrink-0 text-violet-300" />
        <span className="font-mono font-semibold text-violet-200">{call.toolName}</span>
        {label && (
          <span
            className="ml-1.5 min-w-0 flex-1 truncate font-mono text-[11px] text-slate-300"
            title={label}
          >
            · {label}
          </span>
        )}
        {!label && <span className="flex-1" />}
        {status === "running" && (
          <span className="ml-auto flex shrink-0 items-center gap-1 text-[10px] text-amber-300">
            <Loader2 className="h-3 w-3 animate-spin" />
            running
          </span>
        )}
        {status === "success" && (
          <span className="ml-auto flex shrink-0 items-center gap-1 text-[10px] text-emerald-300">
            <Check className="h-3 w-3" />
            {call.durationMs ? `${call.durationMs}ms` : "done"}
          </span>
        )}
        {status === "error" && (
          <span className="ml-auto flex shrink-0 items-center gap-1 text-[10px] text-rose-300">
            <AlertTriangle className="h-3 w-3" />
            failed
          </span>
        )}
      </button>

      {open && (
        <div className="border-t border-white/5 px-2.5 py-2 text-[10px] text-slate-300">
          {outputs.length === 0 && status === "running" && (
            <div className="flex items-center gap-1.5 py-1 text-slate-500">
              <Loader2 className="h-3 w-3 animate-spin" />
              <span>{isStreaming ? "Executing…" : "Waiting for output…"}</span>
            </div>
          )}
          {outputs.map((o, i) => (
            <pre
              key={`${o.toolCallId}-${i}`}
              className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-slate-950/60 p-2 font-mono text-[10px] leading-relaxed text-slate-300"
            >
              {o.output}
            </pre>
          ))}
        </div>
      )}
    </div>
  );
}

function TextStep({ text, isStreaming }: { text: string; isStreaming: boolean }) {
  if (!text.trim()) {
    if (isStreaming) {
      return (
        <div className="flex items-center gap-1.5 py-1 text-slate-500">
          <Loader2 className="h-3 w-3 animate-spin" />
          <span className="text-[11px]">Streaming response…</span>
        </div>
      );
    }
    return null;
  }
  return (
    <div className="rounded-lg border border-white/5 bg-slate-900/30 px-2.5 py-2 text-sm text-slate-100">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => <h1 className="mb-2 mt-1 text-base font-semibold text-white">{children}</h1>,
          h2: ({ children }) => <h2 className="mb-2 mt-1 text-sm font-semibold text-white">{children}</h2>,
          h3: ({ children }) => <h3 className="mb-1 mt-1 text-sm font-semibold text-white">{children}</h3>,
          p: ({ children }) => <p className="mb-1.5 text-sm leading-relaxed">{children}</p>,
          ul: ({ children }) => <ul className="mb-1.5 ml-4 list-disc text-sm">{children}</ul>,
          ol: ({ children }) => <ol className="mb-1.5 ml-4 list-decimal text-sm">{children}</ol>,
          li: ({ children }) => <li className="mb-0.5 leading-relaxed">{children}</li>,
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer" className="text-teal-300 underline underline-offset-2 hover:text-teal-200">
              {children}
            </a>
          ),
          blockquote: ({ children }) => (
            <blockquote className="mb-1.5 border-l-2 border-teal-300/40 pl-2 italic text-slate-300">
              {children}
            </blockquote>
          ),
          hr: () => <hr className="my-2 border-white/10" />,
          table: ({ children }) => (
            <div className="my-2 overflow-x-auto">
              <table className="min-w-full border-collapse border border-white/10 text-sm text-slate-100">{children}</table>
            </div>
          ),
          th: ({ children }) => <th className="border border-white/10 bg-white/5 px-2 py-1 font-semibold">{children}</th>,
          td: ({ children }) => <td className="border border-white/10 px-2 py-1">{children}</td>,
          pre: ({ children }) => (
            <pre className="my-1.5 overflow-x-auto rounded-lg border border-white/10 bg-slate-900/80 p-2 text-[11px] leading-relaxed text-slate-200">
              {children}
            </pre>
          ),
          code: ({ className, children }) => {
            const isBlock = className?.includes("language-");
            if (isBlock) return <>{children}</>;
            return (
              <code className="rounded bg-white/10 px-1 py-0.5 font-mono text-[11px] text-slate-100">
                {children}
              </code>
            );
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildSteps(
  message: ChatMessage,
  toolOutputs: ToolOutputEntry[],
  toolArguments?: Record<string, Record<string, unknown>>,
): TimelineStep[] {
  const steps: TimelineStep[] = [];

  const toolCalls = message.toolCalls ?? [];
  const hasReasoningSegments = message.reasoningSegments && message.reasoningSegments.length > 0;

  if (hasReasoningSegments) {
    const segments = message.reasoningSegments!;
    const numSegments = segments.length;
    const numToolCalls = toolCalls.length;

    for (let i = 0; i < Math.max(numSegments, numToolCalls); i++) {
      if (i < numSegments && segments[i]!.trim().length > 0) {
        steps.push({ kind: "reasoning", id: `r-${message.id}-${i}`, text: segments[i]! });
      }
      if (i < numToolCalls) {
        const call = toolCalls[i]!;
        const outputs = toolOutputs.filter((o) => o.toolCallId === call.toolCallId);
        const args = toolArguments?.[call.toolCallId];
        steps.push({ kind: "tool", id: `t-${message.id}-${call.toolCallId}`, call, arguments: args, outputs });
      }
    }

    // If there are more tool calls than segments, add remaining tool calls
    for (let i = numSegments; i < numToolCalls; i++) {
      const call = toolCalls[i]!;
      const outputs = toolOutputs.filter((o) => o.toolCallId === call.toolCallId);
      const args = toolArguments?.[call.toolCallId];
      steps.push({ kind: "tool", id: `t-${message.id}-${call.toolCallId}`, call, arguments: args, outputs });
    }
  } else {
    if (message.reasoning && message.reasoning.trim().length > 0) {
      steps.push({ kind: "reasoning", id: `r-${message.id}`, text: message.reasoning });
    }

    for (const call of toolCalls) {
      const outputs = toolOutputs.filter((o) => o.toolCallId === call.toolCallId);
      const args = toolArguments?.[call.toolCallId];
      steps.push({ kind: "tool", id: `t-${message.id}-${call.toolCallId}`, call, arguments: args, outputs });
    }
  }

  if (message.content && message.content.trim().length > 0) {
    steps.push({ kind: "text", id: `x-${message.id}`, text: message.content });
  }

  return steps;
}

/**
 * Build a short human-friendly descriptor for a tool call that goes after the
 * tool name. For example: `file_read · /workspace/upload/report.docx`.
 * Falls back to the first string argument or `—` if nothing useful is found.
 */
function toolCallLabel(toolName: string, args?: Record<string, unknown>): string {
  if (!args) return "";
  // Tools that operate on a single primary target — use that argument.
  const singleArgTools: Record<string, string> = {
    file_read: "path",
    file_write: "path",
    file_delete: "path",
    file_info: "path",
    file_move: "source",
    shell: "command",
    pip_install: "package",
    web_search: "query",
    web_fetch: "url",
    chart_create: "output_path",
    image_analyze: "paths",
    docx_to_pdf: "input_path",
    docx_read: "path",
    docx_template_fill: "template_path",
    pdf_from_html: "html_path",
    docx_create: "output_path",
    docx_build: "output_path",
    xlsx_create: "output_path",
    pptx_create: "output_path",
    libreoffice_convert: "input_path",
  };
  const key = singleArgTools[toolName];
  if (key) {
    const v = args[key];
    if (typeof v === "string" && v.trim().length > 0) return v;
    if (Array.isArray(v) && v.length > 0) return v.map(String).join(", ");
  }
  // Fall back to the first non-empty string argument
  for (const value of Object.values(args)) {
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return "";
}

function buildPreview(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max)}…`;
}

export function formatTokensPerSecond(tps?: number): string {
  if (!tps) return "";
  return `${tps.toFixed(1)} t/s`;
}

export function formatTTFT(ms?: number): string {
  if (!ms) return "";
  return `${ms}ms`;
}

export { Zap, Activity };
