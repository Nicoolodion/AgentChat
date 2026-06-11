/**
 * Shared registry to track active agent execution runs so they can be stopped.
 */

export const activeAgents = new Map<string, AbortController>();
export const agentSignals = new Map<string, AbortController>();

export async function resetStuckSessions(): Promise<number> {
  const { prisma } = await import("@/lib/prisma");
  const result = await prisma.agentSession.updateMany({
    where: {
      status: { in: ["thinking", "executing"] },
    },
    data: {
      status: "error",
      errorMessage: "Session interrupted by server restart",
      completedAt: new Date(),
    },
  });
  return result.count;
}
