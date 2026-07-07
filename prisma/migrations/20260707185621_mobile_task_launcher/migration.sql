-- AlterTable
ALTER TABLE "Message" ADD COLUMN "energyDurationSeconds" REAL;
ALTER TABLE "Message" ADD COLUMN "energyJoules" REAL;
ALTER TABLE "Message" ADD COLUMN "energyKwh" REAL;
ALTER TABLE "Message" ADD COLUMN "usageCachedTokens" INTEGER;
ALTER TABLE "Message" ADD COLUMN "usageTotalTokens" INTEGER;

-- CreateTable
CREATE TABLE "RateLimitBucket" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "count" INTEGER NOT NULL DEFAULT 0,
    "resetAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "UserEmail" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "verifiedAt" DATETIME,
    "verifyToken" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "UserEmail_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "UserMobileToken" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "wrappedUserKeyCipher" TEXT NOT NULL,
    "installId" TEXT NOT NULL,
    "label" TEXT,
    "ntfyTopic" TEXT NOT NULL,
    "ntfyAuth" TEXT,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "UserMobileToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MobileTask" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "agentSessionId" TEXT,
    "chatId" TEXT,
    "source" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "model" TEXT,
    "status" TEXT NOT NULL,
    "emailAddress" TEXT,
    "emailMessageId" TEXT,
    "emailThreadId" TEXT,
    "answeredFromDesktop" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "errorMessage" TEXT,
    CONSTRAINT "MobileTask_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "MobileTask_agentSessionId_fkey" FOREIGN KEY ("agentSessionId") REFERENCES "AgentSession" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "MobileTask_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "Chat" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "UserProfile" (
    "userId" TEXT NOT NULL PRIMARY KEY,
    "country" TEXT,
    "language" TEXT,
    "timezone" TEXT,
    CONSTRAINT "UserProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "UserEmail_userId_key" ON "UserEmail"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "UserEmail_address_key" ON "UserEmail"("address");

-- CreateIndex
CREATE UNIQUE INDEX "UserMobileToken_tokenHash_key" ON "UserMobileToken"("tokenHash");

-- CreateIndex
CREATE INDEX "UserMobileToken_userId_idx" ON "UserMobileToken"("userId");

-- CreateIndex
CREATE INDEX "MobileTask_userId_createdAt_idx" ON "MobileTask"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "MobileTask_status_idx" ON "MobileTask"("status");

-- CreateIndex
CREATE INDEX "MobileTask_emailThreadId_idx" ON "MobileTask"("emailThreadId");
