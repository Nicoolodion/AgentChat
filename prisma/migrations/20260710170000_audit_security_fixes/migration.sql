-- CreateTable
CREATE TABLE "MailboxState" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'singleton',
    "lastSeenUid" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "UserEmail_verifyToken_idx" ON "UserEmail"("verifyToken");

-- CreateIndex
CREATE INDEX "RateLimitBucket_resetAt_idx" ON "RateLimitBucket"("resetAt");
