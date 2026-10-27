-- Applies fully or not at all. A brand-new enum can be used in the same transaction.
BEGIN;

-- CreateEnum
CREATE TYPE "AgentRunStatus" AS ENUM ('completed', 'waiting', 'failed');

-- CreateTable
CREATE TABLE "agent_runs" (
    "id" UUID NOT NULL,
    "chat_id" TEXT,
    "agent" TEXT NOT NULL,
    "model" TEXT,
    "user_id" TEXT,
    "status" "AgentRunStatus" NOT NULL,
    "error" TEXT,
    "requests" INTEGER NOT NULL DEFAULT 0,
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "cached_tokens" INTEGER NOT NULL DEFAULT 0,
    "duration_ms" INTEGER NOT NULL,
    "trace_id" TEXT,
    "request_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agent_runs_created_at_idx" ON "agent_runs"("created_at");

-- CreateIndex
CREATE INDEX "agent_runs_chat_id_created_at_idx" ON "agent_runs"("chat_id", "created_at");


COMMIT;
