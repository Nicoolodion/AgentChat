import { runTask, setNotifyDispatcher, setUserKeyResolver } from "./run-task";
import { createTask } from "./create-task";
import type { CreateTaskInput, CreateTaskResult, TaskSource } from "./types";
import { isTaskActive } from "./types";

export {
  createTask,
  runTask,
  setNotifyDispatcher,
  setUserKeyResolver,
  isTaskActive,
};
export type { CreateTaskInput, CreateTaskResult, TaskSource };

/**
 * Enqueue a task to run in the background (fire-and-forget). Used by the mobile
 * and email routes so the HTTP response returns immediately with the taskId
 * while runTask executes detached. Errors are caught + logged inside runTask.
 */
export function enqueueTask(taskId: string): void {
  // Schedule on a microtask so we never block the response. runTask is fully
  // self-contained (persists its own errors), so a bare Promise is enough.
  void runTask(taskId).catch((err) => {
    console.error("[Task Enqueue Error]", err);
  });
}
