-- Retry receipts move from thread metadata into their own table, so none are ever pruned.
-- Applies fully or not at all.
BEGIN;

-- CreateTable
CREATE TABLE "chatkit_operation_receipts" (
    "thread_id" TEXT NOT NULL,
    "request_key" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "chatkit_operation_receipts_pkey" PRIMARY KEY ("thread_id","request_key")
);

-- AddForeignKey
ALTER TABLE "chatkit_operation_receipts" ADD CONSTRAINT "chatkit_operation_receipts_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "chatkit_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Keep every receipt the previous version stored in metadata, then remove the copy.
INSERT INTO "chatkit_operation_receipts" ("thread_id", "request_key", "data", "updated_at")
SELECT t.id, r.key, r.value, CURRENT_TIMESTAMP
FROM "chatkit_threads" t,
     jsonb_each(t.data #> '{metadata,_chatkit_retry_receipts}') r
WHERE jsonb_typeof(t.data #> '{metadata,_chatkit_retry_receipts}') = 'object';

UPDATE "chatkit_threads"
SET data = data #- '{metadata,_chatkit_retry_receipts}'
WHERE data #> '{metadata,_chatkit_retry_receipts}' IS NOT NULL;

COMMIT;
