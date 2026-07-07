export type TaskSource = "mobile" | "email" | "desktop";

export type CreateTaskInput = {
  userId: string;
  userKey: Buffer;
  username: string;
  prompt: string;
  model?: string | null;
  source: TaskSource;
  emailAddress?: string | null;
  emailThreadId?: string | null;
  attachmentIds?: string[];
};

export type CreateTaskResult = {
  taskId: string;
  chatId: string;
  agentSessionId: string;
  status: string;
};

const TASK_ACTIVE_STATUSES = ["queued", "running"];

export function isTaskActive(status: string): boolean {
  return TASK_ACTIVE_STATUSES.includes(status);
}
