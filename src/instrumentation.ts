export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startSessionCleanup } = await import("@/lib/auth");
    const { resetStuckSessions } = await import("@/lib/agent/runner-store");

    startSessionCleanup();
    void resetStuckSessions().then((count) => {
      if (count > 0) {
        console.log(`[Startup] Reset ${count} stuck agent session(s)`);
      }
    });
  }
}
