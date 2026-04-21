import { NextResponse } from "next/server";

import { fetchModelsFromNanoGPT } from "@/lib/nanogpt";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const search = searchParams.get("search") ?? "";
    const models = await fetchModelsFromNanoGPT(search);
    return NextResponse.json({ models });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load models.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
