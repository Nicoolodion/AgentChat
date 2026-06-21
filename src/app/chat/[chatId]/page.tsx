import { redirect } from "next/navigation";

import { resolveServerAuthContext } from "@/lib/auth";
import { env } from "@/lib/env";
import { ChatApp } from "@/components/chat-app";

export default async function ChatPage({
  params,
}: {
  params: Promise<{ chatId: string }>;
}) {
  const auth = await resolveServerAuthContext();

  if (env.AUTH_REQUIRED && !auth) {
    redirect("/login");
  }

  const { chatId } = await params;

  return <ChatApp initialChatId={chatId} />;
}
