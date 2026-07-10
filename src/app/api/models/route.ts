import { NextResponse } from "next/server";

import { env } from "@/lib/env";
import { fetchModelsFromNanoGPT, fetchModelsFromNeuralwatt, normalizeDefaultModel } from "@/lib/nanogpt";
import { resolveAuthContext } from "@/lib/auth";
import type { ModelInfo } from "@/lib/chat-types";

export async function GET(request: Request) {
  const auth = await resolveAuthContext(request);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  try {
    const { searchParams } = new URL(request.url);
    const search = searchParams.get("search") ?? "";

    const [nanogptModels, neuralwattModels] = await Promise.all([
      fetchModelsFromNanoGPT(search).catch(() => []),
      fetchModelsFromNeuralwatt(search).catch(() => []),
    ]);

    // Dedupe by id, merging entries so the richer record wins. A bare
    // Neuralwatt default (e.g. `kimi-k2.7-code-flex`) is normalized to
    // `neuralwatt:kimi-k2.7-code-flex`; `fetchModelsFromNanoGPT` returns that
    // same id as a NanoGPT-source placeholder when no NanoGPT key is set, so
    // without dedupe the model would appear under BOTH provider sections in
    // the picker. The Neuralwatt-sourced row carries full metadata
    // (capabilities/pricing/context), so it wins over the NanoGPT placeholder.
    const byId = new Map<string, ModelInfo>();
    const merge = (m: ModelInfo) => {
      const existing = byId.get(m.id);
      if (!existing) {
        byId.set(m.id, m);
        return;
      }
      // Prefer the real provider's row; otherwise keep the first and fill any
      // missing primitive fields from the second so neither side's metadata is
      // dropped when both contribute something.
      const primary = m.source === "neuralwatt" ? m : existing;
      const secondary = m.source === "neuralwatt" ? existing : m;
      // Fill only the fields the primary is missing — never let the secondary
      // overwrite a value the primary already carries (in particular its
      // `source`, which would relabel a real Neuralwatt row as NanoGPT).
      const filled: ModelInfo = { ...primary };
      for (const [k, v] of Object.entries(secondary)) {
        if (v === undefined || v === null) continue;
        if ((filled as Record<string, unknown>)[k] === undefined || (filled as Record<string, unknown>)[k] === null) {
          (filled as Record<string, unknown>)[k] = v;
        }
      }
      byId.set(m.id, filled);
    };
    for (const m of nanogptModels) merge(m);
    for (const m of neuralwattModels) merge(m);

    const models = [...byId.values()];
    // Surface the configured DEFAULT_MODEL, normalized to the correct provider
    // prefix, so the UI can preselect it instead of blindly taking the first
    // entry (which, with only a Neuralwatt key, used to be a non-routable bare
    // NanoGPT placeholder).
    return NextResponse.json({ models, defaultModel: normalizeDefaultModel(env.DEFAULT_MODEL) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load models.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
