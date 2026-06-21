import { redirect } from "next/navigation";

import { resolveServerAuthContext } from "@/lib/auth";
import { env } from "@/lib/env";
import { AuthCard } from "@/components/auth-card";

export default async function LoginPage() {
  const auth = await resolveServerAuthContext();

  if (!env.AUTH_REQUIRED || auth) {
    redirect("/chat/new-chat");
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-[radial-gradient(circle_at_20%_15%,rgba(20,184,166,0.28),transparent_40%),radial-gradient(circle_at_80%_5%,rgba(251,146,60,0.25),transparent_35%),linear-gradient(145deg,#020617,#0f172a)] px-4">
      <AuthCard mode="login" registrationEnabled={env.REGISTRATION_ENABLED} />
    </main>
  );
}
