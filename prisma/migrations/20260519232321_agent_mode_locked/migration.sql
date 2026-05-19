-- Add agentModeLocked column to Chat to lock mode after first message
ALTER TABLE "Chat" ADD COLUMN "agentModeLocked" BOOLEAN;
