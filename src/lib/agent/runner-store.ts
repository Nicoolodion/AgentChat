/**
 * Shared registry to track active agent execution runs so they can be stopped.
 */

export const agentSignals = new Map<string, AbortController>();
export const activeAgents = agentSignals;

export async function resetStuckSessions(): Promise<number> {
  const { prisma } = await import("@/lib/prisma");
  const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000);
  const result = await prisma.agentSession.updateMany({
    where: {
      status: { in: ["thinking", "executing"] },
      updatedAt: { lt: fifteenMinutesAgo },
    },
    data: {
      status: "error",
      errorMessage: "Session interrupted by server restart",
      completedAt: new Date(),
    },
  });
  return result.count;
}
