-- New enum values must be committed before they can be used, so they run first, on their own.
-- IF NOT EXISTS makes a retry after a failed attempt safe.
ALTER TYPE "PausedRunStatus" ADD VALUE IF NOT EXISTS 'running';
ALTER TYPE "PausedRunStatus" ADD VALUE IF NOT EXISTS 'completed';
ALTER TYPE "PausedRunStatus" ADD VALUE IF NOT EXISTS 'recovery_required';

-- Everything else applies fully or not at all.
BEGIN;

-- CreateEnum
CREATE TYPE "RemoteMachineStatus" AS ENUM ('pending', 'creating', 'ready', 'reconciliation', 'deleted');

-- CreateEnum
CREATE TYPE "RemoteMachineDesiredState" AS ENUM ('active', 'deleted');

-- CreateEnum
CREATE TYPE "HostedWebhookStatus" AS ENUM ('pending', 'processing', 'completed', 'reconciliation');

-- AlterTable
ALTER TABLE "paused_runs" ADD COLUMN     "agent_name" TEXT,
ADD COLUMN     "agent_version" TEXT,
ADD COLUMN     "chat_id" TEXT,
ADD COLUMN     "owner_id" TEXT,
ADD COLUMN     "recovery_note" TEXT,
ADD COLUMN     "run_options" JSONB,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "remote_machines" ADD COLUMN     "desired_state" "RemoteMachineDesiredState" NOT NULL DEFAULT 'active',
ADD COLUMN     "last_error" TEXT,
ADD COLUMN     "provider" TEXT,
ADD COLUMN     "status" "RemoteMachineStatus" NOT NULL DEFAULT 'pending';

-- CreateTable
CREATE TABLE "chat_history_operations" (
    "chat_id" TEXT NOT NULL,
    "operation_id" TEXT NOT NULL,
    "digest" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_history_operations_pkey" PRIMARY KEY ("chat_id","operation_id")
);

-- CreateTable
CREATE TABLE "hosted_webhooks" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "resource_id" TEXT NOT NULL,
    "status" "HostedWebhookStatus" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "available_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_token" UUID,
    "lease_expires_at" TIMESTAMPTZ(3),
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "hosted_webhooks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "hosted_webhooks_status_available_at_idx" ON "hosted_webhooks"("status", "available_at");

-- CreateIndex
CREATE INDEX "hosted_webhooks_type_resource_id_idx" ON "hosted_webhooks"("type", "resource_id");

-- AddForeignKey
ALTER TABLE "chat_history_operations" ADD CONSTRAINT "chat_history_operations_chat_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Existing claims have unknown execution outcomes. Never automatically replay them.
UPDATE "remote_machines"
SET "status" = CASE WHEN "machine_id" IS NULL THEN 'reconciliation'::"RemoteMachineStatus" ELSE 'ready'::"RemoteMachineStatus" END,
    "provider" = CASE WHEN "machine_id" IS NULL THEN NULL ELSE split_part("machine_id", ':', 1) END;
UPDATE "paused_runs" SET "status" = 'recovery_required' WHERE "status" = 'taken';

COMMIT;
