import { NextResponse } from "next/server";

import { fetchModelsFromNanoGPT } from "@/lib/nanogpt";

export async function GET() {
  try {
    const models = await fetchModelsFromNanoGPT();
    return NextResponse.json({ models });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load models.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
