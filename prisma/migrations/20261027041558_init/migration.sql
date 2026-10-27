-- CreateEnum
CREATE TYPE "PausedRunStatus" AS ENUM ('waiting', 'taken');

-- CreateTable
CREATE TABLE "chat_items" (
    "id" BIGSERIAL NOT NULL,
    "chat_id" TEXT NOT NULL,
    "item" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "paused_runs" (
    "id" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "status" "PausedRunStatus" NOT NULL DEFAULT 'waiting',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "paused_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "remote_machines" (
    "session_id" TEXT NOT NULL,
    "environment_id" TEXT NOT NULL,
    "claim_token" TEXT NOT NULL,
    "claimed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "machine_id" TEXT,

    CONSTRAINT "remote_machines_pkey" PRIMARY KEY ("session_id")
);

-- CreateIndex
CREATE INDEX "chat_items_chat_id_id_idx" ON "chat_items"("chat_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "remote_machines_environment_id_key" ON "remote_machines"("environment_id");
