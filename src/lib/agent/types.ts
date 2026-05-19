/**
 * Agent system type definitions
 */

export type AgentSessionStatus = "idle" | "thinking" | "executing" | "completed" | "error";

export type AgentToolCallStatus = "pending" | "running" | "success" | "error";

export type AgentArtifactKind =
  | "document"
  | "pdf"
  | "image"
  | "code"
  | "spreadsheet"
  | "presentation"
  | "archive"
  | "other";

export type AgentSession = {
  id: string;
  chatId: string;
  userId: string;
  status: AgentSessionStatus;
  workspacePath: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  errorMessage?: string;
};

export type AgentToolCall = {
  id: string;
  sessionId: string;
  toolName: string;
  arguments: string; // JSON
  result?: string; // JSON
  error?: string;
  durationMs?: number;
  status: AgentToolCallStatus;
  createdAt: string;
  completedAt?: string;
};

export type AgentArtifact = {
  id: string;
  sessionId: string;
  fileName: string;
  mimeType: string;
  size: number;
  kind: AgentArtifactKind;
  storagePath: string;
  description?: string;
  createdAt: string;
};

export type AgentSessionDetail = {
  session: AgentSession;
  toolCalls: AgentToolCall[];
  artifacts: AgentArtifact[];
};

// SSE Events
export type AgentSseEvent =
  | { type: "status"; data: { status: AgentSessionStatus; step?: string } }
  | { type: "tool_start"; data: { toolCallId: string; toolName: string; arguments: Record<string, unknown> } }
  | { type: "tool_output"; data: { toolCallId: string; output: string; images?: string[] } }
  | { type: "tool_done"; data: { toolCallId: string; toolName: string; ok: boolean; durationMs: number; error?: string } }
  | { type: "content"; data: { text: string } }
  | { type: "reasoning"; data: { text: string } }
  | { type: "artifact"; data: { artifact: AgentArtifact } }
  | { type: "error"; data: { message: string } }
  | { type: "done"; data: { session: AgentSession; artifacts: AgentArtifact[]; meta?: { totalToolCalls: number; totalDurationMs: number } } };

export type SandboxFileInfo = {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  mimeType: string | null;
  modifiedAt: string;
};

export type SkillInfo = {
  name: string;
  description: string;
  routes: Array<{ name: string; condition: string }>;
  dependencies: Array<{ name: string; status: string; version?: string }>;
};

export type SkillDetail = {
  name: string;
  SKILL_md: string;
  references: Array<{ name: string; path: string }>;
};
