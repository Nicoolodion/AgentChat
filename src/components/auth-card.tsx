"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Loader2, Lock, UserRound } from "lucide-react";

type AuthCardProps = {
  mode: "login" | "register";
  registrationEnabled: boolean;
};

async function requestJson<T>(url: string, payload: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const json = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    throw new Error(json.error ?? "Request failed");
  }

  return json;
}

export function AuthCard({ mode, registrationEnabled }: AuthCardProps) {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [registered, setRegistered] = useState(false);

  const isLogin = mode === "login";

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setLoading(true);

    try {
      if (isLogin) {
        await requestJson("/api/auth/login", { username, password });
        router.replace("/chat");
      } else {
        await requestJson("/api/auth/register", { username, password });
        setRegistered(true);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="w-full max-w-md rounded-3xl border border-white/15 bg-slate-950/70 p-7 shadow-[0_24px_80px_rgba(0,0,0,.45)] backdrop-blur">
      <div className="mb-6">
        <div className="text-xs uppercase tracking-[0.25em] text-teal-300">Chatinterface</div>
        <h1 className="mt-2 text-2xl font-semibold text-white">
          {isLogin ? "Welcome back" : "Create a secure account"}
        </h1>
        <p className="mt-1 text-sm text-slate-300">
          {isLogin
            ? "Sign in to access your encrypted chats."
            : "Username + strong password required. Passwords are never stored in plain text."}
        </p>
      </div>

      {registered ? (
        <div className="rounded-2xl border border-emerald-400/40 bg-emerald-500/15 px-4 py-3 text-sm text-emerald-200">
          Account created successfully. <Link href="/login" className="underline">Continue to login</Link>.
        </div>
      ) : (
        <form onSubmit={onSubmit} className="space-y-3">
          <label className="block">
            <span className="mb-1 block text-xs uppercase tracking-wide text-slate-300">Username</span>
            <div className="flex items-center gap-2 rounded-xl border border-white/15 bg-slate-900 px-3">
              <UserRound className="h-4 w-4 text-slate-400" />
              <input
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                required
                minLength={3}
                maxLength={32}
                placeholder="e.g. tavi"
                className="w-full bg-transparent py-2 text-sm text-slate-100 outline-none"
              />
            </div>
          </label>

          <label className="block">
            <span className="mb-1 block text-xs uppercase tracking-wide text-slate-300">Password</span>
            <div className="flex items-center gap-2 rounded-xl border border-white/15 bg-slate-900 px-3">
              <Lock className="h-4 w-4 text-slate-400" />
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
                minLength={10}
                maxLength={128}
                placeholder="At least 10 chars incl. A-Z and number"
                className="w-full bg-transparent py-2 text-sm text-slate-100 outline-none"
              />
            </div>
          </label>

          <button
            type="submit"
            disabled={loading || (!isLogin && !registrationEnabled)}
            className="mt-2 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-teal-400 px-4 py-2.5 text-sm font-semibold text-slate-900 transition disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {isLogin ? "Sign in" : "Register"}
          </button>

          {!isLogin && !registrationEnabled ? (
            <div className="rounded-xl border border-amber-400/40 bg-amber-500/15 px-3 py-2 text-sm text-amber-100">
              Registration is currently disabled by server configuration.
            </div>
          ) : null}

          {error ? (
            <div className="rounded-xl border border-rose-400/40 bg-rose-500/15 px-3 py-2 text-sm text-rose-200">
              {error}
            </div>
          ) : null}
        </form>
      )}

      <div className="mt-5 text-sm text-slate-300">
        {isLogin ? (
          <>
            Need an account? <Link href="/register" className="text-teal-300 hover:underline">Register</Link>
          </>
        ) : (
          <>
            Already have an account? <Link href="/login" className="text-teal-300 hover:underline">Login</Link>
          </>
        )}
      </div>
    </div>
  );
}
