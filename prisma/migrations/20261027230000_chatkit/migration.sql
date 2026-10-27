-- ChatKit threads, items, attachments, and feedback. Applies fully or not at all.
BEGIN;

-- CreateEnum
CREATE TYPE "ChatkitFeedbackKind" AS ENUM ('positive', 'negative');

-- CreateTable
CREATE TABLE "chatkit_threads" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "chatkit_threads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chatkit_items" (
    "thread_id" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "seq" BIGSERIAL NOT NULL,
    "data" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chatkit_items_pkey" PRIMARY KEY ("thread_id","id")
);

-- CreateTable
CREATE TABLE "chatkit_attachments" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "thread_id" TEXT,
    "data" JSONB NOT NULL,
    "content" BYTEA,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "chatkit_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chatkit_feedback" (
    "id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "thread_id" TEXT NOT NULL,
    "item_ids" TEXT[],
    "kind" "ChatkitFeedbackKind" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chatkit_feedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "chatkit_threads_user_id_created_at_idx" ON "chatkit_threads"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "chatkit_items_thread_id_seq_idx" ON "chatkit_items"("thread_id", "seq");

-- CreateIndex
CREATE INDEX "chatkit_attachments_user_id_idx" ON "chatkit_attachments"("user_id");

-- CreateIndex
CREATE INDEX "chatkit_attachments_thread_id_idx" ON "chatkit_attachments"("thread_id");

-- CreateIndex
CREATE INDEX "chatkit_feedback_thread_id_idx" ON "chatkit_feedback"("thread_id");

-- CreateIndex
CREATE INDEX "chatkit_feedback_created_at_idx" ON "chatkit_feedback"("created_at");

-- AddForeignKey
ALTER TABLE "chatkit_items" ADD CONSTRAINT "chatkit_items_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "chatkit_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chatkit_attachments" ADD CONSTRAINT "chatkit_attachments_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "chatkit_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;


COMMIT;
