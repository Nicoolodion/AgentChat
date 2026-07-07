import { redirect } from "next/navigation";

import { resolveServerAuthContext } from "@/lib/auth";
import { env } from "@/lib/env";
import { MobileTaskApp } from "@/components/mobile/mobile-task-app";

export const metadata = {
  title: "Tasks — Mobile",
  description: "Start a Task, get the result by email + push.",
};

export default async function MobilePage() {
  const auth = await resolveServerAuthContext();

  if (env.AUTH_REQUIRED && !auth) {
    redirect("/login?next=/m");
  }

  const userId = auth?.userId ?? "guest";
  const isGuest = !auth || auth.isGuest;

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      <MobileTaskApp
        defaultModel={env.DEFAULT_MODEL}
        userId={userId}
        isGuest={isGuest}
        csrfToken="ChatInterface"
      />
    </main>
  );
}
