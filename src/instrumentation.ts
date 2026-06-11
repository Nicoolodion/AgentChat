export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startSessionCleanup } = await import("@/lib/auth");
    const { resetStuckSessions } = await import("@/lib/agent/runner-store");
    const { cleanupOldWorkspaces } = await import("@/lib/agent/workspace");
    const { cleanupExpiredBuckets } = await import("@/lib/rate-limit");

    startSessionCleanup();
    void resetStuckSessions().then((count) => {
      if (count > 0) {
        console.log(`[Startup] Reset ${count} stuck agent session(s)`);
      }
    });
    void cleanupOldWorkspaces().then((count) => {
      if (count > 0) {
        console.log(`[Startup] Cleaned up ${count} old workspace(s)`);
      }
    });
    void cleanupExpiredBuckets().then((count) => {
      if (count > 0) {
        console.log(`[Startup] Cleaned up ${count} expired rate limit bucket(s)`);
      }
    });

    setInterval(() => {
      void cleanupOldWorkspaces().catch(() => {});
    }, 24 * 60 * 60 * 1000);
  }
}
