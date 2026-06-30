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

    // Recover sessions stuck in thinking/executing (e.g. after a worker OOM-
    // kill) on a periodic interval, not only at boot. resetStuckSessions is
    // idempotent (only touches thinking/executing rows) so a short interval is
    // safe and also ensures their workspaces eventually get cleaned up.
    setInterval(() => {
      void resetStuckSessions().catch(() => {});
    }, 5 * 60 * 1000);
  }
}
