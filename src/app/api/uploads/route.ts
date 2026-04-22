import { NextResponse } from "next/server";

import {
  AttachmentError,
  attachmentLimits,
  saveAttachmentForUser,
} from "@/lib/attachments";
import { resolveAuthContext } from "@/lib/auth";

export async function POST(request: Request) {
  try {
    const auth = await resolveAuthContext(request);
    if (!auth) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

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

    console.error("[Upload Route Error]", error);
    return NextResponse.json({ error: "Failed to upload files." }, { status: 500 });
  }
}
