import { redirect } from "next/navigation";

import { resolveServerAuthContext } from "@/lib/auth";
import { env } from "@/lib/env";

export default async function HomePage() {
  const auth = await resolveServerAuthContext();

  if (!env.AUTH_REQUIRED) {
    redirect("/chat/new-chat");
  }

  if (auth) {
    redirect("/chat/new-chat");
  }

  redirect("/login");
}
