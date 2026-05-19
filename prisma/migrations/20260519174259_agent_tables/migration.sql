-- Agent feature tables

-- AgentSession
CREATE TABLE "AgentSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "chatId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "workspacePath" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "completedAt" DATETIME,
    "errorMessage" TEXT,
    CONSTRAINT "AgentSession_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "Chat" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AgentSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- AgentToolCall
CREATE TABLE "AgentToolCall" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "arguments" TEXT NOT NULL,
    "result" TEXT,
    "error" TEXT,
    "durationMs" INTEGER,
    "status" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    CONSTRAINT "AgentToolCall_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AgentSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- AgentArtifact
CREATE TABLE "AgentArtifact" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgentArtifact_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AgentSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Indexes
CREATE UNIQUE INDEX "AgentSession_chatId_key" ON "AgentSession"("chatId");
CREATE INDEX "AgentSession_userId_idx" ON "AgentSession"("userId");
CREATE INDEX "AgentSession_chatId_idx" ON "AgentSession"("chatId");
CREATE INDEX "AgentSession_status_idx" ON "AgentSession"("status");
CREATE INDEX "AgentToolCall_sessionId_idx" ON "AgentToolCall"("sessionId");
CREATE INDEX "AgentToolCall_createdAt_idx" ON "AgentToolCall"("createdAt");
CREATE INDEX "AgentArtifact_sessionId_idx" ON "AgentArtifact"("sessionId");
