"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";

type TaskRow = {
  id: string;
  chatId: string | null;
  status: string;
  source: string;
  model?: string | null;
  active: boolean;
  createdAt: string;
  completedAt: string | null;
};

type Props = {
  defaultModel: string;
  userId: string;
  isGuest: boolean;
  csrfToken: string;
};

export function MobileTaskApp({ defaultModel, isGuest }: Props) {
  const [prompt, setPrompt] = useState("");
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasActiveRef = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [locale, setLocale] = useState<{ country: string | null; language: string | null } | null>(null);
  const [showLocale, setShowLocale] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/tasks", { cache: "no-store" });
      if (res.ok) {
        const data = (await res.json()) as { tasks: TaskRow[] };
        setTasks(data.tasks);
      }
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const loadTasks = async () => {
      if (typeof document !== "undefined" && document.hidden) return;
      try {
        const res = await fetch("/api/tasks", { cache: "no-store" });
        if (active && res.ok) {
          const data = (await res.json()) as { tasks: TaskRow[] };
          setTasks(data.tasks);
          hasActiveRef.current = data.tasks.some(
            (t) => t.active || t.status === "running" || t.status === "queued",
          );
        }
      } catch {
        /* ignore */
      }
    };
    const loadLocale = async () => {
      try {
        const r = await fetch("/api/locale", { cache: "no-store" });
        if (active && r.ok) {
          const d = (await r.json()) as { locale: { country: string | null; language: string | null } | null };
          if (d?.locale) setLocale(d.locale);
        }
      } catch {
        /* ignore */
      }
    };
    void loadTasks();
    void loadLocale();
    function scheduleNext() {
      if (!active) return;
      // Fast while tasks are running/queued; idle otherwise.
      const delay = hasActiveRef.current ? 4000 : 30000;
      timer = setTimeout(async () => {
        await loadTasks();
        scheduleNext();
      }, delay);
    }
    scheduleNext();
    const onVis = () => { if (!document.hidden) { void loadTasks(); } };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  const saveLocale = useCallback(async (country: string, language: string) => {
    const res = await fetch("/api/locale", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Requested-With": "ChatInterface" },
      body: JSON.stringify({ country: country || undefined, language: language || undefined }),
    });
    if (res.ok) {
      const d = (await res.json()) as { locale: { country: string | null; language: string | null } };
      setLocale(d.locale);
    }
  }, []);

  const submit = useCallback(async () => {
    if (!prompt.trim() || loading) return;
    setLoading(true);
    setError(null);

    let attachmentIds: string[] | undefined;
    try {
      if (pendingFiles.length > 0) {
        const fd = new FormData();
        for (const f of pendingFiles) fd.append("files", f);
        const up = await fetch("/api/uploads", {
          method: "POST",
          headers: { "X-Requested-With": "ChatInterface" },
          body: fd,
        });
        if (up.ok) {
          const data = (await up.json()) as { attachments: Array<{ id: string }> };
          attachmentIds = data.attachments.map((a) => a.id);
        }
      }

      const res = await fetch("/api/tasks", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Requested-With": "ChatInterface",
        },
        body: JSON.stringify({ prompt, attachmentIds }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        setError(err.error ?? "Failed to start task");
        return;
      }
      setPrompt("");
      setPendingFiles([]);
      await refresh();
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }, [prompt, loading, pendingFiles, refresh]);

  return (
    <div className="mx-auto flex min-h-screen max-w-2xl flex-col px-4 py-4">
      <header className="mb-3 flex items-center justify-between">
        <h1 className="text-lg font-semibold">Tasks</h1>
        <span className="rounded bg-slate-800 px-2 py-0.5 text-xs text-slate-300">{defaultModel}</span>
      </header>

      <div className="mb-4 rounded-xl border border-slate-800 bg-slate-900/60 p-3">
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={isGuest ? "Describe a task…" : "Schreibe eine Aufgabe…"}
          rows={4}
          className="w-full resize-none rounded-lg bg-slate-950 p-3 text-sm outline-none ring-1 ring-slate-800 focus:ring-teal-500"
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit();
          }}
        />
        <div className="mt-2 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              className="rounded-lg px-2 py-1.5 text-sm text-slate-300 hover:bg-slate-800"
              aria-label="Attach files"
            >
              📎
            </button>
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                setPendingFiles((prev) => [...prev, ...files]);
                e.target.value = "";
              }}
            />
            {pendingFiles.length > 0 && (
              <span className="text-xs text-slate-400">{pendingFiles.length} file(s)</span>
            )}
          </div>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={loading || !prompt.trim()}
            className="rounded-lg bg-teal-600 px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          >
            {loading ? "…" : "Send"}
          </button>
        </div>
        {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
      </div>

      <div className="flex-1 space-y-2 overflow-y-auto">
        {tasks.length === 0 && (
          <p className="py-8 text-center text-sm text-slate-500">No tasks yet.</p>
        )}
        {tasks.map((t) => (
          <a
            key={t.id}
            href={t.chatId ? `/chat/${t.chatId}` : "#"}
            className="block rounded-lg border border-slate-800 bg-slate-900/40 p-3 hover:bg-slate-900"
          >
            <div className="flex items-center justify-between">
              <span className="text-xs uppercase tracking-wide text-slate-400">{t.source}</span>
              <StatusBadge status={t.status} />
            </div>
            <p className="mt-1 text-sm text-slate-200">
              {t.model ?? defaultModel} — {new Date(t.createdAt).toLocaleString()}
            </p>
          </a>
        ))}
      </div>

      <footer className="mt-3 text-center text-xs text-slate-600">
        <button
          type="button"
          onClick={() => setShowLocale((v) => !v)}
          className="hover:text-slate-400"
        >
          {locale?.country ? `Locale: ${locale.country}${locale.language ? ` (${locale.language})` : ""}` : "Set locale"}
        </button>
        {showLocale && (
          <div className="mt-2 flex flex-col items-center gap-2">
            <div className="flex gap-2">
              <input
                aria-label="Country code"
                value={locale?.country ?? ""}
                onChange={(e) => setLocale({ country: e.target.value.toUpperCase().slice(0, 2), language: locale?.language ?? null })}
                placeholder="AT"
                className="w-16 rounded bg-slate-950 p-1.5 text-center outline-none ring-1 ring-slate-800"
              />
              <input
                aria-label="Language code"
                value={locale?.language ?? ""}
                onChange={(e) => setLocale({ country: locale?.country ?? null, language: e.target.value.slice(0, 16) })}
                placeholder="de-AT"
                className="w-24 rounded bg-slate-950 p-1.5 outline-none ring-1 ring-slate-800"
              />
            </div>
            <button
              type="button"
              onClick={() => void saveLocale(locale?.country ?? "", locale?.language ?? "")}
              className="rounded bg-teal-600 px-3 py-1 text-white"
            >
              Save locale
            </button>
            <p className="px-4 text-slate-500">
              Set your country so ambiguous regional requests (&ldquo;current polls&rdquo;) resolve to it.
            </p>
          </div>
        )}
        <div className="mt-2">
          <Link href="/chat" className="hover:text-slate-400">Open desktop chat</Link>
        </div>
      </footer>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    queued: "bg-slate-700 text-slate-200",
    running: "bg-blue-600 text-white",
    done: "bg-teal-600 text-white",
    error: "bg-red-600 text-white",
    suppressed: "bg-slate-700 text-slate-400",
  };
  return (
    <span className={`rounded px-1.5 py-0.5 text-xs ${map[status] ?? "bg-slate-700 text-slate-200"}`}>
      {status}
    </span>
  );
}
