import { NextResponse } from "next/server";

import { fetchModelsFromNanoGPT, fetchModelsFromNeuralwatt } from "@/lib/nanogpt";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const search = searchParams.get("search") ?? "";

    const [nanogptModels, neuralwattModels] = await Promise.all([
      fetchModelsFromNanoGPT(search).catch(() => []),
      fetchModelsFromNeuralwatt(search).catch(() => []),
    ]);

    const models = [...nanogptModels, ...neuralwattModels];
    return NextResponse.json({ models });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load models.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
