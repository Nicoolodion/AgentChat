import { NextResponse } from "next/server";

import {
  AttachmentError,
  attachmentLimits,
  saveAttachmentForUser,
} from "@/lib/attachments";
import { resolveMobileAuth } from "@/lib/mobile-auth";

/**
 * POST /api/mobile/uploads
 * Encrypted-at-rest file upload for the mobile app; bearer-authed. Mirrors
 * /api/uploads but reads the bearer token instead of the session cookie.
 * Returns attachmentIds usable in POST /api/mobile/tasks.
 */
export async function POST(request: Request) {
  const auth = await resolveMobileAuth(request);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const formData = await request.formData();
    const files = formData
      .getAll("files")
      .filter((entry): entry is File => entry instanceof File);

    if (files.length === 0) {
      return NextResponse.json({ error: "No files uploaded." }, { status: 400 });
    }
    if (files.length > attachmentLimits.maxAttachmentsPerMessage) {
      return NextResponse.json(
        { error: `Upload up to ${attachmentLimits.maxAttachmentsPerMessage} files at once.` },
        { status: 400 },
      );
    }

    const uploaded = [];
    for (const file of files) {
      const bytes = Buffer.from(await file.arrayBuffer());
      if (bytes.length > attachmentLimits.maxFileSizeBytes) {
        return NextResponse.json(
          { error: `File ${file.name} exceeds ${Math.round(attachmentLimits.maxFileSizeBytes / (1024 * 1024))} MB.` },
          { status: 413 },
        );
      }
      const saved = await saveAttachmentForUser({
        userId: auth.userId,
        userKey: auth.userKey,
        fileName: file.name,
        mimeType: file.type,
        bytes,
      });
      uploaded.push(saved);
    }

    return NextResponse.json({ attachments: uploaded }, { status: 201 });
  } catch (error) {
    if (error instanceof AttachmentError) {
      return NextResponse.json({ error: error.message }, { status: error.statusCode });
    }
    console.error("[Mobile Upload Route Error]", error);
    return NextResponse.json({ error: "Failed to upload files." }, { status: 500 });
  }
}
