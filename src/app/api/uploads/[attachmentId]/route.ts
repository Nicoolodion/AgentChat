import { NextResponse } from "next/server";

import { AttachmentError, getAttachmentForUser } from "@/lib/attachments";
import { resolveAuthContext } from "@/lib/auth";

function sanitizeInlineFileName(fileName: string): string {
  const normalized = fileName.replace(/[\r\n"]/g, " ").trim();
  return normalized || "attachment";
}

export async function GET(
  request: Request,
  context: { params: Promise<{ attachmentId: string }> },
) {
  try {
    const auth = await resolveAuthContext(request);
    if (!auth) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { attachmentId } = await context.params;
    const { meta, bytes } = await getAttachmentForUser({
      userId: auth.userId,
      userKey: auth.userKey,
      attachmentId,
    });

    return new NextResponse(bytes.buffer as ArrayBuffer, {
      headers: {
        "Content-Type": meta.mimeType || "application/octet-stream",
        "Content-Length": String(bytes.length),
        "Content-Disposition": `inline; filename="${sanitizeInlineFileName(meta.fileName)}"`,
        "Cache-Control": "private, max-age=120",
      },
    });
  } catch (error) {
    if (error instanceof AttachmentError) {
      return NextResponse.json({ error: error.message }, { status: error.statusCode });
    }

    console.error("[Attachment Read Route Error]", error);
    return NextResponse.json({ error: "Failed to read attachment." }, { status: 500 });
  }
}
