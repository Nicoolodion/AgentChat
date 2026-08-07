-- CreateTable
CREATE TABLE "CustomAgent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "systemPrompt" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "defaultAttachmentIds" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,

    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "CustomAgent_userId_idx" ON "CustomAgent"("userId");

-- AddColumn: bind a chat to a user-defined Custom Agent (nullable; null = plain model mode)
ALTER TABLE "Chat" ADD COLUMN "customAgentId" TEXT;
